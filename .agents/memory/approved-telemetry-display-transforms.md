---
name: Approved telemetry display transforms
description: Safe rules for Admin-configured telemetry display units and multiplier/offset transforms.
---

An active Admin telemetry mapping may calculate a customer-facing **Actual** display value using the explicit linear formula `reported × multiplier + offset`, together with an explicitly configured display unit. The server must retain and expose transport raw value, source-reported value/unit, mapping version, and calculation validation separately.

Alarm, fault, communication, data-quality, and inverter-identity mappings are explicitly unitless source states. They may be saved without a display unit, but must never render an engineering **Actual** value.

When an approved mapping is refreshed in a long-lived SCADA session, its display label, category, destination, unit, and finite transform must be reapplied to visible source-reported evidence. Clearing that mapping must remove both client-injected and server-resolved display overlays immediately.

**Why:** Operators need durable, configuration-led values for arbitrary MQTT/Modbus devices, but a display transform must not erase source evidence or silently turn an unreviewed signal into an engineering KPI. Requiring a unit for a source state blocks valid alarm/event mappings, while transforming numeric state codes misrepresents them as measurements.

**How to apply:** Resolve the current mapping server-side for every newly received, retained, recovered, replayed, and saved signal; only use its display value when the approved calculation is finite and the mapping is an engineering destination with a confirmed display unit. Long-lived browser mapping stores must reproduce that display only from explicit source-reported evidence, then strip every derived overlay before applying a replacement or cleared mapping. Store unmapped observations durably so Admin can map new signals without code. Use the transform for labeled UI/report display, while plant calibration remains the gate for derived energy and engineering KPI calculations.

A "validated"/"scaling confirmed" gate that a display component checks locally must read the *same* field names the mapping-overlay writer actually sets (e.g. `admin_mapping_scaling_status`/`admin_mapping_validation_status`), not an older/parallel set of flag names (`scaling_status`, `validation_status`, etc.). A silent name mismatch makes every correctly-approved admin mapping permanently fail the gate and keeps showing raw evidence forever, even after an admin fixes the underlying multiplier. When a panel shows "raw" for a signal you believe has an approved mapping, check the gate's field names against the overlay's actual output fields before assuming the mapping data itself is wrong.

Also do not trust an "approved" mapping's multiplier at face value: if the raw register value is wildly inconsistent across samples (order-of-magnitude swings) rather than stably-scaled, no linear transform fixes it — clear the mapping's `active` status instead of inventing a scale, and leave it as honest raw/unvalidated evidence pending a hardware/gateway-side fix.