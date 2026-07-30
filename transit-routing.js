"use strict";

import { PROFILE_WEIGHTS, dijkstra, summarizeRoute } from "./routing.js";
import { findNearestNode, haversineMeters } from "./osm-network.js";
import { accessiblePathSupports } from "./elevator-status.js";

const TRANSIT_MODES = new Set(["bus", "subway", "ferry"]);

// Production callers provide provider-derived stops and directed topology.
export function prepareTransitStops(pedestrianNodes, transitStops = [], options = {}) {
  const maxSnapDistanceMeters = Math.max(1, Number(options.maxSnapDistanceMeters || 140));
  return (Array.isArray(transitStops) ? transitStops : []).filter(isPassThroughStopUsable).map(stop => {
    const nearest = findNearestNode(pedestrianNodes, stop.coordinates, maxSnapDistanceMeters);
    const anyNearest = nearest || findNearestNode(pedestrianNodes, stop.coordinates);
    return {
      ...stop,
      originalCoordinates: [...stop.coordinates],
      pedestrianNodeId: nearest?.node.id || null,
      snapDistanceMeters: anyNearest?.distanceMeters ?? Infinity,
      snapStatus: nearest?.node ? "valid" : anyNearest?.node ? "too_far" : "unavailable"
    };
  });
}

export function isBoardingStopUsable(stop, needs = {}, travelMode = null, context = {}) {
  if (!stop || stop.closed) return false;
  if (stop.snapStatus && stop.snapStatus !== "valid") return false;
  if (!needs?.wheelchairMode && !needs?.requireElevator && !needs?.requireCurb) return true;
  if (stop.wheelchairAccessible === false) return false;
  const modes = travelMode ? [travelMode] : (stop.modes || []);
  if (modes.includes("subway") && needs.requireElevator) {
    if (!Array.isArray(stop.accessiblePaths) || !stop.accessiblePaths.length) return false;
    const action = context.action || "boarding";
    const platformStopId = action === "exit"
      ? context.edge?.toPlatformStopId || context.edge?.platformStopId || stop.platformStopId
      : context.edge?.fromPlatformStopId || context.edge?.platformStopId || stop.platformStopId;
    const directionId = context.edge?.directionId || stop.directionId;
    if (!platformStopId) return false;
    if (!stop.accessiblePaths.some(path => accessiblePathSupports(path, action, {
      platformStopId,
      directionId,
      requireCompletePath: true
    }))) return false;
  }
  if (modes.includes("bus") && (needs.wheelchairMode || needs.requireCurb) && stop.curbAccess !== true) return false;
  if (modes.includes("ferry") && stop.gangwayAccessible === false) return false;
  return true;
}

export function isExitStopUsable(stop, needs, travelMode = null, context = {}) {
  return isBoardingStopUsable(stop, needs, travelMode, { ...context, action: "exit" });
}

export function isTransferStopUsable(stop, needs, travelMode = null, context = {}) {
  return isBoardingStopUsable(stop, needs, travelMode, { ...context, action: "transfer" });
}

export function isPassThroughStopUsable(stop) {
  return Boolean(stop && !stop.closed && validCoordinates(stop.coordinates));
}

export function planTransitRoutes({
  pedestrianNodes,
  pedestrianEdges,
  startId,
  endId,
  needs = {},
  weather = {},
  mode,
  transitStops = [],
  transitEdges = [],
  departureTime = new Date(),
  candidateSearch = {}
}) {
  if (!["bus", "subway", "ferry", "mixed"].includes(mode)) return [];
  const startCoordinates = pedestrianNodes?.[startId]?.coordinates;
  const endCoordinates = pedestrianNodes?.[endId]?.coordinates;
  if (!startCoordinates || !endCoordinates) return [];
  const stopMap = new Map(transitStops.filter(isPassThroughStopUsable).map(stop => [stop.id, stop]));
  const edges = transitEdges.filter(edge => validTransitEdge(edge, stopMap) && isTransitEdgeActive(edge, departureTime));
  if (!stopMap.size || !edges.length) return [];
  const endpointStops = [...stopMap.values()].filter(stop => supportsRequestedEndpointMode(stop, mode));
  const weights = needs.wheelchairMode || needs.requireElevator ? PROFILE_WEIGHTS.accessible : PROFILE_WEIGHTS.balanced;
  const walkingCache = new Map();
  const maxWalkMinutes = Math.max(1, Number(needs.maxWalkMinutes || 12));
  const search = {
    maxCandidates: Math.max(4, Number(candidateSearch.maxCandidates || 32)),
    maxEvaluations: Math.max(8, Number(candidateSearch.maxEvaluations || 64))
  };
  const entries = buildEndpointCandidates({
    stops: endpointStops,
    endpointId: startId,
    endpointCoordinates: startCoordinates,
    kind: "access",
    predicate: isBoardingStopUsable,
    needs,
    mode,
    edges,
    nodes: pedestrianNodes,
    pedestrianEdges,
    weather,
    weights,
    cache: walkingCache,
    maxWalkMinutes,
    search
  });
  const exits = buildEndpointCandidates({
    stops: endpointStops,
    endpointId: endId,
    endpointCoordinates: endCoordinates,
    kind: "egress",
    predicate: isExitStopUsable,
    needs,
    mode,
    edges,
    nodes: pedestrianNodes,
    pedestrianEdges,
    weather,
    weights,
    cache: walkingCache,
    maxWalkMinutes,
    search
  });
  const itineraries = [];

  for (const entryCandidate of entries) {
    const { stop: entry, walking: access } = entryCandidate;
    for (const exitCandidate of exits) {
      const { stop: exit, walking: egress } = exitCandidate;
      if (entry.id === exit.id) continue;
      const transit = transitDijkstra(entry.id, exit.id, stopMap, edges, mode, needs, departureTime);
      if (!transit?.edges.length) continue;
      const itinerary = {
        key: `${mode}-${entry.id}-${exit.id}-${transit.signature}`,
        label: mode === "mixed" ? "Accessible mixed transit" : `Accessible ${mode}`,
        optionLabel: "Alternative",
        entryStop: entry,
        exitStop: exit,
        access,
        egress,
        transit,
        totalMinutes: access.metrics.minutes + (transit.durationSeconds + transit.totalWaitSeconds) / 60 + egress.metrics.minutes,
        walkingMinutes: access.metrics.minutes + egress.metrics.minutes,
        transitMinutes: transit.durationSeconds / 60,
        transfers: transit.transfers,
        warnings: ferryWarnings(transit.edges),
        score: access.metrics.minutes + transit.scoreSeconds / 60 + egress.metrics.minutes
      };
      const validation = validateTransitItinerary(itinerary, { mode, needs, startCoordinates, endCoordinates, stopMap });
      if (validation.valid) itineraries.push(itinerary);
    }
  }
  return rankAlternatives(itineraries, needs).slice(0, 3);
}

export function validateTransitItinerary(itinerary, { mode, needs = {}, startCoordinates, endCoordinates, stopMap = new Map() } = {}) {
  const reasons = [];
  const edges = itinerary?.transit?.edges || [];
  if (!edges.length) reasons.push("itinerary has no transit movement");
  const ids = new Set();
  let previousTo = null;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const from = stopMap.get(edge.reverse ? edge.to : edge.from);
    const to = stopMap.get(edge.reverse ? edge.from : edge.to);
    if (!from || !to) reasons.push("transit edge has an unknown stop");
    if (ids.has(edge.id)) reasons.push("transit edge is duplicated");
    ids.add(edge.id);
    if (!Number.isFinite(Number(edge.minutes)) || Number(edge.minutes) < 0) reasons.push("transit edge has invalid duration");
    if (!validCoordinates(from?.coordinates) || !validCoordinates(to?.coordinates)) reasons.push("transit edge has invalid coordinate order");
    if (previousTo && previousTo !== (edge.reverse ? edge.to : edge.from)) reasons.push("transit edges are disconnected");
    if (edge.mode === "transfer" && (!isTransferStopUsable(from, needs, null, { edge }) || !isTransferStopUsable(to, needs, null, { edge }))) reasons.push("transfer location is not accessible");
    if (edge.mode === "transfer" && (edge.providerConfirmed !== true || edge.geometryVerified !== true || edge.accessiblePathComplete !== true)) reasons.push("transfer is not provider-confirmed with a complete accessible path");
    if (edge.mode === "transfer" && (!Number.isFinite(Number(edge.minimumTransferSeconds)) || Number(edge.minimumTransferSeconds) < 0)) reasons.push("transfer has no provider minimum connection time");
    if (edge.mode === "transfer" && from && to && haversineMeters(from.coordinates, to.coordinates) > 750 && !edge.geometryVerified) reasons.push("transfer geometry has an implausible geographic gap");
    if (edge.mode !== "transfer" && edge.reverse && edge.bidirectional !== true) reasons.push("transit edge travels against its provider direction");
    if (edge.fromSequence != null && edge.toSequence != null && !edge.reverse && Number(edge.toSequence) <= Number(edge.fromSequence)) reasons.push("transit stop sequence is not forward");
    previousTo = edge.reverse ? edge.from : edge.to;
    if (index === 0 && previousTo == null) reasons.push("itinerary starts with an invalid transit edge");
  }
  const activeModes = new Set(edges.filter(edge => TRANSIT_MODES.has(edge.mode)).map(edge => edge.mode));
  if (mode === "bus" && (activeModes.size !== 1 || !activeModes.has("bus"))) reasons.push("bus itinerary contains invalid modes");
  if (mode === "subway" && (activeModes.size !== 1 || !activeModes.has("subway"))) reasons.push("subway itinerary contains invalid modes");
  if (mode === "ferry" && (activeModes.size !== 1 || !activeModes.has("ferry"))) reasons.push("ferry itinerary contains invalid modes");
  if (mode === "mixed" && activeModes.size < 2) reasons.push("mixed itinerary must contain at least two vehicle modes");
  const firstEdge = edges[0];
  const lastEdge = edges.at(-1);
  const firstStopId = firstEdge && (firstEdge.reverse ? firstEdge.to : firstEdge.from);
  const lastStopId = lastEdge && (lastEdge.reverse ? lastEdge.from : lastEdge.to);
  if (firstStopId && firstStopId !== itinerary?.entryStop?.id) reasons.push("first transit leg does not begin at the boarding stop");
  if (lastStopId && lastStopId !== itinerary?.exitStop?.id) reasons.push("last transit leg does not end at the exit stop");
  if (!isBoardingStopUsable(itinerary?.entryStop, needs, firstEdge?.mode, { edge: firstEdge })) reasons.push("boarding stop is not usable");
  if (!isExitStopUsable(itinerary?.exitStop, needs, lastEdge?.mode, { edge: lastEdge })) reasons.push("exit stop is not usable");
  if (startCoordinates && itinerary?.access?.route && !itinerary.access.route.path?.length) reasons.push("access route is incomplete");
  if (endCoordinates && itinerary?.egress?.route && !itinerary.egress.route.path?.length) reasons.push("egress route is incomplete");
  return { valid: reasons.length === 0, reasons };
}

function transitDijkstra(startStopId, endStopId, stopMap, edges, requestedMode, needs, departureTime = new Date()) {
  const adjacency = new Map([...stopMap.keys()].map(id => [id, []]));
  for (const edge of edges) {
    if (!edgeAllowed(edge, requestedMode)) continue;
    adjacency.get(edge.from)?.push({ edge, next: edge.to, reverse: false });
    // Only reverse a vehicle edge when the provider explicitly asserts both directions.
    if (edge.bidirectional === true) adjacency.get(edge.to)?.push({ edge, next: edge.from, reverse: true });
  }
  const initial = stateKey(startStopId, null, 0, false);
  const distances = new Map([[initial, 0]]);
  const previous = new Map();
  const requestedDeparture = departureTime instanceof Date ? departureTime : new Date(departureTime);
  if (!Number.isFinite(requestedDeparture.getTime())) return null;
  const queue = [{
    stopId: startStopId,
    activeVehicle: null,
    usedMask: 0,
    hasBoarded: false,
    boardings: 0,
    durationSeconds: 0,
    waitSeconds: 0,
    arrivalTimeMs: requestedDeparture.getTime(),
    score: 0
  }];
  let bestEnd = null;

  while (queue.length) {
    queue.sort((a, b) => a.score - b.score);
    const current = queue.shift();
    const currentKey = stateKey(current.stopId, current.activeVehicle, current.usedMask, current.hasBoarded);
    if (!current || current.score !== distances.get(currentKey)) continue;
    if (current.stopId === endStopId && modeSatisfied(current.usedMask, requestedMode)) {
      bestEnd = { ...current, key: currentKey };
      break;
    }
    for (const neighbor of adjacency.get(current.stopId) || []) {
      const { edge, next, reverse } = neighbor;
      const fromStop = stopMap.get(current.stopId);
      const toStop = stopMap.get(next);
      if (!fromStop || !toStop || !isPassThroughStopUsable(toStop)) continue;
      if (edge.mode === "transfer" && (!isTransferStopUsable(fromStop, needs, null, { edge }) || !isTransferStopUsable(toStop, needs, null, { edge }))) continue;
      if (edge.mode !== "transfer" && needs.wheelchairMode && edge.wheelchairAccessible === false) continue;
      const vehicle = edge.mode === "transfer" ? null : vehicleKey(edge, reverse);
      const isBoarding = edge.mode !== "transfer" && current.activeVehicle !== vehicle;
      if (isBoarding && !isBoardingStopUsable(fromStop, needs, edge.mode, { edge })) continue;
      const scheduledWaitSeconds = isBoarding
        ? nextBoardingWaitSeconds(edge, new Date(current.arrivalTimeMs))
        : 0;
      if (isBoarding && scheduledWaitSeconds == null) continue;
      // Walking/station transfer legs end a ride; reboarding the same line is
      // still another boarding and therefore another transfer when appropriate.
      const nextVehicle = vehicle;
      const usedMask = current.usedMask | modeMask(edge.mode);
      const boardings = current.boardings + (isBoarding ? 1 : 0);
      const hasBoarded = current.hasBoarded || isBoarding;
      const transferPenaltySeconds = isBoarding && current.hasBoarded ? (needs.minimizeTransfers ? 360 : 150) : 0;
      const edgeDurationSeconds = edge.mode === "transfer"
        ? Math.max(Number(edge.minutes) * 60, Number(edge.minimumTransferSeconds || 0))
        : Number(edge.minutes) * 60;
      const nextDurationSeconds = current.durationSeconds + edgeDurationSeconds + Number(scheduledWaitSeconds || 0);
      const nextScore = current.score + edgeDurationSeconds + Number(scheduledWaitSeconds || 0) + transferPenaltySeconds;
      const nextKey = stateKey(next, nextVehicle, usedMask, hasBoarded);
      if (nextScore >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, nextScore);
      previous.set(nextKey, {
        previousKey: currentKey,
        edge: {
          ...edge,
          reverse,
          scheduledWaitSeconds: Number(scheduledWaitSeconds || 0),
          waitSource: isBoarding ? "scheduled" : undefined
        },
        stopId: current.stopId,
        boardings
      });
      queue.push({
        stopId: next,
        activeVehicle: nextVehicle,
        usedMask,
        hasBoarded,
        boardings,
        durationSeconds: nextDurationSeconds,
        waitSeconds: current.waitSeconds + Number(scheduledWaitSeconds || 0),
        arrivalTimeMs: requestedDeparture.getTime() + nextDurationSeconds * 1000,
        score: nextScore
      });
    }
  }
  if (!bestEnd) return null;
  const routeEdges = [];
  let cursor = bestEnd.key;
  while (cursor !== initial) {
    const step = previous.get(cursor);
    if (!step) return null;
    routeEdges.unshift(step.edge);
    cursor = step.previousKey;
  }
  const durationSeconds = routeEdges.reduce((sum, edge) => sum + (edge.mode === "transfer"
    ? Math.max(Number(edge.minutes) * 60, Number(edge.minimumTransferSeconds || 0))
    : Number(edge.minutes) * 60), 0);
  const totalWaitSeconds = routeEdges.reduce((sum, edge) => sum + Number(edge.scheduledWaitSeconds || 0), 0);
  const transitGroups = [];
  let activeVehicle = null;
  for (const edge of routeEdges) {
    if (!TRANSIT_MODES.has(edge.mode)) {
      activeVehicle = null;
      continue;
    }
    const vehicle = vehicleKey(edge, edge.reverse);
    if (vehicle !== activeVehicle) transitGroups.push(vehicle);
    activeVehicle = vehicle;
  }
  return {
    edges: routeEdges,
    durationSeconds,
    totalWaitSeconds,
    scoreSeconds: bestEnd.score,
    transitMinutes: durationSeconds / 60,
    transfers: Math.max(0, transitGroups.length - 1),
    signature: routeEdges.map(edge => `${edge.mode}:${edge.route || edge.id}:${edge.reverse ? "r" : "f"}`).join("|")
  };
}

function buildEndpointCandidates({
  stops,
  endpointId,
  endpointCoordinates,
  kind,
  predicate,
  needs,
  mode,
  edges,
  nodes,
  pedestrianEdges,
  weather,
  weights,
  cache,
  maxWalkMinutes,
  search
}) {
  const isAccess = kind === "access";
  const connected = stops
    .filter(stop => stop.pedestrianNodeId && (!stop.snapStatus || stop.snapStatus === "valid"))
    .filter(stop => isEndpointStopUsable(stop, needs, mode, predicate))
    .filter(stop => edges.some(edge => {
      if (!edgeAllowed(edge, mode)) return false;
      return isAccess ? edge.from === stop.id : edge.to === stop.id;
    }))
    .sort((a, b) => {
      const importance = Number(b.providerImportance || b.importance || 0) - Number(a.providerImportance || a.importance || 0);
      if (importance) return importance;
      return haversineMeters(endpointCoordinates, a.coordinates) - haversineMeters(endpointCoordinates, b.coordinates);
    })
    .slice(0, search.maxEvaluations);
  const candidates = [];
  for (const stop of connected) {
    const from = isAccess ? endpointId : stop.pedestrianNodeId;
    const to = isAccess ? stop.pedestrianNodeId : endpointId;
    const walking = getWalkingRoute(from, to, kind, cache, nodes, pedestrianEdges, needs, weather, weights);
    if (!walking || walking.metrics.minutes > maxWalkMinutes) continue;
    candidates.push({ stop, walking, networkWalkMinutes: walking.metrics.minutes });
  }
  return candidates
    .sort((a, b) => a.networkWalkMinutes - b.networkWalkMinutes
      || Number(b.stop.providerImportance || b.stop.importance || 0) - Number(a.stop.providerImportance || a.stop.importance || 0))
    .slice(0, search.maxCandidates);
}

function getWalkingRoute(from, to, type, cache, nodes, edges, needs, weather, weights) {
  const key = `${type}:${from}:${to}`;
  if (cache.has(key)) return cache.get(key);
  const route = dijkstra(nodes, edges, from, to, needs, weather, weights);
  const value = route ? { route, metrics: summarizeRoute(route, edges) } : null;
  cache.set(key, value);
  return value;
}

export function isTransitEdgeActive(edge, departureTime = new Date()) {
  if (!edge || edge.cancelled === true || edge.tripStatus === "cancelled" || edge.serviceActive === false || edge.skipped === true) return false;
  const date = departureTime instanceof Date ? departureTime : new Date(departureTime);
  if (!Number.isFinite(date.getTime())) return false;
  const serviceDate = localDateKey(date);
  if (Array.isArray(edge.serviceDates) && edge.serviceDates.length && !edge.serviceDates.includes(serviceDate)) return false;
  if (edge.serviceStartDate && serviceDate < String(edge.serviceStartDate)) return false;
  if (edge.serviceEndDate && serviceDate > String(edge.serviceEndDate)) return false;
  const exception = (edge.calendarExceptions || []).find(item => String(item.date) === serviceDate);
  if (exception?.type === "removed" || exception?.exceptionType === 2) return false;
  if (Array.isArray(edge.serviceDays) && edge.serviceDays.length && !exception) {
    const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][date.getDay()];
    if (!edge.serviceDays.map(value => String(value).toLowerCase()).includes(day)) return false;
  }
  if (Array.isArray(edge.alerts) && edge.alerts.some(alert => {
    if (alert?.active === false) return false;
    const effect = String(alert?.effect || alert?.code || "").toLowerCase();
    return ["no_service", "stop_closed", "route_suspended", "trip_cancelled", "station_closed", "path_unavailable"].includes(effect);
  })) return false;
  if (edge.mode !== "transfer" && !hasVerifiedSchedule(edge)) return false;
  return true;
}

function validTransitEdge(edge, stopMap) {
  if (!edge || !["bus", "subway", "ferry", "transfer"].includes(edge.mode)) return false;
  if (!stopMap.has(edge.from) || !stopMap.has(edge.to) || edge.from === edge.to) return false;
  if (!Number.isFinite(Number(edge.minutes)) || Number(edge.minutes) < 0) return false;
  if (edge.mode !== "transfer" && !edge.route) return false;
  if (edge.mode !== "transfer" && !hasVerifiedSchedule(edge)) return false;
  if (edge.mode === "transfer" && (
    edge.providerConfirmed !== true
    || edge.geometryVerified !== true
    || edge.accessiblePathComplete !== true
    || !Number.isFinite(Number(edge.minimumTransferSeconds))
  )) return false;
  if (edge.fromSequence != null && edge.toSequence != null && Number(edge.toSequence) <= Number(edge.fromSequence)) return false;
  return true;
}

export function hasVerifiedSchedule(edge) {
  if (edge?.scheduleVerified !== true
    || edge.scheduleFreshness !== "current"
    || !edge.scheduleSource
    || !Number.isFinite(Date.parse(edge.scheduleUpdatedAt))) return false;
  return Boolean(
    (Array.isArray(edge.departures) && edge.departures.some(value => Number.isFinite(Date.parse(value))))
    || validFrequency(edge.frequency)
    || (Number.isFinite(Number(edge.scheduledWaitSeconds)) && Number(edge.scheduledWaitSeconds) >= 0)
  );
}

export function nextBoardingWaitSeconds(edge, arrivalTime = new Date()) {
  if (!hasVerifiedSchedule(edge)) return null;
  const arrival = arrivalTime instanceof Date ? arrivalTime : new Date(arrivalTime);
  if (!Number.isFinite(arrival.getTime())) return null;
  const departures = (edge.departures || [])
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value) && value >= arrival.getTime())
    .sort((a, b) => a - b);
  if (departures.length) return Math.round((departures[0] - arrival.getTime()) / 1000);
  if (validFrequency(edge.frequency)) {
    const start = timeOnServiceDate(arrival, edge.frequency.startTime);
    let end = timeOnServiceDate(arrival, edge.frequency.endTime);
    if (end <= start) end += 24 * 60 * 60 * 1000;
    const arrivalMs = arrival.getTime();
    if (arrivalMs > end) return null;
    if (arrivalMs <= start) return Math.round((start - arrivalMs) / 1000);
    const elapsedSeconds = (arrivalMs - start) / 1000;
    const headway = Number(edge.frequency.headwaySeconds);
    return Math.ceil(elapsedSeconds / headway) * headway - Math.round(elapsedSeconds);
  }
  const wait = Number(edge.scheduledWaitSeconds);
  return Number.isFinite(wait) && wait >= 0 ? wait : null;
}

function validFrequency(value) {
  return value
    && /^\d{2}:\d{2}(?::\d{2})?$/.test(String(value.startTime || ""))
    && /^\d{2}:\d{2}(?::\d{2})?$/.test(String(value.endTime || ""))
    && Number.isFinite(Number(value.headwaySeconds))
    && Number(value.headwaySeconds) > 0;
}

function timeOnServiceDate(date, value) {
  const [hours, minutes, seconds = 0] = String(value).split(":").map(Number);
  const result = new Date(date);
  result.setHours(hours, minutes, seconds, 0);
  return result.getTime();
}

function supportsRequestedEndpointMode(stop, mode) {
  if (mode === "mixed") return stop.modes?.some(item => TRANSIT_MODES.has(item));
  return stop.modes?.includes(mode);
}

function isEndpointStopUsable(stop, needs, requestedMode, predicate) {
  const modes = requestedMode === "mixed"
    ? (stop.modes || []).filter(mode => TRANSIT_MODES.has(mode))
    : [requestedMode];
  return modes.some(mode => predicate(stop, needs, mode));
}

function edgeAllowed(edge, mode) {
  if (mode === "mixed") return ["bus", "subway", "ferry", "transfer"].includes(edge.mode);
  return edge.mode === mode || edge.mode === "transfer";
}

function stateKey(stopId, activeVehicle, usedMask, hasBoarded) {
  return `${stopId}|${activeVehicle || "none"}|${usedMask}|${hasBoarded ? "boarded" : "new"}`;
}

function vehicleKey(edge, reverse = false) {
  const direction = edge.tripId || edge.directionId || edge.direction || (reverse ? "reverse" : "forward");
  return `${edge.mode}:${edge.route}:${direction}`;
}

function ferryWarnings(edges) {
  if (!edges.some(edge => edge.mode === "ferry")) return [];
  const warnings = [];
  if (edges.some(edge => edge.securityScreeningRequired)) warnings.push("Security screening is required before boarding.");
  if (edges.some(edge => edge.ticketRequired)) warnings.push("A Statue City Cruises ticket is required.");
  if (edges.some(edge => edge.reservationRecommended)) warnings.push("Advance reservations are recommended.");
  if (edges.some(edge => edge.mode === "ferry" && !edge.scheduleSource)) warnings.push("Check the current ferry schedule and ticket availability.");
  return warnings;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function modeSatisfied(mask, mode) {
  return mode !== "mixed" || countBits(mask) >= 2;
}

function modeMask(mode) {
  return mode === "bus" ? 1 : mode === "subway" ? 2 : mode === "ferry" ? 4 : 0;
}

function countBits(mask) {
  let value = mask;
  let count = 0;
  while (value) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
}

function validCoordinates(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function rankAlternatives(itineraries, needs) {
  const seen = new Set();
  const ordered = [...itineraries].sort((a, b) => a.score - b.score).filter(item => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
  return ordered.map((item, index) => ({ ...item, optionLabel: index === 0 ? "Recommended" : index === 1 && needs.minimizeTransfers ? "Fewer transfers" : "Alternative" }));
}
