"use strict";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP_VERSION } from "./app-version.js";
import { applyMobilityPreset, normalizeProfile } from "./profile-store.js";
import { clearSavedRoutes, loadSavedRoutes, saveRoute } from "./saved-store.js";
import {
  StorageAdapterError,
  createMemoryStorage,
  createStorageAdapter
} from "./storage-adapter.js";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(APP_VERSION, packageJson.version, "browser exports and package.json share one enforced version");

const profiles = {
  wheelchair: normalizeProfile({ needs: { mobilityProfile: "wheelchair" } }).needs,
  limited: normalizeProfile({ needs: { mobilityProfile: "limited" } }).needs,
  senior: normalizeProfile({ needs: { mobilityProfile: "senior" } }).needs,
  custom: normalizeProfile({
    needs: {
      mobilityProfile: "custom",
      wheelchairMode: false,
      avoidStairs: false,
      requireCurb: false,
      requireElevator: false,
      preferSmooth: false
    }
  }).needs
};
assert.equal(profiles.wheelchair.wheelchairMode, true);
assert.equal(profiles.limited.wheelchairMode, false);
assert.equal(profiles.limited.requireElevator, true);
assert.equal(profiles.senior.preferShade, true);
assert.equal(profiles.senior.requireElevator, false);
assert.equal(profiles.custom.wheelchairMode, false);
assert.equal(profiles.custom.avoidStairs, false, "Custom preserves manual choices");
assert.notDeepEqual(applyMobilityPreset("limited"), applyMobilityPreset("senior"));

const memory = createMemoryStorage();
const adapter = createStorageAdapter({ storage: memory });
adapter.writeJson("valid", { enabled: true }, { version: 2 });
assert.deepEqual(adapter.readJson("valid", null), { enabled: true });
memory.setItem("corrupt", "{not-json");
assert.deepEqual(adapter.readJson("corrupt", []), [], "corrupt JSON is recovered with the supplied fallback");

const quotaStorage = {
  getItem() { return null; },
  removeItem() {},
  setItem() {
    const error = new Error("full");
    error.name = "QuotaExceededError";
    throw error;
  }
};
const quotaAdapter = createStorageAdapter({ storage: quotaStorage });
assert.throws(
  () => quotaAdapter.writeJson("profile", { name: "Ada" }),
  error => error instanceof StorageAdapterError
    && error.code === "STORAGE_QUOTA_EXCEEDED"
    && error.recoveredInMemory
);
assert.deepEqual(quotaAdapter.readJson("profile", null), { name: "Ada" }, "quota failures retain a non-crashing session copy");

clearSavedRoutes();
saveRoute(
  {
    id: "ferry-route",
    mode: "ferry",
    label: "Ferry",
    totalDurationSeconds: 1200,
    totalWalkingMeters: 0,
    totalWaitSeconds: 300,
    transfers: 0,
    distanceMeters: 3000,
    accessibility: { wheelchairAccessible: "unknown" },
    trust: { confidence: .8 },
    legs: [{
      id: "ferry-leg",
      mode: "ferry",
      from: { id: "start", name: "The Battery", coordinates: [-74.0169, 40.7034] },
      to: { id: "end", name: "Liberty Island", coordinates: [-74.0450, 40.6897] },
      routeId: "battery-liberty",
      routeName: "The Battery to Liberty Island",
      headsign: "Liberty Island",
      durationSeconds: 900,
      distanceMeters: 3000,
      waitSeconds: 300,
      departureTime: "2099-01-01T12:30:00.000Z",
      arrivalTime: "2099-01-01T12:45:00.000Z",
      geometry: null,
      accessibility: { wheelchairAccessible: "unknown" }
    }]
  },
  { id: "start", name: "The Battery", coordinates: [-74.0169, 40.7034] },
  { id: "end", name: "Liberty Island", coordinates: [-74.0450, 40.6897] }
);
assert.equal(loadSavedRoutes()[0].mode, "ferry", "Ferry mode survives save and reload");
assert.equal(loadSavedRoutes()[0].legs[0].mode, "ferry", "saved routes retain normalized legs.");
assert.equal(loadSavedRoutes()[0].totalWaitSeconds, 300);
clearSavedRoutes();

const [html, app] = await Promise.all([readFile("index.html", "utf8"), readFile("app.js", "utf8")]);
assert.doesNotMatch(html, /type="password"/, "the on-device profile has no nonfunctional password field");
assert.match(html, /deleteAllDataButton/);
assert.match(app, /applySelectedMobilityPreset/);

console.log("Storage recovery, profile presets, privacy controls, and Ferry persistence tests passed.");
