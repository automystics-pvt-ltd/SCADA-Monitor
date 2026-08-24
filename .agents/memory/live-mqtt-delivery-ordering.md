---
name: Live MQTT delivery ordering
description: Rules for immediate MQTT-to-SSE delivery without creating unrecoverable gaps.
---

Live MQTT frames may be delivered before their asynchronous archival writes complete, but their SSE delivery identities must still be contiguous, durably allocated, and recoverable.

**Why:** Reserving unused sequence ranges makes ordinary restart or consumer-lease handoff look like a permanent lost-data gap. Conversely, relying only on the durable ledger during a reconnect can omit a just-broadcast frame whose background archival write has not yet committed.

**How to apply:** Allocate one ordered durable identity before fanout. During SSE hydration or recovery, use the highest contiguous evidence across the durable ledger and in-memory recent messages; defer newly arriving frames until hydration completes. Ignore callbacks from MQTT clients that no longer hold the consumer lease, and never let replayed or recovered evidence advance operational live state.