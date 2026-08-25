import assert from "node:assert/strict";
import test from "node:test";
import { dashboardAccessState, type ScadaAccessState } from "./scada-access.ts";

const state = (overrides: Partial<ScadaAccessState> = {}): ScadaAccessState => ({
  sites: [],
  roles: {},
  global: false,
  loading: false,
  error: "",
  ...overrides,
});

test("SCADA dashboard waits for scoped access before rendering site data", () => {
  assert.equal(dashboardAccessState(state({ loading: true }), "north"), "loading");
  assert.equal(dashboardAccessState(state({ sites: ["north"], roles: { north: "viewer" } }), "north"), "ready");
  assert.equal(dashboardAccessState(state({ sites: ["north"] }), "south"), "denied");
  assert.equal(dashboardAccessState(state({ global: true }), "south"), "ready");
  assert.equal(dashboardAccessState(state({ error: "Access request failed" }), "north"), "unavailable");
});