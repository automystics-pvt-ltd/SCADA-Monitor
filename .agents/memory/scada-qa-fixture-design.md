---
name: SCADA QA fixture design
description: How to design a durable, least-privilege SCADA test operator + saved-evidence fixture that authenticated screens and analytics sections can actually exercise.
---

## Least-privilege, isolated scope
A durable test operator account must be scoped to a dedicated fixture organization/site, never a real managed site, and must use the least role that satisfies the screens under test. Every provisioning run should revoke any of that user's access outside the fixture scope, so privilege can never silently accumulate across reruns. Never commit a literal default password — require a caller-supplied or generated one, and refuse to run in production.

**Why:** a test account with broad real-site access and a hardcoded password is a genuine access-control hole, not just a test-hygiene nit.

## Fixture data must target the runtime's actual effective configuration, not a fixed default
When a fixture writes data that a live consumer/query will later look up by some routing or scoping key (a topic, channel, tenant, region, etc.), it must resolve that key the same way the live system resolves it at runtime — including any admin-configurable override that takes precedence over an environment variable or hardcoded default. Recompute this resolution at provisioning time rather than baking in the default.

**Why:** a fixture that assumes the default routing key silently stops matching as soon as an operator changes that setting through the product's own configuration UI, since the fixture and the live consumer would then be looking at different keys.

## Saved-evidence timestamps must be real, not future-dated
Endpoints that serve *saved*/historical evidence for a UI section often compute their default time window from the server's real wall-clock time, independent of anything the browser does. A client-side fake clock only affects the browser's own `Date`/timers — it has no effect on such a server-computed window unless the client actually forwards a clock-derived time range to the server.

A separate, unrelated code path may also compare against the server's real time, but only to *label* a record's freshness rather than to decide which records a query returns. These two are easy to conflate when designing a fixture, since they can appear on the same screen.

**Why:** a future-dated fixture record can pass an unrelated freshness/staleness check while silently falling outside a server-time-windowed evidence query and returning zero rows — a fixture that "looks right" in one panel but produces no data in another.

**How to apply:** compute a saved-evidence fixture's window relative to real time at provisioning time, and recompute it on every run rather than seeding it once, since "real now minus a fixed offset" ages out of a rolling window over time. Identify and clean up prior fixture rows by an embedded marker field, not by a fixed timestamp, once the timestamp itself is dynamic.
