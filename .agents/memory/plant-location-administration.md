---
name: Plant location administration
description: Production authorization and persistence expectations for plant coordinate settings.
---

Plant latitude/longitude settings are maintained by designated administrators globally, not by per-site operator assignments. A saved coordinate belongs to its site record and is reused whenever that site is selected.

**Why:** The production model must be generic across discovered sites while preventing ordinary authenticated users from overwriting the location master.

**How to apply:** Keep location writes fail-closed unless the signed-in identity is in the administrator configuration. Preserve the central site-keyed location master as the source for weather and any other site context; do not substitute browser, IP, or device location.