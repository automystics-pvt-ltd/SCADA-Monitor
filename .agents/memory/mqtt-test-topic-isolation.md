---
name: mqtt-test-topic-isolation
description: How to write deterministic MQTT delivery/replay integration tests in this project without racing the real broker's live production traffic.
---

The real MQTT broker this project connects to (topic `trn246/modbus`, the default `subscriptionTopic`) delivers genuine production telemetry at a very high, unpredictable cadence (observed roughly every ~20ms) whenever the `artifacts/api-server` dev workflow is running, because the sandbox has real network access to it. Any integration test that shares the default topic will race that traffic for delivery-sequence numbers and durable-ledger high-water marks, making exact-replay assertions flaky.

**Why:** Delivery-sequence/replay correctness tests need full control over exactly which rows exist in `mqtt_communication_events` for a given topic and their sequence numbers. Sharing the live topic makes this control impossible.

**How to apply:** Use the test-only export `__setSubscriptionTopicForTest(topic)` in `artifacts/api-server/src/routes/mqtt.ts` (guarded by `NODE_ENV==="test"`, mirrors `__setConfiguredMqttPlantSiteForTest`) to redirect `subscriptionTopic` to a `randomUUID()`-suffixed fixture topic before inserting rows into `mqttCommunicationEventsTable` or asserting on `deliveryHighWater()`/`replayableMessagesAfter()`. This exercises the exact same query path with zero collision risk. A sibling hook, `__setConsumerLeaseHeldForTest(held)`, deterministically forces the standby "ledger fanout" branch of the `/mqtt/stream` route without depending on which process happens to hold the real consumer lease -- necessary because `requestMqttConsumer()` is a no-op under `NODE_ENV==="test"`, so `consumerLeaseHeld` never changes on its own in tests.
