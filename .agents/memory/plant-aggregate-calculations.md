---
name: Plant aggregate calculations
description: Safety and precedence rules for plant Total AC Power and Total Energy KPIs.
---

For Total AC Power, prefer one newest source reading per inverter and sum those readings after rejecting an isolated median-based extreme outlier. If inverter readings are unavailable, fall back to the main active-power meter. Use the three-phase formula only when line voltage, current, and power factor each have explicit engineering-scaling validation.

For Total Energy, sum per-inverter cumulative energy counters when present; otherwise show the plant totalizing meter counter. Do not derive energy by integrating raw or unscaled power samples.

**Why:** An individual communication-fault register can overwhelm a summation, while raw electrical values cannot safely support an engineering calculation or time integration.

**How to apply:** Preserve raw/scaling-required labels and method provenance until a source confirms engineering scaling. Any new aggregate source must retain source identities and use only its newest observation.