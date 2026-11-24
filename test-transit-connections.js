"use strict";

import assert from "node:assert/strict";
import {
  buildTransitConnectionReport,
  sanitizedTransitDiagnostics,
  TRANSIT_CONNECTION_STATUSES,
  validateTransitEnvironment
} from "./transit-connections.js";
import { loadRoutingCapabilities } from "./route-service.js";

const now = "2026-07-30T16:00:00.000Z";
const noProviders = validateTransitEnvironment({});
const disconnected = buildTransitConnectionReport({
  environment: noProviders,
  routeCapabilities: {},
  checkedAt: now
});
assert.equal(disconnected.summary, "Transit services are not connected");
assert.equal(disconnected.detail, "Walk remains available using OpenStreetMap pedestrian data.");
assert.deepEqual(
  Object.values(disconnected.connections).map(item => item.status),
  Array(5).fill("Not configured")
);
assert.deepEqual(disconnected.modeAvailability, {
  walk: true,
  bus: false,
  subway: false,
  ferry: false,
  rail: false,
  mixed: false
});

const routeOnlyEnvironment = validateTransitEnvironment({
  VITE_ACCESSIBLE_ROUTING_URL: "https://routes.example.test/plan",
  VITE_ACCESSIBLE_ROUTING_MODES: "walk,bus",
  VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL: "https://routes.example.test/capabilities"
});
const routeOnly = buildTransitConnectionReport({
  environment: routeOnlyEnvironment,
  routeCapabilities: {
    available: true,
    modes: ["walk", "bus"],
    checked: true,
    connectionStatus: "connected",
    freshness: "current",
    source: "PathForAll route service",
    updatedAt: now
  },
  checkedAt: now
});
assert.equal(routeOnly.connections.routeProvider.status, "Connected");
assert.equal(routeOnly.connections.transitNetwork.status, "Not configured");
assert.equal(routeOnly.connections.realtimeArrivals.status, "Not configured");
assert.equal(routeOnly.connections.elevatorAccessibilityPaths.status, "Not configured");
assert.equal(routeOnly.connections.ferrySchedules.status, "Not configured");
assert.equal(routeOnly.modeAvailability.bus, true);
assert.equal(routeOnly.modeAvailability.subway, false);

const networkEnvironment = validateTransitEnvironment({
  VITE_TRANSIT_NETWORK_URL: "https://transit.example.test/corridor"
});
const networkOnly = buildTransitConnectionReport({
  environment: networkEnvironment,
  transitNetworkState: {
    status: "Connected",
    freshness: "current",
    source: "MTA normalized schedule service",
    updatedAt: now,
    capabilities: { modes: ["bus", "subway"], realtimeArrivals: false }
  },
  checkedAt: now
});
assert.equal(networkOnly.connections.transitNetwork.status, "Connected");
assert.equal(networkOnly.connections.realtimeArrivals.status, "Not configured");
assert.equal(networkOnly.connections.transitNetwork.source, "MTA normalized schedule service");
assert.equal(networkOnly.connections.transitNetwork.updatedAt, now);

const stale = buildTransitConnectionReport({
  environment: routeOnlyEnvironment,
  routeCapabilities: {
    available: true,
    modes: ["bus"],
    checked: true,
    connectionStatus: "stale",
    freshness: "stale",
    source: "Route capabilities",
    updatedAt: "2026-07-29T12:00:00.000Z"
  },
  checkedAt: now
});
assert.equal(stale.connections.routeProvider.status, "Stale");
assert.equal(stale.connections.routeProvider.source, "Route capabilities");
assert.equal(stale.overallStatus, "Stale");

const loadedStaleCapabilities = await loadRoutingCapabilities({
  url: "https://routes.example.test/plan",
  capabilitiesUrl: "https://routes.example.test/capabilities",
  now: new Date(now),
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      available: true,
      modes: ["bus"],
      freshness: "stale",
      source: "Provider capability response",
      updatedAt: "2026-07-29T12:00:00.000Z"
    })
  })
});
assert.equal(loadedStaleCapabilities.connectionStatus, "stale");
assert.equal(loadedStaleCapabilities.freshness, "stale");
assert.equal(loadedStaleCapabilities.updatedAt, "2026-07-29T12:00:00.000Z");

const completeEnvironment = validateTransitEnvironment({
  VITE_ACCESSIBLE_ROUTING_URL: "https://routes.example.test/plan",
  VITE_ACCESSIBLE_ROUTING_MODES: "walk,bus,subway,ferry,mixed",
  VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL: "https://routes.example.test/capabilities",
  VITE_TRANSIT_NETWORK_URL: "https://transit.example.test/corridor",
  VITE_TRANSIT_ARRIVALS_URL: "https://transit.example.test/arrivals"
});
const complete = buildTransitConnectionReport({
  environment: completeEnvironment,
  routeCapabilities: {
    available: true,
    modes: ["walk", "bus", "subway", "ferry", "mixed"],
    checked: true,
    connectionStatus: "connected",
    freshness: "current",
    source: "PathForAll provider",
    updatedAt: now,
    realtimeArrivals: true,
    elevatorAccessibilityPaths: true,
    ferrySchedules: true
  },
  transitNetworkState: {
    status: "Connected",
    freshness: "current",
    source: "Transit topology",
    updatedAt: now,
    capabilities: {
      modes: ["bus", "subway", "ferry", "mixed"],
      realtimeArrivals: true,
      elevatorAccessibilityPaths: true,
      ferrySchedules: true
    }
  },
  realtimeState: {
    status: "Connected",
    freshness: "current",
    source: "Realtime feed",
    updatedAt: now
  },
  checkedAt: now
});
assert.deepEqual(
  Object.values(complete.connections).map(item => item.status),
  Array(5).fill("Connected")
);
assert.deepEqual(complete.modeAvailability, {
  walk: true,
  bus: true,
  subway: true,
  ferry: true,
  rail: false,
  mixed: true
});

const invalid = validateTransitEnvironment({
  VITE_ACCESSIBLE_ROUTING_URL: "ftp://user:password@example.test/route",
  VITE_ACCESSIBLE_ROUTING_MODES: "walk,hovercraft",
  VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL: "https://example.test/capabilities?api_key=secret",
  VITE_TRANSIT_ARRIVALS_URL: "https://example.test/arrivals"
});
assert.equal(invalid.valid, false);
assert.ok(invalid.issues.some(issue => issue.variable === "VITE_ACCESSIBLE_ROUTING_URL"));
assert.ok(invalid.issues.some(issue => issue.code === "UNSUPPORTED_MODE"));
assert.ok(invalid.issues.some(issue => issue.code === "ORPHAN_CAPABILITIES_URL"));

const diagnostics = sanitizedTransitDiagnostics({ ...complete, environment: completeEnvironment });
const serialized = JSON.stringify(diagnostics);
assert.doesNotMatch(serialized, /https?:\/\//);
assert.doesNotMatch(serialized, /routes\.example|transit\.example/);
assert.deepEqual(TRANSIT_CONNECTION_STATUSES, [
  "Connected",
  "Not configured",
  "Unavailable",
  "Stale",
  "Unknown"
]);

console.log("Transit environment validation and five connection-state scenarios passed.");
