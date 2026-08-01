"use strict";

import { coordinate, lineGeometry } from "./route-model.js";
import { normalizeStationAccessibility } from "./elevator-status.js";
import { TransitProviderError } from "./transit-errors.js";
import { fetchWithPolicy } from "./fetch-client.js";
import { transitEnvironment } from "./transit-connections.js";

const TRANSIT_NETWORK_URL = transitEnvironment.endpoints.transitNetwork.url;
const STOP_MODES = new Set(["bus", "subway", "ferry"]);
const EDGE_MODES = new Set(["bus", "subway", "ferry", "transfer"]);

export function hasTransitNetworkService(url = TRANSIT_NETWORK_URL) {
  return Boolean(url);
}

/**
 * Load a provider-scoped corridor/topology response. The endpoint receives the
 * trip endpoints and selected mode so production deployments do not send the
 * complete NYC transit graph to the browser.
 */
export async function loadTransitNetwork({
  signal,
  url = TRANSIT_NETWORK_URL,
  fetchImpl = globalThis.fetch,
  start,
  end,
  mode,
  maxWalkMinutes,
  departureTime = new Date(),
  now = new Date()
} = {}) {
  if (!url) return null;
  const endpoint = transitNetworkRequestUrl(url, { start, end, mode, maxWalkMinutes, departureTime });
  const response = await fetchWithPolicy(endpoint, { headers: { Accept: "application/json" }, signal }, {
    fetchImpl,
    timeoutMs: 15_000,
    retries: 1,
    source: "Transit topology provider"
  });
  if (!response.ok) {
    const payload = await safeJson(response);
    throw new TransitProviderError(
      payload?.code || "TRANSIT_PROVIDER_UNAVAILABLE",
      payload?.message || `Transit network service returned ${response.status}.`,
      { status: response.status, retriable: response.status >= 500 }
    );
  }
  const payload = await response.json();
  if (payload?.error?.code) throw new TransitProviderError(payload.error.code, payload.error.message, payload.error.details);
  const normalized = normalizeTransitNetwork(payload, { now });
  if (normalized.freshness !== "current") {
    throw new TransitProviderError("TRANSIT_DATA_STALE", undefined, {
      freshness: normalized.freshness,
      source: normalized.dataSource,
      updatedAt: normalized.updatedAt,
      expiresAt: normalized.expiresAt
    });
  }
  if (mode && !normalized.capabilities.modes.includes(mode)) {
    throw new TransitProviderError("UNSUPPORTED_MODE", `The transit topology provider does not support ${mode} routing.`);
  }
  if (!normalized.stops.length || !normalized.edges.length) {
    throw new TransitProviderError(
      payload?.code || "NO_SERVICE_AT_THIS_TIME",
      payload?.message || "No provider-derived transit service is available for this trip."
    );
  }
  return normalized;
}

export function transitNetworkRequestUrl(url, { start, end, mode, maxWalkMinutes, departureTime } = {}) {
  const endpoint = new URL(url, "https://pathforall.local");
  if (coordinate(start)) endpoint.searchParams.set("start", coordinate(start).join(","));
  if (coordinate(end)) endpoint.searchParams.set("end", coordinate(end).join(","));
  if (mode) endpoint.searchParams.set("mode", String(mode));
  if (Number.isFinite(Number(maxWalkMinutes))) endpoint.searchParams.set("maxWalkMinutes", String(Number(maxWalkMinutes)));
  const timestamp = departureTime instanceof Date ? departureTime.toISOString() : validTimestamp(departureTime);
  if (timestamp) endpoint.searchParams.set("departureTime", timestamp);
  return endpoint;
}

export function normalizeTransitNetwork(payload = {}, options = {}) {
  const rawStops = Array.isArray(payload.stops) ? payload.stops : [];
  const stops = rawStops.map(stop => normalizeStop(stop, payload, options)).filter(Boolean);
  const stopIds = new Map();
  const canonicalIds = new Set();
  for (const stop of stops) {
    if (canonicalIds.has(stop.id)) {
      throw new TransitProviderError("PROVIDER_CONTRACT_ERROR", `Duplicate normalized transit stop ID: ${stop.id}`);
    }
    canonicalIds.add(stop.id);
    stopIds.set(`canonical:${stop.id}`, stop.id);
    const providerKey = compoundProviderKey(stop.providerNamespace, stop.providerMode, stop.providerId);
    if (stopIds.has(providerKey)) {
      throw new TransitProviderError("PROVIDER_CONTRACT_ERROR", `Ambiguous provider stop identity: ${providerKey}`);
    }
    stopIds.set(providerKey, stop.id);
  }
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : [];
  const edges = rawEdges
    .map(edge => normalizeEdge(edge, stopIds, payload))
    .filter(Boolean);
  if (rawEdges.length !== edges.length) {
    throw new TransitProviderError(
      "PROVIDER_CONTRACT_ERROR",
      "One or more transit edges had an invalid namespace, endpoint identity, transfer, duration, or mode."
    );
  }
  const updatedAt = validTimestamp(payload.updatedAt);
  return {
    stops,
    edges,
    dataSource: safeSource(payload.dataSource),
    updatedAt,
    freshness: dataFreshness(payload.freshness, updatedAt, payload.maxAgeSeconds, options.now),
    expiresAt: validTimestamp(payload.expiresAt) || expirationTimestamp(updatedAt, payload.maxAgeSeconds),
    dataVersion: nullableString(payload.dataVersion),
    serviceAlertVersion: nullableString(payload.serviceAlertVersion),
    elevatorStatusVersion: nullableString(payload.elevatorStatusVersion),
    capabilities: normalizeCapabilities(payload.capabilities),
    maxSnapDistanceMeters: finitePositive(payload.maxSnapDistanceMeters) || 140,
    maxConnectorDistanceMeters: finitePositive(payload.maxConnectorDistanceMeters) || 220,
    candidateSearch: normalizeCandidateSearch(payload.candidateSearch)
  };
}

export function normalizeTransitIdentifier(value, { agency = "mta", mode = "transit", kind = "stop" } = {}) {
  const providerId = String(value || "").trim();
  if (!providerId) return null;
  if (providerId.includes(":")) return isAllowedTransitIdentifier(providerId) ? providerId : null;
  let localId = providerId;
  // Prefix handling occurs only at this provider boundary, and providerId is
  // retained on normalized records for diagnostics.
  if (agency === "mta" && mode === "bus" && /^MTA_/i.test(localId)) localId = localId.slice(4);
  if (String(agency) === "statue-city-cruises") return `statue-city-cruises:${kind}:${localId}`;
  const generated = `${agency}:${mode}:${kind}:${localId}`;
  return isAllowedTransitIdentifier(generated) ? generated : null;
}

export function isAllowedTransitIdentifier(value) {
  const text = String(value || "");
  return /^mta:(bus|subway):(stop|station|platform|complex|entrance|fare-control|edge|path|transfer):[^:\s]+(?:[:][^:\s]+)*$/.test(text)
    || /^statue-city-cruises:(terminal|dock|edge|route|stop|path):[^:\s]+(?:[:][^:\s]+)*$/.test(text);
}

function normalizeStop(stop, payload, options) {
  const coordinates = coordinate(stop?.coordinates || stop?.location);
  const modes = Array.isArray(stop?.modes) ? stop.modes.filter(mode => STOP_MODES.has(mode)) : [];
  if (!stop?.id || !coordinates || modes.length !== 1) return null;
  const primaryMode = modes[0];
  const agency = providerAgency(stop, payload, primaryMode);
  const id = normalizeTransitIdentifier(stop.id, { agency, mode: primaryMode, kind: stop.kind || stop.type || "stop" });
  const normalized = normalizeStationAccessibility({
    ...stop,
    id,
    providerId: String(stop.id),
    providerNamespace: agency,
    providerMode: primaryMode,
    name: String(stop.name || stop.id),
    coordinates,
    modes,
    parentStationId: stop.parentStationId ? normalizeTransitIdentifier(stop.parentStationId, { agency, mode: primaryMode, kind: "station" }) : null,
    platformStopId: stop.platformStopId ? normalizeTransitIdentifier(stop.platformStopId, { agency, mode: primaryMode, kind: "platform" }) : null,
    stationComplexId: stop.stationComplexId ? normalizeTransitIdentifier(stop.stationComplexId, { agency, mode: primaryMode, kind: "complex" }) : null,
    entranceId: stop.entranceId ? normalizeTransitIdentifier(stop.entranceId, { agency, mode: primaryMode, kind: "entrance" }) : null,
    accessiblePaths: normalizeProviderAccessiblePaths(stop.accessiblePaths, agency, primaryMode),
    curbAccess: normalizeCurbAccess(stop.curbAccess),
    boardingLocationType: subwayLocationType(stop, primaryMode),
    pedestrianConnector: normalizePedestrianConnector(stop.pedestrianConnector || stop.accessConnector, coordinates),
    terminalId: stop.terminalId ? normalizeTransitIdentifier(stop.terminalId, { agency, mode: "ferry", kind: "terminal" }) : null,
    dockId: stop.dockId ? normalizeTransitIdentifier(stop.dockId, { agency, mode: "ferry", kind: "dock" }) : null
  }, payload.elevatorRecords || [], {
    source: payload.elevatorSource,
    now: options.now,
    maxAgeSeconds: payload.elevatorMaxAgeSeconds
  });
  return normalized;
}

function normalizeCurbAccess(value) {
  if (value === true || String(value).toLowerCase() === "true") return true;
  if (value === false || String(value).toLowerCase() === "false") return false;
  return "unknown";
}

function subwayLocationType(stop, mode) {
  if (mode !== "subway") return null;
  const explicit = String(stop.boardingLocationType || stop.locationType || stop.stopType || "").toLowerCase();
  if (["street_entrance", "entrance"].includes(explicit)) return "street_entrance";
  if (["directional_platform", "platform"].includes(explicit)) return "directional_platform";
  if (["parent_station", "station", "station_complex"].includes(explicit)) return "parent_station";
  return stop.entranceId && stop.platformStopId ? "street_entrance" : "parent_station";
}

function normalizePedestrianConnector(value, stopCoordinates) {
  if (!value || typeof value !== "object") return null;
  const geometry = lineGeometry(value.connectorGeometry || value.geometry);
  const status = ["verified", "estimated", "too_far", "unavailable"].includes(value.connectorStatus || value.status)
    ? value.connectorStatus || value.status
    : "unavailable";
  if (!geometry || !["verified", "estimated"].includes(status)) return null;
  const first = geometry.coordinates[0];
  const last = geometry.coordinates.at(-1);
  const directOrder = coordinateNear(first, stopCoordinates);
  const reverseOrder = coordinateNear(last, stopCoordinates);
  if (!directOrder && !reverseOrder) return null;
  const orientedGeometry = directOrder
    ? geometry
    : { ...geometry, coordinates: [...geometry.coordinates].reverse() };
  return {
    originalCoordinates: [...stopCoordinates],
    pedestrianNodeId: value.pedestrianNodeId == null ? null : String(value.pedestrianNodeId),
    snapDistanceMeters: finiteNonNegative(value.snapDistanceMeters),
    connectorGeometry: orientedGeometry,
    connectorDistanceMeters: finiteNonNegative(value.connectorDistanceMeters),
    connectorStatus: status,
    connectorSource: String(value.connectorSource || value.source || "Transit topology provider")
  };
}

function coordinateNear(a, b, tolerance = .0002) {
  return coordinate(a) && coordinate(b)
    && Math.abs(a[0] - b[0]) <= tolerance
    && Math.abs(a[1] - b[1]) <= tolerance;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeSource(value) {
  return String(value || "Transit network provider")
    .replace(/https?:\/\/\S+/gi, "provider endpoint")
    .replace(/\bVITE_[A-Z0-9_]+\b/g, "configured provider")
    .slice(0, 120);
}

function normalizeEdge(edge, stopIds, payload) {
  if (!edge?.id || !edge?.from || !edge?.to || !EDGE_MODES.has(edge.mode)) return null;
  const primaryAgency = providerAgency(edge, payload, edge.mode);
  const fromMode = edge.mode === "transfer" ? edge.fromMode : edge.mode;
  const toMode = edge.mode === "transfer" ? edge.toMode : edge.mode;
  if (!STOP_MODES.has(fromMode) || !STOP_MODES.has(toMode)) return null;
  const fromAgency = String(edge.fromAgency || primaryAgency);
  const toAgency = String(edge.toAgency || primaryAgency);
  const from = resolveStopIdentity(stopIds, edge.from, fromAgency, fromMode);
  const to = resolveStopIdentity(stopIds, edge.to, toAgency, toMode);
  if (!from || !to || from === to) return null;
  const minutes = Number(edge.minutes ?? (edge.durationSeconds == null ? undefined : Number(edge.durationSeconds) / 60));
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (edge.mode === "transfer") {
    if (edge.providerConfirmed !== true || edge.geometryVerified !== true) return null;
    if (!Number.isFinite(Number(edge.minimumTransferSeconds)) || Number(edge.minimumTransferSeconds) < 0) return null;
    if (!Array.isArray(edge.geometry) || edge.geometry.length < 2) return null;
  }
  const id = normalizeTransitIdentifier(edge.id, {
    agency: primaryAgency,
    mode: edge.mode === "transfer" ? fromMode : edge.mode,
    kind: edge.mode === "transfer" ? "transfer" : "edge"
  });
  if (!id) return null;
  return {
    ...edge,
    id,
    providerId: String(edge.id),
    from,
    to,
    minutes,
    bidirectional: edge.bidirectional === true,
    operator: edge.operator == null ? undefined : String(edge.operator),
    terminalId: edge.terminalId ? normalizeTransitIdentifier(edge.terminalId, { agency: primaryAgency, mode: "ferry", kind: "terminal" }) : undefined,
    dockId: edge.dockId ? normalizeTransitIdentifier(edge.dockId, { agency: primaryAgency, mode: "ferry", kind: "dock" }) : undefined,
    ticketRequired: edge.ticketRequired === true,
    reservationRecommended: edge.reservationRecommended === true,
    securityScreeningRequired: edge.securityScreeningRequired === true,
    scheduleSource: edge.scheduleSource == null ? undefined : String(edge.scheduleSource),
    scheduleUpdatedAt: validTimestamp(edge.scheduleUpdatedAt),
    scheduleFreshness: ["current", "stale", "unknown"].includes(edge.scheduleFreshness)
      ? edge.scheduleFreshness
      : ["current", "stale", "unknown"].includes(payload.scheduleFreshness)
        ? payload.scheduleFreshness
        : "unknown",
    scheduleVerified: edge.scheduleVerified === true,
    departures: Array.isArray(edge.departures) ? edge.departures.map(validTimestamp).filter(Boolean) : [],
    frequency: normalizeFrequency(edge.frequency),
    minimumTransferSeconds: edge.mode === "transfer" ? Number(edge.minimumTransferSeconds) : undefined,
    providerConfirmed: edge.providerConfirmed === true,
    fromPlatformStopId: edge.fromPlatformStopId
      ? normalizeTransitIdentifier(edge.fromPlatformStopId, { agency: fromAgency, mode: fromMode, kind: "platform" })
      : undefined,
    toPlatformStopId: edge.toPlatformStopId
      ? normalizeTransitIdentifier(edge.toPlatformStopId, { agency: toAgency, mode: toMode, kind: "platform" })
      : undefined,
    directionId: edge.directionId == null ? undefined : String(edge.directionId)
  };
}

function normalizeProviderAccessiblePaths(values, agency, mode) {
  if (!Array.isArray(values) || mode !== "subway") return [];
  return values.map(path => ({
    ...path,
    entranceId: path.entranceId
      ? normalizeTransitIdentifier(path.entranceId, { agency, mode, kind: "entrance" })
      : null,
    fareControlAreaId: path.fareControlAreaId
      ? normalizeTransitIdentifier(path.fareControlAreaId, { agency, mode, kind: "fare-control" })
      : null,
    platformStopIds: (Array.isArray(path.platformStopIds) ? path.platformStopIds : [path.platformStopId])
      .filter(Boolean)
      .map(value => normalizeTransitIdentifier(value, { agency, mode, kind: "platform" }))
      .filter(Boolean),
    directionIds: (Array.isArray(path.directionIds) ? path.directionIds : [path.directionId])
      .filter(Boolean)
      .map(String)
  }));
}

function resolveStopIdentity(stopIds, value, agency, mode) {
  const text = String(value || "");
  if (text.includes(":")) {
    if (!isAllowedTransitIdentifier(text)) return null;
    return stopIds.get(`canonical:${text}`) || null;
  }
  return stopIds.get(compoundProviderKey(agency, mode, text)) || null;
}

function compoundProviderKey(agency, mode, providerId) {
  return `provider:${agency}:${mode}:${String(providerId)}`;
}

function normalizeFrequency(value) {
  if (!value || typeof value !== "object") return null;
  const headwaySeconds = Number(value.headwaySeconds);
  const startTime = String(value.startTime || "");
  const endTime = String(value.endTime || "");
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(startTime)
    || !/^\d{2}:\d{2}(?::\d{2})?$/.test(endTime)
    || !Number.isFinite(headwaySeconds)
    || headwaySeconds <= 0) return null;
  return { startTime, endTime, headwaySeconds };
}

function providerAgency(record, payload, mode) {
  if (record?.namespace) return String(record.namespace);
  if (record?.agency) return String(record.agency);
  if (mode === "ferry" || /statue city cruises/i.test(String(record?.operator || ""))) return "statue-city-cruises";
  return String(payload?.agency || "mta");
}

function normalizeCapabilities(value = {}) {
  return {
    modes: Array.isArray(value.modes) ? value.modes.filter(mode => STOP_MODES.has(mode) || mode === "mixed") : [],
    realtimeArrivals: value.realtimeArrivals === true,
    elevatorStatus: value.elevatorStatus === true,
    elevatorAccessibilityPaths: value.elevatorAccessibilityPaths === true,
    ferrySchedules: value.ferrySchedules === true
  };
}

function normalizeCandidateSearch(value = {}) {
  return {
    maxCandidates: finitePositive(value.maxCandidates) || 32,
    maxEvaluations: finitePositive(value.maxEvaluations) || 64
  };
}

function dataFreshness(explicit, updatedAt, maxAgeSeconds, now = new Date()) {
  if (["current", "stale", "unknown"].includes(explicit)) return explicit;
  if (!updatedAt || !finitePositive(maxAgeSeconds)) return "unknown";
  const current = now instanceof Date ? now : new Date(now);
  return current.getTime() - Date.parse(updatedAt) <= Number(maxAgeSeconds) * 1000 ? "current" : "stale";
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function expirationTimestamp(updatedAt, maxAgeSeconds) {
  const age = Number(maxAgeSeconds);
  if (!updatedAt || !Number.isFinite(age) || age <= 0) return null;
  return new Date(Date.parse(updatedAt) + age * 1000).toISOString();
}

function nullableString(value) {
  return value == null || value === "" ? null : String(value);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
