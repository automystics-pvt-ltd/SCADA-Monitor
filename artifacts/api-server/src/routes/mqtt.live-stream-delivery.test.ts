import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express, { type Request } from "express";
import { eq } from "drizzle-orm";
import { db, platformOrganizationsTable, platformSitesTable } from "@workspace/db";
import { logger } from "../lib/logger.ts";
import mqttRouter, { __broadcastMessageForTest, __setConfiguredMqttPlantSiteForTest, type StoredMessage } from "./mqtt.ts";

// Regression coverage for task #104: a unit test already proves
// messageBelongsToSite() resolves an unlabeled message correctly in
// isolation (mqtt.message-site-attribution.test.ts). That alone would NOT
// have caught the production incident, because the actual bug reached
// operators through the full `/mqtt/stream` SSE pipeline -- the connection
// kept reporting "connected" while zero live `message` events were ever
// delivered. This test drives that real pipeline end-to-end: it opens an
// actual SSE connection to the real route with 2+ active platform sites
// configured, triggers the same `broadcast()` call a live broker delivery
// would, and asserts the assigned site's listener truly receives the
// `message` event over the wire -- and that an unrelated site's listener
// never does.

const fixtureId = randomUUID();
const configuredSite = `Live Stream Delivery Plant ${fixtureId}`;
const otherSite = `Live Stream Delivery Fixture ${fixtureId}`;
const organizationId = `live-stream-delivery-org-${fixtureId}`;
const globalPolicy = process.env.SCADA_ALLOW_GLOBAL_ACCESS;

const globalPrincipal = {
  id: `live-stream-global-user-${fixtureId}`,
  email: `live-stream-global-${fixtureId}@example.com`,
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

before(async () => {
  process.env.SCADA_ALLOW_GLOBAL_ACCESS = "true";
  await db.insert(platformOrganizationsTable).values({
    id: organizationId,
    name: "Live Stream Delivery Org",
    slug: `live-stream-delivery-${fixtureId}`,
    status: "active",
  });
  // 2+ active platform sites -- exactly the state that broke the
  // count-based fallback: an unlabeled message must still reach the site
  // this server's broker/topic is actually configured for.
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

test("an unlabeled live message reaches the configured plant site's real SSE stream and not an unrelated active site's", async () => {
  const assignedStream = await openStream(configuredSite);
  const unrelatedStream = await openStream(otherSite);
  try {
    // Both streams must finish their connection handshake before we inject
    // the message, so a slow initial replay can't be mistaken for a miss.
    assert.ok(await assignedStream.waitFor((frame) => frame.event === "ready"), "assigned stream must become ready");
    assert.ok(await unrelatedStream.waitFor((frame) => frame.event === "ready"), "unrelated stream must become ready");

    const marker = `live-stream-delivery-${fixtureId}`;
    const message: StoredMessage = {
      // Real broker payloads from this plant's single physical topic never
      // carry an explicit site/plant name field (see
      // mqtt.message-site-attribution.test.ts for the documented wire
      // format) -- this is exactly the shape that must fall back to the
      // configured plant site rather than any active-site count.
      topic: "trn246/modbus",
      payload: JSON.stringify({ Automystics: { addr: 5003, data: "4018", name: "inv1", server_name: "ana", marker } }),
      receivedAt: new Date().toISOString(),
      sequence: Date.now(),
      delivery: "immediate",
      captureSiteName: configuredSite,
    };
    __broadcastMessageForTest(message);

    const delivered = await assignedStream.waitFor((frame) =>
      frame.event === "message"
      && typeof frame.data === "object" && frame.data !== null
      && (frame.data as { payload?: string }).payload === message.payload);
    assert.ok(delivered, "the configured plant site's SSE stream must receive the live message event");

    // Give the unrelated stream every chance to (wrongly) receive the same
    // broadcast before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      unrelatedStream.hasReceived((frame) =>
        frame.event === "message"
        && typeof frame.data === "object" && frame.data !== null
        && (frame.data as { payload?: string }).payload === message.payload),
      false,
      "an unrelated active site's SSE stream must never receive another site's live message",
    );
  } finally {
    await assignedStream.close();
    await unrelatedStream.close();
  }
});
