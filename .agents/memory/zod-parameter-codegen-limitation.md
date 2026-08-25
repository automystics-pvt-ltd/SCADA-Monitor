---
name: Zod parameter codegen limitation
description: OpenAPI route parameters can create a duplicate exported name in the current Orval Zod output.
---

For this repository's current Orval/Zod generator configuration, a route with generated parameter types can emit a Zod validator and a TypeScript parameter type with the same exported name. The generated barrel then fails the library typecheck.

**Why:** The output writer regenerates its public index, so manually changing the generated barrel is not durable. This happened when an admin record-browsing endpoint combined a path parameter with pagination parameters.

**How to apply:** Before depending on a new parameterized route, run API codegen and the library typecheck. If this collision occurs, model the safe read request as a typed request body (for example a POST-based browse action) rather than patching generated files.