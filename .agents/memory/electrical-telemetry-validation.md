---
name: Electrical telemetry validation
description: Rules for rendering operational electrical values from MQTT/Modbus telemetry.
---

Do not infer AC electrical values from DC readings, plant totals, nominal frequency, or synthetic factors. An electrical value may drive KPIs, charts, balance calculations, or health status only when its telemetry has an explicit scaling-validation confirmation.

**Why:** The live Modbus feed can provide named readings and raw register payloads without declaring that their engineering scaling is approved. Presenting those as confirmed values could mislead operators.

**How to apply:** Keep each discovered reading traceable with its source, register address, raw value, timestamp, and data-quality state. Show raw/unscaled readings as `Raw / Scaling Required`, and use explicit `Data unavailable` or `Validation Required` states rather than filling missing phase, power factor, or frequency values. For analytical views, raw values may appear as current-source snapshots or raw-tag bars, but never as a synthetic historical trend, engineering total, or validated contribution percentage.

A current source-tag value with `live` provenance may drive a clearly labeled visual telemetry-stream animation, even without an approved operational status mapping. Retained, replayed, recovered, stale-source, offline, zero, or unavailable evidence must not animate as live flow.

**Why:** A moving stream can accurately communicate receipt of a fresh broker message without claiming its raw number is a scaled power value or that the device is operationally online.

**How to apply:** Keep the device status and raw/scaling-required labels unchanged; distinguish the animation as a `Live raw telemetry stream`, not validated power flow.

For a dashboard flow visual, never animate a mixed raw aggregate when any of its contributors are not live. Select one fresh live source tag for the visual lane and identify that exact register; leave the aggregate KPI and its evidence summary unchanged.

**Why:** A mixed aggregate can contain retained or replayed values, so animating it would wrongly imply the complete plant total is current.

**How to apply:** Use the selected live source tag only for the illustrative stream and label it `raw / scaling required`; use validated calculations for plant-level power claims.