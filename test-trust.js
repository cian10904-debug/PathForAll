"use strict";

import assert from "node:assert/strict";
import { applyTrustMetadata, saveSegmentReview, summarizeRouteTrust, clearSegmentReviews } from "./trust-store.js";
import { applyMtaElevatorRecords } from "./elevator-status.js";
import { distanceToRouteMeters } from "./navigation.js";
import { fallbackNodes, fallbackEdges } from "./tests/fixtures/cooper-union-graph.js";
import { dijkstra, PROFILE_WEIGHTS } from "./routing.js";
import { prepareTransitStops, planTransitRoutes } from "./transit-routing.js";
import { TRANSIT_STOPS, TRANSIT_EDGES } from "./tests/fixtures/cooper-union-transit.js";

const needs = {
  wheelchairMode: true,
  avoidStairs: true,
  requireCurb: true,
  preferSmooth: true,
  requireElevator: true,
  preferShade: false,
  avoidRain: false,
  minimizeTransfers: true,
  maxSlope: 6,
  maxWalkMinutes: 15,
  customNeeds: []
};
const weather = { temperatureF: 75, isRaining: false };

clearSegmentReviews();
const base = [{ id: "e1", osmWayId: 1, distanceMeters: 100, minutes: 1, from: "a", to: "b", confidence: .5, surface: "smooth", slope: 2, requiresCurbRamp: false, wheelchairStatus: "yes", pedestrianEvidence: "dedicated", roadCenterline: false, blocked: false }];
let enriched = applyTrustMetadata(base);
assert.equal(enriched[0].dataSourceType, "openstreetmap");
saveSegmentReview("e1", "barrier", "blocked curb");
enriched = applyTrustMetadata(base);
assert.equal(enriched[0].blocked, true);
const summary = summarizeRouteTrust({ edgeIds: ["e1"] }, enriched);
assert.equal(summary.barrierSegments, 1);

const reviewedFallback = applyTrustMetadata(fallbackEdges);
const rerouted = dijkstra(fallbackNodes, reviewedFallback, "cooper", "washNE", needs, weather, PROFILE_WEIGHTS.balanced);
assert.ok(rerouted);
assert.ok(!rerouted.edgeIds.includes("e1"), "a locally reviewed barrier must be removed from routing");

const stops = prepareTransitStops(fallbackNodes, TRANSIT_STOPS, { maxSnapDistanceMeters: 650 }).map(stop => stop.id === "w4-subway" ? {
  ...stop,
  stationComplexId: "mta:subway:complex:w4",
  platformStopId: "mta:subway:platform:w4-south",
  directionId: "south",
  accessiblePaths: [{
    id: "mta:path:w4-south",
    entranceId: "mta:subway:entrance:w4",
    fareControlAreaId: "mta:subway:station:w4",
    complete: true,
    wheelchairAccessible: true,
    actions: ["boarding", "exit"],
    platformStopIds: ["mta:subway:platform:w4-south"],
    directionIds: ["south"],
    equipmentCodes: ["EL-W4-01"]
  }]
} : stop);
const updatedStops = applyMtaElevatorRecords(stops, [{
  equipmentCode: "EL-W4-01",
  status: "out",
  source: "MTA asset/status snapshot",
  updatedAt: "2026-07-29T12:00:00.000Z",
  freshness: "current"
}]);
assert.equal(updatedStops.find(stop => stop.id === "w4-subway").elevatorStatus, "out");
const alternativePath = applyMtaElevatorRecords([{
  ...stops.find(stop => stop.id === "w4-subway"),
  accessiblePaths: [
    ...stops.find(stop => stop.id === "w4-subway").accessiblePaths,
    {
      id: "mta:path:w4-south-alternative",
      entranceId: "mta:subway:entrance:w4-alt",
      fareControlAreaId: "mta:subway:station:w4",
      complete: true,
      wheelchairAccessible: true,
      actions: ["boarding", "exit"],
      platformStopIds: ["mta:subway:platform:w4-south"],
      directionIds: ["south"],
      equipmentCodes: ["EL-W4-02"]
    }
  ]
}], [
  { equipmentCode: "EL-W4-01", status: "out", freshness: "current", updatedAt: "2099-01-01T12:00:00.000Z" },
  { equipmentCode: "EL-W4-02", status: "working", freshness: "current", updatedAt: "2099-01-01T12:00:00.000Z" }
])[0];
assert.equal(alternativePath.elevatorStatus, "working", "one failed elevator does not remove a complex when another complete path remains");
const subway = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs,
  weather,
  mode: "subway",
  transitStops: updatedStops,
  transitEdges: TRANSIT_EDGES
});
assert.ok(subway.every(route => route.entryStop.id !== "w4-subway" && route.exitStop.id !== "w4-subway"));

const distance = distanceToRouteMeters([-73.99, 40.73], [[-73.99, 40.73], [-73.98, 40.73]]);
assert.ok(distance < 1);
console.log("Local trust, elevator, and off-route fixture tests passed.");
