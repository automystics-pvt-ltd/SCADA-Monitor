---
name: Electrical telemetry validation
description: Rules for rendering operational electrical values from MQTT/Modbus telemetry.
---

Do not infer AC electrical values from DC readings, plant totals, nominal frequency, or synthetic factors. An electrical value may drive KPIs, charts, balance calculations, or health status only when its telemetry has an explicit scaling-validation confirmation.

**Why:** The live Modbus feed can provide named readings and raw register payloads without declaring that their engineering scaling is approved. Presenting those as confirmed values could mislead operators.

**How to apply:** Keep each discovered reading traceable with its source, register address, raw value, timestamp, and data-quality state. Show raw/unscaled readings as `Raw / Scaling Required`, and use explicit `Data unavailable` or `Validation Required` states rather than filling missing phase, power factor, or frequency values.