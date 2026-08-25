---
name: Telemetry mapping inverter attribution
description: The source-to-inverter rule for Admin-owned active-power mappings.
---

An Admin-owned active-power mapping must carry a managed inverter identity (`inv1` through `inv5`). The mapping form and API must enforce this together; only then may the SCADA overlay use that identity for the raw inverter contribution path.

**Why:** A generic active-power source without a physical inverter identity cannot be safely assigned to a fleet member. The mapping would otherwise appear configured but never reach the intended inverter-level dashboard behavior.

**How to apply:** Require identity selection for both identity-register and active-power destinations. Keep the verified engineering/KPI path independently gated by calibration approval; this mapping is source routing, not scaling validation.