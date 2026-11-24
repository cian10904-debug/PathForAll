"use strict";

import assert from "node:assert/strict";
import {
  createRoutingService,
  providerSupportsMode,
  routeSourceForMode
} from "./route-service.js";
import {
  normalizeTransitIdentifier,
  normalizeTransitNetwork,
  isAllowedTransitIdentifier,
  transitNetworkRequestUrl
} from "./transit-network-service.js";

const walkOnly = { available: true, modes: ["walk"] };
assert.equal(providerSupportsMode(walkOnly, "bus"), false);
assert.equal(routeSourceForMode("bus", walkOnly, { transitNetwork: true }), "transit-network", "a walking-only provider is bypassed for Bus");
assert.equal(routeSourceForMode("bus", walkOnly, { transitNetwork: false }), "unavailable");
assert.equal(routeSourceForMode("walk", walkOnly, { transitNetwork: true }), "route-provider");
assert.equal(routeSourceForMode("subway", { available: true, modes: ["subway"] }), "route-provider");

let called = false;
const walkingService = createRoutingService({
  url: "https://routes.example.test/plan",
  capabilities: walkOnly,
  fetchImpl: async () => {
    called = true;
    throw new Error("unsupported mode must not be requested");
  }
});
await assert.rejects(
  walkingService.plan({ start: point("start"), end: point("end"), needs: {}, mode: "bus" }),
  error => error.code === "UNSUPPORTED_MODE"
);
assert.equal(called, false, "unsupported provider mode is rejected before network I/O");

const busService = createRoutingService({
  url: "https://routes.example.test/plan",
  capabilities: { available: true, modes: ["bus"] },
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      freshness: "current",
      updatedAt: "2099-01-01T12:00:00.000Z",
      expiresAt: "2099-01-01T13:00:00.000Z",
      routes: [{
        id: "bus-route",
        mode: "bus",
        legs: [{
          id: "bus-leg",
          mode: "bus",
          from: point("start"),
          to: point("end"),
          routeId: "M8",
          departureTime: "2026-11-24T15:00:00.000Z",
          arrivalTime: "2026-11-24T15:10:00.000Z",
          durationSeconds: 600,
          distanceMeters: 1200,
          geometry: null
        }]
      }]
    })
  })
});
assert.equal((await busService.plan({ start: point("start"), end: point("end"), needs: {}, mode: "bus", departureTime: new Date("2026-11-24T15:00:00Z") })).length, 1, "a Bus-capable provider is used for Bus mode");

assert.equal(normalizeTransitIdentifier("MTA_308209", { agency: "mta", mode: "bus", kind: "stop" }), "mta:bus:stop:308209");
assert.equal(normalizeTransitIdentifier("308209", { agency: "mta", mode: "bus", kind: "stop" }), "mta:bus:stop:308209");
assert.equal(normalizeTransitIdentifier("statue-city-cruises:terminal:battery", { agency: "statue-city-cruises", mode: "ferry", kind: "terminal" }), "statue-city-cruises:terminal:battery");
assert.equal(normalizeTransitIdentifier("unexpected:namespace:value"), null, "an arbitrary colon-delimited ID is rejected");
assert.equal(isAllowedTransitIdentifier("mta:subway:platform:A32S"), true);
assert.equal(isAllowedTransitIdentifier("other:subway:platform:A32S"), false);

const network = normalizeTransitNetwork({
  agency: "mta",
  stops: [
    { id: "MTA_308209", name: "Boarding stop", coordinates: [-73.99, 40.73], modes: ["bus"] },
    { id: "308210", name: "Exit stop", coordinates: [-73.98, 40.74], modes: ["bus"] }
  ],
  edges: [{ id: "trip-edge", from: "MTA_308209", to: "308210", mode: "bus", route: "M8", minutes: 6 }]
});
assert.equal(network.stops[0].providerId, "MTA_308209", "the original provider ID is retained for diagnostics");
assert.equal(network.edges[0].from, "mta:bus:stop:308209");
assert.equal(network.edges[0].to, "mta:bus:stop:308210");
assert.equal(network.edges[0].bidirectional, false, "one-way remains the safe provider default");
assert.throws(() => normalizeTransitNetwork({
  agency: "mta",
  stops: [
    { id: "same", coordinates: [-73.99, 40.73], modes: ["bus"] },
    { id: "same", coordinates: [-73.98, 40.74], modes: ["bus"] }
  ],
  edges: []
}), error => error.code === "PROVIDER_CONTRACT_ERROR", "ambiguous compound provider IDs are rejected");

const scoped = transitNetworkRequestUrl("https://transit.example.test/corridor", {
  start: [-73.99, 40.73],
  end: [-73.98, 40.74],
  mode: "subway",
  maxWalkMinutes: 12,
  departureTime: new Date("2026-07-29T12:00:00.000Z")
});
assert.match(String(scoped), /mode=subway/);
assert.match(String(scoped), /start=-73.99%2C40.73/);
assert.match(String(scoped), /departureTime=/);

console.log("Production provider-capability, scoped-network, and identifier tests passed.");

function point(id) {
  return { id, name: id, coordinates: id === "start" ? [-73.99, 40.73] : [-73.98, 40.74] };
}
