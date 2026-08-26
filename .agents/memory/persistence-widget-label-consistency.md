---
name: Persistence status-strip label consistency
description: The Dashboard's overnight save-status strip has a forward-looking countdown widget next to a "Saving paused" widget; their headings must stay logically consistent.
---

`artifacts/mqtt-scada-monitor/src/dashboard-persistence.ts` intentionally keeps `persistenceNextSaveLabel`'s countdown value forward-looking even while `savingActive` is false (documented in `replit.md`: the save-scheduler strip is a live-sourced exception, not saved-record-frozen). That's correct — but pairing the countdown with a *static* "Next save in" heading while the adjacent widget says "Saving paused" reads as a contradiction to users ("if it's paused, why is there a next save?").

**Why:** A user flagged this exact juxtaposition ("Next save in 05:31:52" next to "Persistence: Saving paused") as illogical, even though the countdown's value was numerically correct (time until the 6:00 AM resume).

**How to apply:** Keep the countdown *value* logic (`persistenceNextSaveLabel`) untouched — it's a deliberate, tested design decision. Instead, swap only the *heading* text based on `savingActive`: `persistenceNextSaveHeading(savingActive)` returns `'Resumes in'` when `savingActive === false`, else `'Next save in'`. Any future edit to this status strip (or similar juxtaposed live-status widgets) should re-check that adjacent headings/values don't contradict each other, especially when one widget's value is intentionally forward-looking across a paused state.
