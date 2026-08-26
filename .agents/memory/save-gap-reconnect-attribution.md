---
name: Save-gap reconnect attribution
description: How scheduled-save gaps get explained by MQTT broker instability, and how reconnect frequency is counted as a site-health signal.
---

When a scheduled telemetry save window is missing/incomplete/absent, an unstable
broker connection (not a data-quality problem) is often the real cause. Explain
this by overlapping the gap's window against recorded `mqtt_communication_events`
rows for the same topic, rather than leaving a generic "no snapshot" message.

**Why:** An operator seeing "No scheduled snapshot was recorded" with no further
context reads it as an unexplained outage and escalates, when the actual cause
(the broker dropped and resubscribed mid-window) is already recorded and
actionable.

**How to apply:**
- `communication-interruption` rows only mark an outage's start (no `endedAt` —
  it may still be ongoing); the paired `communication-recovery` row carries both
  bounds and shares the *exact same* `startedAt`. Reconstruct true outage
  intervals by pairing on `startedAt`, not by treating each row as a point event —
  otherwise a multi-window outage only explains the window it started in, and one
  still open (no recovery yet) is dropped entirely.
- Query interruption/recovery history with **no lower time bound** (only an upper
  bound at the query's `to`) so an outage that began before the requested range
  is never missed. An unmatched (unrecovered) interruption's effective end is
  "now", not its own `receivedAt`.
- Reconnect *frequency* is a standalone site-health signal, not just a gap
  explanation. Count only a `broker-connected` that was preceded by an observed
  `broker-closed`/`broker-reconnecting` since the last connect — never count the
  first-ever connect after a process start, or every deploy inflates the
  "reconnect" count and a healthy fresh boot reads as broker instability.
- All active sites currently share one MQTT feed/topic, so a reconnect count
  computed per-topic applies uniformly across sites until multi-feed support exists.
