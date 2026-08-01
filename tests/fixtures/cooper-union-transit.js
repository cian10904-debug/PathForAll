"use strict";

// Test-only transit topology for the Cooper Union / Greenwich Village area.
// It is intentionally small so the Capstone can demonstrate multimodal logic without
// downloading the full MTA GTFS feeds in the browser. Production data should replace it.
export const TRANSIT_STOPS = [
  {
    id: "cooper-bus",
    name: "Cooper Sq / E 6 St",
    coordinates: [-73.99035, 40.72805],
    modes: ["bus"],
    routes: ["M8", "M103"],
    wheelchairAccessible: true,
    curbAccess: true,
    elevatorStatus: null
  },
  {
    id: "wash-square-bus",
    name: "Washington Sq / W 8 St",
    coordinates: [-73.99810, 40.73205],
    modes: ["bus"],
    routes: ["M8", "M55"],
    wheelchairAccessible: true,
    curbAccess: true,
    elevatorStatus: null
  },
  {
    id: "bleecker-bus",
    name: "Broadway / Houston St",
    coordinates: [-73.99445, 40.72545],
    modes: ["bus"],
    routes: ["M21", "M55"],
    wheelchairAccessible: true,
    curbAccess: null,
    elevatorStatus: null
  },
  {
    id: "union-bus",
    name: "Union Square East",
    coordinates: [-73.99055, 40.73550],
    modes: ["bus"],
    routes: ["M8", "M14A", "M14D"],
    wheelchairAccessible: true,
    curbAccess: true,
    elevatorStatus: null
  },
  {
    id: "bowery-houston-bus",
    name: "Bowery / Houston St",
    coordinates: [-73.99170, 40.72445],
    modes: ["bus"],
    routes: ["M21", "M103"],
    wheelchairAccessible: true,
    curbAccess: null,
    elevatorStatus: null
  },
  {
    id: "sixth-8-bus",
    name: "6 Av / W 8 St",
    coordinates: [-74.00095, 40.73335],
    modes: ["bus"],
    routes: ["M8", "M55"],
    wheelchairAccessible: true,
    curbAccess: true,
    elevatorStatus: null
  },
  {
    id: "bleecker-subway",
    name: "Bleecker St / Broadway-Lafayette",
    coordinates: [-73.99440, 40.72580],
    modes: ["subway"],
    routes: ["6", "B", "D", "F", "M"],
    wheelchairAccessible: true,
    curbAccess: true,
    elevatorStatus: "working",
    elevatorDataSource: "demo",
    elevatorStatusUpdatedAt: null
  },
  {
    id: "w4-subway",
    name: "W 4 St–Washington Sq",
    coordinates: [-74.00035, 40.73225],
    modes: ["subway"],
    routes: ["A", "C", "E", "B", "D", "F", "M"],
    wheelchairAccessible: true,
    curbAccess: true,
    elevatorStatus: "working",
    elevatorDataSource: "demo",
    elevatorStatusUpdatedAt: null
  },
  {
    id: "union-subway",
    name: "14 St–Union Sq",
    coordinates: [-73.99075, 40.73575],
    modes: ["subway"],
    routes: ["4", "5", "6", "L", "N", "Q", "R", "W"],
    wheelchairAccessible: true,
    curbAccess: true,
    elevatorStatus: "working",
    elevatorDataSource: "demo",
    elevatorStatusUpdatedAt: null
  },
  {
    id: "astor-subway",
    name: "Astor Pl",
    coordinates: [-73.99110, 40.73005],
    modes: ["subway"],
    routes: ["6"],
    wheelchairAccessible: false,
    curbAccess: true,
    elevatorStatus: null,
    elevatorDataSource: "demo",
    elevatorStatusUpdatedAt: null
  },
  {
    id: "8st-subway",
    name: "8 St–NYU",
    coordinates: [-73.99265, 40.73035],
    modes: ["subway"],
    routes: ["R", "W"],
    wheelchairAccessible: false,
    curbAccess: true,
    elevatorStatus: null,
    elevatorDataSource: "demo",
    elevatorStatusUpdatedAt: null
  }
];

for (const stop of TRANSIT_STOPS) {
  if (!stop.modes.includes("subway") || stop.wheelchairAccessible === false) continue;
  stop.platformStopId = `mta:subway:platform:${stop.id}`;
  stop.entranceId = `mta:subway:entrance:${stop.id}`;
  stop.boardingLocationType = "street_entrance";
  stop.directionId = "south";
  stop.accessiblePaths = [{
    id: `mta:subway:path:${stop.id}`,
    entranceId: stop.entranceId,
    fareControlAreaId: `mta:subway:station:${stop.id}`,
    platformStopIds: [stop.platformStopId],
    directionIds: ["south"],
    actions: ["boarding", "exit", "transfer"],
    equipmentCodes: [],
    complete: true,
    wheelchairAccessible: true,
    status: "working",
    freshness: "current",
    updatedAt: "2099-01-01T12:00:00.000Z"
  }];
}

export const TRANSIT_EDGES = [
  // M8 demonstration corridor.
  transitEdge("m8-union-cooper", "union-bus", "cooper-bus", "bus", "M8", 5.5),
  transitEdge("m8-cooper-wash", "cooper-bus", "wash-square-bus", "bus", "M8", 7),
  transitEdge("m8-wash-sixth", "wash-square-bus", "sixth-8-bus", "bus", "M8", 3),

  // M21 / M55 demonstration links.
  transitEdge("m21-bowery-bleecker", "bowery-houston-bus", "bleecker-bus", "bus", "M21", 4),
  transitEdge("m21-bleecker-wash", "bleecker-bus", "wash-square-bus", "bus", "M21", 7),
  transitEdge("m55-union-wash", "union-bus", "wash-square-bus", "bus", "M55", 6.5),
  transitEdge("m55-wash-bleecker", "wash-square-bus", "bleecker-bus", "bus", "M55", 5),
  transitEdge("m103-bowery-cooper", "bowery-houston-bus", "cooper-bus", "bus", "M103", 5),

  // Subway segments. Accessible routing can pass inaccessible intermediate stations
  // but may only board or exit at accessible stations.
  transitEdge("6-bleecker-union", "bleecker-subway", "union-subway", "subway", "6", 5.5),
  transitEdge("bdfm-bleecker-w4", "bleecker-subway", "w4-subway", "subway", "B/D/F/M", 2.5),
  transitEdge("6-bleecker-astor", "bleecker-subway", "astor-subway", "subway", "6", 2),
  transitEdge("6-astor-union", "astor-subway", "union-subway", "subway", "6", 3),
  transitEdge("rw-8st-union", "8st-subway", "union-subway", "subway", "R/W", 3),

  // Station/stop transfers.
  transferEdge("transfer-bleecker", "bleecker-bus", "bleecker-subway", 3),
  transferEdge("transfer-union", "union-bus", "union-subway", 4),
  transferEdge("transfer-w4", "sixth-8-bus", "w4-subway", 4)
];

function transitEdge(id, from, to, mode, route, minutes) {
  const fromStop = TRANSIT_STOPS.find(stop => stop.id === from);
  const toStop = TRANSIT_STOPS.find(stop => stop.id === to);
  return {
    id,
    from,
    to,
    mode,
    route,
    minutes,
    wheelchairAccessible: true,
    bidirectional: true,
    fromPlatformStopId: mode === "subway" ? fromStop.platformStopId : undefined,
    toPlatformStopId: mode === "subway" ? toStop.platformStopId : undefined,
    directionId: mode === "subway" ? "south" : undefined,
    scheduleVerified: true,
    scheduleSource: "Test-only service schedule",
    scheduleUpdatedAt: "2099-01-01T12:00:00.000Z",
    scheduleFreshness: "current",
    frequency: { startTime: "00:00:00", endTime: "23:59:59", headwaySeconds: 300 },
    // Stop-to-stop topology is available locally, but no authoritative shape is bundled.
    // The UI therefore never renders this two-point connection as a map route line.
    geometryVerified: false,
    geometry: [fromStop.coordinates, toStop.coordinates]
  };
}

function transferEdge(id, from, to, minutes) {
  const fromStop = TRANSIT_STOPS.find(stop => stop.id === from);
  const toStop = TRANSIT_STOPS.find(stop => stop.id === to);
  return {
    id,
    from,
    to,
    mode: "transfer",
    route: "Transfer",
    minutes,
    wheelchairAccessible: true,
    bidirectional: true,
    providerConfirmed: true,
    geometryVerified: true,
    accessiblePathComplete: true,
    minimumTransferSeconds: minutes * 60,
    geometry: [fromStop.coordinates, toStop.coordinates]
  };
}
