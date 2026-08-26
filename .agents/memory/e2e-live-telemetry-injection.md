---
name: Injecting synthetic live telemetry in browser e2e tests
description: How to make an e2e test prove a UI genuinely prefers live vs. saved data, without touching the broker or shared database.
---

To prove a dashboard's "saved-only" (or "live-preferring") pipeline is real
rather than coincidentally always empty, inject one synthetic message
straight into the browser's live-data connection (e.g. an SSE `EventSource`)
via a Playwright `page.addInitScript` that wraps the native constructor and
dispatches a fabricated `message` event a moment after connection. This
exercises the exact client-side parsing/state code a genuine broker delivery
would, with a value distinctive enough to grep for, and never touches the
real broker or any shared durable event ledger.

**Why:** asserting "the saved label is shown" or "a saved snapshot exists"
only proves a saved record is present -- it does not prove live data was
excluded, so a regression that silently switches the pipeline back to live
would still pass. Directly hand-crafting a durable backend event to fake
"live" telemetry instead risks racing/corrupting real delivery-sequence
coordination shared with genuine broker traffic.

**How to apply:** pick a distinctive numeric value for a recognized signal;
inject it before navigation; then assert it appears on a live-preferring
screen (to confirm the injection worked) but never inside the specific
containers a saved-only surface guards. Scope "must not appear" checks to
those specific containers, not the whole page -- unrelated always-live
raw/debug inspectors elsewhere on the same page will legitimately show the
value and are not part of the guarantee under test. If the UI has a
freshness window for live data, assert the live-preferring behavior early,
before that window can lapse.
