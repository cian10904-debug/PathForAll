"use strict";

import assert from "node:assert/strict";
import {
  FERRY_OPERATOR,
  isFerryRequiredDestination,
  rankFerryTerminals,
  resolveFerryDestination
} from "./ferry-service.js";
import { normalizeRouteOption } from "./route-model.js";
import { routeLayerData } from "./route-layer-data.js";
import { buildRouteNavigationSteps } from "./navigation.js";

const liberty = resolveFerryDestination({ name: "Statue of Liberty National Monument" });
assert.equal(liberty.kind, "liberty-island");
assert.equal(resolveFerryDestination({ name: "Ellis Island National Museum of Immigration" }).kind, "ellis-island");
assert.equal(isFerryRequiredDestination({ name: "Statue of Liberty" }), true);
assert.equal(isFerryRequiredDestination({ name: "Pinned destination", coordinates: [-74.0450, 40.6897] }), true, "a map pin on Liberty Island requires Ferry");
assert.equal(isFerryRequiredDestination({ id: "statue-city-cruises:dock:ellis-island", name: "Pinned destination" }), true, "stable dock IDs require Ferry");
assert.equal(isFerryRequiredDestination({ name: "Times Square" }), false);
assert.match(FERRY_OPERATOR, /Statue City Cruises/);

assert.match(rankFerryTerminals({ coordinates: [-73.98, 40.72] })[0].id, /battery$/, "The Battery is the first NYC candidate");
assert.match(rankFerryTerminals({ coordinates: [-74.06, 40.71] })[0].id, /liberty-state-park$/, "Liberty State Park can be selected for a nearby New Jersey origin");

const start = point("start", "Lower Manhattan", [-74.01, 40.71]);
const terminal = point("statue-city-cruises:terminal:battery", "The Battery", [-74.0169, 40.7034]);
const dock = point("statue-city-cruises:dock:liberty-island", "Liberty Island dock", [-74.0450, 40.6897]);
const end = point("destination", "Statue of Liberty", [-74.0452, 40.6893]);
const route = normalizeRouteOption({
  id: "statue-ferry",
  mode: "ferry",
  label: "Statue City Cruises via The Battery",
  legs: [
    leg("access", "walk", start, terminal, { durationSeconds: 600, distanceMeters: 700, geometry: line(start.coordinates, terminal.coordinates) }),
    leg("ferry", "ferry", terminal, dock, {
      routeId: "battery-liberty",
      routeName: "The Battery to Liberty Island",
      operator: FERRY_OPERATOR,
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
    }),
    leg("island", "walk", dock, end, { durationSeconds: 60, distanceMeters: 50, geometry: line(dock.coordinates, end.coordinates) })
  ],
  warnings: ["Check the current schedule and ticket availability."],
  dataSource: "Application ferry provider contract",
  dataFreshness: "current",
  updatedAt: "2099-01-01T12:00:00.000Z",
  expiresAt: "2099-01-01T13:00:00.000Z"
}, { start, end });

assert.ok(route);
assert.equal(route.mode, "ferry");
assert.equal(route.legs[1].operator, FERRY_OPERATOR);
assert.equal(route.legs[1].ticketRequired, true);
assert.equal(routeLayerData(route).ferry.features.length, 0, "missing ferry geometry does not draw a direct harbor line");
assert.ok(buildRouteNavigationSteps(route, end.name).some(step => step.type === "security"));
assert.ok(buildRouteNavigationSteps(route, end.name).some(step => step.type === "ferry"));

const mixed = normalizeRouteOption({
  id: "subway-ferry",
  mode: "mixed",
  legs: [
    leg("subway", "subway", start, terminal, { routeId: "1", durationSeconds: 500 }),
    leg("ferry", "ferry", terminal, dock, {
      operator: FERRY_OPERATOR,
      routeId: "battery-liberty",
      durationSeconds: 0,
      departureTime: "2099-01-01T12:30:00.000Z",
      scheduleSource: "Statue City Cruises normalized schedule",
      scheduleStatus: "verified",
      scheduleFreshness: "current"
    })
  ],
  dataSource: "test",
  dataFreshness: "current",
  updatedAt: "2099-01-01T12:00:00.000Z",
  expiresAt: "2099-01-01T13:00:00.000Z"
});
assert.ok(mixed, "Subway plus Ferry is valid Mixed mode");
assert.equal(mixed.transfers, 1);

console.log("Production Statue City Cruises destination, ferry-model, rendering, and navigation tests passed.");

function point(id, name, coordinates) {
  return { id, name, coordinates };
}

function line(...coordinates) {
  return { type: "LineString", coordinates };
}

function leg(id, mode, from, to, options = {}) {
  return {
    id,
    mode,
    from,
    to,
    routeId: options.routeId,
    routeName: options.routeName,
    operator: options.operator,
    durationSeconds: options.durationSeconds ?? 300,
    distanceMeters: options.distanceMeters ?? 300,
    waitSeconds: 0,
    geometry: options.geometry ?? null,
    ticketRequired: options.ticketRequired,
    reservationRecommended: options.reservationRecommended,
    securityScreeningRequired: options.securityScreeningRequired,
    departureTime: options.departureTime,
    scheduleSource: options.scheduleSource,
    scheduleStatus: options.scheduleStatus,
    scheduleFreshness: options.scheduleFreshness,
    accessibility: options.accessibility || {}
  };
}
