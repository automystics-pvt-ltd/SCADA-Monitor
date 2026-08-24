---
name: Lazy module boundaries
description: Keep lazily loaded monitor components independent of the application entry module.
---

Lazy-loaded components must not import runtime helpers, values, or components from the App entry module that dynamically imports them. Place their small shared utilities in a neutral module or make the lazy component self-contained.

**Why:** A runtime cycle between the App entry and a dynamic import can render in a production build but break Vite Fast Refresh and produce repeated HMR connection errors during development.

**How to apply:** Before adding a lazy boundary, inspect its runtime imports. Type-only imports are safe when erased; runtime dependencies must point to a separate shared module, never back to the entry module.