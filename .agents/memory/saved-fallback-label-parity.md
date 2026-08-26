---
name: Saved fallback label parity
description: Decision that saved-record fallback labels (no verified calculation) must distinguish "raw evidence present but unmapped" from "no evidence at all", not describe both the same way.
---

Any panel that shows a saved/last-known reading when no verified calculation exists must give a different label for "saved record has unmapped raw evidence" vs. "saved record has no evidence at all" vs. "no saved record exists". Collapsing these into one label (e.g. always saying "raw power evidence" present) misleads operators into thinking evidence exists when it doesn't.

**Why:** the mqtt-scada-monitor Dashboard and Overview panels independently built the same "unverified saved AC-power" fallback, and only Overview made this distinction; the Dashboard's saved path used one fixed label regardless of whether raw evidence was actually present. Decided to fix rather than document as intentional, since accurate raw-evidence labeling is a hard project requirement (never imply telemetry that isn't there).

**How to apply:** reuse `buildUnverifiedSavedAcPowerFlowReading` in `artifacts/mqtt-scada-monitor/src/flow-reading.ts` for any new saved-record AC-power (or similarly-shaped) fallback UI instead of writing a new ad hoc label; it takes `hasSavedRecord` and `hasRawEvidence` flags and returns the three-way label/status/provenance split.
