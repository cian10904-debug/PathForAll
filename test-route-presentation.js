"use strict";

import assert from "node:assert/strict";
import { routeLayerData } from "./route-layer-data.js";
import { routeCardMarkup, routeCardViewModel } from "./route-presentation.js";

const START = point("start", "Start", [-73.9900, 40.7300]);
const STOP = point("stop", "Accessible stop", [-73.9880, 40.7315]);
const END = point("end", "Destination", [-73.9860, 40.7330]);

const walking = route({
  id: "walk",
  mode: "walk",
  legs: [leg("walk", "walk", START, END, { geometry: line(START.coordinates, END.coordinates) })]
});
const walkingView = routeCardViewModel(walking);
assert.equal(walkingView.type, "walk");
assert.doesNotThrow(() => routeCardMarkup(walking, 0, escapeHtml, true), "walking routes do not use transit-only fields");
assert.match(routeCardMarkup(walking, 0, escapeHtml), /Personalized accessible walking route/);
assert.match(routeCardMarkup(walking, 0, escapeHtml, true), /<article class="route-card selected">/);
assert.match(routeCardMarkup(walking, 0, escapeHtml, true), /role="radio" aria-checked="true"/);
assert.doesNotMatch(routeCardMarkup(walking, 0, escapeHtml), /Access score/, "cards do not present an unexplained probability-like score");

const busWithoutArrivals = route({
  id: "bus",
  mode: "bus",
  legs: [
    leg("walk-to-bus", "walk", START, STOP, { geometry: line(START.coordinates, STOP.coordinates) }),
    leg("bus", "bus", STOP, END, { routeId: "M8", routeName: "M8", headsign: "East Village", geometry: line(STOP.coordinates, END.coordinates) })
  ]
});
const busView = routeCardViewModel(busWithoutArrivals);
assert.equal(busView.type, "transit");
assert.equal(busView.arrivalText, "Arrival information unavailable");
assert.doesNotThrow(() => routeCardMarkup(busWithoutArrivals, 1, escapeHtml), "a Bus route can render without arrivals or legacy route.transit");
assert.match(routeCardMarkup(busWithoutArrivals, 1, escapeHtml), /Bus M8/);

const subwayUnknownElevator = route({
  id: "subway",
  mode: "subway",
  legs: [leg("subway", "subway", START, END, { routeId: "F", routeName: "F", accessibility: { elevatorStatus: "unknown" }, geometry: line(START.coordinates, END.coordinates) })]
});
assert.equal(routeCardViewModel(subwayUnknownElevator).elevatorStatus, "unknown");
assert.doesNotThrow(() => routeCardMarkup(subwayUnknownElevator, 2, escapeHtml), "unknown elevator data is displayed without a crash");

const mixed = route({
  id: "mixed",
  mode: "mixed",
  legs: [
    leg("bus", "bus", START, STOP, { routeId: "M8", routeName: "M8", geometry: line(START.coordinates, STOP.coordinates) }),
    leg("subway", "subway", STOP, END, { routeId: "F", routeName: "F", accessibility: { elevatorStatus: "working" }, geometry: line(STOP.coordinates, END.coordinates) })
  ]
});
assert.doesNotThrow(() => routeCardMarkup(mixed, 3, escapeHtml), "mixed routes do not access undefined source-specific fields");
assert.equal(routeCardViewModel(mixed).icon, "↔");

const ferry = route({
  id: "ferry",
  mode: "ferry",
  legs: [leg("ferry", "ferry", START, END, {
    routeId: "battery-liberty",
    routeName: "The Battery to Liberty Island",
    operator: "Statue City Cruises",
    geometry: null,
    ticketRequired: true,
    securityScreeningRequired: true
  })]
});
assert.equal(routeCardViewModel(ferry).icon, "⛴");
assert.match(routeCardMarkup(ferry, 4, escapeHtml), /Statue City Cruises/);
assert.equal(routeLayerData(ferry).ferry.features.length, 0, "missing ferry geometry never produces a direct harbor line");

const layers = routeLayerData(mixed);
assert.equal(layers.bus.features.length, 1);
assert.equal(layers.subway.features.length, 1);
assert.equal(layers.walk.features.length, 0);
assert.deepEqual(layers.bus.features[0].geometry.coordinates[0], START.coordinates, "map features retain longitude-latitude order");

const noTransitShape = route({
  id: "bus-no-shape",
  mode: "bus",
  legs: [leg("bus-no-shape", "bus", START, END, { routeId: "M8", routeName: "M8", geometry: null })]
});
const noShapeLayers = routeLayerData(noTransitShape);
assert.equal(noShapeLayers.bus.features.length, 0, "the map never invents a start-to-destination line when verified geometry is absent");
assert.match(routeCardMarkup(noTransitShape, 4, escapeHtml), /Detailed transit map geometry is unavailable/);

const malformedLineRoute = route({
  id: "malformed",
  mode: "walk",
  legs: [leg("bad-line", "walk", START, END, { geometry: { type: "LineString", coordinates: [[999, 40], END.coordinates] } })]
});
assert.equal(routeLayerData(malformedLineRoute).walk.features.length, 0, "invalid coordinate lines are excluded from MapLibre data");
assert.deepEqual(routeLayerData(null), {
  walk: { type: "FeatureCollection", features: [] },
  bus: { type: "FeatureCollection", features: [] },
  subway: { type: "FeatureCollection", features: [] },
  ferry: { type: "FeatureCollection", features: [] }
}, "empty layer data can clear an earlier mode without reinitializing the map");

console.log("Production route presentation and map-layer tests passed.");

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
    durationSeconds: options.durationSeconds ?? 300,
    distanceMeters: options.distanceMeters ?? 300,
    waitSeconds: options.waitSeconds ?? 0,
    routeId: options.routeId,
    routeName: options.routeName,
    headsign: options.headsign,
    operator: options.operator,
    ticketRequired: options.ticketRequired,
    securityScreeningRequired: options.securityScreeningRequired,
    geometry: options.geometry ?? null,
    accessibility: options.accessibility || {}
  };
}

function route(options) {
  const totalDurationSeconds = options.legs.reduce((sum, item) => sum + item.durationSeconds + item.waitSeconds, 0);
  return {
    label: "Accessible route",
    totalDurationSeconds,
    totalWalkingMeters: 0,
    totalWaitSeconds: 0,
    transfers: 0,
    distanceMeters: options.legs.reduce((sum, item) => sum + item.distanceMeters, 0),
    accessibility: {},
    trust: { confidence: .7 },
    warnings: [],
    dataSource: "test",
    ...options
  };
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
