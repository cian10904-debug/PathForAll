"use strict";

import { assessEdge, evidence, reverseEdge, summarizeEvidence } from "./accessibility.js";

import { haversineMeters } from "./osm-network.js";
import { actualVehicleModes, continuesRide, LEG_MODES, matchesSearchMode, ROUTE_MODES, searchMode, VEHICLE_MODES } from "./transit-modes.js";
import { instant, inspectTimeline } from "./route-timeline.js";

/**
 * @typedef {"walk"|"bus"|"subway"|"ferry"|"rail"|"mixed"} RouteMode
 * @typedef {"walk"|"bus"|"subway"|"ferry"|"rail"|"transfer"} LegMode
 * @typedef {{ id?: string, name?: string, coordinates: [number, number] }} RoutePlace
 * @typedef {{ type: "LineString", coordinates: [number, number][] } | null} RouteGeometry
 * @typedef {{ id: string, mode: LegMode, from: RoutePlace, to: RoutePlace, routeId?: string, routeName?: string, headsign?: string, durationSeconds: number, distanceMeters: number, waitSeconds?: number, departureTime?: string, arrivalTime?: string, geometry: RouteGeometry, accessibility: object }} RouteLeg
 * @typedef {{ id: string, mode: RouteMode, label: string, legs: RouteLeg[], totalDurationSeconds: number, totalWalkingMeters: number, totalWaitSeconds: number, transfers: number, distanceMeters: number, accessibility: object, trust: object, warnings: string[], dataSource: string }} RouteOption
 */

export const VALID_ROUTE_MODES = ROUTE_MODES;
export const VALID_LEG_MODES = LEG_MODES;
const MAX_ENDPOINT_DISTANCE_METERS = 25;
const MAX_CONNECTION_DISTANCE_METERS = 25;

export function coordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = value[0];
  const latitude = value[1];
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
  if ((VEHICLE_MODES.has(leg?.mode) || leg?.mode === "transfer")
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
  let previous = null;
  for (const leg of safeLegs) {
    if (VEHICLE_MODES.has(leg.mode) && !continuesRide(previous, leg)) boardings += 1;
    previous = leg;
  }
  return { totalDurationSeconds, totalWalkingMeters, totalWaitSeconds, distanceMeters, transfers: Math.max(0, boardings - 1) };
}

export function normalizeRouteOption(input = {}, validation = {}) {
  const rawLegs = Array.isArray(input.legs) ? input.legs : [];
  const legs = rawLegs.map((leg, index) => normalizeLeg(leg, index)).filter(Boolean);
  if (rawLegs.length !== legs.length) {
    validation.onInvalid?.(["Route contains an invalid leg."], ["PROVIDER_CONTRACT_ERROR"]);
    return null;
  }
  const inferredMode = inferRouteMode(legs);
  const totals = calculateRouteTotals(legs);
  const endpointConnections = normalizeEndpointConnections(input.endpointConnections);
  const route = {
    id: String(input.id || input.key || `route-${Math.random().toString(36).slice(2, 9)}`),
    mode: inferredMode,
    requestedMode: searchMode(validation.requestedMode || input.requestedMode || input.mode) || inferredMode,
    actualModes: actualVehicleModes(legs),
    requestedDepartureTime: validTimestamp(validation.departureTime || input.requestedDepartureTime),
    timelineRequired: validation.requireTimeline === true || input.timelineRequired === true,
    arrivalTime: legs.at(-1)?.arrivalTime || null,
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
    warnings: [...new Set([
      ...asStringList(input.warnings || input.reasons),
      ...endpointConnectionWarnings(endpointConnections)
    ])],
    dataSource: safeDataSource(input.dataSource),
    endpointConnections,
    evidence: routeEvidence(legs, validation.needs || input.needs || {}, validation.now),
    generalizedCostMinutes: Number.isFinite(input.generalizedCostMinutes) ? input.generalizedCostMinutes : null,
    provenance: input.provenance || null,
    retrievedAt: validTimestamp(input.retrievedAt) || null,
    observedAt: validTimestamp(input.observedAt) || null,
    dataVersion: input.dataVersion == null ? null : String(input.dataVersion),
    serviceAlertVersion: input.serviceAlertVersion == null ? null : String(input.serviceAlertVersion),
    elevatorStatusVersion: input.elevatorStatusVersion == null ? null : String(input.elevatorStatusVersion),
    providerUpdatedAt: validTimestamp(input.providerUpdatedAt) || null,
    dataFreshness: validFreshness(input.dataFreshness),
    updatedAt: validTimestamp(input.updatedAt || input.providerUpdatedAt) || null,
    expiresAt: validTimestamp(input.expiresAt) || null
  };
  if (route.evidence.status === "unknown") route.warnings.push(`Selected requirements are not fully confirmed. Walking gaps: ${Math.round(route.evidence.unknownDistanceMeters)} m; boarding gaps: ${route.evidence.unknownEvents}. Inspect the evidence before travel.`);
  const result = validateRouteOption(route, { ...validation, requestedMode: validation.requestedMode || input.requestedMode });
  if (!result.valid) {
    validation.onInvalid?.(result.reasons, result.codes);
    return null;
  }
  return route;
}

export function validateRouteOption(route, options = {}) {
  const reasons = [];
  const codes = new Set();
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const legs = route?.legs || [];
  const requestedStart = place(options.start);
  const requestedEnd = place(options.end);
  const connectionLimit = Number(options.maxConnectionMeters || MAX_CONNECTION_DISTANCE_METERS);
  const endpointLimit = Number(options.maxEndpointMeters || MAX_ENDPOINT_DISTANCE_METERS);
  const requestedMode = searchMode(options.requestedMode || route?.requestedMode);
  const needs = options.needs || {};

  if (!VALID_ROUTE_MODES.has(route?.mode)) reasons.push("unknown route mode");
  if (!legs.length) reasons.push("route has no valid legs");
  const ids = new Set();
  const logicalLegs = new Set();
  for (const [legIndex, leg] of legs.entries()) {
    if (!VALID_LEG_MODES.has(leg.mode)) reasons.push(`invalid leg mode: ${leg.mode}`);
    if (ids.has(leg.id)) reasons.push("route contains a duplicated leg");
    ids.add(leg.id);
    const from = place(leg.from);
    const to = place(leg.to);
    if (!from || !to) {
      reasons.push(`leg ${leg.id} has invalid coordinates`);
      continue;
    }
    const logicalLeg = `${leg.mode}:${from.id}:${to.id}:${leg.routeId || ""}`;
    if (logicalLegs.has(logicalLeg)) reasons.push("route contains a logically duplicated leg");
    logicalLegs.add(logicalLeg);
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
      codes.add("ENDPOINT_CONNECTOR_UNAVAILABLE");
    }
    if (["walk", "transfer"].includes(leg.mode)) {
      const assessment = assessEdge(legToEdge(leg), needs, { now });
      if (!assessment.eligible) {
        reasons.push(`leg ${leg.id}: ${[...assessment.violations, ...assessment.unknowns].map(([, value]) => value.reason).join(" ")}`);
        codes.add(assessment.violations.length ? "ACCESSIBILITY_CONSTRAINT_BLOCKED" : "INSUFFICIENT_ACCESSIBILITY_EVIDENCE");
      }
    }
    for (const [name, value] of Object.entries(vehicleRequirements(legs, legIndex, needs, now))) {
      if (value.state === "violated" || (value.state === "unknown"
        && (needs.unknownPolicy !== "allow" || (needs.requireVerifiedCurbAccess && ["boardingCurb", "exitCurb"].includes(name))))) {
        reasons.push(`leg ${leg.id}: ${name}: ${value.reason}`);
        codes.add(value.state === "violated" ? "ACCESSIBILITY_CONSTRAINT_BLOCKED" : "INSUFFICIENT_ACCESSIBILITY_EVIDENCE");
      }
    }
    if (leg.departureTime && leg.arrivalTime && Date.parse(leg.arrivalTime) < Date.parse(leg.departureTime)) reasons.push(`leg ${leg.id} arrives before it departs`);
  }
  for (let index = 1; index < legs.length; index += 1) {
    const previousTo = place(legs[index - 1]?.to);
    const currentFrom = place(legs[index]?.from);
    if (!previousTo || !currentFrom || haversineMeters(previousTo.coordinates, currentFrom.coordinates) > connectionLimit) reasons.push("route legs are disconnected");
  }
  const validatedStart = endpointValidationCoordinate(route?.endpointConnections?.start, requestedStart, "start", reasons);
  const validatedEnd = endpointValidationCoordinate(route?.endpointConnections?.end, requestedEnd, "end", reasons);
  if (validatedStart && legs[0] && haversineMeters(validatedStart, legs[0].from.coordinates) > endpointLimit) reasons.push("first leg is too far from the selected start access point");
  if (validatedEnd && legs.at(-1) && haversineMeters(validatedEnd, legs.at(-1).to.coordinates) > endpointLimit) reasons.push("last leg is too far from the selected destination access point");
  const transit = transitLegs(route);
  const modes = actualVehicleModes(legs);
  if (route?.mode !== inferRouteMode(legs) || !matchesSearchMode(requestedMode, modes))
    reasons.push("Route modes do not match the selected transit search.");
  if (transit.length && Number.isFinite(needs.maxWalkMinutes)
    && legs.filter(leg => ["walk", "transfer"].includes(leg.mode)).reduce((sum, leg) => sum + leg.durationSeconds, 0) > needs.maxWalkMinutes * 60 + 1) {
    reasons.push("Combined access, transfer, and exit walking exceeds the walking limit.");
    codes.add("NO_FEASIBLE_ROUTE");
  }
  // Older saved routes may lack a full timestamp set. Operational provider
  // responses always request strict timeline validation.
  const requiresTimeline = transit.length > 0 && (route?.timelineRequired || options.requireTimeline || legs.some(leg => leg.departureTime && leg.arrivalTime));
  if (requiresTimeline) {
    const timeline = inspectTimeline(legs, { required: true, departedAt: options.departureTime || route.requestedDepartureTime });
    reasons.push(...timeline.issues);
    if (timeline.issues.length) codes.add("PROVIDER_CONTRACT_ERROR");
  }
  for (const leg of transit.filter(item => item.mode === "ferry")) {
    if (leg.scheduleStatus !== "verified" || leg.scheduleFreshness !== "current" || !leg.scheduleSource || !leg.departureTime) {
      reasons.push(`ferry leg ${leg.id} lacks a current verified departure`);
    }
  }
  if (transit.length && route?.dataFreshness !== "current") reasons.push("transit route data is not current");
  if (transit.length && !Number.isFinite(Date.parse(route?.updatedAt))) reasons.push("transit route has no valid source timestamp");
  if (transit.length && !Number.isFinite(Date.parse(route?.expiresAt))) reasons.push("transit route has no expiration timestamp");
  if (route?.dataFreshness === "stale") reasons.push("route data is stale");
  if (route?.expiresAt && Date.parse(route.expiresAt) <= now) reasons.push("route data has expired");
  const totals = calculateRouteTotals(legs);
  if (!Number.isFinite(Number(route?.totalDurationSeconds)) || Math.abs(Number(route.totalDurationSeconds) - totals.totalDurationSeconds) > .5) reasons.push("route duration does not match its legs");
  if (!Number.isFinite(Number(route?.totalWaitSeconds)) || Math.abs(Number(route.totalWaitSeconds) - totals.totalWaitSeconds) > .5) reasons.push("route wait time does not match its legs");
  if (Number(route?.totalDurationSeconds) < 0) reasons.push("route duration is negative");
  return { valid: reasons.length === 0, reasons, codes: reasons.length ? [...(codes.size ? codes : ["PROVIDER_CONTRACT_ERROR"])] : [] };
}

export function normalizeWalkingRoute(item, context = {}) {
  const edgeMap = new Map((context.edges || []).map(edge => [edge.id, edge]));
  const nodes = context.nodes || {};
  const legs = (item?.route?.traversals || []).map((traversal, index) => {
    const storedEdge = edgeMap.get(traversal.edgeId);
    const edge = storedEdge && traversal.reverse ? reverseEdge(storedEdge) : storedEdge;
    if (!edge) return null;
    const rawGeometry = Array.isArray(edge.geometry) && edge.geometry.length >= 2 ? edge.geometry : null;
    const fromCoordinates = rawGeometry?.[0] || nodes[edge.from]?.coordinates;
    const toCoordinates = rawGeometry?.at(-1) || nodes[edge.to]?.coordinates;
    return {
      id: `walk-${index}-${edge.id}`,
      mode: "walk",
      from: { id: edge.from, name: edge.name || "Walking segment", coordinates: fromCoordinates },
      to: { id: edge.to, name: edge.name || "Walking segment", coordinates: toCoordinates },
      durationSeconds: nonNegative(edge.minutes) * 60,
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
    generalizedCostMinutes: item?.route?.score,
    needs: context.needs,
    retrievedAt: context.retrievedAt,
    provenance: context.provenance,
    mode: "walk",
    label: item?.label || "Walking option",
    legs,
    accessibility: item?.metrics || {},
    trust: context.trust || {},
    warnings: item?.reasons || [],
    dataSource: context.dataSource || "OpenStreetMap via Overpass API",
    endpointConnections: context.endpointConnections
  }, { start: context.start, end: context.end, needs: context.needs });
}

export function normalizeLocalTransitRoute(itinerary, context = {}) {
  const edgeMap = new Map((context.pedestrianEdges || []).map(edge => [edge.id, edge]));
  const nodes = context.pedestrianNodes || {};
  const stopMap = new Map((context.transitStops || []).map(stop => [stop.id, stop]));
  const walkingLegs = (route, prefix) => (route?.traversals || []).map((traversal, index) => {
    const storedEdge = edgeMap.get(traversal.edgeId);
    const edge = storedEdge && traversal.reverse ? reverseEdge(storedEdge) : storedEdge;
    if (!edge) return null;
    const rawGeometry = Array.isArray(edge.geometry) && edge.geometry.length >= 2 ? edge.geometry : null;
    return {
      id: `${prefix}-walk-${index}-${edge.id}`,
      mode: "walk",
      from: { id: edge.from, name: edge.name || "Walking segment", coordinates: rawGeometry?.[0] || nodes[edge.from]?.coordinates },
      to: { id: edge.to, name: edge.name || "Walking segment", coordinates: rawGeometry?.at(-1) || nodes[edge.to]?.coordinates },
      durationSeconds: nonNegative(edge.minutes) * 60,
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
      durationSeconds: Math.round(edge.mode === "transfer"
        ? Math.max(nonNegative(edge.minutes) * 60, nonNegative(edge.minimumTransferSeconds))
        : nonNegative(edge.minutes) * 60),
      distanceMeters: nonNegative(edge.distanceMeters),
      waitSeconds: Number.isFinite(Number(edge.scheduledWaitSeconds)) ? Math.max(0, Number(edge.scheduledWaitSeconds)) : 0,
      geometry: rawGeometry,
      accessibility: {
        ...(edge.accessibility && typeof edge.accessibility === "object" ? edge.accessibility : {}),
        wheelchairAccessible: edge.wheelchairAccessible === true ? true : edge.wheelchairAccessible === false ? false : "unknown",
        ...edge.accessibility,
        boardingPath: edge.boardingPath, exitPath: edge.exitPath,
        boardingCurb: stopMap.get(fromId)?.curbAccess,
        exitCurb: stopMap.get(toId)?.curbAccess,
        elevatorStatus: edge.elevatorStatus || edge.accessibility?.elevatorStatus || null,
        crossingsUnknown: edge.mode === "transfer" && edge.accessiblePathComplete !== true,
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
      scheduleStatus: edge.scheduleVerified === true ? "verified" : "unknown",
      scheduleFreshness: edge.scheduleFreshness,
      waitSource: edge.waitSource || undefined,
      scheduledWaitSeconds: Number.isFinite(Number(edge.scheduledWaitSeconds)) ? Number(edge.scheduledWaitSeconds) : undefined
    };
  }).filter(leg => place(leg.from) && place(leg.to));
  const accessConnector = connectorLeg(itinerary?.entryStop, "access", true);
  const egressConnector = connectorLeg(itinerary?.exitStop, "egress", false);
  const legs = applyScheduledTimeline([
    ...walkingLegs(itinerary?.access?.route, "access"),
    ...(accessConnector ? [accessConnector] : []),
    ...transit,
    ...(egressConnector ? [egressConnector] : []),
    ...walkingLegs(itinerary?.egress?.route, "egress")
  ], itinerary?.departureTime || context.departureTime);
  const route = normalizeRouteOption({
    id: itinerary?.key,
    mode: context.mode,
    requestedDepartureTime: itinerary?.departureTime || context.departureTime,
    timelineRequired: Boolean(itinerary?.departureTime),
    label: itinerary?.optionLabel || itinerary?.label,
    legs,
    accessibility: itinerary?.accessibility || {},
    trust: context.trust || {},
    warnings: [
      ...(transit.some(leg => VEHICLE_MODES.has(leg.mode) && !leg.geometry) ? ["Detailed transit map geometry is unavailable for one or more legs."] : []),
      ...(itinerary?.warnings || [])
    ],
    endpointConnections: context.endpointConnections,
    dataSource: context.dataSource || "Provider-derived transit topology",
    dataVersion: context.dataVersion,
    serviceAlertVersion: context.serviceAlertVersion,
    elevatorStatusVersion: context.elevatorStatusVersion,
    providerUpdatedAt: context.providerUpdatedAt,
    dataFreshness: context.dataFreshness,
    updatedAt: context.updatedAt || context.providerUpdatedAt,
    expiresAt: context.expiresAt
  }, { start: context.start, end: context.end, needs: context.needs });
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
    serviceDate: /^\d{8}$/.test(input.serviceDate || "") ? input.serviceDate : undefined,
    fromSequence: Number.isSafeInteger(input.fromSequence) ? input.fromSequence : undefined,
    toSequence: Number.isSafeInteger(input.toSequence) ? input.toSequence : undefined,
    staySeated: input.staySeated === true,
    minimumBoardingSeconds: nonNegative(input.minimumBoardingSeconds),
    minimumTransferSeconds: nonNegative(input.minimumTransferSeconds),
    scheduledDepartureTime: validTimestamp(input.scheduledDepartureTime),
    scheduledArrivalTime: validTimestamp(input.scheduledArrivalTime),
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
  const modes = actualVehicleModes(legs);
  return modes.length > 1 ? "mixed" : modes[0] || "walk";
}

function edgeAccessibility(edge) {
  return {
    stairs: edge.stairs,
    pedestrianEvidence: edge.pedestrianEvidence,
    roadCenterline: edge.roadCenterline,
    requiresCurbRamp: edge.requiresCurbRamp,
    curbEvidence: edge.curbEvidence,
    requiresElevator: edge.requiresElevator,
    elevator: edge.elevator,
    blocked: edge.blocked,
    surface: edge.surface || "unknown",
    slope: Number.isFinite(edge.slope) ? edge.slope : null,
    wheelchair: edge.wheelchairStatus || "unknown",
    nodeRestrictions: edge.nodeRestrictions,
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
  const ms = instant(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function validFreshness(value) {
  return ["current", "stale", "unknown"].includes(value) ? value : "unknown";
}

function completeCurrentAccessiblePath(path, now = Date.now()) {
  return path?.complete === true
    && now - Date.parse(path.updatedAt) <= 300_000
    && Date.parse(path.updatedAt) <= now + 60_000
    && path?.status === "working"
    && path?.freshness === "current"
    && Boolean(path.entranceId)
    && Boolean(path.fareControlAreaId)
    && Array.isArray(path.platformStopIds)
    && path.platformStopIds.length > 0
    && Number.isFinite(Date.parse(path.updatedAt));
}

function connectorLeg(stop, prefix, reverse) {
  const connector = stop?.accessConnector || stop;
  const distanceMeters = Number(connector?.connectorDistanceMeters || 0);
  if (distanceMeters <= 1) return null;
  const geometry = lineGeometry(connector?.connectorGeometry);
  if (!geometry || !["verified", "estimated"].includes(connector?.connectorStatus)) return null;
  const oriented = reverse
    ? { ...geometry, coordinates: [...geometry.coordinates].reverse() }
    : geometry;
  const fromCoordinates = oriented.coordinates[0];
  const toCoordinates = oriented.coordinates.at(-1);
  return {
    id: `${prefix}-connector-${stop.id}`,
    mode: "walk",
    from: {
      id: reverse ? connector.pedestrianNodeId : stop.id,
      name: reverse ? "Pedestrian access point" : stop.name,
      coordinates: fromCoordinates
    },
    to: {
      id: reverse ? stop.id : connector.pedestrianNodeId,
      name: reverse ? stop.name : "Pedestrian access point",
      coordinates: toCoordinates
    },
    durationSeconds: Math.ceil(distanceMeters / 1.15),
    distanceMeters,
    geometry: oriented,
    geometryVerified: true,
    accessibility: {
      geometryVerified: true,
      connectorStatus: connector.connectorStatus,
      connectorSource: connector.connectorSource || "Transit topology provider"
    },
    streetName: "transit access path"
  };
}

function normalizeEndpointConnections(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(["start", "end"].map(key => {
    const item = value[key];
    const selectedCoordinates = coordinate(item?.selectedCoordinates);
    const accessPointCoordinates = coordinate(item?.accessPointCoordinates);
    const connectorGeometry = item?.connectorGeometry == null ? null : lineGeometry(item.connectorGeometry);
    const connectorStatus = ["verified", "estimated", "too_far", "unavailable"].includes(item?.connectorStatus)
      ? item.connectorStatus
      : "unavailable";
    return /** @type {const} */ ([key, {
      selectedCoordinates,
      accessPointCoordinates,
      connectorGeometry,
      connectorDistanceMeters: nonNegative(item?.connectorDistanceMeters),
      connectorSource: item?.connectorSource == null ? null : String(item.connectorSource),
      connectorStatus
    }]);
  }).filter(([, item]) => item.selectedCoordinates || item.accessPointCoordinates));
}

function applyScheduledTimeline(legs, departureTime) {
  let cursor = Date.parse(departureTime);
  if (!Number.isFinite(cursor)) return legs;
  return legs.map(leg => {
    const departure = instant(leg.departureTime) ?? cursor + nonNegative(leg.waitSeconds) * 1000;
    const arrival = instant(leg.arrivalTime) ?? departure + nonNegative(leg.durationSeconds) * 1000;
    cursor = arrival;
    return {
      ...leg,
      departureTime: new Date(departure).toISOString(),
      arrivalTime: new Date(arrival).toISOString()
    };
  });
}

function endpointValidationCoordinate(connection, selected, label, reasons) {
  if (!connection) return selected?.coordinates || null;
  if (!["verified", "estimated"].includes(connection.connectorStatus) || !connection.accessPointCoordinates) {
    reasons.push(`${label} endpoint connector is unavailable`);
    return null;
  }
  if (connection.selectedCoordinates && selected
    && haversineMeters(connection.selectedCoordinates, selected.coordinates) > 2) {
    reasons.push(`${label} endpoint connector does not preserve the selected location`);
  }
  if (connection.connectorGeometry) {
    const geometry = lineGeometry(connection.connectorGeometry);
    const accessDistance = Math.min(
      haversineMeters(connection.accessPointCoordinates, geometry.coordinates[0]),
      haversineMeters(connection.accessPointCoordinates, geometry.coordinates.at(-1))
    );
    if (accessDistance > 10) reasons.push(`${label} endpoint connector geometry misses its access point`);
  }
  return connection.accessPointCoordinates;
}

function endpointConnectionWarnings(connections) {
  if (!connections || typeof connections !== "object") return [];
  return Object.values(connections).some(connection => connection?.connectorStatus === "estimated")
    ? ["A mapped nearby access point is used, but the internal path from the selected place could not be verified."]
    : [];
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
  return ({ walk: "Walking route", bus: "Bus route", subway: "Subway route", ferry: "Ferry route", rail: "Rail route", mixed: "Transit route" })[mode] || "Route";
}

function safeDataSource(value) {
  return String(value || "Unknown route source")
    .replace(/https?:\/\/\S+/gi, "provider endpoint")
    .replace(/\bVITE_[A-Z0-9_]+\b/g, "configured provider")
    .slice(0, 120);
}

/** Convert the route contract back to the shared requirements boundary. */
export function legToEdge(leg) {
  return { ...leg.accessibility, id: leg.edgeId || leg.id, from: leg.from.id, to: leg.to.id,
    distanceMeters: leg.distanceMeters, minutes: leg.durationSeconds / 60,
    wheelchairStatus: leg.accessibility?.wheelchairStatus || leg.accessibility?.wheelchair,
    geometry: leg.geometry?.coordinates };
}

function vehicleRequirements(legs, index, needs, now = Date.now()) {
  /** @type {Record<string, import('./accessibility.js').Evidence>} */
  const result = {};
  const leg = legs[index];
  if (!VEHICLE_MODES.has(leg.mode)) return result;
  const boards = !continuesRide(legs[index - 1], leg);
  const exits = !continuesRide(leg, legs[index + 1]);
  const a = leg.accessibility || {};
  const check = (value, reason) => evidence(value === true ? "satisfied" : value === false ? "violated" : "unknown", reason);
  if (needs.wheelchairMode) {
    result.vehicle = check(a.vehicleWheelchairAccessible ?? a.wheelchairAccessible, "Wheelchair accessibility of the vehicle.");
    if (boards) result.boarding = check(a.boardingAccessible ?? a.wheelchairAccessible, "Wheelchair boarding at the stop.");
    if (exits) result.exit = check(a.exitAccessible ?? a.wheelchairAccessible, "Wheelchair alighting at the stop.");
  }
  if (leg.mode === "bus" && (needs.requireCurb || needs.wheelchairMode || needs.requireVerifiedCurbAccess)) {
    if (boards) result.boardingCurb = check(a.boardingCurb, "Lowered-curb evidence at the boarding stop.");
    if (exits) result.exitCurb = check(a.exitCurb, "Lowered-curb evidence at the exit stop.");
  }
  if (["subway", "rail"].includes(leg.mode) && (needs.requireElevator || needs.wheelchairMode || needs.avoidStairs)) {
    const stationPath = (path, reason) => {
      const observed = instant(path?.updatedAt);
      const out = path?.status === "out" && path.freshness === "current" && observed != null && now - observed >= 0 && now - observed <= 300_000;
      return check(out ? false : completeCurrentAccessiblePath(path, now) ? true : null, reason);
    };
    if (boards) result.stationEntry = stationPath(a.boardingPath, "Current accessible entrance-to-platform path.");
    if (exits) result.stationExit = stationPath(a.exitPath, "Current accessible platform-to-exit path.");
  }
  return result;
}

function routeEvidence(legs, needs, now) {
  const summary = summarizeEvidence(legs.filter(leg => ["walk", "transfer"].includes(leg.mode)).map(legToEdge), needs);
  let unknownEvents = 0;
  for (const [index, leg] of legs.entries()) {
    const requirements = vehicleRequirements(legs, index, needs, now);
    const violations = Object.entries(requirements).filter(([, value]) => value.state === "violated");
    const unknowns = Object.entries(requirements).filter(([, value]) => value.state === "unknown");
    if (!violations.length && !unknowns.length) continue;
    unknownEvents += unknowns.length;
    summary.segments.push({ edgeId: leg.id, distanceMeters: 0, requirements, violations, unknowns, status: violations.length ? "violated" : "unknown", eligible: !violations.length && (needs.unknownPolicy === "allow" || !unknowns.length) });
    if (violations.length) summary.status = "violated";
    else if (summary.status !== "violated") summary.status = "unknown";
  }
  return { ...summary, unknownEvents };
}
