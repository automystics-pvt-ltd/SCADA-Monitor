---
name: Post-merge pnpm catalogs
description: Why post-merge dependency setup must reconcile pnpm catalogs without frozen-lockfile enforcement.
---

The workspace post-merge install must use pnpm's explicit non-frozen lockfile reconciliation mode when catalog configuration can change across merged artifacts.

**Why:** pnpm's frozen install validates the lockfile's catalogs configuration against the current workspace manifests and exits before dependency setup when those values differ, even when the required package entries are already present.

**How to apply:** Keep the post-merge install non-interactive and run `pnpm install --no-frozen-lockfile --reporter append-only` before migrations or schema reconciliation.