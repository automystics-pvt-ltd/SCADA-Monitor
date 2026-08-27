import assert from "node:assert/strict";
import test from "node:test";
import {
  __setConfiguredMqttPlantSiteForTest,
  messageBelongsToSite,
  type StoredMessage,
} from "./mqtt.ts";

// Real broker payloads from this plant's single physical topic never carry an
// explicit site/plant name field (confirmed against production telemetry: the
// wire format is `{"Automystics": {addr, data, name, server_name, ...}}`).
// messageBelongsToSite() is the exact gate the live SSE stream uses to decide
// which connected dashboard a message is broadcast to. Regression: this used
// to fall back on "is exactly one platform site currently active", which
// silently broke the moment a second site (e.g. a QA fixture) was registered
// — every unlabeled message then matched nobody, live status/heartbeats kept
// flowing, and dashboards showed "connected" while zero telemetry ever
// arrived. It must instead always resolve to the site this server's broker
// topic is actually configured for, independent of how many sites exist.
function unlabeledMessage(): StoredMessage {
  return {
    topic: "trn246/modbus",
    payload: JSON.stringify({ Automystics: { addr: 5003, data: "4018", name: "inv1", server_name: "ana" } }),
    receivedAt: "2026-08-27T05:00:00.000Z",
    sequence: 1,
    delivery: "immediate",
    captureSiteName: "Sambavi",
  };
}

function explicitlyLabeledMessage(siteName: string): StoredMessage {
  return {
    topic: "qa-fixture/topic",
    // `name`/`data` must be present: telemetryParameterFromRawPayload() only
    // recognizes an object as a telemetry parameter (and thus reads its
    // site_name) when at least one of those fields is set.
    payload: JSON.stringify({ site_name: siteName, name: "fixtureMarker", data: "1" }),
    receivedAt: "2026-08-27T05:00:00.000Z",
    sequence: 1,
    delivery: "immediate",
    captureSiteName: siteName,
  };
}

test("an unlabeled message is attributed to the configured plant site no matter how many other sites are active", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  assert.equal(messageBelongsToSite(unlabeledMessage(), "Sambavi"), true);
  assert.equal(messageBelongsToSite(unlabeledMessage(), "QA Fixture Plant"), false);
  assert.equal(messageBelongsToSite(unlabeledMessage(), "Some Other Managed Site"), false);
});

test("an explicitly declared source site always wins over the configured plant site", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  const labeled = explicitlyLabeledMessage("QA Fixture Plant");
  assert.equal(messageBelongsToSite(labeled, "QA Fixture Plant"), true);
  assert.equal(messageBelongsToSite(labeled, "Sambavi"), false);
});

test("an unscoped broadcast (no siteName filter) reaches every message", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  assert.equal(messageBelongsToSite(unlabeledMessage(), undefined), true);
});
