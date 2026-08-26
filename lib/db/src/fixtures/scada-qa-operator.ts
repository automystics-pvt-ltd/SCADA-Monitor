/**
 * Shared fixture: a durable, least-privilege SCADA test operator scoped to
 * one dedicated synthetic fixture site. Used by both the CLI provisioning
 * script (scripts/src/provision-scada-test-operator.ts) and the committed
 * end-to-end test (artifacts/mqtt-scada-monitor/e2e) so both stay in sync
 * with a single source of truth.
 *
 * Safety model -- do not weaken without re-reviewing the access-control
 * impact:
 *  - `viewer` role only (never `site-admin` or any role with export/device/
 *    site/user administration).
 *  - Scoped to exactly one dedicated fixture site/organization, never a real
 *    managed site.
 *  - Every call revokes any site/org access this user has outside the
 *    fixture scope, so privilege can never silently accumulate across reruns.
 */
import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../index";
import { mqttSnapshotsTable } from "../schema/mqtt-snapshots";
import {
  platformConfigurationTable,
  platformOrganizationAccessTable,
  platformOrganizationsTable,
  platformSiteAccessTable,
  platformSitesTable,
} from "../schema/platform-admin";
import { usersTable } from "../schema/auth";

/**
 * Resolves the same effective MQTT topic the API server's saved-parameters
 * route uses at runtime: a persisted `platform_configuration` row (key
 * `"mqtt"`, field `topic`) takes precedence over `MQTT_TOPIC`/the default,
 * exactly like `loadRuntimeConfiguration` in artifacts/api-server/src/routes/mqtt.ts.
 * The fixture snapshot must be written under this topic or the saved-parameters
 * query will never find it once an operator has configured a non-default topic.
 */
export async function resolveEffectiveMqttTopic(): Promise<string> {
  const [saved] = await db.select().from(platformConfigurationTable)
    .where(eq(platformConfigurationTable.key, "mqtt")).limit(1);
  const value = saved?.value;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).topic === "string") {
    return (value as Record<string, unknown>).topic as string;
  }
  return process.env.MQTT_TOPIC ?? "trn246/modbus";
}

export const SCADA_QA_OPERATOR_EMAIL = "scada.qa.operator@example.com";
export const SCADA_QA_OPERATOR_USERNAME = "qa.operator";
export const SCADA_QA_FIXTURE_ORGANIZATION_ID = "scada-qa-fixture-organization";
export const SCADA_QA_FIXTURE_ORGANIZATION_SLUG = "scada-qa-fixture";
export const SCADA_QA_FIXTURE_SITE_NAME = "QA Fixture Plant";
export const SCADA_QA_FIXTURE_MARKER = "scada-qa-fixture-v1";

async function hashScadaPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
  return `${salt}:${derived.toString("hex")}`;
}

function fixtureParameter(options: {
  name: string;
  address: string;
  value: number;
  destination?: string;
  deviceId?: string;
  deviceName?: string;
  validated: boolean;
  unit?: string;
}, observedAt: string) {
  return {
    siteName: SCADA_QA_FIXTURE_SITE_NAME,
    site_name: SCADA_QA_FIXTURE_SITE_NAME,
    sourceName: "qa-fixture-gateway",
    server_name: "qa-fixture-gateway",
    name: options.name,
    originalName: options.name,
    address: options.address,
    full_addr: options.address,
    value: options.value,
    ...(options.deviceId ? { deviceId: options.deviceId, device_id: options.deviceId } : {}),
    ...(options.deviceName ? { deviceName: options.deviceName, device_name: options.deviceName } : {}),
    ...(options.destination ? { admin_mapping_destination: options.destination, adminMappingDestination: options.destination } : {}),
    ...(options.unit ? { source_unit: options.unit, sourceUnit: options.unit } : {}),
    ...(options.validated ? { scaling_validated: true } : {}),
    observedAt,
    provenance: "saved-snapshot",
  };
}

/**
 * Synthetic saved-parameter evidence covering KPI, device, summary, and raw
 * categories. `observedAt` should fall inside the saved-parameters route's
 * rolling 48-hour server-side window (see provisionScadaQaOperatorFixture),
 * since that endpoint always filters by the server's real wall-clock time
 * and never honours a client-supplied/faked date.
 */
export function buildScadaQaFixtureParameters(observedAt: string) {
  const kpi = [
    { name: "activePowerFixture", address: "900001", value: 512.4, destination: "active-power", unit: "kW" },
    { name: "dailyEnergyFixture", address: "900002", value: 812.5, destination: "daily-energy", unit: "kWh" },
    { name: "totalEnergyFixture", address: "900003", value: 284213.7, destination: "total-energy", unit: "kWh" },
    { name: "specificYieldFixture", address: "900004", value: 4.82, destination: "specific-yield", unit: "kWh/kWp" },
  ].map((entry) => fixtureParameter({ ...entry, validated: true }, observedAt));

  const device = [1, 2, 3, 4, 5].map((index) => fixtureParameter({
    name: `inv${index}ActivePowerFixture`,
    address: `90010${index}`,
    value: 95 + index * 3.4,
    deviceId: `inv${index}`,
    deviceName: `Inverter ${index}`,
    unit: "kW",
    validated: true,
  }, observedAt));

  const summary = [
    { name: "frequencyFixture", address: "900020", value: 50.01, unit: "Hz" },
    { name: "powerFactorFixture", address: "900021", value: 0.98, unit: "PF" },
    { name: "plantVoltageFixture", address: "900022", value: 415.2, unit: "V" },
  ].map((entry) => fixtureParameter({ ...entry, validated: true }, observedAt));

  const raw = [
    { name: "phaseAVoltageFixture", address: "900030", value: 233.1, unit: "V" },
    { name: "phaseBVoltageFixture", address: "900031", value: 231.8, unit: "V" },
    { name: "phaseCVoltageFixture", address: "900032", value: 232.4, unit: "V" },
    { name: "phaseACurrentFixture", address: "900033", value: 18.2, unit: "A" },
    { name: "phaseBCurrentFixture", address: "900034", value: 17.9, unit: "A" },
    { name: "phaseCCurrentFixture", address: "900035", value: 18.5, unit: "A" },
    { name: "internalTemperatureFixture", address: "900036", value: 41.3, unit: "°C", deviceId: "inv1", deviceName: "Inverter 1" },
    { name: "internalTemperatureFixture", address: "900037", value: 42.1, unit: "°C", deviceId: "inv2", deviceName: "Inverter 2" },
    { name: "string1CurrentFixture", address: "900038", value: 8.4, unit: "A", deviceId: "inv1", deviceName: "Inverter 1" },
    { name: "string2CurrentFixture", address: "900039", value: 8.1, unit: "A", deviceId: "inv1", deviceName: "Inverter 1" },
    { name: "alarmFixture", address: "900040", value: 0, deviceId: "inv3", deviceName: "Inverter 3" },
    { name: "communicationStatusFixture", address: "900041", value: 1 },
  ].map((entry) => fixtureParameter({ ...entry, validated: false }, observedAt));

  return [...kpi, ...device, ...summary, ...raw];
}

async function removeStaleAccess(userId: string) {
  await db.delete(platformSiteAccessTable).where(eq(platformSiteAccessTable.userId, userId));
  await db.delete(platformOrganizationAccessTable).where(eq(platformOrganizationAccessTable.userId, userId));
}

async function removePriorFixtureSnapshot() {
  // Match by the fixture marker embedded in `data`, not a fixed timestamp --
  // the window is recomputed to "now" on every provisioning run so the
  // saved-parameters route's rolling 48-hour server-side filter always finds
  // it (see provisionScadaQaOperatorFixture).
  await db.delete(mqttSnapshotsTable).where(sql`(${mqttSnapshotsTable.data} ->> 'fixtureMarker') = ${SCADA_QA_FIXTURE_MARKER}`);
}

export type ProvisionScadaQaOperatorResult = {
  userId: string;
  username: string;
  password: string;
  siteName: string;
  parameterCount: number;
};

/**
 * Idempotently provisions the dedicated fixture org/site, the least-privilege
 * `qa.operator` user scoped only to it, and a synthetic saved-parameter
 * snapshot exercising every SavedParameterAnalytics category.
 *
 * `password` must be supplied by the caller (generated or from a secret) --
 * this module never contains a literal default password.
 */
export async function provisionScadaQaOperatorFixture(password: string): Promise<ProvisionScadaQaOperatorResult> {
  const now = new Date();
  const passwordHash = await hashScadaPassword(password);

  await db.insert(platformOrganizationsTable).values({
    id: SCADA_QA_FIXTURE_ORGANIZATION_ID,
    name: "SCADA QA Fixture Organization",
    slug: SCADA_QA_FIXTURE_ORGANIZATION_SLUG,
    status: "active",
  }).onConflictDoUpdate({
    target: platformOrganizationsTable.id,
    set: { name: "SCADA QA Fixture Organization", status: "active", updatedAt: now },
  });

  await db.insert(platformSitesTable).values({
    siteName: SCADA_QA_FIXTURE_SITE_NAME,
    organizationId: SCADA_QA_FIXTURE_ORGANIZATION_ID,
    status: "active",
    activationStatus: "active",
  }).onConflictDoUpdate({
    target: platformSitesTable.siteName,
    set: { organizationId: SCADA_QA_FIXTURE_ORGANIZATION_ID, status: "active", activationStatus: "active", updatedAt: now },
  });

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, SCADA_QA_OPERATOR_EMAIL)).limit(1);
  const user = existing
    ? (await db.update(usersTable).set({
        username: SCADA_QA_OPERATOR_USERNAME,
        passwordHash,
        passwordSetAt: now,
        firstName: "SCADA",
        lastName: "QA Operator",
        accountStatus: "active",
        deactivatedAt: null,
        updatedAt: now,
      }).where(eq(usersTable.id, existing.id)).returning())[0]
    : (await db.insert(usersTable).values({
        email: SCADA_QA_OPERATOR_EMAIL,
        username: SCADA_QA_OPERATOR_USERNAME,
        passwordHash,
        passwordSetAt: now,
        firstName: "SCADA",
        lastName: "QA Operator",
        accountStatus: "active",
      }).returning())[0];

  await removeStaleAccess(user.id);

  await db.insert(platformOrganizationAccessTable).values({
    userId: user.id,
    organizationId: SCADA_QA_FIXTURE_ORGANIZATION_ID,
    status: "active",
  });

  await db.insert(platformSiteAccessTable).values({
    userId: user.id,
    siteName: SCADA_QA_FIXTURE_SITE_NAME,
    role: "viewer",
    status: "active",
  });

  await removePriorFixtureSnapshot();
  // GET /api/mqtt/saved-parameters always filters by the server's real
  // wall-clock time (`now - 48h` .. `now`) and never accepts a client- or
  // test-supplied date, so the fixture's window must be genuinely recent.
  // The route matches `windowEndedAt >= from` and `windowStartedAt <= to`,
  // so ending just under `now` keeps it inside range immediately after
  // provisioning. The seconds offset (37s, not aligned to a 15-minute mark)
  // keeps this from ever landing on the same instant as a real scheduled
  // capture, which would collide with the topic+windowEndedAt unique index.
  const windowEndedAt = new Date(now.getTime() - 37_000);
  const windowStartedAt = new Date(windowEndedAt.getTime() - 15 * 60_000);
  const observedAt = new Date(windowEndedAt.getTime() - 60_000).toISOString();
  const parameters = buildScadaQaFixtureParameters(observedAt);
  const topic = await resolveEffectiveMqttTopic();
  await db.insert(mqttSnapshotsTable).values({
    topic,
    windowStartedAt,
    windowEndedAt,
    capturedAt: windowEndedAt,
    messageCount: parameters.length,
    parameterCount: parameters.length,
    data: {
      schemaVersion: 4,
      fixtureMarker: SCADA_QA_FIXTURE_MARKER,
      saveStatus: "saved",
      scheduledFor: windowEndedAt.toISOString(),
      timezone: "UTC",
      messages: [{ payload: JSON.stringify({ site_name: SCADA_QA_FIXTURE_SITE_NAME, fixtureMarker: SCADA_QA_FIXTURE_MARKER }) }],
      latestParameters: parameters,
      latestDiscoveredParameters: parameters,
    },
  });

  return {
    userId: user.id,
    username: SCADA_QA_OPERATOR_USERNAME,
    password,
    siteName: SCADA_QA_FIXTURE_SITE_NAME,
    parameterCount: parameters.length,
  };
}
