import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import { db, platformOrganizationsTable, platformSitesTable, platformTelemetryDiscoveriesTable } from "@workspace/db";
import {
  __injectMessageHistoryForTest,
  __resetMessageHistoryForTest,
  __setConfiguredMqttPlantSiteForTest,
  listLatestDeviceParameters,
  listLiveTelemetryDevices,
  runLiveTelemetryTest,
  type StoredMessage,
} from "./mqtt.ts";

// Regression coverage for task #103: the "sole active managed site" fallback
// (soleManagedSiteForConfiguredFallback/configuredManagedSiteFallback) that
// caused messageBelongsToSite to silently drop every unlabeled message once a
// second platform site existed was also relied on by listLiveTelemetryDevices,
// runLiveTelemetryTest's device-parameter test-waiting, and (intentionally,
// see mqtt.ts) listLatestDeviceParameters' legacy-source bridge. These tests
// prove the first two now stay correct regardless of how many sites are
// active, and that the third fails safe (no crash, no cross-site leakage)
// rather than silently misattributing evidence.

const fixtureId = randomUUID();
const configuredSite = `Multi Site Attribution Plant ${fixtureId}`;
const otherSiteA = `Multi Site Fixture A ${fixtureId}`;
const otherSiteB = `Multi Site Fixture B ${fixtureId}`;
const organizationId = `multi-site-attribution-org-${fixtureId}`;

function unlabeledDeviceMessage(sequence: number): StoredMessage {
  const receivedAt = new Date().toISOString();
  return {
    topic: "trn246/modbus",
    // Real broker payloads never carry a site/plant name -- see
    // mqtt.message-site-attribution.test.ts for the documented wire format.
    payload: JSON.stringify({ Automystics: { addr: 5003, data: "4018", name: "inv1", server_name: "ana" } }),
    receivedAt,
    sequence,
    delivery: "immediate",
    captureSiteName: configuredSite,
  };
}

before(async () => {
  await db.insert(platformOrganizationsTable).values({
    id: organizationId,
    name: "Multi Site Attribution Org",
    slug: `multi-site-attribution-${fixtureId}`,
    status: "active",
  });
  // Two active managed sites, neither of which is the configured plant site
  // -- this is exactly the state that permanently broke the count-based
  // fallback (soleManagedSiteForConfiguredFallback returns undefined the
  // moment a second active site exists).
  await db.insert(platformSitesTable).values([
    { siteName: otherSiteA, organizationId, status: "active", activationStatus: "active" },
    { siteName: otherSiteB, organizationId, status: "active", activationStatus: "active" },
  ]);
});

after(async () => {
  await db.delete(platformTelemetryDiscoveriesTable).where(eq(platformTelemetryDiscoveriesTable.siteName, otherSiteA));
  await db.delete(platformSitesTable).where(eq(platformSitesTable.organizationId, organizationId));
  await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.id, organizationId));
});

test("listLiveTelemetryDevices attributes an unlabeled device to the configured plant site with 2+ other active sites", async () => {
  __setConfiguredMqttPlantSiteForTest(configuredSite);
  __resetMessageHistoryForTest();
  __injectMessageHistoryForTest(unlabeledDeviceMessage(1));
  try {
    const devices = await listLiveTelemetryDevices();
    const device = devices.find((candidate) => candidate.deviceId === "ana");
    assert.ok(device, "expected the unlabeled device to be discovered");
    assert.equal(device!.siteName, configuredSite);
  } finally {
    __resetMessageHistoryForTest();
  }
});

test("runLiveTelemetryTest finds live evidence for the configured plant site with 2+ other active sites", async () => {
  __setConfiguredMqttPlantSiteForTest(configuredSite);
  __resetMessageHistoryForTest();
  __injectMessageHistoryForTest(unlabeledDeviceMessage(1));
  try {
    const result = await runLiveTelemetryTest(configuredSite, "ana", 1);
    assert.equal(result.result, "success");
  } finally {
    __resetMessageHistoryForTest();
  }
});

test("runLiveTelemetryTest never misattributes evidence to an unrelated active site", async () => {
  __setConfiguredMqttPlantSiteForTest(configuredSite);
  __resetMessageHistoryForTest();
  __injectMessageHistoryForTest(unlabeledDeviceMessage(1));
  try {
    const result = await runLiveTelemetryTest(otherSiteA, "ana", 0.2);
    assert.equal(result.result, "no-telemetry");
  } finally {
    __resetMessageHistoryForTest();
  }
});

test("listLatestDeviceParameters returns a site's own discoveries and never throws once legacy-source bridging becomes ambiguous", async () => {
  __setConfiguredMqttPlantSiteForTest(configuredSite);
  const now = new Date();
  await db.insert(platformTelemetryDiscoveriesTable).values({
    siteName: otherSiteA,
    deviceId: "ana",
    deviceName: "ana",
    topic: "trn246/modbus",
    sourceIdentity: `${otherSiteA}|ana|inv1|—`,
    sourceName: "ana",
    originalName: "inv1",
    normalizedName: "inv1",
    rawValue: "4018",
    reportedValue: "4018",
    observedAt: now,
    receivedAt: now,
    provenance: "live",
    sourceMappingStatus: "raw",
    dataQuality: "raw",
    scalingStatus: "raw",
  });
  // With two other active sites present, canAdoptLegacyConfiguredSource must
  // stay false (configuredSite !== otherSiteA and otherSiteA is not the sole
  // active site), so this must resolve purely from otherSiteA's own explicit
  // discoveries -- no crash, no evidence borrowed from configuredSite.
  const parameters = await listLatestDeviceParameters(otherSiteA);
  assert.ok(parameters.some((parameter) => parameter.siteName === otherSiteA && parameter.deviceId === "ana"));
  assert.ok(parameters.every((parameter) => parameter.siteName === otherSiteA));
});
