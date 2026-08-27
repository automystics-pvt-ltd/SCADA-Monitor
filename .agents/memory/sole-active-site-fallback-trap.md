---
name: Sole-active-site fallback trap
description: Why an unlabeled telemetry message can silently stop reaching any dashboard the moment a second platform site is registered.
---

Real MQTT wire payloads from the plant's physical broker/topic never carry an explicit site/plant name field. Server code that must decide "which registered site does this unlabeled message belong to" had two different fallback strategies living side by side in `artifacts/api-server/src/routes/mqtt.ts`:

1. `configuredMqttPlantSite` — the actual admin-configured site for this server's one physical broker/topic. Always meaningful, regardless of how many platform sites exist.
2. `configuredManagedSiteFallback` (via `soleManagedSiteForConfiguredFallback()`) — "the sole active platform site, if there is exactly one." Silently becomes `undefined` the instant a second site is registered (e.g. a QA/test fixture site), and stays that way permanently.

The live SSE stream's per-listener message filter (`messageBelongsToSite`, gating `broadcast()`) used strategy 2. The day a second site existed, every unlabeled live message matched zero sites — dashboards kept showing "connected" (status/heartbeat events don't go through this filter) while receiving no telemetry at all, with no error anywhere. This ran in production for about a day before being noticed.

**Why:** "count how many things are currently active" is not a stable identity — it silently degrades as soon as the count changes, with no signal that anything broke. It's a trap whenever it stands in for "the one thing this specific piece of infrastructure is configured to serve."

**How to apply:** When code needs to attribute unlabeled/legacy data to "the" site or tenant a physical resource serves, use the explicit configured mapping (`configuredMqttPlantSite`), never a fallback derived from "there happens to be only one of X right now." Reserve the sole-active-site fallback pattern strictly for legacy-migration bridging (see `canAdoptLegacyConfiguredSource` in the same file), and audit any of its other call sites before adding a second entity of the counted kind.

A full audit of every `soleManagedSiteForConfiguredFallback()` call site in that file found the pattern is safe whenever it *degrades to* `configuredMqttPlantSite` when ambiguous (e.g. `telemetryCaptureSite`'s `explicit || soleManagedSite || configuredSourceSite` chain — never goes fully dark), but unsafe whenever something *overrides* an already-correct `configuredMqttPlantSite`-based value with the sole-site result (live-device listing, live-telemetry-test matching) — that override is what silently flips behavior once a second site appears, even though it looks like harmless single-site convenience. Prefer deleting the override outright over trying to make the count-based check smarter.
