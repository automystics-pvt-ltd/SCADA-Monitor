---
name: Ubuntu deployment safety
description: Safety boundaries for routine Ubuntu Docker Compose deployments of this application.
---

Routine Ubuntu deployments must update Git with fast-forward-only behavior and must not discard local server changes. Rebuild and restart the Docker Compose services, but do not apply database schema changes automatically or use a forced schema push as part of deployment. Keep production `.env` files untracked and ignored.

**Why:** A deployment should not silently overwrite server state or make irreversible production database changes. The supplied example's hard reset and forced schema push belonged to another application and are unsafe defaults here.

**How to apply:** Follow these boundaries when changing the Ubuntu deploy script or its runbook. Apply reviewed database changes separately before shipping code that depends on them.