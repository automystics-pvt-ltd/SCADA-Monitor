---
name: Fault guidance provenance
description: Safety rules for displaying inverter alarm and fault-code interpretations.
---

Fault-code explanations must be clearly scoped to their evidence: use a source-reported cause when available, label a known code mapping as a reference that needs manufacturer-manual verification, and never invent an explanation for an unknown code.

**Why:** Inverter fault numbers are vendor- and model-specific. Presenting a generic lookup as certain can lead an operator to take the wrong corrective action.

**How to apply:** Keep the raw code, source, timestamp, and unmodified evidence visible. Unknown or absent codes should state that no approved mapping is available and offer conservative inspect/verify/escalate steps only. Do not provide automatic acknowledge, reset, or clear controls.