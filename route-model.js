"use strict";

import { haversineMeters } from "./osm-network.js";

/**
 * @typedef {"walk"|"bus"|"subway"|"ferry"|"mixed"} RouteMode
 * @typedef {"walk"|"bus"|"subway"|"ferry"|"transfer"} LegMode
 * @typedef {{ id?: string, name?: string, coordinates: [number, number] }} RoutePlace
 * @typedef {{ type: "LineString", coordinates: [number, number][] } | null} RouteGeometry
 * @typedef {{ id: string, mode: LegMode, from: RoutePlace, to: RoutePlace, routeId?: string, routeName?: string, headsign?: string, durationSeconds: number, distanceMeters: number, waitSeconds?: number, departureTime?: string, arrivalTime?: string, geometry: RouteGeometry, accessibility: object }} RouteLeg
 * @typedef {{ id: string, mode: RouteMode, label: string, legs: RouteLeg[], totalDurationSeconds: number, totalWalkingMeters: number, totalWaitSeconds: number, transfers: number, distanceMeters: number, accessibility: object, trust: object, warnings: string[], dataSource: string }} RouteOption
 */

export const VALID_ROUTE_MODES = new Set(["walk", "bus", "subway", "ferry", "mixed"]);
export const VALID_LEG_MODES = new Set(["walk", "bus", "subway", "ferry", "transfer"]);
const VEHICLE_MODES = new Set(["bus", "subway", "ferry"]);
const MAX_ENDPOINT_DISTANCE_METERS = 25;
const MAX_CONNECTION_DISTANCE_METERS = 25;

export function coordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return [longitude, latitude];
}

export function place(value, fallback = {}) {
  const coordinates = coordinate(value?.coordinates || value?.location || (Array.isArray(value) ? value : null) || fallback.coordinates);
  if (!coordinates) return null;
  return {
    id: String(value?.id || value?.stopId || value?.stationId || fallback.id || `${coordinates[0].toFixed(6)},${coordinates[1].toFixed(6)}`),
    name: String(value?.name || value?.label || fallback.name || "Unnamed location"),
    coordinates
  };
}

export function lineGeometry(value) {
  const candidate = value?.type === "Feature" ? value.geometry : value;
  const raw = candidate?.type === "LineString" ? candidate.coordinates : candidate?.coordinates || candidate;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const coordinates = raw.map(coordinate).filter(Boolean);
  return coordinates.length === raw.length && coordinates.length >= 2 ? { type: "LineString", coordinates } : null;
}

export function transitLegs(route) {
  return (route?.legs || []).filter(leg => VEHICLE_MODES.has(leg.mode));
}

export function routeGeometrySegments(route) {
  return (route?.legs || [])
    .filter(isRenderableLegGeometry)
    .map(leg => ({ mode: leg.mode, coordinates: lineGeometry(leg.geometry).coordinates, leg }));
}

/**
 * Transit and transfer geometry is renderable only when its source did not mark
 * it unverified. Adapters set unverified local stop-to-stop shapes to `null`.
 */
export function isRenderableLegGeometry(leg) {
  if (!lineGeometry(leg?.geometry)) return false;
  if (["bus", "subway", "ferry", "transfer"].includes(leg?.mode)
    && (leg?.geometryVerified === false || leg?.accessibility?.geometryVerified === false)) return false;
  return true;
}

export function calculateRouteTotals(legs) {
  const safeLegs = Array.isArray(legs) ? legs : [];
  const totalDurationSeconds = safeLegs.reduce((sum, leg) => sum + nonNegative(leg.durationSeconds) + nonNegative(leg.waitSeconds), 0);
  const totalWalkingMeters = safeLegs
    .filter(leg => leg.mode === "walk" || leg.mode === "transfer")
    .reduce((sum, leg) => sum + nonNegative(leg.distanceMeters), 0);
  const totalWaitSeconds = safeLegs.reduce((sum, leg) => sum + nonNegative(leg.waitSeconds), 0);
  const distanceMeters = safeLegs.reduce((sum, leg) => sum + nonNegative(leg.distanceMeters), 0);
  let boardings = 0;
  let activeVehicle = null;
  for (const leg of safeLegs) {
    if (!VEHICLE_MODES.has(leg.mode)) {
      // A walking or transfer leg ends the current vehicle ride, even if the
      // following boarding uses the same line again.
      activeVehicle = null;
      continue;
    }
    const vehicle = `${leg.mode}:${leg.routeId || leg.routeName || leg.id}`;
    if (vehicle !== activeVehicle) boardings += 1;
    activeVehicle = vehicle;
  }
  return { totalDurationSeconds, totalWalkingMeters, totalWaitSeconds, distanceMeters, transfers: Math.max(0, boardings - 1) };
}

export function normalizeRouteOption(input = {}, validation = {}) {
  const rawLegs = Array.isArray(input.legs) ? input.legs : [];
  const legs = rawLegs.map((leg, index) => normalizeLeg(leg, index)).filter(Boolean);
  if (rawLegs.length !== legs.length) return null;
  const inferredMode = inferRouteMode(legs);
  const totals = calculateRouteTotals(legs);
  const route = {
    id: String(input.id || input.key || `route-${Math.random().toString(36).slice(2, 9)}`),
    mode: inferredMode,
    label: String(input.label || input.optionLabel || defaultLabel(inferredMode)),
    legs,
    // Totals are deliberately derived from legs. This prevents a provider or
    // arrival refresh from counting a wait twice or mixing minutes and seconds.
    totalDurationSeconds: totals.totalDurationSeconds,
    totalWalkingMeters: totals.totalWalkingMeters,
    totalWaitSeconds: totals.totalWaitSeconds,
    transfers: totals.transfers,
    distanceMeters: totals.distanceMeters,
    accessibility: input.accessibility && typeof input.accessibility === "object" ? input.accessibility : {},
    trust: input.trust && typeof input.trust === "object" ? input.trust : { confidence: .45, unknownSegments: 0, reviewedPercent: 0 },
    warnings: [...new Set(asStringList(input.warnings || input.reasons))],
    dataSource: String(input.dataSource || "Unknown route source"),
    dataVersion: input.dataVersion == null ? null : String(input.dataVersion),
    serviceAlertVersion: input.serviceAlertVersion == null ? null : String(input.serviceAlertVersion),
    elevatorStatusVersion: input.elevatorStatusVersion == null ? null : String(input.elevatorStatusVersion),
    providerUpdatedAt: validTimestamp(input.providerUpdatedAt) || null,
    dataFreshness: validFreshness(input.dataFreshness),
    updatedAt: validTimestamp(input.updatedAt || input.providerUpdatedAt) || null,
    expiresAt: validTimestamp(input.expiresAt) || null
  };
  const result = validateRouteOption(route, { ...validation, requestedMode: validation.requestedMode || input.requestedMode });
  return result.valid ? route : null;
}

export function validateRouteOption(route, options = {}) {
  const reasons = [];
  const legs = route?.legs || [];
  const requestedStart = place(options.start);
  const requestedEnd = place(options.end);
  const connectionLimit = Number(options.maxConnectionMeters || MAX_CONNECTION_DISTANCE_METERS);
  const endpointLimit = Number(options.maxEndpointMeters || MAX_ENDPOINT_DISTANCE_METERS);
  const requestedMode = String(options.requestedMode || "").toLowerCase();
  const needs = options.needs || {};

  if (!VALID_ROUTE_MODES.has(route?.mode)) reasons.push("unknown route mode");
  if (!legs.length) reasons.push("route has no valid legs");
  const ids = new Set();
  for (const leg of legs) {
    if (!VALID_LEG_MODES.has(leg.mode)) reasons.push(`invalid leg mode: ${leg.mode}`);
    if (ids.has(leg.id)) reasons.push("route contains a duplicated leg");
    ids.add(leg.id);
    const from = place(leg.from);
    const to = place(leg.to);
    if (!from || !to) {
      reasons.push(`leg ${leg.id} has invalid coordinates`);
      continue;
    }
    if (!Number.isFinite(Number(leg.durationSeconds)) || !Number.isFinite(Number(leg.distanceMeters)) || !Number.isFinite(Number(leg.waitSeconds || 0)) || Number(leg.durationSeconds) < 0 || Number(leg.distanceMeters) < 0 || Number(leg.waitSeconds || 0) < 0) reasons.push(`leg ${leg.id} has an invalid duration, distance, or wait`);
    if (leg.geometry && !lineGeometry(leg.geometry)) reasons.push(`leg ${leg.id} has invalid geometry`);
    if (leg.geometry) {
      const geometry = lineGeometry(leg.geometry);
      if (geometry && (haversineMeters(from.coordinates, geometry.coordinates[0]) > endpointLimit || haversineMeters(to.coordinates, geometry.coordinates.at(-1)) > endpointLimit)) {
        reasons.push(`leg ${leg.id} geometry does not connect to its endpoints`);
      }
    }
    if ((leg.mode === "walk" || leg.mode === "transfer")
      && (Number(leg.distanceMeters) > 1 || (from && to && haversineMeters(from.coordinates, to.coordinates) > 1))
      && !isRenderableLegGeometry(leg)) {
      reasons.push(`leg ${leg.id} has no verified pedestrian geometry`);
    }
    if (leg.departureTime && leg.arrivalTime && Date.parse(leg.arrivalTime) < Date.parse(leg.departureTime)) reasons.push(`leg ${leg.id} arrives before it departs`);
  }
  for (let index = 1; index < legs.length; index += 1) {
    const previousTo = place(legs[index - 1]?.to);
    const currentFrom = place(legs[index]?.from);
    if (!previousTo || !currentFrom || haversineMeters(previousTo.coordinates, currentFrom.coordinates) > connectionLimit) reasons.push("route legs are disconnected");
  }
  if (requestedStart && legs[0] && haversineMeters(requestedStart.coordinates, legs[0].from.coordinates) > endpointLimit) reasons.push("first leg is too far from the selected start");
  if (requestedEnd && legs.at(-1) && haversineMeters(requestedEnd.coordinates, legs.at(-1).to.coordinates) > endpointLimit) reasons.push("last leg is too far from the selected destination");
  const transit = transitLegs(route);
  if (["bus", "subway", "ferry", "mixed"].includes(route?.mode) && !transit.length) reasons.push("transit route has no transit legs");
  if (route?.mode === "bus" && transit.some(leg => leg.mode !== "bus")) reasons.push("bus route contains a non-bus transit leg");
  if (route?.mode === "subway" && transit.some(leg => leg.mode !== "subway")) reasons.push("subway route contains a non-subway transit leg");
  if (route?.mode === "ferry" && transit.some(leg => leg.mode !== "ferry")) reasons.push("ferry route contains a non-ferry transit leg");
  if (route?.mode === "mixed" && new Set(transit.map(leg => leg.mode)).size < 2) reasons.push("mixed route must contain at least two vehicle modes");
  if (requestedMode && VALID_ROUTE_MODES.has(requestedMode) && requestedMode !== route?.mode) {
    reasons.push(`provider route mode ${route?.mode} does not match requested mode ${requestedMode}`);
  }
  for (const leg of transit.filter(item => item.mode === "ferry")) {
    if (leg.scheduleStatus !== "verified" || leg.scheduleFreshness !== "current" || !leg.scheduleSource || !leg.departureTime) {
      reasons.push(`ferry leg ${leg.id} lacks a current verified departure`);
    }
  }
  if (transit.length && route?.dataFreshness !== "current") reasons.push("transit route data is not current");
  if (transit.length && !Number.isFinite(Date.parse(route?.updatedAt))) reasons.push("transit route has no valid source timestamp");
  if (transit.length && !Number.isFinite(Date.parse(route?.expiresAt))) reasons.push("transit route has no expiration timestamp");
  if (needs.requireElevator) {
    for (const leg of transit.filter(item => item.mode === "subway")) {
      const paths = [leg.accessibility?.boardingPath, leg.accessibility?.exitPath].filter(Boolean);
      if (paths.length !== 2 || paths.some(path => !completeCurrentAccessiblePath(path))) {
        reasons.push(`subway leg ${leg.id} lacks complete current boarding and exit paths`);
      }
    }
  }
  if (route?.dataFreshness === "stale") reasons.push("route data is stale");
  if (route?.expiresAt && Date.parse(route.expiresAt) <= Date.now()) reasons.push("route data has expired");
  const totals = calculateRouteTotals(legs);
  if (!Number.isFinite(Number(route?.totalDurationSeconds)) || Math.abs(Number(route.totalDurationSeconds) - totals.totalDurationSeconds) > .5) reasons.push("route duration does not match its legs");
  if (!Number.isFinite(Number(route?.totalWaitSeconds)) || Math.abs(Number(route.totalWaitSeconds) - totals.totalWaitSeconds) > .5) reasons.push("route wait time does not match its legs");
  if (Number(route?.totalDurationSeconds) < 0) reasons.push("route duration is negative");
  return { valid: reasons.length === 0, reasons };
}

export function normalizeWalkingRoute(item, context = {}) {
  const edgeMap = new Map((context.edges || []).map(edge => [edge.id, edge]));
  const nodes = context.nodes || {};
  const legs = (item?.route?.traversals || []).map((traversal, index) => {
    const edge = edgeMap.get(traversal.edgeId);
    if (!edge) return null;
    const rawGeometry = Array.isArray(edge.geometry) && edge.geometry.length >= 2 ? (traversal.reverse ? [...edge.geometry].reverse() : edge.geometry) : null;
    const fromCoordinates = rawGeometry?.[0] || nodes[traversal.reverse ? edge.to : edge.from]?.coordinates;
    const toCoordinates = rawGeometry?.at(-1) || nodes[traversal.reverse ? edge.from : edge.to]?.coordinates;
    return {
      id: `walk-${index}-${edge.id}`,
      mode: "walk",
      from: { id: traversal.reverse ? edge.to : edge.from, name: edge.name || "Walking segment", coordinates: fromCoordinates },
      to: { id: traversal.reverse ? edge.from : edge.to, name: edge.name || "Walking segment", coordinates: toCoordinates },
      durationSeconds: Math.round(nonNegative(edge.minutes) * 60),
      distanceMeters: nonNegative(edge.distanceMeters),
      geometry: lineGeometry(rawGeometry),
      accessibility: edgeAccessibility(edge),
      edgeId: edge.id,
      edgeIds: [edge.id],
      streetName: edge.name || "pedestrian path"
    };
  }).filter(Boolean);
  return normalizeRouteOption({
    id: item?.key,
    mode: "walk",
    label: item?.label || "Accessible walking route",
    legs,
    accessibility: item?.metrics || {},
    trust: context.trust || {},
    warnings: item?.reasons || [],
    dataSource: context.dataSource || "OpenStreetMap via Overpass API"
  }, { start: context.start, end: context.end });
}

export function normalizeLocalTransitRoute(itinerary, context = {}) {
  const edgeMap = new Map((context.pedestrianEdges || []).map(edge => [edge.id, edge]));
  const nodes = context.pedestrianNodes || {};
  const stopMap = new Map((context.transitStops || []).map(stop => [stop.id, stop]));
  const walkingLegs = (route, prefix) => (route?.traversals || []).map((traversal, index) => {
    const edge = edgeMap.get(traversal.edgeId);
    if (!edge) return null;
    const rawGeometry = Array.isArray(edge.geometry) && edge.geometry.length >= 2 ? (traversal.reverse ? [...edge.geometry].reverse() : edge.geometry) : null;
    return {
      id: `${prefix}-walk-${index}-${edge.id}`,
      mode: "walk",
      from: { id: traversal.reverse ? edge.to : edge.from, name: edge.name || "Walking segment", coordinates: rawGeometry?.[0] || nodes[traversal.reverse ? edge.to : edge.from]?.coordinates },
      to: { id: traversal.reverse ? edge.from : edge.to, name: edge.name || "Walking segment", coordinates: rawGeometry?.at(-1) || nodes[traversal.reverse ? edge.from : edge.to]?.coordinates },
      durationSeconds: Math.round(nonNegative(edge.minutes) * 60),
      distanceMeters: nonNegative(edge.distanceMeters),
      geometry: lineGeometry(rawGeometry),
      accessibility: edgeAccessibility(edge),
      edgeId: edge.id,
      edgeIds: [edge.id],
      streetName: edge.name || "pedestrian path"
    };
  }).filter(Boolean);
  const transit = (itinerary?.transit?.edges || []).map((edge, index) => {
    const fromId = edge.reverse ? edge.to : edge.from;
    const toId = edge.reverse ? edge.from : edge.to;
    const rawGeometry = edge.geometryVerified === true ? orientedLineGeometry(edge.geometry, edge.reverse) : null;
    return {
      id: `transit-${index}-${edge.id}`,
      mode: edge.mode === "transfer" ? "transfer" : edge.mode,
      from: stopMap.get(fromId) || { id: fromId, name: fromId, coordinates: null },
      to: stopMap.get(toId) || { id: toId, name: toId, coordinates: null },
      routeId: edge.route || undefined,
      routeName: edge.route || undefined,
      tripId: edge.tripId || undefined,
      directionId: edge.directionId || undefined,
      headsign: edge.headsign || edge.direction || undefined,
      durationSeconds: Math.round(nonNegative(edge.minutes) * 60),
      distanceMeters: nonNegative(edge.distanceMeters),
      geometry: rawGeometry,
      accessibility: {
        ...(edge.accessibility && typeof edge.accessibility === "object" ? edge.accessibility : {}),
        wheelchairAccessible: edge.wheelchairAccessible !== false,
        elevatorStatus: edge.elevatorStatus || edge.accessibility?.elevatorStatus || null,
        geometryVerified: Boolean(edge.geometryVerified)
      },
      stopCount: Number.isFinite(Number(edge.stopCount)) ? Number(edge.stopCount) : 1,
      operator: edge.operator || undefined,
      terminalId: edge.terminalId || undefined,
      dockId: edge.dockId || undefined,
      ticketRequired: edge.ticketRequired === true,
      reservationRecommended: edge.reservationRecommended === true,
      securityScreeningRequired: edge.securityScreeningRequired === true,
      scheduleSource: edge.scheduleSource || undefined,
      scheduleUpdatedAt: edge.scheduleUpdatedAt || undefined,
      waitSource: edge.waitSource || undefined,
      scheduledWaitSeconds: Number.isFinite(Number(edge.scheduledWaitSeconds)) ? Number(edge.scheduledWaitSeconds) : undefined
    };
  }).filter(leg => place(leg.from) && place(leg.to));
  const legs = [...walkingLegs(itinerary?.access?.route, "access"), ...transit, ...walkingLegs(itinerary?.egress?.route, "egress")];
  const route = normalizeRouteOption({
    id: itinerary?.key,
    mode: context.mode,
    label: itinerary?.optionLabel || itinerary?.label,
    legs,
    accessibility: itinerary?.accessibility || {},
    trust: context.trust || {},
    warnings: [
      ...(transit.some(leg => VEHICLE_MODES.has(leg.mode) && !leg.geometry) ? ["Detailed transit map geometry is unavailable for one or more legs."] : []),
      ...(itinerary?.warnings || [])
    ],
    dataSource: context.dataSource || "Provider-derived transit topology",
    dataVersion: context.dataVersion,
    serviceAlertVersion: context.serviceAlertVersion,
    elevatorStatusVersion: context.elevatorStatusVersion,
    providerUpdatedAt: context.providerUpdatedAt
    ,
    dataFreshness: context.dataFreshness,
    updatedAt: context.updatedAt || context.providerUpdatedAt,
    expiresAt: context.expiresAt
  }, { start: context.start, end: context.end });
  return route;
}

function normalizeLeg(input, index) {
  const from = place(input?.from);
  const to = place(input?.to);
  const mode = String(input?.mode || "").toLowerCase();
  if (!from || !to || !VALID_LEG_MODES.has(mode)) return null;
  const geometry = input?.geometry == null ? null : lineGeometry(input.geometry);
  if (input?.geometry != null && !geometry) return null;
  const durationSeconds = finiteNonNegative(input.durationSeconds);
  const distanceMeters = finiteNonNegative(input.distanceMeters);
  const waitSeconds = finiteNonNegative(input.waitSeconds);
  if (durationSeconds == null || distanceMeters == null || waitSeconds == null) return null;
  const departureTime = validTimestamp(input.departureTime);
  const arrivalTime = validTimestamp(input.arrivalTime);
  if ((input.departureTime && !departureTime) || (input.arrivalTime && !arrivalTime)) return null;
  if (departureTime && arrivalTime && Date.parse(arrivalTime) < Date.parse(departureTime)) return null;
  const accessibility = input.accessibility && typeof input.accessibility === "object" ? { ...input.accessibility } : {};
  if (input.geometryVerified != null && accessibility.geometryVerified == null) accessibility.geometryVerified = Boolean(input.geometryVerified);
  return {
    id: String(input.id || `leg-${index}`),
    mode,
    from,
    to,
    routeId: input.routeId == null ? undefined : String(input.routeId),
    routeName: input.routeName == null ? undefined : String(input.routeName),
    tripId: input.tripId == null ? undefined : String(input.tripId),
    directionId: input.directionId == null ? undefined : String(input.directionId),
    headsign: input.headsign == null ? undefined : String(input.headsign),
    durationSeconds,
    distanceMeters,
    waitSeconds,
    departureTime,
    arrivalTime,
    geometry,
    accessibility,
    edgeId: input.edgeId == null ? undefined : String(input.edgeId),
    edgeIds: Array.isArray(input.edgeIds) ? input.edgeIds.map(String).filter(Boolean) : undefined,
    streetName: input.streetName == null ? undefined : String(input.streetName),
    stopCount: Number.isFinite(Number(input.stopCount)) ? Math.max(0, Number(input.stopCount)) : undefined,
    operator: input.operator == null ? undefined : String(input.operator),
    terminalId: input.terminalId == null ? undefined : String(input.terminalId),
    dockId: input.dockId == null ? undefined : String(input.dockId),
    ticketRequired: input.ticketRequired === true,
    reservationRecommended: input.reservationRecommended === true,
    securityScreeningRequired: input.securityScreeningRequired === true,
    scheduleSource: input.scheduleSource == null ? undefined : String(input.scheduleSource),
    scheduleUpdatedAt: validTimestamp(input.scheduleUpdatedAt),
    scheduleStatus: ["verified", "unavailable", "unknown"].includes(input.scheduleStatus) ? input.scheduleStatus : "unknown",
    scheduleFreshness: validFreshness(input.scheduleFreshness),
    lastDepartureTime: validTimestamp(input.lastDepartureTime),
    departureTerminalId: input.departureTerminalId == null ? undefined : String(input.departureTerminalId),
    vesselAccessibility: input.vesselAccessibility && typeof input.vesselAccessibility === "object" ? { ...input.vesselAccessibility } : undefined,
    gangwayAccessibility: input.gangwayAccessibility && typeof input.gangwayAccessibility === "object" ? { ...input.gangwayAccessibility } : undefined,
    waitSource: input.waitSource == null ? undefined : String(input.waitSource),
    scheduledWaitSeconds: Number.isFinite(Number(input.scheduledWaitSeconds)) ? Math.max(0, Number(input.scheduledWaitSeconds)) : undefined
  };
}

function inferRouteMode(legs) {
  const modes = new Set(transitLegs({ legs }).map(leg => leg.mode));
  if (modes.size >= 2) return "mixed";
  if (modes.has("bus")) return "bus";
  if (modes.has("subway")) return "subway";
  if (modes.has("ferry")) return "ferry";
  return "walk";
}

function edgeAccessibility(edge) {
  return {
    surface: edge.surface || "unknown",
    slope: Number.isFinite(edge.slope) ? edge.slope : null,
    wheelchair: edge.wheelchairStatus || "unknown",
    curbRamp: edge.curbRamp == null ? null : edge.curbRamp === true,
    lighting: edge.lit === true ? "lit" : edge.lit === false ? "unlit" : "unknown"
  };
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function finiteNonNegative(value) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validTimestamp(value) {
  return value && Number.isFinite(Date.parse(value)) ? String(value) : undefined;
}

function validFreshness(value) {
  return ["current", "stale", "unknown"].includes(value) ? value : "unknown";
}

function completeCurrentAccessiblePath(path) {
  return path?.complete === true
    && path?.status === "working"
    && path?.freshness === "current"
    && Boolean(path.entranceId)
    && Boolean(path.fareControlAreaId)
    && Array.isArray(path.platformStopIds)
    && path.platformStopIds.length > 0
    && Number.isFinite(Date.parse(path.updatedAt));
}

function asStringList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map(String).filter(Boolean);
}

function orientedLineGeometry(value, reverse) {
  const geometry = lineGeometry(value);
  if (!geometry) return null;
  return reverse ? { ...geometry, coordinates: [...geometry.coordinates].reverse() } : geometry;
}

function defaultLabel(mode) {
  return ({ walk: "Accessible walking route", bus: "Accessible bus route", subway: "Accessible subway route", ferry: "Accessible ferry route", mixed: "Accessible mixed transit" })[mode] || "Accessible route";
}
