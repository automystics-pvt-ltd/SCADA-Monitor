import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const WEATHER_CACHE_TTL_MS = 4 * 60 * 1000;

type OpenMeteoResponse = {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  utc_offset_seconds?: number;
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    weather_code?: number;
    cloud_cover?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  hourly?: {
    time?: string[];
    shortwave_radiation?: number[];
    temperature_2m?: number[];
  };
};

type ReverseGeocodeResponse = {
  display_name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    city_district?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
  };
};

type CachedWeather = {
  expiresAt: number;
  payload: Record<string, unknown>;
};

const cache = new Map<string, CachedWeather>();

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function weatherCondition(code: number | null) {
  if (code === null) return null;
  if (code === 0) return "Clear sky";
  if ([1, 2, 3].includes(code)) return code === 1 ? "Mainly clear" : code === 2 ? "Partly cloudy" : "Overcast";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  return null;
}

function formatUtcOffset(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const sign = seconds < 0 ? "-" : "+";
  const absoluteMinutes = Math.floor(Math.abs(seconds) / 60);
  return `UTC${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")}:${String(absoluteMinutes % 60).padStart(2, "0")}`;
}

function localDateTime(now: Date, timezone: string | null) {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "medium",
      hourCycle: "h23",
    }).format(now);
  } catch {
    return null;
  }
}

async function reverseGeocode(latitude: number, longitude: number) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "en");

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Solar SCADA Monitor/1.0 (configured plant weather)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, latitude, longitude }, "Reverse geocoding request failed");
      return null;
    }
    return await response.json() as ReverseGeocodeResponse;
  } catch (error) {
    logger.warn({ err: error, latitude, longitude }, "Reverse geocoding request could not be completed");
    return null;
  }
}

router.get("/weather", async (req, res): Promise<void> => {
  const latitudeInput = typeof req.query.latitude === "string" ? req.query.latitude.trim() : "";
  const longitudeInput = typeof req.query.longitude === "string" ? req.query.longitude.trim() : "";
  const latitude = Number(latitudeInput);
  const longitude = Number(longitudeInput);
  if (!latitudeInput || !longitudeInput || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    res.status(400).json({ message: "Valid latitude and longitude are required" });
    return;
  }

  const cacheKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json({
      ...cached.payload,
      freshness: {
        ...(cached.payload.freshness as Record<string, unknown>),
        servedAt: new Date().toISOString(),
        cacheStatus: "cached",
      },
    });
    return;
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m");
  url.searchParams.set("hourly", "shortwave_radiation,temperature_2m");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");

  try {
    const [response, reverse] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(10_000) }),
      reverseGeocode(latitude, longitude),
    ]);
    if (!response.ok) {
      logger.warn({ status: response.status }, "Weather provider request failed");
      res.status(502).json({ message: "Weather data is unavailable from the provider" });
      return;
    }

    const source = await response.json() as OpenMeteoResponse;
    const retrievedAt = new Date().toISOString();
    const timezone = typeof source.timezone === "string" ? source.timezone : null;
    const utcOffsetSeconds = numberOrNull(source.utc_offset_seconds);
    const reverseAddress = reverse?.address ?? {};
    const exactLocationName = typeof reverse?.display_name === "string" && reverse.display_name.trim() ? reverse.display_name.trim() : null;
    const city = reverseAddress.city ?? reverseAddress.town ?? reverseAddress.village ?? reverseAddress.municipality ?? null;
    const district = reverseAddress.city_district ?? reverseAddress.district ?? reverseAddress.county ?? null;
    const current = source.current ?? {};
    const currentTime = current.time;
    const hourlyIndex = currentTime && source.hourly?.time ? source.hourly.time.indexOf(currentTime) : -1;
    const radiation = hourlyIndex !== undefined && hourlyIndex >= 0 ? source.hourly?.shortwave_radiation?.[hourlyIndex] : undefined;
    const temperatureTrend = (source.hourly?.time ?? []).map((time, index) => ({
      time,
      temperatureC: numberOrNull(source.hourly?.temperature_2m?.[index]),
    })).filter((point) => point.temperatureC !== null).slice(Math.max(0, (hourlyIndex >= 0 ? hourlyIndex : 0) - 2), (hourlyIndex >= 0 ? hourlyIndex : 0) + 5);
    const weatherCode = numberOrNull(current.weather_code);
    const payload = {
      available: true,
      source: "Open-Meteo",
      location: {
        latitude,
        longitude,
        locationName: exactLocationName,
        city,
        district,
        state: reverseAddress.state ?? null,
        country: reverseAddress.country ?? null,
        timezone,
        utcOffsetSeconds,
        utcOffset: formatUtcOffset(utcOffsetSeconds),
        localDateTime: localDateTime(new Date(), timezone),
        coordinateSource: "Configured plant location",
        reverseGeocodedAt: reverse ? retrievedAt : null,
      },
      current: {
        temperatureC: numberOrNull(current.temperature_2m),
        windSpeedMs: numberOrNull(current.wind_speed_10m),
        windDirectionDeg: numberOrNull(current.wind_direction_10m),
        humidityPct: numberOrNull(current.relative_humidity_2m),
        irradianceWm2: numberOrNull(radiation),
        weatherCondition: weatherCondition(weatherCode),
        cloudCoverPct: numberOrNull(current.cloud_cover),
        precipitationMm: numberOrNull(current.precipitation),
      },
      temperatureTrend,
      freshness: {
        observationTime: typeof current.time === "string" ? current.time : null,
        retrievedAt,
        servedAt: retrievedAt,
        cacheStatus: "fresh",
      },
    };
    cache.set(cacheKey, { expiresAt: Date.now() + WEATHER_CACHE_TTL_MS, payload });
    res.json(payload);
  } catch (error) {
    logger.warn({ err: error }, "Weather provider request could not be completed");
    res.status(502).json({ message: "Weather data is unavailable from the provider" });
  }
});

export default router;