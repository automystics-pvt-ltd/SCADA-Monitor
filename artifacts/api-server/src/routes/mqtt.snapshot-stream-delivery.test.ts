import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express, { type Request } from "express";
import { eq } from "drizzle-orm";
import { db, platformOrganizationsTable, platformSitesTable } from "@workspace/db";
import { logger } from "../lib/logger.ts";
import mqttRouter, { __broadcastSnapshotForTest, __setConfiguredMqttPlantSiteForTest } from "./mqtt.ts";

// Task #106: the "snapshot" SSE event -- sent on connect and on every
// scheduled/retry-confirmed persistSnapshot() write -- uses its own
// attribution gate, snapshotBelongsToSite(), which had no test coverage at
// all. A unit test against that function in isolation
// (mqtt.snapshot-site-attribution.test.ts) does not prove the real
// `/mqtt/stream` pipeline actually routes a live "snapshot" broadcast to the
// correct listener: the connection could keep reporting "connected" while
// scheduled-snapshot evidence silently never reaches (or wrongly reaches) a
// plant's dashboard. This test drives the real pipeline end-to-end, exactly
// mirroring mqtt.live-stream-delivery.test.ts's pattern for the "message"
// event: it opens real SSE connections to the real route with 2+ active
// platform sites configured, triggers the same broadcast("snapshot", ...)
// call a scheduled snapshot write would (via a parallel test-only hook), and
// asserts only the assigned site's listener truly receives it over the wire.

const fixtureId = randomUUID();
const configuredSite = `Snapshot Stream Delivery Plant ${fixtureId}`;
const otherSite = `Snapshot Stream Delivery Fixture ${fixtureId}`;
const organizationId = `snapshot-stream-delivery-org-${fixtureId}`;
const globalPolicy = process.env.SCADA_ALLOW_GLOBAL_ACCESS;

const globalPrincipal = {
  id: `snapshot-stream-global-user-${fixtureId}`,
  email: `snapshot-stream-global-${fixtureId}@example.com`,
  firstName: "Global",
  lastName: "Tester",
  profileImageUrl: null,
};

let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;

function testApp() {
  const app = express();
  app.use((req, _res, next) => {
    const authenticated = req.get("x-scada-test-principal") === "global";
    const testRequest = req as Request & {
      scadaUser?: typeof globalPrincipal;
      isAuthenticated(): boolean;
      isScadaAuthenticated(): boolean;
    };
    testRequest.isAuthenticated = (() => authenticated) as Request["isAuthenticated"];
    testRequest.isScadaAuthenticated = (() => authenticated) as Request["isScadaAuthenticated"];
    if (authenticated) testRequest.scadaUser = globalPrincipal;
    testRequest.log = logger as unknown as typeof req.log;
    next();
  });
  app.use("/api", mqttRouter);
  return app;
}

/** A minimal incremental SSE frame reader over a real streamed HTTP response. */
function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Array<{ event: string; data: unknown }> = [];
  let closed = false;

  function drainBuffer() {
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventLine = rawFrame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = rawFrame.split("\n").find((line) => line.startsWith("data: "));
      if (eventLine && dataLine) {
        frames.push({ event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) });
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  // A single background pump owns the one allowed outstanding `reader.read()`
  // call; `waitFor` only ever polls the already-decoded `frames` array so it
  // can be called (and time out) repeatedly without racing reads.
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        drainBuffer();
      }
    } catch {
      // Expected once close()/reader.cancel() tears down the connection.
    }
  })();

  return {
    /** Waits until a frame matching `predicate` has been received, or times out. */
    async waitFor(predicate: (frame: { event: string; data: unknown }) => boolean, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = frames.find(predicate);
        if (match) return match;
        if (closed || Date.now() > deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    /** True if no frame matching `predicate` has arrived so far (non-blocking snapshot). */
    hasReceived(predicate: (frame: { event: string; data: unknown }) => boolean) {
      return frames.some(predicate);
    },
    async close() {
      closed = true;
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
    },
  };
}

async function openStream(siteName: string) {
  const response = await fetch(`${baseUrl}/api/mqtt/stream?siteName=${encodeURIComponent(siteName)}`, {
    headers: { "x-scada-test-principal": "global" },
  });
  assert.equal(response.status, 200, `expected the stream for ${siteName} to open`);
  return sseReader(response as unknown as Response);
}

/** The exact shape persistSnapshot() broadcasts: a SavedSnapshotEvidence object, not a raw DB row. */
function snapshotEvidenceFor(marker: string, options: { explicitSiteName?: string } = {}) {
  return {
    id: Date.now(),
    topic: "trn246/modbus",
    windowStartedAt: "2026-08-27T05:45:00.000Z",
    windowEndedAt: "2026-08-27T06:00:00.000Z",
    scheduledFor: "2026-08-27T06:00:00.000Z",
    capturedAt: new Date().toISOString(),
    saveStatus: "saved",
    messageCount: 1,
    parameterCount: 1,
    parameters: [{
      sourceIdentity: `${options.explicitSiteName ?? ""}|ana|inv1|5003`,
      originalName: "inv1",
      normalizedName: "inv1",
      displayLabel: "inv1",
      originalValue: "4018",
      transportRawValue: "4018",
      sourceReportedValue: null,
      normalizedValue: null,
      sourceUnit: null,
      displayUnit: null,
      dataQuality: "raw",
      scalingStatus: "raw",
      validationStatus: "raw",
      sourceName: "ana",
      address: "5003",
      marker,
      // Real broker payloads never carry an explicit site/plant name field
      // -- only a QA fixture explicitly declaring its own source site does.
      ...(options.explicitSiteName ? { siteName: options.explicitSiteName, site_name: options.explicitSiteName } : {}),
    }],
    metrics: { activePower: null, dailyEnergy: null, totalEnergy: null, specificYield: null },
    calibrationProfile: null,
  };
}

before(async () => {
  process.env.SCADA_ALLOW_GLOBAL_ACCESS = "true";
  await db.insert(platformOrganizationsTable).values({
    id: organizationId,
    name: "Snapshot Stream Delivery Org",
    slug: `snapshot-stream-delivery-${fixtureId}`,
    status: "active",
  });
  // 2+ active platform sites -- exactly the state that broke the
  // count-based message fallback in task #104; the same shape of bug is
  // plausible for scheduled snapshot evidence carrying no explicit label.
  await db.insert(platformSitesTable).values([
    { siteName: configuredSite, organizationId, status: "active", activationStatus: "active" },
    { siteName: otherSite, organizationId, status: "active", activationStatus: "active" },
  ]);
  __setConfiguredMqttPlantSiteForTest(configuredSite);

  server = testApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await db.delete(platformSitesTable).where(eq(platformSitesTable.organizationId, organizationId));
  await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.id, organizationId));
  if (globalPolicy === undefined) delete process.env.SCADA_ALLOW_GLOBAL_ACCESS;
  else process.env.SCADA_ALLOW_GLOBAL_ACCESS = globalPolicy;
});

test("a scheduled snapshot with no explicit site label reaches the configured plant site's real SSE stream and not an unrelated active site's", async () => {
  const assignedStream = await openStream(configuredSite);
  const unrelatedStream = await openStream(otherSite);
  try {
    assert.ok(await assignedStream.waitFor((frame) => frame.event === "ready"), "assigned stream must become ready");
    assert.ok(await unrelatedStream.waitFor((frame) => frame.event === "ready"), "unrelated stream must become ready");

    const marker = `snapshot-stream-delivery-unlabeled-${fixtureId}`;
    const evidence = snapshotEvidenceFor(marker);
    __broadcastSnapshotForTest(evidence);

    const delivered = await assignedStream.waitFor((frame) =>
      frame.event === "snapshot"
      && typeof frame.data === "object" && frame.data !== null
      && Array.isArray((frame.data as { parameters?: Array<{ marker?: string }> }).parameters)
      && (frame.data as { parameters: Array<{ marker?: string }> }).parameters.some((parameter) => parameter.marker === marker));
    assert.ok(delivered, "the configured plant site's SSE stream must receive the unlabeled live snapshot event");

    // Give the unrelated stream every chance to (wrongly) receive the same
    // broadcast before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      unrelatedStream.hasReceived((frame) =>
        frame.event === "snapshot"
        && typeof frame.data === "object" && frame.data !== null
        && Array.isArray((frame.data as { parameters?: Array<{ marker?: string }> }).parameters)
        && (frame.data as { parameters: Array<{ marker?: string }> }).parameters.some((parameter) => parameter.marker === marker)),
      false,
      "an unrelated active site's SSE stream must never receive another site's live snapshot",
    );
  } finally {
    await assignedStream.close();
    await unrelatedStream.close();
  }
});

test("a scheduled snapshot with an explicit site label reaches only that site's real SSE stream", async () => {
  const assignedStream = await openStream(otherSite);
  const unrelatedStream = await openStream(configuredSite);
  try {
    assert.ok(await assignedStream.waitFor((frame) => frame.event === "ready"), "assigned stream must become ready");
    assert.ok(await unrelatedStream.waitFor((frame) => frame.event === "ready"), "unrelated stream must become ready");

    const marker = `snapshot-stream-delivery-explicit-${fixtureId}`;
    const evidence = snapshotEvidenceFor(marker, { explicitSiteName: otherSite });
    __broadcastSnapshotForTest(evidence);

    const delivered = await assignedStream.waitFor((frame) =>
      frame.event === "snapshot"
      && typeof frame.data === "object" && frame.data !== null
      && Array.isArray((frame.data as { parameters?: Array<{ marker?: string }> }).parameters)
      && (frame.data as { parameters: Array<{ marker?: string }> }).parameters.some((parameter) => parameter.marker === marker));
    assert.ok(delivered, "the explicitly labeled site's SSE stream must receive the live snapshot event");

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      unrelatedStream.hasReceived((frame) =>
        frame.event === "snapshot"
        && typeof frame.data === "object" && frame.data !== null
        && Array.isArray((frame.data as { parameters?: Array<{ marker?: string }> }).parameters)
        && (frame.data as { parameters: Array<{ marker?: string }> }).parameters.some((parameter) => parameter.marker === marker)),
      false,
      // Even though otherSite is this server's non-configured site, the
      // configured plant site's stream must never receive evidence
      // explicitly labeled for a different site.
      "an unrelated active site's SSE stream must never receive another site's explicitly-labeled live snapshot",
    );
  } finally {
    await assignedStream.close();
    await unrelatedStream.close();
  }
});
