---
name: node --test can't resolve extensionless workspace TS imports
description: Why a package's `node --test src/*.test.ts` script can fail with ERR_MODULE_NOT_FOUND even though the same tests pass under tsx.
---

Node's native TypeScript stripping (`node --test src/*.test.ts` on modern Node) type-strips the test file itself, but its ESM resolver still requires literal, resolvable specifiers. A test file that imports a workspace package (e.g. `@workspace/api-client-react`) whose own source re-exports another file by an extensionless path (`export * from "./generated/api"`) fails with `ERR_MODULE_NOT_FOUND` under plain `node --test`, even though the same file runs fine as application code (bundled/compiled) or under `tsx`.

**Why:** `tsx`'s loader resolves extensionless/`.ts` specifiers across packages; Node's built-in loader does not, so the failure only shows up in the test runner, not in the app itself — easy to misdiagnose as a real code bug.

**How to apply:** for a package whose tests import other workspace TS packages, use `"test": "tsx --test src/*.test.ts"` (with `tsx` as a devDependency, `catalog:` version) instead of bare `node --test`. Reserve bare `node --test` for packages whose tests only import same-package relative files.
