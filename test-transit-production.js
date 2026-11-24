"use strict";

import assert from "node:assert/strict";
import {
  isBoardingStopUsable,
  isPassThroughStopUsable,
  planTransitRoutes,
  prepareTransitStops,
  validateTransitItinerary,
  isTransitEdgeActive
} from "./transit-routing.js";
import { fallbackEdges, fallbackNodes } from "./tests/fixtures/cooper-union-graph.js";

const needs = {
  wheelchairMode: true,
  requireElevator: true,
  requireCurb: true,
  maxSlope: 6,
  maxWalkMinutes: 2,
  minimizeTransfers: true
};
const weather = { temperatureF: 70, isRaining: false };
const stopDefinitions = [
  stop("entry", "Accessible entry", "cooper", ["bus"], true),
  stop("middle", "Pass-through only", "astor", ["bus"], false),
  stop("exit", "Accessible exit", "washNE", ["bus"], true)
];
const stops = prepareTransitStops(fallbackNodes, stopDefinitions);
const implausibleSnap = prepareTransitStops(fallbackNodes, [{
  id: "far-stop",
  name: "Far stop",
  coordinates: [-73.80, 40.80],
  modes: ["bus"],
  wheelchairAccessible: true
}], { maxSnapDistanceMeters: 100 })[0];
assert.equal(implausibleSnap.snapStatus, "too_far");
assert.equal(implausibleSnap.pedestrianNodeId, null, "an implausibly distant pedestrian snap is not usable");
assert.deepEqual(implausibleSnap.originalCoordinates, [-73.80, 40.80], "the visible provider stop location is preserved");
const directedBus = [
  edge("bus-1", "entry", "middle", "bus", "M8", 1, 2),
  edge("bus-2", "middle", "exit", "bus", "M8", 2, 3)
];

assert.equal(isBoardingStopUsable(stops.find(stop => stop.id === "middle"), needs), false, "an inaccessible station cannot be used to board");
assert.equal(isPassThroughStopUsable(stops.find(stop => stop.id === "middle")), true, "an inaccessible but open station remains usable as a pass-through");

const forwardBus = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs,
  weather,
  mode: "bus",
  transitStops: stops,
  transitEdges: directedBus
});
assert.ok(forwardBus.length > 0, "an accessible rider can remain on the vehicle through an inaccessible intermediate stop");
assert.deepEqual(forwardBus[0].transit.edges.map(item => item.id), ["bus-1", "bus-2"]);
assert.equal(forwardBus[0].transfers, 0, "a direct route has zero transfers");

const reverseBus = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "washNE",
  endId: "cooper",
  needs,
  weather,
  mode: "bus",
  transitStops: stops,
  transitEdges: directedBus
});
assert.deepEqual(reverseBus, [], "directed transit edges cannot be ridden backwards without provider confirmation");
assert.equal(isTransitEdgeActive({ cancelled: true }, new Date()), false, "cancelled trips are rejected");
assert.equal(isTransitEdgeActive({ serviceDays: ["monday"] }, new Date("2026-07-29T12:00:00")), false, "service-calendar weekdays are applied");
assert.equal(isTransitEdgeActive({ alerts: [{ effect: "route_suspended", active: true }] }, new Date()), false, "active service alerts reject invalid service before itinerary selection");

const mixedStops = prepareTransitStops(fallbackNodes, [
  stop("mixed-entry", "Bus entry", "cooper", ["bus"], true),
  stop("mixed-bus", "Bus transfer", "astor", ["bus"], true),
  stop("mixed-subway", "Subway transfer", "laf8", ["subway"], true),
  stop("mixed-exit", "Subway exit", "washNE", ["subway"], true)
]);
const mixedEdges = [
  edge("mixed-bus", "mixed-entry", "mixed-bus", "bus", "M8", 1, 2),
  transfer("station-transfer", "mixed-bus", "mixed-subway", fallbackNodes.astor.coordinates, fallbackNodes.laf8.coordinates),
  edge("mixed-subway", "mixed-subway", "mixed-exit", "subway", "F", 1, 2)
];
const mixed = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs,
  weather,
  mode: "mixed",
  transitStops: mixedStops,
  transitEdges: mixedEdges
});
assert.ok(mixed.length > 0, "a bus-to-subway trip is available in Mixed mode");
assert.ok(mixed[0].transit.edges.some(item => item.mode === "bus"));
assert.ok(mixed[0].transit.edges.some(item => item.mode === "subway"));
assert.equal(mixed[0].transfers, 1, "bus to subway produces one transfer");

const ferryStops = prepareTransitStops(fallbackNodes, [
  stop("ferry-entry", "The Battery", "cooper", ["ferry"], true),
  stop("ferry-exit", "Liberty Island dock", "washNE", ["ferry"], true)
]);
const ferryEdges = [{
  ...edge("ferry-edge", "ferry-entry", "ferry-exit", "ferry", "battery-liberty", 1, 2),
  operator: "Statue City Cruises",
  ticketRequired: true,
  securityScreeningRequired: true
}];
const ferry = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs: { ...needs, requireElevator: false },
  weather,
  mode: "ferry",
  transitStops: ferryStops,
  transitEdges: ferryEdges
});
assert.ok(ferry.length > 0, "Ferry mode accepts a provider-supplied Statue City Cruises edge");
assert.equal(ferry[0].transit.edges[0].mode, "ferry");

const busFerryStops = prepareTransitStops(fallbackNodes, [
  stop("bf-entry", "Bus entry", "cooper", ["bus"], true),
  stop("bf-transfer-bus", "Bus terminal stop", "astor", ["bus"], true),
  stop("bf-transfer-ferry", "The Battery terminal", "laf8", ["ferry"], true),
  stop("bf-exit", "Liberty Island dock", "washNE", ["ferry"], true)
]);
const busFerry = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs: { ...needs, requireElevator: false },
  weather,
  mode: "mixed",
  transitStops: busFerryStops,
  transitEdges: [
    edge("bf-bus", "bf-entry", "bf-transfer-bus", "bus", "M20", 1, 2),
    transfer("bf-transfer", "bf-transfer-bus", "bf-transfer-ferry", fallbackNodes.astor.coordinates, fallbackNodes.laf8.coordinates),
    { ...edge("bf-ferry", "bf-transfer-ferry", "bf-exit", "ferry", "battery-liberty", 1, 2), operator: "Statue City Cruises" }
  ]
});
assert.ok(busFerry.length > 0, "Bus plus Ferry is a valid Mixed itinerary");
assert.equal(busFerry[0].transfers, 1);

assert.ok(planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs,
  weather,
  mode: "mixed",
  transitStops: stops,
  transitEdges: directedBus
}).some(route => route.transit.edges.every(leg => leg.mode === "bus")), "All Transit may return a bus-only path");

const subwayOnlyEdges = directedBus.map(item => ({ ...item, id: `subway-${item.id}`, mode: "subway", route: "F" }));
assert.ok(planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs,
  weather,
  mode: "mixed",
  transitStops: stops,
  transitEdges: subwayOnlyEdges
}).length === 0, "bus stops cannot be treated as subway entrances");

const routeStateEdges = [
  edge("in-a", "entry", "middle", "bus", "A", 1, 2),
  edge("in-b", "entry", "middle", "bus", "B", 1, 2),
  edge("out-b", "middle", "exit", "bus", "B", 2, 3)
];
const routeStateAlternatives = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: fallbackEdges,
  startId: "cooper",
  endId: "washNE",
  needs: { ...needs, requireElevator: false },
  weather,
  mode: "bus",
  transitStops: prepareTransitStops(fallbackNodes, [
    stop("entry", "Accessible entry", "cooper", ["bus"], true),
    stop("middle", "Accessible interchange", "astor", ["bus"], true),
    stop("exit", "Accessible exit", "washNE", ["bus"], true)
  ]),
  transitEdges: routeStateEdges
});
assert.ok(routeStateAlternatives.length > 0);
assert.deepEqual(
  routeStateAlternatives[0].transit.edges.map(item => item.id),
  ["in-b", "out-b"],
  "Dijkstra retains the slightly slower arrival on route B because it avoids a later transfer"
);
assert.equal(routeStateAlternatives[0].transfers, 0);

const stopMap = new Map(stops.map(item => [item.id, item]));
const invalidContinuity = validateTransitItinerary({
  entryStop: stops[0],
  exitStop: stops[2],
  transit: { edges: [directedBus[0], { ...directedBus[1], from: "entry" }] }
}, { mode: "bus", needs, stopMap });
assert.equal(invalidContinuity.valid, false);
assert.ok(invalidContinuity.reasons.includes("transit edges are disconnected"));
const duplicatedTransfer = transfer(
  "duplicate-a",
  "mixed-bus",
  "mixed-subway",
  fallbackNodes.astor.coordinates,
  fallbackNodes.laf8.coordinates
);
const duplicateLogical = validateTransitItinerary({
  entryStop: mixedStops[1],
  exitStop: mixedStops[2],
  transit: {
    edges: [
      duplicatedTransfer,
      { ...duplicatedTransfer, id: "duplicate-b" }
    ]
  }
}, { mode: "mixed", needs, stopMap: new Map(mixedStops.map(item => [item.id, item])) });
assert.equal(duplicateLogical.valid, false);
assert.ok(duplicateLogical.reasons.includes("transit edge is logically duplicated"));

console.log("Production transit-algorithm behavior tests passed.");

function stop(id, name, nodeId, modes, wheelchairAccessible) {
  const subway = modes.includes("subway");
  const platformStopId = subway ? `mta:subway:platform:${id}` : null;
  return {
    id,
    name,
    coordinates: fallbackNodes[nodeId].coordinates,
    modes,
    wheelchairAccessible,
    curbAccess: true,
    elevatorStatus: subway ? "working" : null,
    platformStopId,
    entranceId: subway ? `mta:subway:entrance:${id}` : null,
    boardingLocationType: subway ? "street_entrance" : null,
    directionId: subway ? "south" : null,
    accessiblePaths: subway ? [{
      id: `mta:subway:path:${id}`,
      entranceId: `mta:subway:entrance:${id}`,
      fareControlAreaId: `mta:subway:station:${id}`,
      platformStopIds: [platformStopId],
      directionIds: ["south"],
      actions: ["boarding", "exit", "transfer"],
      complete: true,
      wheelchairAccessible: true,
      status: "working",
      freshness: "current",
      updatedAt: new Date().toISOString()
    }] : []
  };
}

function edge(id, from, to, mode, route, fromSequence, toSequence) {
  return {
    id,
    from,
    to,
    mode,
    route,
    tripId: route + "-trip",
    minutes: 4,
    wheelchairAccessible: true,
    bidirectional: false,
    fromSequence,
    toSequence,
    fromPlatformStopId: mode === "subway" ? `mta:subway:platform:${from}` : undefined,
    toPlatformStopId: mode === "subway" ? `mta:subway:platform:${to}` : undefined,
    directionId: mode === "subway" ? "south" : undefined,
    scheduleVerified: true,
    scheduleSource: "Test schedule",
    scheduleUpdatedAt: "2099-01-01T12:00:00.000Z",
    scheduleFreshness: "current",
    frequency: { startTime: "00:00:00", endTime: "23:59:59", headwaySeconds: 60 },
    geometryVerified: false
  };
}

function transfer(id, from, to, fromCoordinates, toCoordinates) {
  return {
    id,
    from,
    to,
    mode: "transfer",
    route: "transfer",
    minutes: 2,
    wheelchairAccessible: true,
    bidirectional: false,
    providerConfirmed: true,
    geometryVerified: true,
    accessiblePathComplete: true,
    accessibility: { pedestrianEvidence: "provider-verified", stairs: false, slope: 0, requiresCurbRamp: false },
    minimumTransferSeconds: 120,
    geometry: [fromCoordinates, toCoordinates]
  };
}
