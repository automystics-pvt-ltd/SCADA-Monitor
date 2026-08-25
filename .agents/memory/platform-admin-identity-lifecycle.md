---
name: Platform admin identity lifecycle
description: Rules for matching Platform Admin OIDC sign-ins to managed user accounts without bypassing lifecycle controls.
---

Platform Admin OIDC sign-in must normalize the verified email, match an existing pre-provisioned user by that email before considering the OIDC subject, and preserve the managed account’s stable ID. A deleted or inactive account, or a disabled Platform Admin identity, must remain denied; a successful OIDC login must never silently reactivate either state.

**Why:** User provisioning and lifecycle controls are only meaningful if a subsequent identity-provider login cannot create a parallel account or restore deliberately revoked administrative access.

**How to apply:** Keep email normalization and pre-provisioned lookup in every Platform Admin identity handshake. New SCADA accounts start inactive and require an administrator to activate them after scope assignment.