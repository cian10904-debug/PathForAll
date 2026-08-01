"use strict";

import assert from "node:assert/strict";
import {
  attachArrivalData,
  boardingGroups,
  getTransitArrivals,
  normalizePredictions,
  predictionFreshness,
  rankRoutesAfterArrivals
} from "./transit-realtime.js";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const route = {
  id: "arrival-test",
  mode: "mixed",
  legs: [
    leg("walk", "walk", "start", "bus-stop", 120, 0),
    leg("bus", "bus", "bus-stop", "transfer", 480, 0, { routeId: "M8", tripId: "bus-trip" }),
    leg("transfer", "transfer", "transfer", "subway-stop", 90, 0),
    leg("subway", "subway", "subway-stop", "end", 600, 0, { routeId: "F", tripId: "subway-trip" })
  ]
};

assert.equal(boardingGroups(route).length, 2, "Bus to Subway creates two boarding groups");

let called = false;
const unavailable = await getTransitArrivals(route, NOW, {
  url: "",
  fetchImpl: async () => {
    called = true;
    throw new Error("should not request without a configured provider");
  }
});
assert.equal(called, false);
assert.equal(unavailable.status, "unavailable");
assert.equal(unavailable.boardings.length, 2);
assert.ok(unavailable.boardings.every(boarding => boarding.predictions.length === 0), "missing provider never produces synthetic arrivals");

const requestUrls = [];
const available = await getTransitArrivals(route, NOW, {
  url: "https://arrivals.example.test/predictions",
  fetchImpl: async url => {
    requestUrls.push(String(url));
    const isBus = String(url).includes("mode=bus");
    return {
      ok: true,
      json: async () => ({
        source: "MTA-compatible provider",
        sourceLabel: "Provider",
        updatedAt: "2026-07-29T11:59:30.000Z",
        maxAgeSeconds: 180,
        predictions: [{ timestamp: isBus ? "2026-07-29T12:05:00.000Z" : "2026-07-29T12:23:30.000Z" }]
      })
    };
  }
});
assert.equal(available.status, "available");
assert.equal(available.boardings.length, 2);
assert.equal(available.boardings[0].selectedPrediction.waitSeconds, 180);
assert.equal(available.boardings[1].selectedPrediction.waitSeconds, 540);
assert.equal(requestUrls.length, 2, "every boarding receives its own provider lookup");
assert.match(requestUrls[0], /stopId=bus-stop/);
assert.match(requestUrls[1], /stopId=subway-stop/);
assert.match(requestUrls[0], /tripId=bus-trip/);

const attached = attachArrivalData(route, available);
assert.equal(route.legs[1].waitSeconds, 0, "attaching arrivals does not mutate the original route");
assert.equal(attached.legs[1].waitSeconds, 180);
assert.equal(attached.legs[3].waitSeconds, 540);
assert.equal(attached.totalWaitSeconds, 720, "both boarding waits are counted from the time the rider reaches each stop");
assert.equal(attached.totalDurationSeconds, 2010, "access, rides, transfer, and both waits remain in seconds");
const attachedAgain = attachArrivalData(attached, available);
assert.equal(attachedAgain.totalWaitSeconds, 720, "refreshing arrivals does not double-count waits");
assert.equal(attachedAgain.totalDurationSeconds, 2010);

assert.deepEqual(
  normalizePredictions([{ timestamp: "2026-07-29T11:59:00.000Z" }], NOW),
  [],
  "an arrival earlier than departure is excluded"
);
assert.equal(predictionFreshness(null, "2026-07-29T11:50:00.000Z", 180, NOW), "stale");

const stale = await getTransitArrivals(route, NOW, {
  url: "https://arrivals.example.test/predictions",
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      source: "Stale provider",
      updatedAt: "2026-07-29T11:50:00.000Z",
      maxAgeSeconds: 180,
      predictions: [{ timestamp: "2026-07-29T12:05:00.000Z" }]
    })
  })
});
assert.equal(stale.status, "stale");
assert.ok(stale.boardings.every(boarding => boarding.predictions.length === 0), "stale predictions are not shown as current");

const scheduled = await getTransitArrivals({
  mode: "ferry",
  legs: [leg("ferry", "ferry", "battery", "liberty", 0, 0, { routeId: "battery-liberty" })]
}, NOW, {
  url: "https://arrivals.example.test/predictions",
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({ sourceLabel: "Schedule", scheduledPredictions: [{ timestamp: "2026-07-29T12:20:00.000Z" }] })
  })
});
assert.equal(scheduled.boardings[0].selectedPrediction.kind, "scheduled", "scheduled estimates remain distinguishable from realtime");

const slowerBeforeWait = { ...route, id: "short-ride-long-wait", totalDurationSeconds: 900, transfers: 0, trust: { criticalUnknowns: 0 } };
const fasterAfterWait = { ...route, id: "longer-ride-short-wait", totalDurationSeconds: 780, transfers: 0, trust: { criticalUnknowns: 0 } };
const finalRanking = rankRoutesAfterArrivals([slowerBeforeWait, fasterAfterWait], {});
assert.equal(finalRanking.routes[0].id, "longer-ride-short-wait", "final wait-enriched duration determines recommendation order");
assert.equal(finalRanking.routes[0].label, "Recommended");

console.log("Production multi-boarding arrival, wait-time, and freshness tests passed.");

function leg(id, mode, fromId, toId, durationSeconds, waitSeconds, options = {}) {
  return {
    id,
    mode,
    from: { id: fromId, name: fromId, coordinates: [-73.99, 40.73] },
    to: { id: toId, name: toId, coordinates: [-73.98, 40.74] },
    durationSeconds,
    distanceMeters: 300,
    waitSeconds,
    routeId: options.routeId,
    routeName: options.routeId,
    tripId: options.tripId,
    geometry: null,
    accessibility: {}
  };
}
