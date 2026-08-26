import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express, { type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  mqttSnapshotsTable,
  platformOrganizationsTable,
  platformSiteAccessTable,
  platformSitesTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../lib/logger.ts";
import mqttRouter from "./mqtt.ts";

const fixtureId = randomUUID();
const assignedSite = `isolation-assigned-${fixtureId}`;
const otherSite = `isolation-other-${fixtureId}`;
const principal = {
  id: `isolation-user-${fixtureId}`,
  email: `isolation-${fixtureId}@example.com`,
  firstName: "Isolation",
  lastName: "Tester",
  profileImageUrl: null,
};
const globalPrincipal = {
  id: `isolation-global-user-${fixtureId}`,
  email: `isolation-global-${fixtureId}@example.com`,
  firstName: "Global",
  lastName: "Tester",
  profileImageUrl: null,
};
const periodStart = "2026-08-01T00:00:00.000Z";
const periodEnd = "2026-08-02T00:00:00.000Z";
const validHistoryQuery = `from=${encodeURIComponent(periodStart)}&to=${encodeURIComponent(periodEnd)}`;
const validInverterQuery = `inverterId=INV-01&period=Day&anchor=2026-08-01`;
const validReportQuery = `reportType=operations&${validHistoryQuery}`;
const globalPolicy = process.env.SCADA_ALLOW_GLOBAL_ACCESS;

const namedEvidenceReads = [
  ["snapshots", `/mqtt/snapshots?siteName=${encodeURIComponent(otherSite)}`],
  ["latest snapshot", `/mqtt/snapshots/latest?siteName=${encodeURIComponent(otherSite)}`],
  ["electrical history", `/mqtt/electrical-history?siteName=${encodeURIComponent(otherSite)}&${validHistoryQuery}`],
  ["inverter energy history", `/mqtt/inverter-energy-history?siteName=${encodeURIComponent(otherSite)}&${validInverterQuery}`],
  ["inverter measurements", `/mqtt/inverter-measurements?siteName=${encodeURIComponent(otherSite)}&${validInverterQuery}`],
  ["device parameters", `/mqtt/device-parameters?siteName=${encodeURIComponent(otherSite)}&deviceId=INV-01`],
  ["report", `/mqtt/reports?siteName=${encodeURIComponent(otherSite)}&${validReportQuery}`],
  ["communication evidence", `/mqtt/communication-events?siteName=${encodeURIComponent(otherSite)}`],
  ["telemetry stream", `/mqtt/stream?siteName=${encodeURIComponent(otherSite)}`],
  ["snapshot gaps", `/mqtt/snapshot-gaps?siteName=${encodeURIComponent(otherSite)}`],
] as const;

const unscopedEvidenceReads = [
  ["snapshots", "/mqtt/snapshots"],
  ["latest snapshot", "/mqtt/snapshots/latest"],
  ["electrical history", `/mqtt/electrical-history?${validHistoryQuery}`],
  ["report", `/mqtt/reports?${validReportQuery}`],
  ["communication evidence", "/mqtt/communication-events"],
  ["telemetry stream", "/mqtt/stream"],
] as const;

let baseUrl = "";
let accessGrantId = "";
let snapshotIds: number[] = [];
let server: ReturnType<express.Express["listen"]>;

function testApp() {
  const app = express();
  app.use((req, _res, next) => {
    const sessionKind = req.get("x-scada-test-principal");
    const scadaAuthenticated = sessionKind === "assigned" || sessionKind === "global";
    const authenticated = scadaAuthenticated || sessionKind === "platform";
    const testRequest = req as Request & {
      user?: typeof principal;
      scadaUser?: typeof principal;
      isAuthenticated(): boolean;
      isScadaAuthenticated(): boolean;
    };
    testRequest.isAuthenticated = (() => authenticated) as Request["isAuthenticated"];
    testRequest.isScadaAuthenticated = (() => scadaAuthenticated) as Request["isScadaAuthenticated"];
    const currentPrincipal = sessionKind === "global" ? globalPrincipal : principal;
    if (authenticated) testRequest.user = currentPrincipal;
    if (scadaAuthenticated) testRequest.scadaUser = currentPrincipal;
    testRequest.log = logger as unknown as typeof req.log;
    next();
  });
  app.use("/api", mqttRouter);
  return app;
}

async function requestEvidence(path: string, authenticated = true) {
  return fetch(`${baseUrl}/api${path}`, {
    headers: authenticated ? { "x-scada-test-principal": "assigned" } : undefined,
  });
}

async function requestWithScadaPrincipal(path: string, principalType: "global" | "platform") {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "x-scada-test-principal": principalType },
  });
}

async function closeStream(response: Response) {
  await response.body?.cancel();
}

before(async () => {
  const [organization] = await db.insert(platformOrganizationsTable).values({
    name: `Isolation organization ${fixtureId}`,
    slug: `isolation-${fixtureId}`,
  }).returning();
  await db.insert(usersTable).values([principal, globalPrincipal]);
  await db.insert(platformSitesTable).values([
    { siteName: assignedSite, organizationId: organization.id, timezone: "UTC" },
    { siteName: otherSite, organizationId: organization.id, timezone: "UTC" },
  ]);
  const [grant] = await db.insert(platformSiteAccessTable).values({
    userId: principal.id,
    siteName: assignedSite,
    role: "viewer",
    status: "active",
  }).returning({ id: platformSiteAccessTable.id });
  accessGrantId = grant.id;

  const snapshotWindow = new Date("2099-01-01T00:00:00.000Z");
  const snapshots = await db.insert(mqttSnapshotsTable).values([
    {
      topic: `isolation-${fixtureId}-assigned`,
      windowStartedAt: snapshotWindow,
      windowEndedAt: new Date(snapshotWindow.getTime() + 60_000),
      capturedAt: new Date("2099-01-01T00:01:00.000Z"),
      messageCount: 1,
      parameterCount: 1,
      data: {
        schemaVersion: 4,
        messages: [{ payload: JSON.stringify({ site_name: assignedSite }) }],
        parameters: [{ site_name: assignedSite }],
      },
    },
    {
      topic: `isolation-${fixtureId}-other`,
      windowStartedAt: snapshotWindow,
      windowEndedAt: new Date(snapshotWindow.getTime() + 60_000),
      capturedAt: new Date("2099-01-01T00:02:00.000Z"),
      messageCount: 1,
      parameterCount: 1,
      data: {
        schemaVersion: 4,
        messages: [{ payload: JSON.stringify({ site_name: otherSite }) }],
        parameters: [{ site_name: otherSite }],
      },
    },
    {
      topic: process.env.MQTT_TOPIC ?? "trn246/modbus",
      windowStartedAt: new Date("2099-01-02T00:00:00.000Z"),
      windowEndedAt: new Date("2099-01-02T00:01:00.000Z"),
      capturedAt: new Date("2099-01-02T00:02:00.000Z"),
      messageCount: 1,
      parameterCount: 1,
      data: {
        schemaVersion: 4,
        latestParameters: [
          { site_name: otherSite, inverter_id: "legacy-isolation", name: "dc_voltage", data: 701 },
          { inverter_id: "legacy-isolation", name: "unscoped_value", data: 1 },
        ],
      },
    },
  ]).returning({ id: mqttSnapshotsTable.id });
  snapshotIds = snapshots.map((snapshot) => snapshot.id);

  server = testApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (snapshotIds.length) await db.delete(mqttSnapshotsTable).where(inArray(mqttSnapshotsTable.id, snapshotIds));
  if (accessGrantId) await db.delete(platformSiteAccessTable).where(eq(platformSiteAccessTable.id, accessGrantId));
  await db.delete(platformSitesTable).where(inArray(platformSitesTable.siteName, [assignedSite, otherSite]));
  await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.slug, `isolation-${fixtureId}`));
  await db.delete(usersTable).where(inArray(usersTable.id, [principal.id, globalPrincipal.id]));
  if (globalPolicy === undefined) delete process.env.SCADA_ALLOW_GLOBAL_ACCESS;
  else process.env.SCADA_ALLOW_GLOBAL_ACCESS = globalPolicy;
});

for (const role of ["viewer", "operator", "site-admin"] as const) {
  test(`${role} receives 403 from every unassigned SCADA evidence route`, async () => {
    await db.update(platformSiteAccessTable).set({ role }).where(eq(platformSiteAccessTable.id, accessGrantId));
    for (const [label, path] of namedEvidenceReads) {
      const response = await requestEvidence(path);
      assert.equal(response.status, 403, `${label} must deny an unassigned site`);
      await closeStream(response);
    }
  });
}

test("the snapshots route returns only evidence from an assigned site and rejects an unscoped assigned-user request", async () => {
  const scoped = await requestEvidence(`/mqtt/snapshots?siteName=${encodeURIComponent(assignedSite)}`);
  assert.equal(scoped.status, 200);
  const body = await scoped.json() as { snapshots: Array<{ id: number }> };
  assert.ok(body.snapshots.some((snapshot) => snapshot.id === snapshotIds[0]), "assigned evidence must be returned");
  assert.equal(body.snapshots.some((snapshot) => snapshot.id === snapshotIds[1]), false, "other-site evidence must not be returned");

  const unscoped = await requestEvidence("/mqtt/snapshots");
  assert.equal(unscoped.status, 403, "assigned users must select a granted site before reading snapshots");
});

test("an assigned user cannot relabel another site's or unscoped legacy snapshot data as their own device parameters", async () => {
  const response = await requestEvidence(`/mqtt/device-parameters?siteName=${encodeURIComponent(assignedSite)}&deviceId=legacy-isolation`);
  assert.equal(response.status, 200);
  const body = await response.json() as { parameters: Array<{ deviceId: string }> };
  assert.equal(body.parameters.some((parameter) => parameter.deviceId === "legacy-isolation"), false);
});

test("electrical history preserves source-reported schema-v4 discovered snapshot evidence", async () => {
  const observedAt = "2026-08-01T00:15:00.000Z";
  const [snapshot] = await db.insert(mqttSnapshotsTable).values({
    topic: `isolation-electrical-${fixtureId}`,
    windowStartedAt: new Date("2026-08-01T00:00:00.000Z"),
    windowEndedAt: new Date("2026-08-01T00:15:00.000Z"),
    capturedAt: new Date(observedAt),
    messageCount: 1,
    parameterCount: 1,
    data: {
      schemaVersion: 4,
      saveStatus: "saved",
      scheduledFor: observedAt,
      latestDiscoveredParameters: [{
        observationId: `electrical-${fixtureId}`,
        signalKey: "active_power",
        siteName: assignedSite,
        deviceId: "inv-01",
        deviceName: "Inverter 01",
        topic: `isolation-electrical-${fixtureId}`,
        originalName: "active_power",
        normalizedName: "activepower",
        displayLabel: "Active Power",
        category: "Electrical",
        rawValue: "31393536383339343234",
        reportedValue: "195",
        reportedNumericValue: 195,
        value: 195,
        unit: null,
        sourceUnit: "kW",
        address: "305031",
        sourceName: "ana",
        sourceIdentity: `${assignedSite}|ana|activepower|305031`,
        sourceMappingStatus: "source-reported",
        observedAt,
        receivedAt: observedAt,
        provenance: "live",
        dataQuality: "source-reported",
        scalingStatus: "raw",
      }],
    },
  }).returning({ id: mqttSnapshotsTable.id });
  snapshotIds.push(snapshot.id);

  const response = await requestEvidence(`/mqtt/electrical-history?siteName=${encodeURIComponent(assignedSite)}&${validHistoryQuery}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { samples: Array<Record<string, unknown>> };
  const sample = body.samples.find((entry) => entry.source_identity === `${assignedSite}|ana|activepower|305031`);
  assert.deepEqual(sample && {
    name: sample.name,
    timestamp: sample.timestamp,
    reportedValue: sample.reportedValue,
    sourceUnit: sample.sourceUnit,
    rawData: sample.raw_data,
    sourceIdentity: sample.source_identity,
  }, {
    name: "active_power",
    timestamp: observedAt,
    reportedValue: "195",
    sourceUnit: "kW",
    rawData: "31393536383339343234",
    sourceIdentity: `${assignedSite}|ana|activepower|305031`,
  });
});

test("an archived site is removed from SCADA access and denied across every evidence route", async () => {
  await db.update(platformSitesTable).set({ status: "archived" }).where(eq(platformSitesTable.siteName, assignedSite));
  try {
    const access = await requestEvidence("/mqtt/site-access");
    assert.equal(access.status, 200);
    const body = await access.json() as { sites: string[]; activations: Record<string, string> };
    assert.equal(body.sites.includes(assignedSite), false);
    assert.equal(Object.hasOwn(body.activations, assignedSite), false);

    for (const [label, path] of namedEvidenceReads.map(([label, path]) => [label, path.replace(encodeURIComponent(otherSite), encodeURIComponent(assignedSite))] as const)) {
      const response = await requestEvidence(path);
      assert.equal(response.status, 403, `${label} must deny an archived site`);
      await closeStream(response);
    }
  } finally {
    await db.update(platformSitesTable).set({ status: "active" }).where(eq(platformSitesTable.siteName, assignedSite));
  }
});

test("the retired SCADA location write route cannot mutate central coordinates", async () => {
  const response = await fetch(`${baseUrl}/api/mqtt/site-locations/${encodeURIComponent(assignedSite)}`, {
    method: "PUT",
    headers: { "x-scada-test-principal": "assigned", "content-type": "application/json" },
    body: JSON.stringify({ latitude: 12.9716, longitude: 77.5946 }),
  });
  assert.equal(response.status, 404);
});

for (const globalEnabled of [false, true]) {
  test(`anonymous unscoped evidence reads are denied ${globalEnabled ? "even with" : "without"} global access`, async () => {
    if (globalEnabled) process.env.SCADA_ALLOW_GLOBAL_ACCESS = "true";
    else delete process.env.SCADA_ALLOW_GLOBAL_ACCESS;
    for (const [label, path] of unscopedEvidenceReads) {
      const response = await requestEvidence(path, false);
      assert.equal(response.status, 401, `${label} must require SCADA operator sign-in`);
      await closeStream(response);
    }
  });
}

test("global access can select any active managed site but cannot select an archived site", async () => {
  process.env.SCADA_ALLOW_GLOBAL_ACCESS = "true";
  const activeSite = await requestWithScadaPrincipal(`/mqtt/snapshots?siteName=${encodeURIComponent(otherSite)}`, "global");
  assert.equal(activeSite.status, 200);

  await db.update(platformSitesTable).set({ status: "archived" }).where(eq(platformSitesTable.siteName, otherSite));
  try {
    const archivedSite = await requestWithScadaPrincipal(`/mqtt/snapshots?siteName=${encodeURIComponent(otherSite)}`, "global");
    assert.equal(archivedSite.status, 403);
  } finally {
    await db.update(platformSitesTable).set({ status: "active" }).where(eq(platformSitesTable.siteName, otherSite));
  }
});

test("a Platform Admin identity without a SCADA session is denied every protected MQTT surface", async () => {
  const protectedPaths = [
    "/mqtt/status",
    "/mqtt/site-access",
    "/mqtt/site-locations",
    `/mqtt/telemetry-mappings?siteName=${encodeURIComponent(assignedSite)}`,
    `/mqtt/calibration-profile?siteName=${encodeURIComponent(assignedSite)}`,
    `/mqtt/calibration-preview?siteName=${encodeURIComponent(assignedSite)}`,
    ...namedEvidenceReads.map(([, path]) => path),
    ...unscopedEvidenceReads.map(([, path]) => path),
  ];
  for (const path of protectedPaths) {
    const response = await requestWithScadaPrincipal(path, "platform");
    assert.equal(response.status, 401, `${path} must not accept a Platform Admin identity as a SCADA session`);
    await closeStream(response);
  }
});