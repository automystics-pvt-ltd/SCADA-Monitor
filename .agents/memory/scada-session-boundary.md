---
name: SCADA session boundary
description: User experience required when Platform Admin and SCADA sessions are intentionally separate.
---

Platform Admin authentication and SCADA operator authentication use separate sessions. A site grant created by a Platform Administrator can belong to the same underlying user, while the SCADA browser remains unauthenticated. SCADA operators authenticate with a Platform-Admin-provisioned username and password; the password is salted/hashed and never returned to the UI.

**Why:** Administrative privileges must not leak into an operational browser session, and a shared OIDC session makes it too easy to conflate the two. Credentials can be reset or an account disabled without exposing passwords; those actions invalidate SCADA sessions immediately.

**How to apply:** Before rendering an assignment-denied state in SCADA, establish normal SCADA session status. For an unauthenticated browser, show the local username/password form and explain that it uses the account holding the grant. Only show “No SCADA site assigned” after an authenticated user has no active assignment. Keep Platform Admin authentication separate; never reuse its cookie or add a universal password/OTP bypass.