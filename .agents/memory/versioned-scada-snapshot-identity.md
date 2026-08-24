---
name: Versioned SCADA snapshot identity
description: How scheduled MQTT snapshots coexist safely with legacy persistence rows.
---

Only the versioned scheduled-snapshot format participates in the `(topic, window end)` unique identity. New snapshot writes must use the matching partial conflict predicate, and dashboard latest-snapshot reads must select the versioned format.

The 15-minute schedule includes both the 06:00 opening boundary and the 18:00 closing boundary in plant time. Flush an in-memory completed interval before reconciling missing boundaries, and advance dashboard KPI evidence only on a successfully saved snapshot.

**Why:** Earlier persistence used misaligned 10-minute windows. A full unique key would make those legacy rows block correct 15-minute records that end at the same instant, while deleting them would unnecessarily discard traceable historical evidence. A restart can create explicit missing-window evidence; that must not conflict with a real buffered interval or clear the operator’s last trustworthy KPI record.

**How to apply:** When evolving scheduled snapshot storage, preserve the schema-version predicate in the database index and `ON CONFLICT` target. Treat old-format rows as historical evidence only, never as the source for current saved KPI cards. Keep missing/incomplete windows visible as schedule status, while retaining the newest successfully saved evidence in KPI cards.