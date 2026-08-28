---
name: Source-exported workspace typechecks
description: Why source-exported workspace packages should not also be API-server project references.
---

API-server typechecks should resolve workspace packages through their source-based package export maps, without TypeScript project references to those same packages.

**Why:** project-reference redirection makes a standalone consumer check read ignored generated declarations. Missing or stale declaration output can then hide valid source exports or make a clean checkout fail before the consumer is checked.

**How to apply:** when adding a source-exported workspace dependency to API-server, import it through its package name and do not add it to API-server's `references`. Keep library projects in the root solution build for declaration validation.