---
name: SCADA session boundary
description: User experience required when Platform Admin and SCADA sessions are intentionally separate.
---

Platform Admin authentication and SCADA operator authentication use separate sessions. A site grant created by a Platform Administrator can belong to the same underlying user, while the SCADA browser remains unauthenticated.

**Why:** The portal must preserve the administrative-session boundary, but presenting an empty access list as a missing assignment masks a valid grant and prevents the user from recovering.

**How to apply:** Before rendering an assignment-denied state in SCADA, establish normal SCADA session status. For an unauthenticated browser, show a direct normal SCADA sign-in route and explain that it should use the account holding the grant. Only show “No SCADA site assigned” after an authenticated user has no active assignment.