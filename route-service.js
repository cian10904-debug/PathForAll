"use strict";

import { lineGeometry, normalizeRouteOption, place } from "./route-model.js";
import { TransitProviderError } from "./transit-errors.js";
import { fetchWithPolicy } from "./fetch-client.js";
import { transitEnvironment } from "./transit-connections.js";

const ROUTING_URL = transitEnvironment.endpoints.routeProvider.url;
const CAPABILITIES_URL = transitEnvironment.endpoints.capabilities.url;
const CONFIGURED_MODES = transitEnvironment.modes;
const ROUTE_MODES = new Set(["walk", "bus", "subway", "ferry", "mixed"]);

export function hasAccessibleRoutingService(url = ROUTING_URL, mode = null, capabilities = configuredRoutingCapabilities({ url })) {
  return Boolean(url) && (!mode || providerSupportsMode(capabilities, mode));
}

export function configuredRoutingCapabilities({
  url = ROUTING_URL,
  modes = CONFIGURED_MODES,
  realtimeArrivals = false,
  elevatorStatus = false,
  elevatorAccessibilityPaths = false,
  ferrySchedules = false
} = {}) {
  return normalizeCapabilities({
    available: Boolean(url),
    modes: url ? parseModes(modes) : [],
    realtimeArrivals,
    elevatorStatus,
    elevatorAccessibilityPaths,
    ferrySchedules,
    source: "Environment configuration",
    checked: false,
    connectionStatus: url ? "unknown" : "not-configured"
  }, Boolean(url));
}

export function providerSupportsMode(capabilities, mode) {
  const supportedModes = capabilities?.supportedModes || capabilities?.modes || [];
  return Boolean(
    capabilities?.available
    && capabilities?.routeProvider !== false
    && supportedModes.includes(String(mode || "").toLowerCase())
  );
}

export function routeSourceForMode(mode, capabilities, { transitNetwork = false } = {}) {
  if (providerSupportsMode(capabilities, mode)) return "route-provider";
  if (mode === "walk") return "local-walk";
  if (transitNetwork) return "transit-network";
  return "unavailable";
}

export async function loadRoutingCapabilities({
  url = ROUTING_URL,
  capabilitiesUrl = CAPABILITIES_URL,
  fetchImpl = globalThis.fetch,
  signal,
  fallback = configuredRoutingCapabilities({ url }),
  now = new Date()
} = {}) {
  if (!url) return normalizeCapabilities({}, false);
  if (!capabilitiesUrl) return fallback;
  try {
    const response = await fetchWithPolicy(capabilitiesUrl, { headers: { Accept: "application/json" }, signal }, {
      fetchImpl,
      timeoutMs: 8_000,
      retries: 1,
      source: "Route-provider capabilities"
    });
    if (!response.ok) throw new Error(`Route capability service returned ${response.status}.`);
    return normalizeCapabilities({
      ...(await response.json()),
      checked: true
    }, true, { now });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.warn("Route-provider capabilities unavailable; using configured modes.", error);
    return {
      ...fallback,
      checked: true,
      connectionStatus: "unavailable",
      freshness: "unknown"
    };
  }
}

export function createRoutingService({
  url = ROUTING_URL,
  fetchImpl = globalThis.fetch,
  capabilities = configuredRoutingCapabilities({ url })
} = {}) {
  return {
    available: Boolean(url),
    capabilities,
    supports(mode) {
      return providerSupportsMode(capabilities, mode);
    },
    async plan({ start, end, needs, mode, departureTime = new Date(), signal }) {
      if (!url) return [];
      if (!providerSupportsMode(capabilities, mode)) {
        throw new TransitProviderError("UNSUPPORTED_MODE", `The connected route provider does not support ${mode} routing.`, {
          supportedModes: capabilities.modes
        });
      }
      const response = await fetchWithPolicy(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal,
        body: JSON.stringify({
          start: start.coordinates,
          end: end.coordinates,
          needs,
          mode,
          departureTime: validTimestamp(departureTime)
        })
      }, {
        fetchImpl,
        timeoutMs: 20_000,
        retries: 0,
        source: "Accessible route provider"
      });
      if (!response.ok) {
        const payload = await safeJson(response);
        throw new TransitProviderError(
          payload?.code || "TRANSIT_PROVIDER_UNAVAILABLE",
          payload?.message || `Accessible routing service returned ${response.status}.`,
          { status: response.status, retriable: response.status >= 500 }
        );
      }
      const payload = await response.json();
      const routes = Array.isArray(payload?.routes) ? payload.routes : [];
      const normalized = routes.map((route, index) => normalizeServerRoute(route, index, {
        start,
        end,
        requestedMode: mode,
        dataVersion: payload.dataVersion,
        serviceAlertVersion: payload.serviceAlertVersion,
        elevatorStatusVersion: payload.elevatorStatusVersion,
        providerUpdatedAt: payload.updatedAt,
        dataFreshness: payload.dataFreshness || payload.freshness,
        expiresAt: payload.expiresAt,
        needs
      })).filter(Boolean);
      if (routes.length && !normalized.length) {
        throw new TransitProviderError(
          "PROVIDER_CONTRACT_ERROR",
          "The route provider returned itineraries that did not match the requested mode or route contract.",
          { requestedMode: mode, routeCount: routes.length }
        );
      }
      return normalized;
    }
  };
}

/** Calls an application-owned service. Provider keys remain server-side. */
export async function planServerRoutes(request, options = {}) {
  return createRoutingService(options).plan(request);
}

/**
 * Convert provider payloads into the shared RouteOption model. Invalid route data is
 * intentionally discarded rather than rendered as a misleading line.
 */
export function normalizeServerRoute(route, index = 0, context = {}) {
  const rawLegs = Array.isArray(route?.legs) ? route.legs : (Array.isArray(route?.segments) ? route.segments : []);
  if (!hasValidProviderTotals(route)) return null;
  const legContext = { ...context, routeGeometry: rawLegs.length === 1 ? route?.geometry || route?.shape : null };
  const legs = rawLegs.map((leg, legIndex) => normalizeServerLeg(leg, legIndex, rawLegs.length, legContext)).filter(Boolean);
  if (!rawLegs.length || legs.length !== rawLegs.length) return null;
  const actualMode = normalizeMode(legs);
  const requestedMode = String(context.requestedMode || "").toLowerCase();
  if (!actualMode || (requestedMode && actualMode !== requestedMode)) return null;
  return normalizeRouteOption({
    id: route?.id || route?.routeId || `server-route-${index}`,
    mode: actualMode,
    requestedMode,
    label: route?.label || route?.name || (index === 0 ? "Recommended accessible route" : "Accessible alternative"),
    legs,
    totalDurationSeconds: optionalSeconds(route?.totalDurationSeconds ?? route?.durationSeconds ?? route?.duration ?? (route?.totalMinutes == null ? undefined : Number(route.totalMinutes) * 60)),
    totalWalkingMeters: nonNegative(route?.totalWalkingMeters ?? route?.walkingMeters),
    totalWaitSeconds: optionalSeconds(route?.totalWaitSeconds ?? route?.waitSeconds ?? (route?.waitMinutes == null ? undefined : Number(route.waitMinutes) * 60)),
    transfers: optionalNonNegative(route?.transfers),
    distanceMeters: nonNegative(route?.distanceMeters ?? route?.distance),
    accessibility: route?.accessibility || {},
    trust: { confidence: Number(route?.dataConfidence ?? route?.accessibility?.confidence ?? .55), unknownSegments: Number(route?.accessibility?.unknownSegments || 0), reviewedPercent: 0 },
    warnings: route?.warnings || route?.alerts || route?.reasons || [],
    dataSource: route?.dataSource || route?.provider || "Routing service",
    endpointConnections: route?.endpointConnections,
    dataVersion: route?.dataVersion || context.dataVersion,
    serviceAlertVersion: route?.serviceAlertVersion || context.serviceAlertVersion,
    elevatorStatusVersion: route?.elevatorStatusVersion || context.elevatorStatusVersion,
    providerUpdatedAt: route?.updatedAt || context.providerUpdatedAt,
    dataFreshness: route?.dataFreshness || route?.freshness || context.dataFreshness,
    updatedAt: route?.updatedAt || context.providerUpdatedAt,
    expiresAt: route?.expiresAt || context.expiresAt
  }, { start: context.start, end: context.end, requestedMode, needs: context.needs });
}

function normalizeServerLeg(raw = {}, index, total, context) {
  const rawGeometry = raw.geometry ?? raw.coordinates ?? raw.shape ?? context.routeGeometry;
  const geometry = raw.geometryVerified === false ? null : lineGeometry(rawGeometry);
  if (raw.geometryVerified !== false && rawGeometry != null && !geometry) return null;
  const fromFallback = index === 0 ? context.start : geometry ? { coordinates: geometry.coordinates[0] } : null;
  const toFallback = index === total - 1 ? context.end : geometry ? { coordinates: geometry.coordinates.at(-1) } : null;
  const from = place(raw.from || raw.start || raw.origin || fromFallback);
  const to = place(raw.to || raw.end || raw.destination || toFallback);
  const mode = normalizeLegMode(raw.mode || raw.type || raw.travelMode);
  if (!from || !to || !mode) return null;
  const durationSeconds = seconds(raw.durationSeconds ?? raw.travelSeconds ?? raw.duration ?? (raw.minutes == null ? undefined : Number(raw.minutes) * 60));
  const waitSeconds = seconds(raw.waitSeconds ?? raw.waitDurationSeconds ?? (raw.waitMinutes == null ? undefined : Number(raw.waitMinutes) * 60));
  const rawDistance = raw.distanceMeters ?? raw.distance;
  const distanceMeters = rawDistance == null ? 0 : Number(rawDistance);
  if (durationSeconds < 0 || waitSeconds < 0 || !Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
  return {
    id: String(raw.id || raw.legId || `server-leg-${index}`), mode, from, to,
    routeId: raw.routeId || raw.route || raw.line || undefined,
    routeName: raw.routeName || raw.route || raw.lineName || raw.line || undefined,
    tripId: raw.tripId || undefined,
    directionId: raw.directionId || undefined,
    headsign: raw.headsign || raw.direction || raw.destinationName || undefined,
    durationSeconds, distanceMeters, waitSeconds,
    departureTime: raw.departureTime || raw.departure || undefined,
    arrivalTime: raw.arrivalTime || raw.arrival || undefined,
    geometry,
    accessibility: normalizeLegAccessibility(raw),
    stopCount: Number.isFinite(Number(raw.stopCount ?? raw.stops)) ? Number(raw.stopCount ?? raw.stops) : undefined,
    operator: raw.operator || undefined,
    terminalId: raw.terminalId || undefined,
    dockId: raw.dockId || undefined,
    ticketRequired: raw.ticketRequired === true,
    reservationRecommended: raw.reservationRecommended === true,
    securityScreeningRequired: raw.securityScreeningRequired === true,
    scheduleSource: raw.scheduleSource || undefined,
    scheduleUpdatedAt: raw.scheduleUpdatedAt || undefined,
    scheduleStatus: raw.scheduleStatus || undefined,
    scheduleFreshness: raw.scheduleFreshness || raw.freshness || undefined,
    lastDepartureTime: raw.lastDepartureTime || undefined,
    departureTerminalId: raw.departureTerminalId || raw.terminalId || undefined,
    vesselAccessibility: raw.vesselAccessibility || undefined,
    gangwayAccessibility: raw.gangwayAccessibility || undefined,
    waitSource: raw.waitSource || (waitSeconds > 0 ? "scheduled" : undefined),
    scheduledWaitSeconds: raw.scheduledWaitSeconds ?? (waitSeconds > 0 ? waitSeconds : undefined)
  };
}

function normalizeMode(legs) {
  const transitModes = new Set(legs.filter(leg => ["bus", "subway", "ferry"].includes(leg.mode)).map(leg => leg.mode));
  if (transitModes.size >= 2) return "mixed";
  if (transitModes.has("bus")) return "bus";
  if (transitModes.has("subway")) return "subway";
  if (transitModes.has("ferry")) return "ferry";
  return "walk";
}

function normalizeLegMode(value) {
  const text = String(value || "").toLowerCase();
  if (["walk", "foot", "walking"].includes(text)) return "walk";
  if (["bus", "coach"].includes(text)) return "bus";
  if (["subway", "metro", "rail", "train"].includes(text)) return "subway";
  if (["ferry", "boat"].includes(text)) return "ferry";
  if (["transfer", "change"].includes(text)) return "transfer";
  return null;
}

function seconds(value) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}

function optionalSeconds(value) {
  return value == null || value === "" ? undefined : seconds(value);
}

function optionalNonNegative(value) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}

function hasValidProviderTotals(route) {
  return [route?.totalDurationSeconds, route?.durationSeconds, route?.duration, route?.totalMinutes, route?.totalWaitSeconds, route?.waitSeconds, route?.waitMinutes, route?.distanceMeters, route?.distance, route?.totalWalkingMeters, route?.walkingMeters, route?.transfers]
    .filter(value => value != null && value !== "")
    .every(value => Number.isFinite(Number(value)) && Number(value) >= 0);
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeCapabilities(value = {}, available = true, options = {}) {
  const updatedAt = validTimestamp(value.updatedAt);
  const expiresAt = validTimestamp(value.expiresAt);
  const freshness = capabilityFreshness(value.freshness, {
    updatedAt,
    expiresAt,
    maxAgeSeconds: value.maxAgeSeconds,
    now: options.now
  });
  const checked = value.checked === true;
  return {
    available: Boolean(available && value.available !== false),
    routeProvider: Boolean(available && value.routeProvider !== false),
    supportedModes: parseModes(value.supportedModes || value.modes),
    modes: parseModes(value.supportedModes || value.modes),
    transitNetwork: value.transitNetwork === true,
    realtimeArrivals: value.realtimeArrivals === true,
    elevatorStatus: value.elevatorStatus === true,
    elevatorAccessibilityPaths: value.elevatorAccessibilityPaths === true,
    ferrySchedules: value.ferrySchedules === true,
    source: safeSource(value.source || "Routing provider"),
    updatedAt,
    expiresAt,
    freshness,
    checked,
    connectionStatus: normalizeConnectionStatus(value.connectionStatus, checked, freshness, available)
  };
}

function parseModes(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map(mode => String(mode).trim().toLowerCase()).filter(mode => ROUTE_MODES.has(mode)))];
}

function capabilityFreshness(value, { updatedAt, expiresAt, maxAgeSeconds, now = new Date() } = {}) {
  if (value === "stale") return "stale";
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (expiresAt && Number.isFinite(nowMs) && Date.parse(expiresAt) <= nowMs) return "stale";
  const ageLimit = Number(maxAgeSeconds);
  if (updatedAt && Number.isFinite(ageLimit) && ageLimit > 0 && Number.isFinite(nowMs)) {
    return nowMs - Date.parse(updatedAt) <= ageLimit * 1000 ? "current" : "stale";
  }
  return value === "current" ? "current" : "unknown";
}

function normalizeConnectionStatus(value, checked, freshness, available) {
  if (["connected", "not-configured", "unavailable", "stale", "unknown"].includes(value)) return value;
  if (!available) return "not-configured";
  if (!checked) return "unknown";
  if (freshness === "stale") return "stale";
  if (freshness === "current") return "connected";
  return "unknown";
}

function validTimestamp(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeSource(value) {
  return String(value || "Routing provider")
    .replace(/https?:\/\/\S+/gi, "[endpoint]")
    .slice(0, 120);
}

function normalizeLegAccessibility(raw) {
  const accessibility = raw.accessibility && typeof raw.accessibility === "object" ? { ...raw.accessibility } : {};
  const elevatorValue = accessibility.elevator || raw.elevatorStatus;
  if (elevatorValue && typeof elevatorValue === "object") {
    accessibility.elevator = {
      status: ["working", "out", "unknown"].includes(elevatorValue.status) ? elevatorValue.status : "unknown",
      source: String(elevatorValue.source || "Transit accessibility provider"),
      updatedAt: elevatorValue.updatedAt || null,
      freshness: ["current", "stale", "unknown"].includes(elevatorValue.freshness) ? elevatorValue.freshness : "unknown"
    };
    accessibility.elevatorStatus = accessibility.elevator.status;
  } else {
    accessibility.elevatorStatus = ["working", "out", "unknown"].includes(String(elevatorValue)) ? String(elevatorValue) : "unknown";
  }
  if (raw.wheelchairAccessible != null && accessibility.wheelchairAccessible == null) accessibility.wheelchairAccessible = raw.wheelchairAccessible;
  return accessibility;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
