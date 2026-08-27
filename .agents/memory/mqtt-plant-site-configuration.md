---
name: MQTT plant-site configuration
description: Why the admin-configured "plant site" for the MQTT broker can silently default to the raw topic string, and how to verify/fix it.
---

The MQTT broker/topic in `artifacts/api-server/src/routes/mqtt.ts` has an admin-configurable `plantSite` field (`configuredMqttPlantSite` / `runtimeConfiguration.plantSite`) meant to hold the actual `platform_sites.site_name` this broker's telemetry belongs to. It is used as the authoritative fallback for attributing unlabeled real broker messages to a site (see `messageBelongsToSite`).

If nobody has ever explicitly saved this via Platform Admin's MQTT settings (PATCH `/platform-admin/mqtt-config` + POST `.../apply`), it silently defaults to the raw subscription topic string (e.g. `"trn246/modbus"`) — which never equals any real site name, so unlabeled telemetry never gets attributed to any site's dashboard even though the broker itself is healthy and connected.

We found this the hard way: the settings-page PATCH handler had a bug (returned a partial response object missing `applyState`/`connected`, tripping the response's zod schema and returning a 500) — the config value was still correctly written to `platform_configuration`, but the visible failure meant nobody could tell a save had worked, so `plantSite` was simply never set for this deployment.

**Why:** an unconfigured admin setting failing loudly (or, worse, failing silently on the response while still writing to the DB) is easy to mistake for "this was already configured" or "this doesn't matter." Combined with a code fallback that always returns *something* plausible-looking (the topic string), there is no obvious signal that the real per-site attribution is broken until you check `GET /platform-admin/mqtt-config`'s `plantSite` field against the actual site names in `platform_sites`.

**How to apply:** When live telemetry attribution to a specific site is suspect, check `GET /api/platform-admin/mqtt-config` — `plantSite` must equal an active `platform_sites.site_name`, not the topic. If it doesn't, PATCH + apply it via that endpoint (do not hand-edit `platform_configuration` directly; `applyMqttConfiguration` safely reconnects the broker and rolls back on failure). Verify end-to-end by opening `/api/mqtt/stream?siteName=<site>` and confirming `event: message` frames actually arrive, not just `status`/`heartbeat` — a "connected" status proves the broker link, not per-site message delivery.
