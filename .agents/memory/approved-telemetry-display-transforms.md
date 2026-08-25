---
name: Approved telemetry display transforms
description: Safe rules for Admin-configured telemetry display units and multiplier/offset transforms.
---

An active Admin telemetry mapping may calculate a customer-facing **Actual** display value using the explicit linear formula `reported × multiplier + offset`, together with an explicitly configured display unit. The server must retain and expose transport raw value, source-reported value/unit, mapping version, and calculation validation separately.

**Why:** Operators need durable, configuration-led values for arbitrary MQTT/Modbus devices, but a display transform must not erase source evidence or silently turn an unreviewed signal into an engineering KPI.

**How to apply:** Resolve the current mapping server-side for every newly received, retained, recovered, replayed, and saved signal; only use its display value when the approved calculation is finite. Store unmapped observations durably so Admin can map new signals without code. Use the transform for labeled UI/report display, while plant calibration remains the gate for derived energy and engineering KPI calculations.