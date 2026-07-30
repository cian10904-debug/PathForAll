"use strict";

import assert from "node:assert/strict";
import {
  coordinate,
  normalizeLocalTransitRoute,
  normalizeWalkingRoute,
  routeGeometrySegments,
  validateRouteOption
} from "./route-model.js";
import { createRoutingService, normalizeServerRoute } from "./route-service.js";

const START = place("start", "Starting point", [-73.9900, 40.7300]);
const BOARD = place("board", "Accessible bus stop", [-73.9892, 40.7307]);
const TRANSFER = place("transfer", "Accessible transfer", [-73.9878, 40.7315]);
const EXIT = place("exit", "Accessible station exit", [-73.9864, 40.7323]);
const END = place("end", "Destination", [-73.9856, 40.7330]);
const CURRENT_TRANSIT = {
  dataFreshness: "current",
  providerUpdatedAt: "2099-01-01T12:00:00.000Z",
  expiresAt: "2099-01-01T13:00:00.000Z"
};

assert.deepEqual(coordinate([-73.9900, 40.7300]), [-73.9900, 40.7300], "coordinates retain [longitude, latitude] order");
assert.equal(coordinate([200, 40]), null, "out-of-range longitude is rejected");

const walking = normalizeServerRoute(serverWalkingRoute(), 0, { start: START, end: END, requestedMode: "walk" });
assertRouteShape(walking, "walk");
assert.equal(walking.legs.length, 1);

const bus = normalizeServerRoute(serverBusRoute(), 0, { start: START, end: END, requestedMode: "bus", ...CURRENT_TRANSIT });
assertRouteShape(bus, "bus");
assert.ok(bus.legs.some(leg => leg.mode === "bus"));
assert.equal(bus.legs.find(leg => leg.mode === "bus").headsign, "East Village");

const subway = normalizeServerRoute(serverSubwayRoute(), 0, { start: START, end: END, requestedMode: "subway", ...CURRENT_TRANSIT });
assertRouteShape(subway, "subway");
assert.ok(subway.legs.some(leg => leg.mode === "subway"));

const ferry = normalizeServerRoute(serverFerryRoute(), 0, { start: START, end: END, requestedMode: "ferry", ...CURRENT_TRANSIT });
assertRouteShape(ferry, "ferry");
assert.equal(ferry.legs.find(leg => leg.mode === "ferry").operator, "Statue City Cruises");
assert.equal(ferry.legs.find(leg => leg.mode === "ferry").ticketRequired, true);

const mixed = normalizeServerRoute(serverMixedRoute(), 0, { start: START, end: END, requestedMode: "mixed", ...CURRENT_TRANSIT });
assertRouteShape(mixed, "mixed");
assert.ok(mixed.legs.some(leg => leg.mode === "bus"));
assert.ok(mixed.legs.some(leg => leg.mode === "subway"));
assert.equal(mixed.transfers, 1, "one bus-to-subway boarding change is one transfer");

assert.equal(
  normalizeServerRoute({ id: "empty", mode: "bus", legs: [] }, 0, { start: START, end: END, requestedMode: "bus" }),
  null,
  "a provider route without valid legs is rejected"
);
assert.equal(
  normalizeServerRoute(withLeg(serverBusRoute(), 1, { durationSeconds: -1 }), 0, { start: START, end: END, requestedMode: "bus" }),
  null,
  "a provider route with negative duration is rejected"
);
assert.equal(
  normalizeServerRoute(withLeg(serverBusRoute(), 1, { from: place("far", "Far away", [-74.10, 40.60]) }), 0, { start: START, end: END, requestedMode: "bus" }),
  null,
  "disconnected provider legs are rejected"
);
assert.equal(
  normalizeServerRoute({ ...serverWalkingRoute(), mode: "bus" }, 0, { start: START, end: END, requestedMode: "bus" }),
  null,
  "a transit-labelled provider route without a transit leg is rejected"
);
assert.equal(
  normalizeServerRoute(withLeg(serverBusRoute(), 1, { mode: undefined }), 0, { start: START, end: END, requestedMode: "bus", ...CURRENT_TRANSIT }),
  null,
  "a production-provider leg without a mode is rejected"
);

const invalidGeometry = serverBusRoute();
invalidGeometry.legs[1].geometry = line(BOARD.coordinates, [-74.10, 40.60]);
assert.equal(
  normalizeServerRoute(invalidGeometry, 0, { start: START, end: END, requestedMode: "bus", ...CURRENT_TRANSIT }),
  null,
  "geometry that does not reach a leg endpoint is rejected"
);

const requestLog = [];
const service = createRoutingService({
  url: "https://routing.example.test/plan",
  capabilities: { available: true, modes: ["bus"] },
  fetchImpl: async (url, request) => {
    requestLog.push({ url: String(url), request });
    return {
      ok: true,
      json: async () => ({
        freshness: "current",
        updatedAt: "2099-01-01T12:00:00.000Z",
        expiresAt: "2099-01-01T13:00:00.000Z",
        routes: [serverBusRoute(), { id: "bad", mode: "bus", legs: [] }]
      })
    };
  }
});
const planned = await service.plan({ start: START, end: END, needs: { wheelchairMode: true }, mode: "bus" });
assert.equal(planned.length, 1, "invalid provider responses are filtered before the UI sees them");
assertRouteShape(planned[0], "bus");
assert.equal(requestLog.length, 1);
assert.equal(requestLog[0].url, "https://routing.example.test/plan");
assert.deepEqual(JSON.parse(requestLog[0].request.body).start, START.coordinates, "the provider receives selected coordinates");

const walkingFromGraph = normalizeWalkingRoute({
  key: "walking-graph",
  label: "Balanced",
  route: { traversals: [{ edgeId: "edge-1", reverse: false }] },
  metrics: { confidence: .8 }
}, {
  nodes: { a: START, b: END },
  edges: [{
    id: "edge-1",
    from: "a",
    to: "b",
    name: "Verified sidewalk",
    minutes: 6,
    distanceMeters: 700,
    geometry: [START.coordinates, END.coordinates],
    surface: "smooth",
    slope: 2,
    curbRamp: true,
    lit: true
  }],
  start: START,
  end: END
});
assertRouteShape(walkingFromGraph, "walk");
assert.equal(routeGeometrySegments(walkingFromGraph).length, 1);
assert.equal(validateRouteOption(walkingFromGraph, { start: START, end: END }).valid, true);

const localTransitWithoutVerifiedShape = normalizeLocalTransitRoute({
  key: "local-topology-bus",
  optionLabel: "Accessible local bus",
  access: { route: { traversals: [{ edgeId: "access", reverse: false }] } },
  egress: { route: { traversals: [{ edgeId: "egress", reverse: false }] } },
  transit: { edges: [{
    id: "topology-only-bus",
    mode: "bus",
    route: "M8",
    from: "local-board",
    to: "local-exit",
    minutes: 5,
    geometryVerified: false,
    geometry: [BOARD.coordinates, EXIT.coordinates]
  }] }
}, {
  mode: "bus",
  start: START,
  end: END,
  pedestrianNodes: { start: START, board: BOARD, exit: EXIT, end: END },
  pedestrianEdges: [
    { id: "access", from: "start", to: "board", name: "Access sidewalk", minutes: 2, distanceMeters: 95, geometry: [START.coordinates, BOARD.coordinates] },
    { id: "egress", from: "exit", to: "end", name: "Egress sidewalk", minutes: 2, distanceMeters: 90, geometry: [EXIT.coordinates, END.coordinates] }
  ],
  transitStops: [
    { id: "local-board", name: BOARD.name, coordinates: BOARD.coordinates },
    { id: "local-exit", name: EXIT.name, coordinates: EXIT.coordinates }
  ],
  dataFreshness: "current",
  providerUpdatedAt: "2099-01-01T12:00:00.000Z",
  expiresAt: "2099-01-01T13:00:00.000Z"
});
assertRouteShape(localTransitWithoutVerifiedShape, "bus");
assert.equal(
  localTransitWithoutVerifiedShape.legs.find(leg => leg.mode === "bus").geometry,
  null,
  "topology-only transit geometry is not promoted to a drawable route line"
);

console.log("Production route-model and provider-normalization tests passed.");

function assertRouteShape(route, mode) {
  assert.ok(route, `${mode} route should normalize`);
  assert.equal(route.mode, mode);
  assert.ok(Array.isArray(route.legs) && route.legs.length > 0, "normalized routes contain legs");
  assert.ok(Number.isFinite(route.totalDurationSeconds) && route.totalDurationSeconds >= 0);
  assert.ok(Number.isFinite(route.totalWalkingMeters) && route.totalWalkingMeters >= 0);
  assert.ok(Number.isFinite(route.totalWaitSeconds) && route.totalWaitSeconds >= 0);
  assert.equal(typeof route.dataSource, "string");
}

function place(id, name, coordinates) {
  return { id, name, coordinates };
}

function line(...coordinates) {
  return { type: "LineString", coordinates };
}

function serverWalkingRoute() {
  return {
    id: "provider-walk",
    mode: "walk",
    label: "Accessible walk",
    dataSource: "Test routing provider",
    legs: [{
      id: "walk-1",
      mode: "walk",
      from: START,
      to: END,
      durationSeconds: 720,
      distanceMeters: 950,
      geometry: line(START.coordinates, END.coordinates),
      accessibility: { curbRamps: "known" }
    }]
  };
}

function serverBusRoute() {
  return {
    id: "provider-bus",
    mode: "bus",
    label: "Accessible M8",
    dataSource: "Test routing provider",
    legs: [
      { id: "walk-to-bus", mode: "walk", from: START, to: BOARD, durationSeconds: 120, distanceMeters: 95, geometry: line(START.coordinates, BOARD.coordinates) },
      { id: "ride-m8", mode: "bus", from: BOARD, to: EXIT, routeId: "M8", routeName: "M8", headsign: "East Village", durationSeconds: 480, waitSeconds: 120, distanceMeters: 760, geometry: line(BOARD.coordinates, EXIT.coordinates), accessibility: { wheelchairAccessible: true } },
      { id: "walk-from-bus", mode: "walk", from: EXIT, to: END, durationSeconds: 100, distanceMeters: 90, geometry: line(EXIT.coordinates, END.coordinates) }
    ]
  };
}

function serverSubwayRoute() {
  const route = serverBusRoute();
  route.id = "provider-subway";
  route.mode = "subway";
  route.label = "Accessible subway";
  route.legs[1] = {
    ...route.legs[1],
    id: "ride-subway",
    mode: "subway",
    routeId: "F",
    routeName: "F",
    headsign: "Coney Island",
    accessibility: { elevatorStatus: "unknown" }
  };
  return route;
}

function serverFerryRoute() {
  return {
    id: "provider-ferry",
    mode: "ferry",
    label: "Statue City Cruises via The Battery",
    dataSource: "Test routing provider",
    legs: [
      { id: "walk-to-terminal", mode: "walk", from: START, to: BOARD, durationSeconds: 120, distanceMeters: 95, geometry: line(START.coordinates, BOARD.coordinates) },
      {
        id: "ride-ferry",
        mode: "ferry",
        from: BOARD,
        to: EXIT,
        routeId: "battery-liberty",
        routeName: "The Battery to Liberty Island",
        operator: "Statue City Cruises",
        durationSeconds: 0,
        distanceMeters: 0,
        geometry: null,
        ticketRequired: true,
        reservationRecommended: true,
        securityScreeningRequired: true,
        departureTime: "2099-01-01T12:30:00.000Z",
        scheduleSource: "Statue City Cruises normalized schedule",
        scheduleStatus: "verified",
        scheduleFreshness: "current",
        accessibility: {
          wheelchairAccessible: "unknown",
          gangwayAssistance: "unknown",
          accessibleMainDeck: "unknown",
          accessibleRestroomOnboard: "unknown"
        }
      },
      { id: "island-path", mode: "walk", from: EXIT, to: END, durationSeconds: 100, distanceMeters: 90, geometry: line(EXIT.coordinates, END.coordinates) }
    ],
    warnings: ["Check the current ferry schedule and ticket availability."]
  };
}

function serverMixedRoute() {
  return {
    id: "provider-mixed",
    mode: "mixed",
    label: "Accessible mixed route",
    dataSource: "Test routing provider",
    legs: [
      { id: "walk-to-bus", mode: "walk", from: START, to: BOARD, durationSeconds: 120, distanceMeters: 95, geometry: line(START.coordinates, BOARD.coordinates) },
      { id: "ride-bus", mode: "bus", from: BOARD, to: TRANSFER, routeId: "M8", routeName: "M8", durationSeconds: 240, distanceMeters: 330, geometry: line(BOARD.coordinates, TRANSFER.coordinates) },
      { id: "station-transfer", mode: "transfer", from: TRANSFER, to: TRANSFER, durationSeconds: 90, distanceMeters: 35, geometry: line(TRANSFER.coordinates, TRANSFER.coordinates), accessibility: { elevatorStatus: "working" } },
      { id: "ride-subway", mode: "subway", from: TRANSFER, to: EXIT, routeId: "F", routeName: "F", headsign: "Coney Island", durationSeconds: 300, waitSeconds: 60, distanceMeters: 380, geometry: line(TRANSFER.coordinates, EXIT.coordinates), accessibility: { elevatorStatus: "unknown" } },
      { id: "walk-from-station", mode: "walk", from: EXIT, to: END, durationSeconds: 100, distanceMeters: 90, geometry: line(EXIT.coordinates, END.coordinates) }
    ]
  };
}

function withLeg(route, index, change) {
  const copy = JSON.parse(JSON.stringify(route));
  copy.legs[index] = { ...copy.legs[index], ...change };
  return copy;
}
