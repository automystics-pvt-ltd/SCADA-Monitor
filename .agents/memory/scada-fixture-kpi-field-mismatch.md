---
name: SCADA QA fixture vs Dashboard KPI field mismatch
description: Exact field/naming conventions a saved-snapshot fixture row needs to be recognized by the Dashboard Overview's numeric KPI/inverter pipeline.
---

The "Saved Parameter Analytics" screens only need a generic `value` field, but
the Dashboard Overview's stricter KPI-card pipeline (telemetry-kpis.ts /
verified-kpis.ts) reads different fields entirely. A fixture row must carry
**all** of the following to actually drive a numeric KPI/inverter card,
not just "Saved Parameter Analytics":

- `data` (transport raw value) — `asRawMetric`/`numericValue` and
  verified-kpis' `numeric()` both read `row.data` (or an explicit
  `reported_value`/`customer_value`/`engineering_value`), never the
  generic `value` field.
- `date_iso_8601` (or `timestamp`/`date`) with a real parseable
  timestamp — verified-kpis' `observedMs()` returns `0` without it, and a
  falsy `0` timestamp is treated as "no reading" and silently skipped by
  `profileSourcesForRole`, even when everything else matches a calibration
  profile.
- For a per-inverter power tag to be recognized by `isInverterSourceSignal`:
  name must match `inv<N>ActivePower`/`acPower`/`Power` **exactly**
  (normalized, case/punctuation-insensitive) — any extra suffix (e.g. a
  "Fixture" tag suffix) breaks the regex — plus an explicit
  `inverter_id`/`inverterId` field (not just `deviceId`/`device_id`) for
  `declaredInverterIdentity`.
- For `rawInverterIdentitySignals` (Inverter Inventory card): a **separate**
  row with `measurement_type`/`measurementType` normalizing to
  `"inverter-identity"` plus the same `inverter_id`. Never reuse the active
  power row for this — identity-tagged rows are explicitly excluded from
  power summation, and power rows are excluded from identity signals.
- For the fully "verified" AC Power/Energy/Yield cards: an embedded
  `calibrationProfile` object in the snapshot's `data` (siteName, version,
  status: "approved", numeric `installedDcCapacityKwp`, `sources[]` with
  role/sourceName/parameter/address/unit/multiplier/counterRole/
  `scalingConfirmed: true` matching real fixture rows exactly via
  `profileSourceMatches` — normalized sourceName from `server_name`, name
  from `name`, address from `full_addr`).

**Why:** these gates are intentional (see the electrical-telemetry-validation
principle: never show engineering values without explicit validation) — the
fix is to give the fixture a fully compliant shape, never to loosen the app's
validation logic.

**How to apply:** when a saved-evidence e2e fixture needs to drive real
numeric KPI/inverter cards (not just the raw parameter-analytics table),
audit it against every bullet above, then write e2e assertions against the
resulting card testids (`kpi-<title-slug>`) rather than working around the
gap. Also remember that dedicated identity-only rows count as "unvalidated
raw" in the Saved Parameter Analytics `section-raw` category (since they
have no scaled engineering value) even though they carry a device identity —
update any fixed section/record-count assertions when adding them.
