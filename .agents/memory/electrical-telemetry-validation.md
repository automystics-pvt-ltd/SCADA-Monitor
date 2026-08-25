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

Reviewed counter roles are semantic evidence and should take precedence over vendor parameter spelling when selecting raw daily or cumulative energy evidence. Preserve a declared source unit alongside the raw counter, but do not relabel the number as an engineering KPI until the plant approves its scale.

**Why:** Vendor labels such as `todayyield` can be daily energy counters without containing the expected `dailyenergy` text. Name-only selection can hide real live evidence, while displaying its MWh label as a validated value can imply an unapproved decimal scale.

**How to apply:** Select raw daily and total-energy fallbacks using the reviewed `daily-counter` or `cumulative-counter` role as well as known names. Show the source unit in the evidence detail with `scaling required`; only an approved plant calibration profile may produce the final engineering KPI.

When a row is explicitly source-reported, use its reported/customer value and reported unit for the current evidence display; retain its transport raw register value separately and keep it unverified until scaling is approved.

**Why:** The transport payload can be an encoded register string while the device also provides the current customer-facing value and source unit. Displaying the transport value as the live KPI hides the actual source reading.

**How to apply:** Prefer `reported_value`/`customer_value` and their declared unit only for source-reported evidence. If a row is explicitly marked raw, ignore any convenience reported-value field and continue to show the raw register evidence.

The same evidence precedence applies after persistence, not just to live cards: saved snapshots, historical report rows, charts, and exports must carry reported value/unit, transport raw, and source identity as distinct fields.

**Why:** A row that is accurately presented live can become misleading when a later snapshot or report reconstructs it from transport data alone, or promotes a convenience reported value despite an explicit raw mapping.

**How to apply:** Store the evidence components with archived records. On every projection, check the explicit raw mapping before validation or reported-value branches; raw mapping wins and cannot be promoted by a retained convenience field.

An approved plant calibration profile may be role-specific. Installed DC capacity is optional unless calculating Specific Yield, so a confirmed Total Energy mapping can be verified without approving unrelated power, daily-energy, or capacity metadata.

**Why:** Requiring a complete plant profile to approve one well-evidenced counter either hides valid energy evidence or pressures operators to fabricate unknown capacity values.

**How to apply:** Permit partial profiles with one or more verified source mappings. Verify only the roles present; keep absent roles unavailable. Calculate Specific Yield only when both its approved daily counter and an approved positive installed DC capacity are present.