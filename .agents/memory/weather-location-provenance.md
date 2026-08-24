---
name: Weather location provenance
description: Safety and accuracy rules for choosing a plant location for live weather.
---

For the explicitly selected plant/site, use only the operator-verified persisted plant location. Resolve its exact place identity through server-side reverse geocoding and derive the weather timezone and UTC offset from those same coordinates. Do not use MQTT-derived coordinates until a server-controlled registry binds immutable device IDs to authorized sites and coordinate schemas. Never use browser geolocation, IP location, or dashboard-device location. If no selected-site location exists, render “Location data unavailable” and do not imply a place or timezone.

**Why:** A multi-site solar fleet can otherwise show legitimate weather data for the wrong plant. Self-reported MQTT device type, site, and coordinates are not an authorization boundary. A verified saved location keeps remote plants covered without trusting arbitrary payload fields. Browser and dashboard-device locations are both privacy-invasive and unrelated to remote SCADA assets.

**How to apply:** Keep weather source, selected site/device provenance, configured coordinates, reverse-geocoded address, timezone, UTC offset, coordinate-timezone local clock, observation time, received time, and cache state consistent wherever weather is shown. Treat cached provider data as explicitly cached/stale, not as a new live observation.