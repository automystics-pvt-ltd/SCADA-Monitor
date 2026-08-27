import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import express, { type Request } from "express";
import { eq } from "drizzle-orm";
import { db, mqttCommunicationEventsTable, platformOrganizationsTable, platformSitesTable } from "@workspace/db";
import { logger } from "../lib/logger.ts";
import mqttRouter, {
  __injectMessageHistoryForTest,
  __resetMessageHistoryForTest,
  __setConfiguredMqttPlantSiteForTest,
  __setConsumerLeaseHeldForTest,
  __setSubscriptionTopicForTest,
  type StoredMessage,
} from "./mqtt.ts";

// Regression coverage for task #107. Task #104/#105 proved the *live*
// broadcast() path attributes an unlabeled message to the right site. That
// is a completely separate code path from missed-telemetry *recovery*: when
// a browser reconnects with a `Last-Event-ID` header, or when this server
// process is in MQTT-consumer standby, `/mqtt/stream` replays evidence from
// `deliveryHighWater()`/`replayableMessagesAfter()` instead of a live
// broadcast(). Both still gate delivery through `messageBelongsToSite()`,
// but the replay wiring itself (Last-Event-ID handling, the
// resync-required fallback, and the standby ledger fanout `setInterval`)
// had never been exercised end-to-end with a real SSE reconnect and 2+
// active sites. These tests drive the real `/mqtt/stream` route for all
// three of those paths.
//
// The real deployment's single physical broker topic receives production
// telemetry at a very high, unpredictable cadence (tens of messages per
// second), shared across every test process that imports mqtt.ts. Racing
// that traffic for delivery-sequence numbers would make an exact-replay
// assertion flaky, so every test here overrides the subscription topic to
// an isolated, uniquely-named topic via __setSubscriptionTopicForTest --
// exercising the exact same deliveryHighWater()/replayableMessagesAfter()
// query path, scoped to evidence only this file ever writes.

const fixtureId = randomUUID();
const configuredSite = `Replay Reconnect Plant ${fixtureId}`;
const otherSite = `Replay Reconnect Fixture ${fixtureId}`;
const organizationId = `replay-reconnect-org-${fixtureId}`;
const globalPolicy = process.env.SCADA_ALLOW_GLOBAL_ACCESS;

const globalPrincipal = {
  id: `replay-reconnect-global-user-${fixtureId}`,
  email: `replay-reconnect-global-${fixtureId}@example.com`,
  firstName: "Global",
  lastName: "Tester",
  profileImageUrl: null,
};

let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;
const commEventTopics: string[] = [];

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
    async waitFor(predicate: (frame: { event: string; data: unknown }) => boolean, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = frames.find(predicate);
        if (match) return match;
        if (closed || Date.now() > deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
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

async function openStream(siteName: string, lastEventId?: number) {
  const headers: Record<string, string> = { "x-scada-test-principal": "global" };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
  const response = await fetch(`${baseUrl}/api/mqtt/stream?siteName=${encodeURIComponent(siteName)}`, { headers });
  assert.equal(response.status, 200, `expected the stream for ${siteName} to open`);
  return sseReader(response as unknown as Response);
}

/** A directly-persisted "telemetry" communication event, mirroring exactly what captureMqttMessage() would have written to the durable ledger. */
async function insertPersistedTelemetryEvent(topic: string, deliverySequence: number, rawPayload: string) {
  await db.insert(mqttCommunicationEventsTable).values({
    topic,
    eventType: "telemetry",
    deliverySequence,
    rawPayload,
    receivedAt: new Date(),
  });
}

function unlabeledPayload(marker: string) {
  // Real broker payloads from this plant's single physical topic never carry
  // an explicit site/plant name field -- see mqtt.message-site-attribution.test.ts
  // for the documented wire format. This must fall back to the configured
  // plant site, never to an active-site count.
  return JSON.stringify({ Automystics: { addr: 5003, data: "4018", name: "inv1", server_name: "ana", marker } });
}

function explicitlyLabeledPayload(siteName: string, marker: string) {
  return JSON.stringify({ site_name: siteName, name: "fixtureMarker", data: "1", marker });
}

function messageFrame(frame: { event: string; data: unknown }, marker: string) {
  return frame.event === "message"
    && typeof frame.data === "object" && frame.data !== null
    && typeof (frame.data as { payload?: unknown }).payload === "string"
    && ((frame.data as { payload: string }).payload).includes(marker);
}

before(async () => {
  process.env.SCADA_ALLOW_GLOBAL_ACCESS = "true";
  await db.insert(platformOrganizationsTable).values({
    id: organizationId,
    name: "Replay Reconnect Org",
    slug: `replay-reconnect-${fixtureId}`,
    status: "active",
  });
  // 2+ active platform sites -- exactly the state that broke the count-based
  // fallback for live delivery (#104/#105). This proves the *replay* path
  // stays correct under the same condition.
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

beforeEach(() => {
  __resetMessageHistoryForTest();
  __setConsumerLeaseHeldForTest(false);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  __resetMessageHistoryForTest();
  for (const topic of commEventTopics) {
    await db.delete(mqttCommunicationEventsTable).where(eq(mqttCommunicationEventsTable.topic, topic));
  }
  await db.delete(platformSitesTable).where(eq(platformSitesTable.organizationId, organizationId));
  await db.delete(platformOrganizationsTable).where(eq(platformOrganizationsTable.id, organizationId));
  if (globalPolicy === undefined) delete process.env.SCADA_ALLOW_GLOBAL_ACCESS;
  else process.env.SCADA_ALLOW_GLOBAL_ACCESS = globalPolicy;
});

test("a Last-Event-ID reconnect recovers exactly the durably persisted messages that belong to each active site, and none from another", async () => {
  const topic = `replay-reconnect-clean-${fixtureId}`;
  commEventTopics.push(topic);
  __setSubscriptionTopicForTest(topic);

  const assignedMarker = `replay-clean-assigned-${fixtureId}`;
  const otherMarker = `replay-clean-other-${fixtureId}`;
  // Two contiguous durable deliveries the reconnecting client missed while
  // disconnected: one unlabeled (must fall back to the configured plant
  // site), one explicitly labeled to the unrelated active site.
  await insertPersistedTelemetryEvent(topic, 1, unlabeledPayload(assignedMarker));
  await insertPersistedTelemetryEvent(topic, 2, explicitlyLabeledPayload(otherSite, otherMarker));

  // Last-Event-ID: 0 -- the client's last delivery before the gap, i.e. it
  // missed both of the sequence-1 and sequence-2 deliveries above.
  const assignedStream = await openStream(configuredSite, 0);
  const unrelatedStream = await openStream(otherSite, 0);
  try {
    const readyAssigned = await assignedStream.waitFor((frame) => frame.event === "ready");
    const readyUnrelated = await unrelatedStream.waitFor((frame) => frame.event === "ready");
    assert.ok(readyAssigned, "assigned stream must become ready");
    assert.ok(readyUnrelated, "unrelated stream must become ready");
    assert.equal((readyAssigned!.data as { replayVerified?: boolean }).replayVerified, true, "a contiguous durable range must be verified, not resync-required");
    assert.equal((readyUnrelated!.data as { replayVerified?: boolean }).replayVerified, true);
    assert.equal((readyAssigned!.data as { recoveredThrough?: number }).recoveredThrough, 2);

    assert.ok(
      await assignedStream.waitFor((frame) => messageFrame(frame, assignedMarker)),
      "the configured plant site's stream must recover the unlabeled missed delivery",
    );
    assert.equal(
      assignedStream.hasReceived((frame) => messageFrame(frame, otherMarker)),
      false,
      "the configured plant site's stream must never recover a delivery explicitly labeled to another active site",
    );

    assert.ok(
      await unrelatedStream.waitFor((frame) => messageFrame(frame, otherMarker)),
      "the unrelated active site's stream must recover its own explicitly labeled missed delivery",
    );
    assert.equal(
      unrelatedStream.hasReceived((frame) => messageFrame(frame, assignedMarker)),
      false,
      "the unrelated active site's stream must never recover the configured plant site's unlabeled delivery",
    );
  } finally {
    await assignedStream.close();
    await unrelatedStream.close();
  }
});

test("a Last-Event-ID reconnect that cannot prove a contiguous durable range falls back to resync replay, still filtered per site", async () => {
  const topic = `replay-reconnect-gap-${fixtureId}`;
  commEventTopics.push(topic);
  __setSubscriptionTopicForTest(topic);

  const assignedMarker = `replay-gap-assigned-${fixtureId}`;
  const otherMarker = `replay-gap-other-${fixtureId}`;
  // The in-memory process buffer (what a resync fallback replays from) holds
  // sequences 1 and 2 -- one unlabeled, one explicitly labeled elsewhere.
  __injectMessageHistoryForTest({
    topic,
    payload: unlabeledPayload(assignedMarker),
    receivedAt: new Date().toISOString(),
    sequence: 1,
    delivery: "immediate",
    captureSiteName: configuredSite,
  });
  __injectMessageHistoryForTest({
    topic,
    payload: explicitlyLabeledPayload(otherSite, otherMarker),
    receivedAt: new Date().toISOString(),
    sequence: 2,
    delivery: "immediate",
    captureSiteName: otherSite,
  });
  // A durable delivery at sequence 4 with nothing recorded at sequence 3, in
  // either the ledger or the in-memory buffer -- an unrecoverable gap that
  // must trigger "resync-required" rather than a silently incomplete replay.
  await insertPersistedTelemetryEvent(topic, 4, unlabeledPayload(`replay-gap-unreachable-${fixtureId}`));

  const assignedStream = await openStream(configuredSite, 0);
  const unrelatedStream = await openStream(otherSite, 0);
  try {
    assert.ok(await assignedStream.waitFor((frame) => frame.event === "resync"), "a genuine sequence gap must surface a resync-required event");
    assert.ok(await unrelatedStream.waitFor((frame) => frame.event === "resync"));

    const readyAssigned = await assignedStream.waitFor((frame) => frame.event === "ready");
    assert.ok(readyAssigned, "the stream must still reach ready after the resync fallback replay completes");
    assert.equal((readyAssigned!.data as { replayVerified?: boolean }).replayVerified, false);

    assert.ok(
      await assignedStream.waitFor((frame) => messageFrame(frame, assignedMarker)),
      "the resync fallback must still deliver the configured plant site's own buffered evidence",
    );
    assert.equal(
      assignedStream.hasReceived((frame) => messageFrame(frame, otherMarker)),
      false,
      "the resync fallback must never leak another active site's buffered evidence",
    );

    assert.ok(
      await unrelatedStream.waitFor((frame) => messageFrame(frame, otherMarker)),
      "the unrelated site's resync fallback must still deliver its own buffered evidence",
    );
    assert.equal(
      unrelatedStream.hasReceived((frame) => messageFrame(frame, assignedMarker)),
      false,
      "the unrelated site's resync fallback must never leak the configured plant site's buffered evidence",
    );
  } finally {
    await assignedStream.close();
    await unrelatedStream.close();
  }
});

test("the standby ledger fanout recovers newly persisted deliveries for a listener whose process does not hold the MQTT consumer lease", async () => {
  const topic = `replay-reconnect-ledger-fanout-${fixtureId}`;
  commEventTopics.push(topic);
  __setSubscriptionTopicForTest(topic);
  __setConsumerLeaseHeldForTest(false);

  // Bootstrap with no prior evidence and no Last-Event-ID -- a fresh
  // connection, not a reconnect. This must reach "ready" before any ledger
  // fanout polling is meaningful.
  const assignedStream = await openStream(configuredSite);
  const unrelatedStream = await openStream(otherSite);
  try {
    assert.ok(await assignedStream.waitFor((frame) => frame.event === "ready"), "assigned stream must become ready");
    assert.ok(await unrelatedStream.waitFor((frame) => frame.event === "ready"), "unrelated stream must become ready");

    const assignedMarker = `replay-fanout-assigned-${fixtureId}`;
    const otherMarker = `replay-fanout-other-${fixtureId}`;
    // Simulate telemetry captured by a different process instance (the real
    // MQTT consumer) while this listener's connection was already open and
    // in standby -- it can only ever learn about these through the ledger
    // fanout poll, never through this process's own broadcast().
    await insertPersistedTelemetryEvent(topic, 1, unlabeledPayload(assignedMarker));
    await insertPersistedTelemetryEvent(topic, 2, explicitlyLabeledPayload(otherSite, otherMarker));

    // The ledger fanout polls every 1s; give it a couple of cycles.
    assert.ok(
      await assignedStream.waitFor((frame) => messageFrame(frame, assignedMarker), 4_000),
      "the standby ledger fanout must deliver the configured plant site's own newly persisted evidence",
    );
    assert.equal(
      assignedStream.hasReceived((frame) => messageFrame(frame, otherMarker)),
      false,
      "the standby ledger fanout must never deliver another active site's newly persisted evidence",
    );

    assert.ok(
      await unrelatedStream.waitFor((frame) => messageFrame(frame, otherMarker), 4_000),
      "the standby ledger fanout must deliver the unrelated site's own newly persisted evidence",
    );
    assert.equal(
      unrelatedStream.hasReceived((frame) => messageFrame(frame, assignedMarker)),
      false,
      "the standby ledger fanout must never deliver the configured plant site's evidence to an unrelated site",
    );
  } finally {
    await assignedStream.close();
    await unrelatedStream.close();
  }
});
