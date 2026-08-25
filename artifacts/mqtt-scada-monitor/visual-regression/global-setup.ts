import { promisify } from "node:util";
import { scrypt as scryptCallback } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { db, pool } from "@workspace/db";
import {
  mqttSnapshotsTable,
  platformOrganizationsTable,
  platformSiteAccessTable,
  platformSitesTable,
  usersTable,
} from "@workspace/db/schema";

export const VISUAL_TEST_USERNAME = "scada-visual-regression";
export const VISUAL_TEST_PASSWORD = "VisualRegression!2026";
export const VISUAL_TEST_USER_ID = "scada-visual-regression-user";
export const VISUAL_TEST_ORGANIZATION_ID = "scada-visual-regression-organization";
export const VISUAL_TEST_SITE_NAME = "SCADA visual regression plant";
export const VISUAL_FIXTURE_MARKER = "scada-visual-regression-v1";

const scrypt = promisify(scryptCallback);

async function passwordHash(password: string) {
  const salt = "scada-visual-regression-salt";
  const derived = await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

function fixtureParameter(
  name: string,
  value: number,
  address: string,
  observedAt: string,
  options: { deviceId?: string; unit?: string; quality?: string } = {},
) {
  const deviceId = options.deviceId;
  const unit = options.unit ?? "kW";
  return {
    signalKey: `${deviceId ?? "plant"}-${name}-${address}`,
    siteName: VISUAL_TEST_SITE_NAME,
    deviceId,
    inverterId: deviceId,
    deviceName: deviceId ? `Inverter ${deviceId.replace("inv", "")}` : "Plant meter",
    sourceName: "fixture-modbus-gateway",
    server_name: "fixture-modbus-gateway",
    sourceIdentity: `${VISUAL_TEST_SITE_NAME}|fixture-modbus-gateway|${name}|${address}`,
    name,
    originalName: name,
    parameter: name,
    displayLabel: name.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()),
    address,
    full_addr: address,
    rawValue: String(value),
    raw_data: String(value),
    data: String(value),
    value,
    reportedValue: String(value),
    reported_value: String(value),
    reportedUnit: unit,
    reported_unit: unit,
    sourceUnit: unit,
    source_unit: unit,
    sourceMappingStatus: "source-reported",
    source_mapping_status: "source-reported",
    dataQuality: options.quality ?? "good",
    quality: options.quality ?? "good",
    observedAt,
    date_iso_8601: observedAt,
    timestamp: observedAt,
    receivedAt: observedAt,
    provenance: "live",
    ...(deviceId && name.toLowerCase().includes("activepower") ? { measurementType: "activePower", measurement_type: "activePower" } : {}),
  };
}

async function removePriorFixture() {
  const snapshots = await db.select({
    id: mqttSnapshotsTable.id,
    data: mqttSnapshotsTable.data,
  }).from(mqttSnapshotsTable);
  const snapshotIds = snapshots
    .filter((snapshot) => typeof snapshot.data === "object"
      && snapshot.data !== null
      && !Array.isArray(snapshot.data)
      && (snapshot.data as Record<string, unknown>).visualFixture === VISUAL_FIXTURE_MARKER)
    .map((snapshot) => snapshot.id);
  if (snapshotIds.length) await db.delete(mqttSnapshotsTable).where(inArray(mqttSnapshotsTable.id, snapshotIds));

  await db.delete(usersTable).where(eq(usersTable.id, VISUAL_TEST_USER_ID));
  await db.delete(platformSitesTable).where(eq(platformSitesTable.siteName, VISUAL_TEST_SITE_NAME));
  await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.id, VISUAL_TEST_ORGANIZATION_ID));
}

export default async function globalSetup() {
  await removePriorFixture();

  // This intentionally sits outside the plant's scheduled persistence windows:
  // it avoids colliding with real topic/window evidence while remaining the
  // newest site-scoped source-backed record selected by the regular API.
  const capturedAt = new Date("2099-01-01T00:00:00.000Z");
  const windowStartedAt = new Date("2098-12-31T23:45:00.000Z");
  const observedAt = "2098-12-31T23:59:45.000Z";
  const parameters = [
    ...[1, 2, 3, 4, 5].map((index) => fixtureParameter(`inv${index}ActivePower`, 94 + index * 7, `3050${30 + index}`, observedAt, { deviceId: `inv${index}` })),
    fixtureParameter("actpow", 575, "305101", observedAt),
    fixtureParameter("dailyEnergyKwh", 1842.6, "306001", observedAt, { deviceId: "inv1", unit: "kWh" }),
    fixtureParameter("totalEnergy", 284921.4, "306101", observedAt, { deviceId: "inv1", unit: "kWh" }),
    fixtureParameter("todayYield", 4.83, "306201", observedAt, { unit: "kWh/kWp" }),
    fixtureParameter("frequency", 50.02, "307001", observedAt, { unit: "Hz" }),
    fixtureParameter("alarm", 1, "308001", observedAt, { deviceId: "inv3", unit: "code", quality: "good" }),
  ];
  const topic = process.env.MQTT_TOPIC ?? "trn246/modbus";

  await db.insert(platformOrganizationsTable).values({
    id: VISUAL_TEST_ORGANIZATION_ID,
    name: "SCADA visual regression organization",
    slug: "scada-visual-regression",
    status: "active",
  });
  await db.insert(platformSitesTable).values({
    siteName: VISUAL_TEST_SITE_NAME,
    organizationId: VISUAL_TEST_ORGANIZATION_ID,
    status: "active",
  });
  await db.insert(usersTable).values({
    id: VISUAL_TEST_USER_ID,
    email: "scada-visual-regression@invalid.example",
    username: VISUAL_TEST_USERNAME,
    passwordHash: await passwordHash(VISUAL_TEST_PASSWORD),
    accountStatus: "active",
  });
  await db.insert(platformSiteAccessTable).values({
    userId: VISUAL_TEST_USER_ID,
    siteName: VISUAL_TEST_SITE_NAME,
    role: "operator",
    grantedBy: "visual-regression-suite",
  });
  await db.insert(mqttSnapshotsTable).values({
    topic,
    windowStartedAt,
    windowEndedAt: capturedAt,
    capturedAt,
    messageCount: parameters.length,
    parameterCount: parameters.length,
    data: {
      schemaVersion: 4,
      visualFixture: VISUAL_FIXTURE_MARKER,
      saveStatus: "saved",
      scheduledFor: capturedAt.toISOString(),
      timezone: "UTC",
      messages: [{ payload: JSON.stringify({ site_name: VISUAL_TEST_SITE_NAME, visualFixture: VISUAL_FIXTURE_MARKER }) }],
      latestParameters: parameters,
      latestDiscoveredParameters: parameters,
    },
  });

  return async () => {
    try {
      await removePriorFixture();
    } finally {
      await pool.end();
    }
  };
}