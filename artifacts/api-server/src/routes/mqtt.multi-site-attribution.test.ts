import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  platformLegacyTelemetrySiteAssignmentsTable,
  platformOrganizationsTable,
  platformSitesTable,
  platformTelemetryDiscoveriesTable,
} from "@workspace/db";
import {
  __injectMessageHistoryForTest,
  __resetMessageHistoryForTest,
  __setConfiguredMqttPlantSiteForTest,
  listLatestDeviceParameters,
  listLiveTelemetryDevices,
  runLiveTelemetryTest,
  soleCandidateLegacyOwner,
  type StoredMessage,
} from "./mqtt.ts";

// Regression coverage for the "sole active managed site" fallback
// (soleManagedSiteForConfiguredFallback/configuredManagedSiteFallback) that
// caused messageBelongsToSite to silently drop every unlabeled message once a
// second platform site existed. It was also relied on by
// listLiveTelemetryDevices, runLiveTelemetryTest's device-parameter
// test-waiting, and (until the per-row rewrite below) listLatestDeviceParameters'
// legacy-source bridge. These tests prove the first two stay correct
// regardless of how many sites are active, and that the legacy bridge fails
// safe (no crash, no cross-site leakage) rather than silently misattributing
// evidence, even before it is unambiguous which site legacy rows belong to.

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
  // otherSiteA already has its own explicit discovery for this device (filed
  // directly under its own name, not the raw configuredSite default), so
  // there is no legacy-configured-source row to bridge here at all -- this
  // must resolve purely from otherSiteA's own explicit discoveries, with two
  // other active sites present, no crash, and no evidence borrowed from
  // configuredSite.
  const parameters = await listLatestDeviceParameters(otherSiteA);
  assert.ok(parameters.some((parameter) => parameter.siteName === otherSiteA && parameter.deviceId === "ana"));
  assert.ok(parameters.every((parameter) => parameter.siteName === otherSiteA));
});

// Regression coverage for task #105: legacy configured-source bridging used
// to be gated on "exactly one other active managed site exists" -- a live,
// global count that silently and permanently stopped historical backfill
// for the real production site the moment ANY second active site was
// registered, including an unrelated QA/test fixture site. Ownership is now
// resolved once, while unambiguous, and durably persisted in
// platformLegacyTelemetrySiteAssignmentsTable (see
// resolveLegacyConfiguredSourceOwner in mqtt.ts) rather than re-derived from
// a live count on every call. These tests prove: (1) an assignment
// established while there is exactly one active site keeps applying
// correctly after the plant later expands to 3+ active sites (a mix of real
// and fixture sites), and that the bridged evidence is exclusive to the
// assigned site; (2) when 3+ active sites already exist and no assignment
// was ever established, nobody guesses -- the row stays unbridged rather
// than being leaked to whichever site happens to ask.
test("soleCandidateLegacyOwner establishes an owner only while exactly one active site differs from the raw legacy default", () => {
  // Unambiguous: exactly one other active site -- this is the moment an
  // assignment can be established.
  assert.equal(soleCandidateLegacyOwner(["raw-default", "real-site"], "raw-default"), "real-site");
  // Still unambiguous even if the raw default itself is (harmlessly) also
  // listed as an active site -- it never counts as its own candidate owner.
  assert.equal(soleCandidateLegacyOwner(["raw-default"], "raw-default"), undefined);
  // Ambiguous: zero other active sites -- nobody to assign to yet.
  assert.equal(soleCandidateLegacyOwner([], "raw-default"), undefined);
  // Ambiguous: 3+ active sites (a mix of a real site and QA/test fixtures)
  // -- must never guess which one owns the legacy evidence.
  assert.equal(soleCandidateLegacyOwner(["real-site", "fixture-a", "fixture-b"], "raw-default"), undefined);
  // Duplicate rows for the same site name must not be miscounted as two
  // distinct candidates.
  assert.equal(soleCandidateLegacyOwner(["real-site", "real-site"], "raw-default"), "real-site");
});

const legacyFixtureId = randomUUID();
const legacyRawSite = `Legacy Raw Default ${legacyFixtureId}`;
const legacyRealSite = `Legacy Real Production Plant ${legacyFixtureId}`;
const legacyFixtureSiteA = `Legacy QA Fixture A ${legacyFixtureId}`;
const legacyFixtureSiteB = `Legacy QA Fixture B ${legacyFixtureId}`;
const legacyOrganizationId = `legacy-bridge-org-${legacyFixtureId}`;

before(async () => {
  await db.insert(platformOrganizationsTable).values({
    id: legacyOrganizationId,
    name: "Legacy Bridge Org",
    slug: `legacy-bridge-${legacyFixtureId}`,
    status: "active",
  });
  // Only the real site is active at first -- exactly one active site that
  // differs from the raw legacy default, i.e. the unambiguous moment when an
  // ownership assignment can be established.
  await db.insert(platformSitesTable).values({
    siteName: legacyRealSite, organizationId: legacyOrganizationId, status: "active", activationStatus: "active",
  });
});

after(async () => {
  await db.delete(platformTelemetryDiscoveriesTable).where(eq(platformTelemetryDiscoveriesTable.siteName, legacyRawSite));
  await db.delete(platformLegacyTelemetrySiteAssignmentsTable)
    .where(eq(platformLegacyTelemetrySiteAssignmentsTable.rawSiteName, legacyRawSite));
  await db.delete(platformSitesTable).where(eq(platformSitesTable.organizationId, legacyOrganizationId));
  await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.id, legacyOrganizationId));
});

test("listLatestDeviceParameters keeps bridging legacy configured-source evidence to the assigned site after the plant expands to 3+ active sites", async () => {
  __setConfiguredMqttPlantSiteForTest(legacyRawSite);
  const now = new Date();
  await db.insert(platformTelemetryDiscoveriesTable).values({
    siteName: legacyRawSite,
    deviceId: "inv1",
    deviceName: "inv1",
    topic: "trn246/modbus",
    sourceIdentity: `${legacyRawSite}|ana|acPower|40001`,
    sourceName: "ana",
    originalName: "AC Power",
    normalizedName: "acPower",
    address: "40001",
    rawValue: "5000",
    reportedValue: "5000",
    observedAt: now,
    receivedAt: now,
    provenance: "live",
    sourceMappingStatus: "raw",
    dataQuality: "raw",
    scalingStatus: "raw",
  });

  // Seed the assignment the way it is established in production: once,
  // durably, back when legacyRealSite really was the only active site (this
  // suite runs alongside other files' concurrently-active site fixtures, so
  // asserting that exact global moment here would be flaky -- the point of
  // this test is that the persisted decision survives expansion, not how it
  // was first made).
  await db.insert(platformLegacyTelemetrySiteAssignmentsTable)
    .values({ rawSiteName: legacyRawSite, managedSiteName: legacyRealSite });

  const beforeExpansion = await listLatestDeviceParameters(legacyRealSite);
  const bridgedBefore = beforeExpansion.find((parameter) => parameter.deviceId === "inv1" && parameter.normalizedName === "acPower");
  assert.ok(bridgedBefore, "expected the legacy row to be bridged per the persisted assignment");
  assert.equal(bridgedBefore!.siteName, legacyRealSite);

  // The plant now expands to 3 active sites total. Under the old count-based
  // rule this would have silently and permanently stopped backfill for
  // legacyRealSite; the persisted assignment must keep applying regardless.
  await db.insert(platformSitesTable).values([
    { siteName: legacyFixtureSiteA, organizationId: legacyOrganizationId, status: "active", activationStatus: "active" },
    { siteName: legacyFixtureSiteB, organizationId: legacyOrganizationId, status: "active", activationStatus: "active" },
  ]);

  const afterExpansion = await listLatestDeviceParameters(legacyRealSite);
  const bridgedAfter = afterExpansion.find((parameter) => parameter.deviceId === "inv1" && parameter.normalizedName === "acPower");
  assert.ok(bridgedAfter, "expected the legacy row to still be bridged after the plant expanded to 3+ active sites");
  assert.equal(bridgedAfter!.siteName, legacyRealSite);

  // The bridged evidence must remain exclusive to the assigned site -- an
  // unrelated fixture site added later must never receive a copy of it.
  const fixtureParameters = await listLatestDeviceParameters(legacyFixtureSiteA);
  assert.ok(fixtureParameters.every((parameter) => parameter.siteName === legacyFixtureSiteA));
  assert.ok(fixtureParameters.every((parameter) => !(parameter.deviceId === "inv1" && parameter.normalizedName === "acPower")));
});

test("listLatestDeviceParameters never guesses legacy ownership when 3+ active sites already exist and no assignment was ever established", async () => {
  const ambiguousFixtureId = randomUUID();
  const ambiguousRawSite = `Ambiguous Legacy Raw Default ${ambiguousFixtureId}`;
  const ambiguousSiteA = `Ambiguous Site A ${ambiguousFixtureId}`;
  const ambiguousSiteB = `Ambiguous Site B ${ambiguousFixtureId}`;
  const ambiguousSiteC = `Ambiguous Site C ${ambiguousFixtureId}`;
  const ambiguousOrganizationId = `ambiguous-legacy-org-${ambiguousFixtureId}`;

  await db.insert(platformOrganizationsTable).values({
    id: ambiguousOrganizationId,
    name: "Ambiguous Legacy Org",
    slug: `ambiguous-legacy-${ambiguousFixtureId}`,
    status: "active",
  });
  try {
    // All three sites are active simultaneously, from the start -- there was
    // never an unambiguous moment during which an assignment could have been
    // established automatically.
    await db.insert(platformSitesTable).values([
      { siteName: ambiguousSiteA, organizationId: ambiguousOrganizationId, status: "active", activationStatus: "active" },
      { siteName: ambiguousSiteB, organizationId: ambiguousOrganizationId, status: "active", activationStatus: "active" },
      { siteName: ambiguousSiteC, organizationId: ambiguousOrganizationId, status: "active", activationStatus: "active" },
    ]);
    __setConfiguredMqttPlantSiteForTest(ambiguousRawSite);
    const now = new Date();
    await db.insert(platformTelemetryDiscoveriesTable).values({
      siteName: ambiguousRawSite,
      deviceId: "inv9",
      deviceName: "inv9",
      topic: "trn246/modbus",
      sourceIdentity: `${ambiguousRawSite}|ana|acPower|40099`,
      sourceName: "ana",
      originalName: "AC Power",
      normalizedName: "acPower",
      address: "40099",
      rawValue: "5000",
      reportedValue: "5000",
      observedAt: now,
      receivedAt: now,
      provenance: "live",
      sourceMappingStatus: "raw",
      dataQuality: "raw",
      scalingStatus: "raw",
    });

    for (const siteName of [ambiguousSiteA, ambiguousSiteB, ambiguousSiteC]) {
      const parameters = await listLatestDeviceParameters(siteName);
      assert.ok(
        parameters.every((parameter) => !(parameter.deviceId === "inv9" && parameter.normalizedName === "acPower")),
        `expected no site to guess ownership of the ambiguous legacy row (checked ${siteName})`,
      );
    }
    const [assignment] = await db.select().from(platformLegacyTelemetrySiteAssignmentsTable)
      .where(eq(platformLegacyTelemetrySiteAssignmentsTable.rawSiteName, ambiguousRawSite));
    assert.equal(assignment, undefined, "no assignment should ever be established while ownership stays ambiguous");
  } finally {
    await db.delete(platformTelemetryDiscoveriesTable).where(eq(platformTelemetryDiscoveriesTable.siteName, ambiguousRawSite));
    await db.delete(platformLegacyTelemetrySiteAssignmentsTable)
      .where(eq(platformLegacyTelemetrySiteAssignmentsTable.rawSiteName, ambiguousRawSite));
    await db.delete(platformSitesTable).where(eq(platformSitesTable.organizationId, ambiguousOrganizationId));
    await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.id, ambiguousOrganizationId));
  }
});
