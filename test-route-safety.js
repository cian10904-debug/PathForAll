"use strict";

import assert from "node:assert/strict";
import { accessiblePathSupports } from "./elevator-status.js";
import {
  connectRouteEndpoints,
  parseOverpassGraph
} from "./osm-network.js";
import {
  isPedestrianOffRouteEligible,
  recordNavigationCompletionOnce,
  splitRouteGeometrySegments
} from "./navigation.js";
import { normalizeRouteOption } from "./route-model.js";
import { isEdgeAllowed } from "./routing.js";
import { loadTransitNetwork } from "./transit-network-service.js";
import { planTransitRoutes } from "./transit-routing.js";

const elevatorGraph = parseOverpassGraph({
  elements: [
    { type: "node", id: 1, lon: -73.99, lat: 40.73 },
    { type: "node", id: 2, lon: -73.99, lat: 40.7301 },
    { type: "way", id: 10, nodes: [1, 2], tags: { highway: "elevator", wheelchair: "yes" } }
  ]
});
assert.equal(elevatorGraph.edges[0].elevatorStatus, "unknown", "OSM elevators never default to working");
assert.equal(elevatorGraph.edges[0].elevator.authoritative, false);

const unsupportedRoad = parseOverpassGraph({
  elements: [
    { type: "node", id: 1, lon: -73.99, lat: 40.73 },
    { type: "node", id: 2, lon: -73.98, lat: 40.73 },
    { type: "way", id: 20, nodes: [1, 2], tags: { highway: "primary" } }
  ]
});
assert.equal(unsupportedRoad.edges.length, 0, "a motor-road centerline without pedestrian evidence is excluded");

assert.equal(isEdgeAllowed({
  blocked: false,
  pedestrianEvidence: "dedicated",
  roadCenterline: false,
  requiresCurbRamp: true,
  curbRamp: null
}, { wheelchairMode: true, requireCurb: true, curbPolicy: "required" }), false, "unknown curb data fails a strict requirement");

const stalePath = {
  complete: true,
  wheelchairAccessible: true,
  status: "working",
  freshness: "stale",
  updatedAt: "2099-01-01T12:00:00.000Z",
  entranceId: "entrance",
  fareControlAreaId: "fare",
  platformStopIds: ["platform"],
  actions: ["boarding"]
};
assert.equal(accessiblePathSupports(stalePath, "boarding", { platformStopId: "platform" }), false);
assert.equal(accessiblePathSupports({ ...stalePath, freshness: "unknown" }, "boarding", { platformStopId: "platform" }), false);
assert.equal(accessiblePathSupports({ ...stalePath, freshness: "current" }, "boarding", { platformStopId: "platform" }), true);

const nodes = {
  a: { id: "a", coordinates: [-73.9900, 40.7300] },
  b: { id: "b", coordinates: [-73.9890, 40.7300] }
};
const edges = [{
  id: "path",
  from: "a",
  to: "b",
  geometry: [nodes.a.coordinates, nodes.b.coordinates],
  distanceMeters: 84,
  minutes: 1.1,
  pedestrianEvidence: "dedicated",
  roadCenterline: false,
  bidirectional: true
}];
const connected = connectRouteEndpoints(
  nodes,
  edges,
  { id: "start", name: "Start", coordinates: nodes.a.coordinates },
  { id: "end", name: "End", coordinates: nodes.b.coordinates }
);
assert.equal(connected.startId, "a");
assert.equal(connected.endId, "b");
const rejectedConnector = connectRouteEndpoints(
  nodes,
  edges,
  { id: "start", coordinates: [-73.9900, 40.7310] },
  { id: "end", coordinates: nodes.b.coordinates },
  { maxProjectionDistanceMeters: 2 }
);
assert.equal(rejectedConnector.startId, null, "a distant straight endpoint snap is rejected");

assert.equal(normalizeRouteOption({
  id: "omitted-access",
  mode: "walk",
  legs: [{
    id: "walk",
    mode: "walk",
    from: { id: "snapped", coordinates: [-73.98, 40.73] },
    to: { id: "end", coordinates: [-73.97, 40.73] },
    durationSeconds: 100,
    distanceMeters: 800,
    geometry: { type: "LineString", coordinates: [[-73.98, 40.73], [-73.97, 40.73]] }
  }]
}, {
  start: { id: "actual", coordinates: [-73.99, 40.73] },
  end: { id: "end", coordinates: [-73.97, 40.73] }
}), null, "a route cannot omit the selected-to-graph connection");

await assert.rejects(loadTransitNetwork({
  url: "https://transit.example.test/network",
  mode: "bus",
  start: [-73.99, 40.73],
  end: [-73.98, 40.74],
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      freshness: "stale",
      updatedAt: "2020-01-01T00:00:00.000Z",
      capabilities: { modes: ["bus"] },
      stops: [
        { id: "a", coordinates: [-73.99, 40.73], modes: ["bus"] },
        { id: "b", coordinates: [-73.98, 40.74], modes: ["bus"] }
      ],
      edges: [{
        id: "ride",
        from: "a",
        to: "b",
        mode: "bus",
        route: "M8",
        minutes: 5,
        scheduleVerified: true,
        scheduleSource: "provider",
        scheduleUpdatedAt: "2020-01-01T00:00:00.000Z",
        scheduleFreshness: "stale",
        scheduledWaitSeconds: 120
      }]
    })
  })
}), error => error.code === "TRANSIT_DATA_STALE", "stale topology fails closed");

assert.deepEqual(planTransitRoutes({
  pedestrianNodes: nodes,
  pedestrianEdges: edges,
  startId: "a",
  endId: "b",
  needs: { maxWalkMinutes: 10 },
  mode: "bus",
  transitStops: [
    { id: "s1", coordinates: nodes.a.coordinates, modes: ["bus"], pedestrianNodeId: "a", snapStatus: "valid" },
    { id: "s2", coordinates: nodes.b.coordinates, modes: ["bus"], pedestrianNodeId: "b", snapStatus: "valid" }
  ],
  transitEdges: [{ id: "ride", from: "s1", to: "s2", mode: "bus", route: "M8", minutes: 5 }]
}), [], "static topology without a verified time-dependent schedule is unavailable");

assert.equal(isPedestrianOffRouteEligible({ type: "bus", coordinates: [nodes.a.coordinates, nodes.b.coordinates] }, 5), false);
assert.equal(isPedestrianOffRouteEligible({ type: "walk", coordinates: [nodes.a.coordinates, nodes.b.coordinates] }, 80), false);
assert.equal(isPedestrianOffRouteEligible({ type: "walk", coordinates: [nodes.a.coordinates, nodes.b.coordinates] }, 8), true);
assert.equal(splitRouteGeometrySegments([nodes.a.coordinates, null, nodes.b.coordinates]).length, 2);
const navigation = { completedRecorded: false };
let completions = 0;
assert.equal(recordNavigationCompletionOnce(navigation, () => { completions += 1; }, {}), true);
assert.equal(recordNavigationCompletionOnce(navigation, () => { completions += 1; }, {}), false);
assert.equal(completions, 1, "preview and GPS completion share one guard");

console.log("Route trust boundaries, connector, stale-data, schedule, and navigation safety tests passed.");
