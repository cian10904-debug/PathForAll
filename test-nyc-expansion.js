import assert from "node:assert/strict";
import { NYC_BOUNDS, buildOverpassQuery, buildRouteCorridor, isInsideBounds } from "./osm-network.js";
import { isInsideServiceArea } from "./geocoding.js";
import { planServerRoutes } from "./route-service.js";

const trips = [
  [[-73.9905, 40.7292], [-73.9680, 40.7829]], // Lower Manhattan → Central Park
  [[-73.9905, 40.7292], [-73.9626, 40.8075]], // Cooper Union → Columbia
  [[-73.9905, 40.7292], [-73.9857, 40.6931]], // Manhattan → Downtown Brooklyn
  [[-73.9905, 40.7292], [-73.8310, 40.7590]], // Manhattan → Queens
  [[-73.9905, 40.7292], [-73.9018, 40.8506]], // Manhattan → Bronx
  [[-73.9905, 40.7292], [-74.0736, 40.6437]]  // Manhattan → Staten Island Ferry
];

assert.deepEqual(NYC_BOUNDS, { west: -74.2591, south: 40.4774, east: -73.7004, north: 40.9176 });
assert.ok(isInsideServiceArea([-74.1502, 40.5795]), "Staten Island must be accepted");
assert.ok(isInsideServiceArea([-73.8310, 40.7590]), "Queens must be accepted");
assert.ok(isInsideServiceArea([-73.9018, 40.8506]), "Bronx must be accepted");
assert.equal(isInsideServiceArea([-74.30, 40.7]), false, "outside-NYC locations must be rejected");

for (const [start, end] of trips) {
  assert.ok(isInsideBounds(start) && isInsideBounds(end));
  const corridor = buildRouteCorridor(start, end);
  assert.equal(corridor.type, "corridor");
  assert.ok(corridor.points.length >= 2 && corridor.points.length <= 30);
  const query = buildOverpassQuery(corridor);
  assert.match(query, /way\(around:/, "corridor queries must not request the full NYC bbox");
}

assert.throws(() => buildRouteCorridor([-74.30, 40.7], trips[0][1]), /inside New York City/);
assert.deepEqual(await planServerRoutes({ start: { coordinates: trips[0][0] }, end: { coordinates: trips[0][1] }, needs: {}, mode: "walk" }), [], "an absent server endpoint must not fabricate a route");

console.log("All NYC boundary, corridor-loading, and no-fake-route tests passed.");
