---
name: Telemetry verification attribution
description: Safe device discovery and live-test evidence rules for MQTT payloads without managed-site labels.
---

MQTT telemetry can identify a Modbus source through server/source fields rather than a device ID, and it may omit a managed-site label entirely.

**Why:** Requiring only device-ID fields hides valid live sources. Mapping an unlabeled stream across multiple managed sites would risk activating or exposing the wrong site.

**How to apply:** Accept stable source identifiers as testable devices. Attribute payloads without a site label to a managed site only when exactly one active managed site exists; preserve explicit payload labels and reject ambiguous multi-site attribution. Retain ambiguous/unassigned source evidence as catalog evidence, but never surface it as mapped site data. Apply resolved attribution consistently to verification, discovery, SSE/replay, history, and snapshots. A recent, direct, non-retained message inside the live freshness window is valid test evidence when the publishing cadence is longer than the observation window.