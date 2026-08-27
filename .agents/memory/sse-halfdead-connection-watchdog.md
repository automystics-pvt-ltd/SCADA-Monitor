---
name: SSE half-dead connection watchdog
description: Why a browser EventSource can show "connected/live" for minutes with no fresh data, and how to make it self-heal.
---

A native browser `EventSource` can silently sit in a half-dead state — proxy/network drops the underlying TCP connection but the browser doesn't fire `onerror` for a long time (observed: 6-10 minutes in this project, then several more minutes before any reconnect attempt). During that window the UI's "live"/"connected" badge stays true while no fresh telemetry arrives at all. This reproduces intermittently, not on every connection, which made it easy to mistake for a backend delivery bug — but backend evidence (broker events, consumer lease) can be perfectly healthy while the browser-side pipe is dead.

**Why:** `onerror`/native reconnect is not a reliable heartbeat signal — it depends on the OS/browser noticing the TCP connection is gone, which proxies and idle network paths can delay indefinitely. Relying solely on it for "is my live stream actually alive" is not production-safe for a monitoring dashboard.

**How to apply:** For any SSE/WebSocket "live" indicator that matters operationally, don't trust `onopen`/`onerror` alone. Have the server emit a periodic heartbeat event (this app already does, every 20s) and have the client track a `lastActivityAt` timestamp updated on every received event (heartbeat included). Run a watchdog interval (~2-2.5x the heartbeat period) that force-closes and reopens the connection if no activity was seen in that window — don't wait for the browser to notice on its own. This is implemented in `artifacts/mqtt-scada-monitor/src/App.tsx` (`streamLastActivityRef` + a watchdog `setInterval` alongside the `connect()` lifecycle effect).
