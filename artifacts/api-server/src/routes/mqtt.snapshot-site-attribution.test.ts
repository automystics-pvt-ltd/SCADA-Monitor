import assert from "node:assert/strict";
import test from "node:test";
import {
  __setConfiguredMqttPlantSiteForTest,
  snapshotBelongsToSite,
} from "./mqtt.ts";

// Companion to mqtt.message-site-attribution.test.ts, but for the "snapshot"
// SSE event's own attribution gate. snapshotBelongsToSite() has the same
// similar-shaped array-scanning logic messageBelongsToSite() had before task
// #104's fix, and the same failure mode is plausible here: a scheduled
// snapshot whose evidence carries no explicit site/plant label anywhere (the
// common real-broker shape, or a "missing"/"incomplete" window with zero
// captured messages) must still resolve to the site this server's single
// configured broker/topic is mapped to -- independent of how many platform
// sites are active -- or the live "snapshot" broadcast silently stops
// reaching every plant's dashboard.
function unlabeledSnapshotData() {
  return {
    schemaVersion: 4,
    messages: [{
      topic: "trn246/modbus",
      payload: JSON.stringify({ Automystics: { addr: 5003, data: "4018", name: "inv1", server_name: "ana" } }),
    }],
    latestParameters: [{ name: "inv1", data: "4018", server_name: "ana", address: "5003" }],
    latestDiscoveredParameters: [{ name: "inv1", signalKey: "inv1|5003" }],
  };
}

function explicitlyLabeledSnapshotData(siteName: string) {
  return {
    schemaVersion: 4,
    messages: [],
    latestParameters: [{ site_name: siteName, name: "fixtureMarker", data: "1" }],
    latestDiscoveredParameters: [],
  };
}

function emptySnapshotData() {
  // Exactly the shape of a "missing" scheduled window: zero messages, zero
  // parameters, zero discovered parameters. There is nothing explicit to key
  // off of, but the snapshot is still real evidence for this server's one
  // configured plant site and must be routed there.
  return { schemaVersion: 4, saveStatus: "missing", messages: [], latestParameters: [], latestDiscoveredParameters: [] };
}

test("unlabeled snapshot evidence is attributed to the configured plant site no matter how many other sites are active", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  assert.equal(snapshotBelongsToSite({ data: unlabeledSnapshotData() }, "Sambavi"), true);
  assert.equal(snapshotBelongsToSite({ data: unlabeledSnapshotData() }, "QA Fixture Plant"), false);
  assert.equal(snapshotBelongsToSite({ data: unlabeledSnapshotData() }, "Some Other Managed Site"), false);
});

test("an entirely empty ('missing') snapshot still resolves to the configured plant site", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  assert.equal(snapshotBelongsToSite({ data: emptySnapshotData() }, "Sambavi"), true);
  assert.equal(snapshotBelongsToSite({ data: emptySnapshotData() }, "QA Fixture Plant"), false);
});

test("an explicitly declared source site always wins over the configured plant site", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  const labeled = explicitlyLabeledSnapshotData("QA Fixture Plant");
  assert.equal(snapshotBelongsToSite({ data: labeled }, "QA Fixture Plant"), true);
  assert.equal(snapshotBelongsToSite({ data: labeled }, "Sambavi"), false);
});

test("an unscoped broadcast (no siteName filter) reaches every snapshot", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  assert.equal(snapshotBelongsToSite({ data: unlabeledSnapshotData() }, undefined), true);
  assert.equal(snapshotBelongsToSite({ data: emptySnapshotData() }, undefined), true);
});

test("non-object snapshot data never matches a scoped site", () => {
  __setConfiguredMqttPlantSiteForTest("Sambavi");
  assert.equal(snapshotBelongsToSite({ data: null }, "Sambavi"), false);
  assert.equal(snapshotBelongsToSite({ data: "not-a-record" }, "Sambavi"), false);
});
