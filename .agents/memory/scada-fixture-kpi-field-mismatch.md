---
name: SCADA QA fixture vs Dashboard KPI field mismatch
description: Why the mqtt-scada-monitor QA fixture's saved parameters don't populate the Dashboard Overview's numeric KPI/inverter cards.
---

The QA e2e fixture's saved parameters carry enough shape for the "Saved
Parameter Analytics" screens, but not for the Dashboard Overview's stricter
KPI-card pipeline, which requires an explicit reported/engineering value
(not just a generic value field), an unambiguous inverter-identity tag, and
-- for the fully "verified" AC Power/Energy/Yield cards -- an approved plant
calibration profile that the fixture's site never has.

**Why:** these gates are intentional (see the electrical-telemetry-validation
principle: never show engineering values without explicit validation), so
don't loosen app logic to make the fixture "work" -- extend the fixture's
data shape instead if a test needs real numeric KPI values.

**How to apply:** when writing Dashboard Overview e2e assertions against the
QA fixture, prefer signals independent of these gates (e.g. a saved-record
status label or banner) rather than the numeric AC Power/Energy/Yield/
Inverter-count cards, which stay "Not reported" for this fixture regardless
of live vs. saved wiring.
