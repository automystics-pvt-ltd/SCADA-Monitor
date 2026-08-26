---
name: API server stale build after code edits
description: Why the api-server workflow can silently keep serving pre-edit behavior until explicitly restarted.
---

The `api-server` artifact's dev workflow runs a build step and then starts the compiled `dist/index.mjs` — it is not a hot-reloading dev server. Editing `artifacts/api-server/src/**` has zero effect on the running process until the workflow is restarted (which reruns the build).

**Why:** a curl/browser check against the live server right after an edit can pass or fail based on months-old compiled output, not the code you just wrote — e.g. a brand-new response field can come back consistently empty/missing even though the DB and source code are both correct, because the server never rebuilt.

**How to apply:** after any `artifacts/api-server/src` change, restart the `artifacts/api-server: API Server` workflow before trusting live verification (curl, screenshots, e2e tests) of backend behavior. If a live response looks stale/wrong in a way the source code doesn't explain, check `dist/index.mjs`'s mtime against the source files before debugging application logic.
