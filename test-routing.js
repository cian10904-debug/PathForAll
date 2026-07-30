import assert from "node:assert/strict";
import { planAllRoutes, PROFILE_WEIGHTS, dijkstra } from "./routing.js";
import { fallbackNodes, fallbackEdges, fallbackDefaultStart, fallbackDefaultEnd } from "./tests/fixtures/cooper-union-graph.js";
import { prepareTransitStops, planTransitRoutes } from "./transit-routing.js";
import { TRANSIT_STOPS, TRANSIT_EDGES } from "./tests/fixtures/cooper-union-transit.js";
import { parseInclinePercent } from "./osm-network.js";
import { normalizeProfile } from "./profile-store.js";

const needs = {
  mobilityProfile: "wheelchair",
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
const edges = fallbackEdges.map(edge => ({ ...edge }));

const walking = planAllRoutes(fallbackNodes, edges, fallbackDefaultStart, fallbackDefaultEnd, needs, weather);
assert.equal(walking.length, 4);
assert.ok(walking.every(option => option.route), "all four walking profiles should find a route");
assert.ok(walking.every(option => option.metrics.minutes > 0));
assert.ok(walking.some(option => option.key === "lit" && option.label === "Best-lit route"));

const direct = dijkstra(fallbackNodes, edges, fallbackDefaultStart, fallbackDefaultEnd, needs, weather, PROFILE_WEIGHTS.balanced);
assert.ok(direct);
assert.ok(!direct.edgeIds.includes("e13"), "wheelchair route must avoid the stairs edge");

const transitStops = prepareTransitStops(fallbackNodes, TRANSIT_STOPS, { maxSnapDistanceMeters: 650 });
const busRoutes = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: edges,
  startId: fallbackDefaultStart,
  endId: fallbackDefaultEnd,
  needs,
  weather,
  mode: "bus",
  transitStops,
  transitEdges: TRANSIT_EDGES
});
assert.ok(busRoutes.length >= 1, "bus planner should produce a demonstration itinerary");
assert.ok(busRoutes[0].transit.edges.some(edge => edge.mode === "bus"));

const subwayRoutes = planTransitRoutes({
  pedestrianNodes: fallbackNodes,
  pedestrianEdges: edges,
  startId: fallbackDefaultStart,
  endId: fallbackDefaultEnd,
  needs,
  weather,
  mode: "subway",
  transitStops,
  transitEdges: TRANSIT_EDGES
});
assert.ok(subwayRoutes.length >= 1, "subway planner should produce a demonstration itinerary");
assert.ok(subwayRoutes[0].entryStop.wheelchairAccessible);
assert.ok(subwayRoutes[0].exitStop.wheelchairAccessible);

assert.equal(Math.round(parseInclinePercent("5%")), 5);
assert.equal(Math.round(parseInclinePercent("5°")), 9);

const normalized = normalizeProfile({ name: "Test", needs: { mobilityProfile: "custom", maxSlope: 50, customNeeds: ["avoid crowds"] } });
assert.equal(normalized.needs.wheelchairMode, false, "Custom does not silently force wheelchair mode");
assert.equal(normalized.needs.maxSlope, 12);
assert.deepEqual(normalized.needs.customNeeds, ["avoid crowds"]);

console.log("Local walking, transit, and profile algorithm fixture tests passed.");
