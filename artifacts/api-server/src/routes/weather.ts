import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const WEATHER_CACHE_TTL_MS = 4 * 60 * 1000;

type OpenMeteoResponse = {
  latitude?: number;
  longitude?: number;
  timezone?: string;
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

router.get("/weather", async (req, res): Promise<void> => {
  const latitudeInput = typeof req.query.latitude === "string" ? req.query.latitude.trim() : "";
  const longitudeInput = typeof req.query.longitude === "string" ? req.query.longitude.trim() : "";
  const latitude = Number(latitudeInput);
  const longitude = Number(longitudeInput);
  if (!latitudeInput || !longitudeInput || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    res.status(400).json({ message: "Valid latitude and longitude are required" });
    return;
  }

  const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
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
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn({ status: response.status }, "Weather provider request failed");
      res.status(502).json({ message: "Weather data is unavailable from the provider" });
      return;
    }

    const source = await response.json() as OpenMeteoResponse;
    const current = source.current ?? {};
    const currentTime = current.time;
    const hourlyIndex = currentTime && source.hourly?.time ? source.hourly.time.indexOf(currentTime) : -1;
    const radiation = hourlyIndex !== undefined && hourlyIndex >= 0 ? source.hourly?.shortwave_radiation?.[hourlyIndex] : undefined;
    const temperatureTrend = (source.hourly?.time ?? []).map((time, index) => ({
      time,
      temperatureC: numberOrNull(source.hourly?.temperature_2m?.[index]),
    })).filter((point) => point.temperatureC !== null).slice(Math.max(0, (hourlyIndex >= 0 ? hourlyIndex : 0) - 2), (hourlyIndex >= 0 ? hourlyIndex : 0) + 5);
    const weatherCode = numberOrNull(current.weather_code);
    const retrievedAt = new Date().toISOString();
    const payload = {
      available: true,
      source: "Open-Meteo",
      location: {
        latitude: numberOrNull(source.latitude) ?? latitude,
        longitude: numberOrNull(source.longitude) ?? longitude,
        timezone: typeof source.timezone === "string" ? source.timezone : null,
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