import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express, { type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  mqttInverterEnergyHistoryTable,
  mqttInverterMeasurementHistoryTable,
  mqttSnapshotsTable,
  platformOrganizationsTable,
  platformSiteAccessTable,
  platformSitesTable,
  platformTelemetryMappingsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../lib/logger.ts";
import mqttRouter from "./mqtt.ts";

// This suite exists to catch exactly the risk task #85 was created for: the
// "complete" export path and the paged preview path must return the identical
// filtered evidence set (same rows, same values, same quality), never a
// second independently-computed approximation of it.

const fixtureId = randomUUID();
const siteName = `export-parity-${fixtureId}`;
// The /mqtt/reports route always queries the live-configured subscription
// topic (not an arbitrary per-request value), so fixture evidence must be
// written under that same topic or the route will see zero rows regardless
// of site/date filters.
const topic = process.env.MQTT_TOPIC ?? "trn246/modbus";
const principal = {
  id: `export-parity-user-${fixtureId}`,
  email: `export-parity-${fixtureId}@example.com`,
  firstName: "Parity",
  lastName: "Tester",
  profileImageUrl: null,
};

let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;
let accessGrantId = "";
let mappingId = "";
let measurementIds: number[] = [];
let energyIds: number[] = [];
let snapshotIds: number[] = [];

function testApp() {
  const app = express();
  app.use((req, _res, next) => {
    const authenticated = req.get("x-scada-test-principal") === "operator";
    const testRequest = req as Request & {
      user?: typeof principal;
      scadaUser?: typeof principal;
      isAuthenticated(): boolean;
      isScadaAuthenticated(): boolean;
    };
    testRequest.isAuthenticated = (() => authenticated) as Request["isAuthenticated"];
    testRequest.isScadaAuthenticated = (() => authenticated) as Request["isScadaAuthenticated"];
    if (authenticated) {
      testRequest.user = principal;
      testRequest.scadaUser = principal;
    }
    testRequest.log = logger as unknown as typeof req.log;
    next();
  });
  app.use("/api", mqttRouter);
  return app;
}

async function fetchReport(query: string) {
  const response = await fetch(`${baseUrl}/api/mqtt/reports?${query}`, {
    headers: { "x-scada-test-principal": "operator" },
  });
  if (response.status !== 200) assert.fail(`expected 200, got ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{
    records: Array<Record<string, unknown>>;
    pagination: { totalRecords: number; totalPages: number; complete: boolean };
    excludedEvidence: { count: number };
  }>;
}

/** Fetches every page of the non-complete preview and concatenates the records. */
async function fetchAllPreviewPages(baseQuery: string) {
  const pageSize = 500;
  const all: Array<Record<string, unknown>> = [];
  let page = 1;
  for (;;) {
    const body = await fetchReport(`${baseQuery}&page=${page}&pageSize=${pageSize}`);
    all.push(...body.records);
    if (page >= body.pagination.totalPages) return { records: all, totalRecords: body.pagination.totalRecords };
    page += 1;
  }
}

before(async () => {
  const [organization] = await db.insert(platformOrganizationsTable).values({
    name: `Export parity organization ${fixtureId}`,
    slug: `export-parity-${fixtureId}`,
  }).returning();
  await db.insert(usersTable).values(principal);
  await db.insert(platformSitesTable).values({ siteName, organizationId: organization.id, timezone: "UTC" });
  const [grant] = await db.insert(platformSiteAccessTable).values({
    userId: principal.id,
    siteName,
    role: "operator",
    status: "active",
  }).returning({ id: platformSiteAccessTable.id });
  accessGrantId = grant.id;

  const now = new Date();
  const observedAt = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

  // An active approved mapping for a measurement whose raw source sample never
  // self-validates. The preview and complete paths must both apply it (or both
  // skip it) — never disagree on whether/how this record appears.
  const [mapping] = await db.insert(platformTelemetryMappingsTable).values({
    siteName,
    deviceId: "inv-01",
    sourceIdentity: `${siteName}|export-parity-source|dccurrent|30401`,
    sourceName: "export-parity-source",
    normalizedName: "dccurrent",
    address: "30401",
    destination: "current",
    displayLabel: "DC Current (mapped)",
    category: "electrical",
    scalingMultiplier: 2,
    scalingOffset: 1,
    scalingStatus: "approved",
    status: "active",
    createdBy: principal.id,
    updatedBy: principal.id,
  }).returning({ id: platformTelemetryMappingsTable.id });
  mappingId = mapping.id;

  const measurements = await db.insert(mqttInverterMeasurementHistoryTable).values([
    {
      // Mapped, source-native "raw" — only becomes reportable through the admin mapping.
      topic, siteName, inverterId: "inv-01", inverterName: "Inverter 01", parameter: "dc_current",
      displayLabel: "DC current", measurementKind: "electrical", value: 10, rawValue: "10", unit: "raw units",
      address: "30401", sourceName: "export-parity-source", observedAt: observedAt(120), receivedAt: observedAt(119),
      scalingStatus: "raw", sourcePayload: "{}",
    },
    {
      // Explicitly validated at the source — no mapping needed, always reportable.
      topic, siteName, inverterId: "inv-01", inverterName: "Inverter 01", parameter: "ac_voltage",
      displayLabel: "AC voltage", measurementKind: "electrical", value: 415, rawValue: "415", unit: "V",
      address: "30501", sourceName: "export-parity-source", observedAt: observedAt(100), receivedAt: observedAt(99),
      scalingStatus: "validated", sourcePayload: "{}",
    },
    {
      // Raw with no mapping anywhere — must be excluded from both paths.
      topic, siteName, inverterId: "inv-02", inverterName: "Inverter 02", parameter: "unmapped_raw",
      displayLabel: "Unmapped raw", measurementKind: "other", value: 7, rawValue: "7", unit: "raw units",
      address: "30601", sourceName: "export-parity-source", observedAt: observedAt(90), receivedAt: observedAt(89),
      scalingStatus: "raw", sourcePayload: "{}",
    },
  ]).returning({ id: mqttInverterMeasurementHistoryTable.id });
  measurementIds = measurements.map((row) => row.id);

  const energyRows = await db.insert(mqttInverterEnergyHistoryTable).values([
    {
      topic, siteName, inverterId: "inv-01", inverterName: "Inverter 01", parameter: "daily_energy_kwh",
      value: 342.5, rawValue: "342.5", unit: "kWh", address: "30701", sourceName: "export-parity-source",
      observedAt: observedAt(80), receivedAt: observedAt(79), scalingStatus: "validated", sourcePayload: "{}",
    },
  ]).returning({ id: mqttInverterEnergyHistoryTable.id });
  energyIds = energyRows.map((row) => row.id);

  const capturedAt = observedAt(60);
  const [snapshot] = await db.insert(mqttSnapshotsTable).values({
    topic,
    windowStartedAt: observedAt(61),
    windowEndedAt: capturedAt,
    capturedAt,
    messageCount: 1,
    parameterCount: 2,
    data: {
      schemaVersion: 4,
      saveStatus: "saved",
      scheduledFor: capturedAt.toISOString(),
      latestDiscoveredParameters: [
        {
          site_name: siteName, inverter_id: "inv-01", inverter_name: "Inverter 01",
          name: "grid_frequency", server_name: "export-parity-source",
          full_addr: "30801", date_iso_8601: capturedAt.toISOString(),
          value: 50.02, engineering_unit: "Hz", scaling_status: "validated",
        },
        {
          site_name: siteName, inverter_id: "inv-01", inverter_name: "Inverter 01",
          name: "unvalidated_register", server_name: "export-parity-source",
          full_addr: "30901", date_iso_8601: capturedAt.toISOString(),
          value: 3, unit: "raw units",
        },
      ],
    },
  }).returning({ id: mqttSnapshotsTable.id });
  snapshotIds = [snapshot.id];

  server = testApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (measurementIds.length) await db.delete(mqttInverterMeasurementHistoryTable).where(inArray(mqttInverterMeasurementHistoryTable.id, measurementIds));
  if (energyIds.length) await db.delete(mqttInverterEnergyHistoryTable).where(inArray(mqttInverterEnergyHistoryTable.id, energyIds));
  if (snapshotIds.length) await db.delete(mqttSnapshotsTable).where(inArray(mqttSnapshotsTable.id, snapshotIds));
  if (mappingId) await db.delete(platformTelemetryMappingsTable).where(eq(platformTelemetryMappingsTable.id, mappingId));
  if (accessGrantId) await db.delete(platformSiteAccessTable).where(eq(platformSiteAccessTable.id, accessGrantId));
  await db.delete(platformSitesTable).where(eq(platformSitesTable.siteName, siteName));
  await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.slug, `export-parity-${fixtureId}`));
  await db.delete(usersTable).where(eq(usersTable.id, principal.id));
});

test("a complete saved-data export returns exactly the same rows, values, and quality as the full paged preview", async () => {
  const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();
  const baseQuery = `reportType=historical-saved&siteName=${encodeURIComponent(siteName)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const preview = await fetchAllPreviewPages(baseQuery);
  const complete = await fetchReport(`${baseQuery}&complete=true`);

  assert.equal(complete.pagination.complete, true);
  assert.equal(complete.records.length, complete.pagination.totalRecords, "complete export must not truncate its own reported total");
  assert.equal(preview.totalRecords, complete.pagination.totalRecords, "preview and complete totals must match for identical filters");
  assert.equal(preview.records.length, complete.records.length);

  // The mapped-but-source-raw dc_current sample must be included (via the
  // active mapping) with the mapped value/unit — identically in both paths.
  const mappedParameterName = "dc_current";
  const previewMapped = preview.records.find((record) => record.parameter === mappedParameterName);
  const completeMapped = complete.records.find((record) => record.parameter === mappedParameterName);
  assert.ok(previewMapped, "preview must include the admin-mapped measurement");
  assert.ok(completeMapped, "complete export must include the admin-mapped measurement");
  assert.equal(completeMapped!.value, 10 * 2 + 1, "complete export must apply the same scaling mapping as preview");
  assert.deepEqual(
    { value: previewMapped!.value, unit: previewMapped!.unit, quality: previewMapped!.quality, category: previewMapped!.category },
    { value: completeMapped!.value, unit: completeMapped!.unit, quality: completeMapped!.quality, category: completeMapped!.category },
  );

  // The unmapped raw measurement must be excluded from both.
  assert.equal(preview.records.some((record) => record.parameter === "unmapped_raw"), false);
  assert.equal(complete.records.some((record) => record.parameter === "unmapped_raw"), false);

  // Row-for-row parity across every id (value/unit/category/quality/status).
  const byId = new Map(preview.records.map((record) => [record.id, record]));
  assert.equal(byId.size, preview.records.length, "preview ids must be unique across pages");
  for (const completeRecord of complete.records) {
    const previewRecord = byId.get(completeRecord.id);
    assert.ok(previewRecord, `preview must include record ${String(completeRecord.id)} that complete export returned`);
    assert.deepEqual(
      { value: completeRecord.value, unit: completeRecord.unit, quality: completeRecord.quality, category: completeRecord.category, status: completeRecord.status },
      { value: previewRecord!.value, unit: previewRecord!.unit, quality: previewRecord!.quality, category: previewRecord!.category, status: previewRecord!.status },
      `record ${String(completeRecord.id)} must match between preview and complete export`,
    );
  }

  assert.equal(preview.records.length > 0, true, "fixture must actually produce reportable evidence");
});

test("a wide-range, unfiltered complete export completes without truncation for a larger evidence set", async () => {
  const wideBatchSize = 1500;
  const anchor = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  const bulk = Array.from({ length: wideBatchSize }, (_, index) => {
    const observedAt = new Date(anchor.getTime() + index * 60_000);
    return {
      topic, siteName, inverterId: "inv-03", inverterName: "Inverter 03", parameter: `bulk_signal_${index % 5}`,
      displayLabel: `Bulk signal ${index % 5}`, measurementKind: "electrical", value: index, rawValue: String(index),
      unit: "V", address: `4${String(index).padStart(4, "0")}`, sourceName: "export-parity-bulk-source",
      observedAt, receivedAt: observedAt, scalingStatus: "validated", sourcePayload: "{}",
    };
  });
  const inserted = await db.insert(mqttInverterMeasurementHistoryTable).values(bulk).returning({ id: mqttInverterMeasurementHistoryTable.id });
  measurementIds.push(...inserted.map((row) => row.id));

  const from = new Date(anchor.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();
  const query = `reportType=historical-saved&siteName=${encodeURIComponent(siteName)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&complete=true`;

  const startedAt = Date.now();
  const complete = await fetchReport(query);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 20_000, `complete export of ${wideBatchSize}+ rows must not time out (took ${elapsedMs}ms)`);
  assert.equal(complete.records.length, complete.pagination.totalRecords, "complete export must return every matching row, not a truncated page");
  assert.ok(complete.pagination.totalRecords >= wideBatchSize, "complete export must include the full bulk evidence set");
});
