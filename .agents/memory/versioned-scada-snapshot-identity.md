---
name: Versioned SCADA snapshot identity
description: How scheduled MQTT snapshots coexist safely with legacy persistence rows.
---

Only the versioned scheduled-snapshot format participates in the `(topic, window end)` unique identity. New snapshot writes must use the matching partial conflict predicate, and dashboard latest-snapshot reads must select the versioned format.

The 15-minute schedule includes both the 06:00 opening boundary and the 18:00 closing boundary in plant time. Flush an in-memory completed interval before reconciling missing boundaries, and advance dashboard KPI evidence only on a successfully saved snapshot.

**Why:** Earlier persistence used misaligned 10-minute windows. A full unique key would make those legacy rows block correct 15-minute records that end at the same instant, while deleting them would unnecessarily discard traceable historical evidence. A restart can create explicit missing-window evidence; that must not conflict with a real buffered interval or clear the operator’s last trustworthy KPI record.

**How to apply:** When evolving scheduled snapshot storage, give every new schema version its own partial unique index and make its `ON CONFLICT` target use that exact predicate; do not repurpose an older version's index. Treat old-format rows as historical evidence only, never as the source for current saved KPI cards. Keep missing/incomplete windows visible as schedule status, while retaining the newest successfully saved evidence in KPI cards.

Before attempting the database write, stage every completed snapshot in a server-only durable retry spool. Drain the spool in scheduled-time order and remove an item only after the backend confirms its idempotent record.

**Why:** An in-memory retry list is lost when the API restarts during a transient database or connectivity failure. Retrying newer windows before older ones also makes operational history harder to audit.

**How to apply:** Keep the retry spool private to the API process, permission-restricted, and free of browser access. It may preserve genuine source evidence and honest missing/incomplete window status, but only a backend-confirmed `saved` snapshot can be shown as Saved Data or used as a short-lived operational fallback.