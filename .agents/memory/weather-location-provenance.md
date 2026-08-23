---
name: Weather location provenance
description: Safety and accuracy rules for choosing a plant location for live weather.
---

Use the explicitly selected plant/site's configured coordinates as the sole weather-location source. For a selected inverter, use its registered coordinates only when explicitly configured; otherwise inherit the parent site coordinates. Never use browser geolocation, IP location, or dashboard-device location. If no configured location exists, render “Weather data unavailable for this site.”

**Why:** A multi-site solar fleet can otherwise show legitimate weather data for the wrong plant. Browser and dashboard-device locations are both privacy-invasive and unrelated to remote SCADA assets.

**How to apply:** Keep weather source, selected site/device provenance, coordinates, observation time, received time, and cache state consistent wherever weather is shown. Treat cached provider data as explicitly cached/stale, not as a new live observation.