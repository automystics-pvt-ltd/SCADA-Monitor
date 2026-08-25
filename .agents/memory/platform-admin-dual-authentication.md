---
name: Platform Admin dual authentication
description: Rules for Google sign-in and Gmail SMTP OTP access to Platform Admin.
---

Platform Admin supports Google OIDC as the primary sign-in path and Gmail SMTP-delivered, one-time email codes as a fallback. Both paths must resolve only to active, pre-provisioned administrator emails and must create the existing separate Platform Admin session, never a SCADA operator session.

**Why:** A mailbox account alone must not grant administrative access, while OTP fallback protects access when a trusted Google session is unavailable.

**How to apply:** Keep Google email verification, the platform-admin allowlist, account status, and identity enabled state mandatory for both methods. OTPs must be short-lived, hashed at rest, rate-limited, limited in attempts, atomically consumed, and auditable without recording the code.