---
name: Extracting shared live/saved shaping logic
description: How to safely deduplicate parallel live-vs-saved shaping code (e.g. Dashboard/Overview) without changing behavior.
---

## Extract only true duplication; document the rest
When a live-preferring pipeline and a saved-only pipeline both shape the same kind of evidence (device rows, KPI cards, flow readings), some branches are byte-identical and some only *look* similar but encode a genuine, possibly historical, behavioral difference (e.g. one path checks raw-fallback nullness for its label text and the other doesn't). Extract a pure, parameterized helper only for the identical branches; leave genuinely divergent branches untouched and call out the difference in a comment or follow-up rather than force-merging them.

**Why:** force-merging a branch that looks like duplication but isn't silently changes user-visible behavior in whichever pipeline didn't originally have that logic — the opposite of the point of a dedup refactor.

**How to apply:** parameterize the extracted helper with a small context object (e.g. `{ live, saved, savedSnapshotTime }` or a `reportingState` classifier callback) so both call sites pass in only what actually differs.

## Centralize the JSON-value type before extracting row-shaped data
A component-local `type JsonValue = ... | { [key: string]: JsonValue }` (and any `Record<string, JsonValue>` alias built on it) must move to its own tiny shared module before other extracted helpers pass row objects around — otherwise a new module's `Record<string, unknown>` row type silently fails to satisfy the original component's stricter `Record<string, JsonValue>` field type when the two are structurally compared.

**Why:** `unknown` is broader than `JsonValue`, so `Record<string, unknown>` is not assignable to `Record<string, JsonValue>` even though both "look like a generic row bag" — this only surfaces as a `tsc` error at the array-assignment call site, not at the helper's own definition.
