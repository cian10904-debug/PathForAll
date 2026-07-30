"use strict";

import assert from "node:assert/strict";
import { fallbackNodes, fallbackEdges } from "./tests/fixtures/cooper-union-graph.js";
import { dijkstra, PROFILE_WEIGHTS } from "./routing.js";
import { buildWalkingNavigationSteps, routeCoordinates, remainingMinutes } from "./navigation.js";

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
const walking = dijkstra(fallbackNodes, fallbackEdges, "cooper", "washNE", needs, weather, PROFILE_WEIGHTS.balanced);
assert.ok(walking);
const steps = buildWalkingNavigationSteps(walking, fallbackEdges, fallbackNodes, "Washington Square Park");
assert.ok(steps.length >= 2);
assert.match(steps[0].instruction, /Head|Continue|Turn/);
assert.equal(steps.at(-1).type, "arrive");
assert.ok(remainingMinutes(steps, 0) > 0);

const geometry = walking.traversals.map(traversal => {
  const edge = fallbackEdges.find(item => item.id === traversal.edgeId);
  const coordinates = edge.geometry || [fallbackNodes[edge.from].coordinates, fallbackNodes[edge.to].coordinates];
  return { mode: "walk", coordinates: traversal.reverse ? [...coordinates].reverse() : coordinates };
});
assert.ok(routeCoordinates({ geometrySegments: geometry }).length >= 2);

console.log("Local walking-navigation fixture tests passed.");
