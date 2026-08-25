---
name: Proxied visual test routing
description: Replit artifact proxy behavior that affects client routing and authenticated visual tests.
---

Treat the browser pathname as the client router base in Replit's path-proxied development preview; do not assume Vite's development `BASE_URL` includes the artifact segment. Hide the Replit development banner inside visual tests before interacting with fixed header controls or creating baselines.

**Why:** The proxy serves an artifact under a path segment while Vite can report `/` as its base. The preview banner can also sit above responsive header controls, causing false interaction failures and contaminating screenshots.

**How to apply:** Exercise the proxied artifact URL in browser tests, derive the router base from the current browser path when needed, and remove only the preview overlay in the test context—not in application code.