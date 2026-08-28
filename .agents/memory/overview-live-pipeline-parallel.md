---
name: Overview saved-only vs. shared live pipeline (mqtt-scada-monitor)
description: How Dashboard/Overview was made saved-record-only without touching MonitorWorkspace's shared live-preferring variables, and a display-prop pitfall hit along the way.
---

## Parallel pipeline, not a shared-variable edit
In `artifacts/mqtt-scada-monitor/src/App.tsx`, the Overview/Dashboard section and the `MonitorWorkspace` tabs (Inverters/Live Data/Energy/Environment/Alarms/Raw Data/Saved Data/Performance) read from the *same* root-level variables (`inverterDisplayDevices`, `calculations`, `validatedInverterFleet`, `dashboardEvidenceRows`, `dashboardFlowReading`, etc.). When only the Dashboard needed to become saved-record-only, editing those shared variables in place would have changed behavior on every tab that also reads them.

**Why:** the file has no per-tab data boundary — it's one large component tree over one shared derived-state graph — so "fix Dashboard" and "don't touch other tabs" are in tension unless the two consumers are given separate derived state.

**How to apply:** when a change must affect only one consumer of a shared computed value in this file, add parallel, equivalently-named variables scoped to that consumer (e.g. an `overview*` prefix) rather than editing the shared one. Confirm nothing else reads the new variables, and confirm the shared variables are untouched (diff-review, not just compile success) before considering the change isolated.

## Latest-record cards and historical trends need separate evidence lanes
Dashboard KPI/comparison cards may remain strictly bound to the latest confirmed saved snapshot, but a trend chart cannot use that same one-snapshot collection as its complete series. Give trends a parallel recent-saved-history lane and merge the newest saved snapshot into it for immediate refresh; do not broaden the KPI/card evidence lane.

**Why:** reusing a latest-snapshot-only array for a trend makes every refresh look like a permanent one-point or empty state, even though the persisted history endpoint already contains valid records.

**How to apply:** keep latest-record summaries on saved-snapshot rows, build trend rows from recent persisted history plus the latest snapshot with receipt-aware deduplication, and render a visible point when only one eligible sample exists.

## Passing timestamps to display components
A component that formats its own timestamp prop internally (e.g. calls `new Date(observedAt)` itself, like `DashboardPowerFlow`) must receive a raw parseable value (ISO string / epoch), never an already human-formatted label string (e.g. "26 Aug, 15:13"). Passing a pretty label into such a prop can silently parse into a wrong/garbage date (observed: a real label parsed to year 2001) instead of erroring, because `new Date(arbitrary string)` rarely throws.

**Why:** this class of bug passes type-checking and unit tests (both deal in strings) and only shows up as a visibly wrong date in the running UI — caught here only via an actual screenshot review, not tsc or the existing test suite.

**How to apply:** when threading a "last saved" timestamp through several derived variables to a leaf display component, keep the raw timestamp and the pretty label as two distinct values throughout, and grep the leaf component's prop usage (does it call `new Date(...)` on the prop, or does it just render the string?) before deciding which one to pass.
