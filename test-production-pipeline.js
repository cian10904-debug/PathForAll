"use strict";

import assert from "node:assert/strict";
import { normalizeStationAccessibility } from "./elevator-status.js";
import { connectRouteEndpoints } from "./osm-network.js";
import { normalizeLocalTransitRoute, normalizeWalkingRoute } from "./route-model.js";
import { createRoutingService, routeSourceForMode } from "./route-service.js";
import { normalizeTransitNetwork } from "./transit-network-service.js";
import {
  isBoardingStopUsable,
  planTransitRoutes,
  prepareTransitStops
} from "./transit-routing.js";

const CURRENT = new Date().toISOString();
const EXPIRES = "2099-01-01T13:00:00.000Z";

let walkOnlyCalls = 0;
const walkOnlyService = createRoutingService({
  url: "https://routes.example.test/plan",
  capabilities: {
    available: true,
    routeProvider: true,
    supportedModes: ["walk"]
  },
  fetchImpl: async () => {
    walkOnlyCalls += 1;
    throw new Error("A walking-only provider must not receive transit requests.");
  }
});
await assert.rejects(
  walkOnlyService.plan({ start: point("a", [-74, 40.7]), end: point("b", [-73.99, 40.7]), mode: "subway" }),
  error => error.code === "UNSUPPORTED_MODE"
);
assert.equal(walkOnlyCalls, 0);
assert.equal(
  routeSourceForMode("mixed", walkOnlyService.capabilities, { transitNetwork: true }),
  "transit-network",
  "Mixed falls through only to a compatible real transit topology provider."
);

const nodes = {
  start: point("start", [-74.0000, 40.7000]),
  near: point("near", [-73.9998, 40.7000]),
  farther: point("farther", [-73.9980, 40.7000]),
  end: point("end", [-73.9960, 40.7000])
};
const pedestrianEdges = [
  walkingEdge("start-near", "start", "near", nodes, 17),
  walkingEdge("near-farther", "near", "farther", nodes, 152),
  walkingEdge("farther-end", "farther", "end", nodes, 169)
];
const network = normalizeTransitNetwork({
  agency: "mta",
  dataSource: "Production-contract test provider",
  updatedAt: CURRENT,
  freshness: "current",
  expiresAt: EXPIRES,
  capabilities: { modes: ["bus"] },
  stops: [
    { id: "near", coordinates: nodes.near.coordinates, modes: ["bus"], curbAccess: false },
    { id: "farther", coordinates: nodes.farther.coordinates, modes: ["bus"], curbAccess: true },
    { id: "exit", coordinates: nodes.end.coordinates, modes: ["bus"], curbAccess: true },
    { id: "unknown", coordinates: nodes.start.coordinates, modes: ["bus"] }
  ],
  edges: [
    scheduledEdge("near-trip", "near", "exit", "M1"),
    scheduledEdge("farther-trip", "farther", "exit", "M2")
  ]
});
const preparedStops = prepareTransitStops(nodes, network.stops);
const unknownCurb = preparedStops.find(stop => stop.providerId === "unknown");
assert.equal(unknownCurb.curbAccess, "unknown");
assert.equal(
  isBoardingStopUsable(unknownCurb, { wheelchairMode: true, requireCurb: true, unknownPolicy: "allow" }, "bus"),
  true,
  "unknown curb evidence is allowed with an uncertainty warning only under explicitly selected unknown-data mode."
);
assert.equal(
  isBoardingStopUsable(unknownCurb, { wheelchairMode: true, requireCurb: true, requireVerifiedCurbAccess: true }, "bus"),
  false,
  "the separate verified-curb preference rejects unknown evidence."
);

const busItineraries = planTransitRoutes({
  pedestrianNodes: nodes,
  pedestrianEdges,
  startId: "start",
  endId: "end",
  needs: {
    wheelchairMode: true,
    requireCurb: true,
    requireVerifiedCurbAccess: false,
    maxWalkMinutes: 10
  },
  mode: "bus",
  transitStops: preparedStops,
  transitEdges: network.edges,
  departureTime: new Date("2026-07-29T12:00:00")
});
assert.ok(busItineraries.length > 0);
assert.equal(
  busItineraries[0].entryStop.providerId,
  "farther",
  "network walking and accessibility can outrank a geographically closer inaccessible stop."
);
const normalizedBus = normalizeLocalTransitRoute(busItineraries[0], {
  mode: "bus",
  start: nodes.start,
  end: nodes.end,
  pedestrianNodes: nodes,
  pedestrianEdges,
  transitStops: preparedStops,
  dataSource: network.dataSource,
  dataFreshness: network.freshness,
  providerUpdatedAt: network.updatedAt,
  expiresAt: network.expiresAt
});
assert.ok(normalizedBus);
assert.equal(normalizedBus.mode, "bus");
assert.ok(normalizedBus.legs.every(leg => leg.from && leg.to && Object.hasOwn(leg, "accessibility")));
assert.equal(Object.hasOwn(normalizedBus, "transit"), false, "the normalized route has no source-specific transit field.");

const platformId = "mta:subway:platform:entrance";
const subwayNetwork = normalizeTransitNetwork({
  agency: "mta",
  stops: [
    {
      id: "center",
      coordinates: nodes.near.coordinates,
      modes: ["subway"],
      locationType: "parent_station",
      platformStopId: platformId
    },
    {
      id: "entrance",
      coordinates: nodes.farther.coordinates,
      modes: ["subway"],
      locationType: "street_entrance",
      entranceId: "entrance",
      platformStopId: "entrance",
      directionId: "south",
      accessiblePaths: [{
        id: "path",
        entranceId: "entrance",
        fareControlAreaId: "fare",
        platformStopIds: ["entrance"],
        directionIds: ["south"],
        actions: ["boarding", "exit", "transfer"],
        complete: true,
        wheelchairAccessible: true,
        status: "working",
        freshness: "current",
        updatedAt: CURRENT
      }]
    }
  ],
  edges: []
});
const preparedSubway = prepareTransitStops(nodes, subwayNetwork.stops);
const parentCenter = preparedSubway.find(stop => stop.providerId === "center");
const streetEntrance = preparedSubway.find(stop => stop.providerId === "entrance");
assert.equal(
  streetEntrance.accessiblePaths[0].fareControlAreaId,
  "mta:subway:fare-control:fare",
  "fare-control areas remain distinct from parent stations."
);
assert.equal(
  isBoardingStopUsable(parentCenter, { requireElevator: true }, "subway"),
  false,
  "a parent-station center is never used as a street entrance."
);
assert.equal(
  isBoardingStopUsable(streetEntrance, { requireElevator: true }, "subway", {
    edge: { fromPlatformStopId: streetEntrance.platformStopId, directionId: "south" }
  }),
  true,
  "the complete entrance-to-fare-control-to-directional-platform path is preserved."
);
assert.equal(
  isBoardingStopUsable({ ...streetEntrance, accessiblePaths: [] }, { wheelchairMode: true }, "subway"),
  false,
  "wheelchair routing does not board at an entrance whose complete platform path is unknown."
);

const elevatorPaths = [{
  id: "path-one",
  entranceId: "entrance-one",
  fareControlAreaId: "fare-one",
  platformStopIds: ["platform-south"],
  directionIds: ["south"],
  complete: true,
  wheelchairAccessible: true,
  status: "working",
  freshness: "current",
  updatedAt: CURRENT,
  equipmentCodes: ["EL1"]
}, {
  id: "path-two",
  entranceId: "entrance-two",
  fareControlAreaId: "fare-two",
  platformStopIds: ["platform-south"],
  directionIds: ["south"],
  complete: true,
  wheelchairAccessible: true,
  status: "working",
  freshness: "current",
  updatedAt: CURRENT,
  equipmentCodes: ["EL2"]
}];
const stationWithAlternative = normalizeStationAccessibility(
  { id: "station", accessiblePaths: elevatorPaths },
  [
    elevatorRecord("EL1", "out"),
    elevatorRecord("EL2", "working")
  ]
);
assert.equal(stationWithAlternative.accessiblePaths[0].status, "out");
assert.equal(stationWithAlternative.accessiblePaths[1].status, "working");
assert.equal(stationWithAlternative.elevatorStatus, "working", "one valid alternative path keeps the complex usable.");
const stationWithoutAlternative = normalizeStationAccessibility(
  { id: "station", accessiblePaths: elevatorPaths.slice(0, 1) },
  [elevatorRecord("EL1", "out")]
);
assert.equal(stationWithoutAlternative.elevatorStatus, "out", "an outage invalidates the path served by that equipment.");

const pennSelection = {
  id: "penn-station",
  name: "Penn Station",
  coordinates: [-73.9945, 40.7506]
};
const entrance = [-73.9940, 40.7506];
const endpointNodes = {
  entrance: point("entrance", entrance),
  destination: point("destination", [-73.9920, 40.7506])
};
const endpointEdges = [walkingEdge("sidewalk", "entrance", "destination", endpointNodes, 169)];
const attached = connectRouteEndpoints(
  endpointNodes,
  endpointEdges,
  pennSelection,
  endpointNodes.destination,
  {
    maxProjectionDistanceMeters: 3,
    maxAccessPointDistanceMeters: 160,
    accessPoints: [
      {
        coordinates: [-73.9943, 40.7506],
        connectorSource: "OpenStreetMap transit entrance",
        connectorStatus: "estimated"
      },
      {
        coordinates: entrance,
        connectorSource: "OpenStreetMap entrance",
        connectorStatus: "estimated"
      }
    ]
  }
);
assert.equal(attached.failure, null);
assert.deepEqual(attached.endpointConnections.start.selectedCoordinates, pennSelection.coordinates);
assert.deepEqual(
  attached.endpointConnections.start.accessPointCoordinates,
  entrance,
  "a known OSM entrance is considered before a closer transit entrance."
);
assert.equal(attached.endpointConnections.start.connectorStatus, "estimated");
assert.deepEqual(attached.nodes[attached.startId].coordinates, entrance);
assert.equal(
  attached.edges.some(edge => edge.geometry?.some(coordinates => sameCoordinate(coordinates, pennSelection.coordinates))),
  false,
  "no straight line from the selected landmark center is added to the pedestrian graph."
);
const normalizedWalk = normalizeWalkingRoute({
  key: "entrance-walk",
  route: { traversals: [{ edgeId: attached.edges[0].id, reverse: false }] }
}, {
  nodes: attached.nodes,
  edges: attached.edges,
  start: pennSelection,
  end: endpointNodes.destination,
  endpointConnections: attached.endpointConnections
});
assert.ok(normalizedWalk, "route validation uses the access-point endpoint while preserving the selected marker.");
assert.ok(normalizedWalk.warnings.some(warning => /internal path/.test(warning)));
const unavailable = connectRouteEndpoints(
  endpointNodes,
  endpointEdges,
  { ...pennSelection, coordinates: [-73.9970, 40.7506] },
  endpointNodes.destination,
  { maxProjectionDistanceMeters: 3, accessPoints: [] }
);
assert.equal(unavailable.startId, null, "missing mapped access produces a controlled unavailable connector.");

console.log("Production route-pipeline repair integration tests passed.");

function point(id, coordinates) {
  return { id, name: id, coordinates };
}

function walkingEdge(id, from, to, graph, distanceMeters) {
  return {
    id,
    from,
    to,
    name: "Mapped pedestrian path",
    geometry: [graph[from].coordinates, graph[to].coordinates],
    distanceMeters,
    minutes: distanceMeters / 75,
    pedestrianEvidence: "dedicated",
    roadCenterline: false,
    wheelchairStatus: "yes",
    curbRamp: true,
    surface: "smooth",
    stairs: false,
    requiresCurbRamp: false,
    confidence: .9,
    bidirectional: true
  };
}

function scheduledEdge(id, from, to, route) {
  return {
    id,
    from,
    to,
    mode: "bus",
    route,
    minutes: 5,
    wheelchairAccessible: true,
    scheduleVerified: true,
    scheduleSource: "Provider schedule",
    scheduleUpdatedAt: CURRENT,
    scheduleFreshness: "current",
    frequency: {
      startTime: "00:00:00",
      endTime: "23:59:59",
      headwaySeconds: 300
    }
  };
}

function elevatorRecord(equipmentCode, status) {
  return {
    equipmentCode,
    status,
    source: "Elevator provider",
    updatedAt: CURRENT,
    freshness: "current"
  };
}

function sameCoordinate(a, b) {
  return a?.[0] === b?.[0] && a?.[1] === b?.[1];
}
