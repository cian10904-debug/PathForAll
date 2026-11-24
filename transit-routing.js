"use strict";

import { PROFILE_WEIGHTS, MinHeap, dijkstra, summarizeRoute } from "./routing.js";
import { findNearestNode, haversineMeters } from "./osm-network.js";
import { accessiblePathSupports } from "./elevator-status.js";
import { lineGeometry } from "./route-model.js";

import { localDateKey, serviceInstant, shiftDateKey } from "./agency-time.js";
import { matchesSearchMode, searchMode, VEHICLE_MODES as TRANSIT_MODES } from "./transit-modes.js";
import { assessEdge } from "./accessibility.js";
const MAX_LABELS = 30_000;

// Production callers provide provider-derived stops and directed topology.
export function prepareTransitStops(pedestrianNodes, transitStops = [], options = {}) {
  const maxSnapDistanceMeters = Math.max(1, Number(options.maxSnapDistanceMeters || 140));
  return (Array.isArray(transitStops) ? transitStops : []).filter(isPassThroughStopUsable).map(stop => {
    const exact = findNearestNode(pedestrianNodes, stop.coordinates, 1);
    const providerConnector = exact
      ? exactStopConnector(stop, exact)
      : verifiedStopConnector(stop, pedestrianNodes, {
        maxSnapDistanceMeters,
        maxConnectorDistanceMeters: options.maxConnectorDistanceMeters
      });
    const anyNearest = findNearestNode(pedestrianNodes, stop.coordinates);
    const connector = providerConnector || {
      originalCoordinates: [...stop.coordinates],
      pedestrianNodeId: null,
      snapDistanceMeters: anyNearest?.distanceMeters ?? Infinity,
      connectorGeometry: null,
      connectorDistanceMeters: 0,
      connectorStatus: anyNearest?.node && anyNearest.distanceMeters > maxSnapDistanceMeters ? "too_far" : "unavailable",
      connectorSource: null
    };
    return {
      ...stop,
      originalCoordinates: [...stop.coordinates],
      pedestrianNodeId: connector.pedestrianNodeId,
      snapDistanceMeters: connector.snapDistanceMeters,
      connectorGeometry: connector.connectorGeometry,
      connectorDistanceMeters: connector.connectorDistanceMeters,
      connectorStatus: connector.connectorStatus,
      connectorSource: connector.connectorSource,
      accessConnector: connector,
      snapStatus: ["verified", "estimated"].includes(connector.connectorStatus)
        ? "valid"
        : connector.connectorStatus
    };
  });
}

export function isBoardingStopUsable(stop, needs = {}, travelMode = null, context = {}) {
  if (!stop || stop.closed) return false;
  if (!["verified", "estimated"].includes(stop.connectorStatus)
    && stop.snapStatus !== "valid") return false;
  if (travelMode === "subway" && !isStreetEntrance(stop)) return false;
  if (!needs?.wheelchairMode && !needs?.requireElevator && !needs?.avoidStairs && !needs?.requireCurb && !needs?.requireVerifiedCurbAccess) return true;
  if (needs.wheelchairMode && stop.wheelchairAccessible === false) return false;
  const modes = travelMode ? [travelMode] : (stop.modes || []);
  if (modes.includes("subway") && (needs.wheelchairMode || needs.requireElevator || needs.avoidStairs)) {
    const status = stationPathFor(stop, context.edge, context.action || "boarding");
    if (!status && (needs.unknownPolicy !== "allow" || stop.accessiblePaths?.some(path => path.status === "out" && path.freshness === "current"))) return false;
  }
  if (modes.includes("bus") && (needs.wheelchairMode || needs.requireCurb || needs.requireVerifiedCurbAccess)) {
    if (stop.curbAccess === false) return false;
    if (stop.curbAccess !== true && (needs.requireVerifiedCurbAccess || needs.unknownPolicy !== "allow")) return false;
  }
  if (modes.includes("ferry") && stop.gangwayAccessible === false) return false;
  return true;
}

export function isExitStopUsable(stop, needs, travelMode = null, context = {}) {
  if (context.edge?.dropOffAllowed === false || context.edge?.alightingSkipped === true) return false;
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
  needs = /** @type {import("./domain.js").Needs} */ ({}),
  weather = {},
  mode,
  transitStops = [],
  transitEdges = [],
  departureTime = new Date(),
  candidateSearch = { maxCandidates: 32, maxEvaluations: 64 },
  diagnostics = { code: "" }
}) {
  mode = searchMode(mode);
  if (!(TRANSIT_MODES.has(mode) || mode === "mixed")) return [];
  const startTime = +new Date(departureTime);
  if (!Number.isFinite(startTime)) return [];
  diagnostics.code = "ENDPOINT_CONNECTOR_UNAVAILABLE";
  const startCoordinates = pedestrianNodes?.[startId]?.coordinates;
  const endCoordinates = pedestrianNodes?.[endId]?.coordinates;
  if (!startCoordinates || !endCoordinates) return [];
  const stopMap = new Map(transitStops.filter(isPassThroughStopUsable).map(stop => [stop.id, stop]));
  const edges = transitEdges.filter(edge => validTransitEdge(edge, stopMap) && edgeAllowed(edge, mode));
  if (!stopMap.size || !edges.length) {
    diagnostics.code = !stopMap.size ? "NO_NEARBY_STOP" : "SCHEDULE_UNAVAILABLE";
    return [];
  }
  const adjacency = new Map([...stopMap.keys()].map(id => [id, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push({ edge, next: edge.to, reverse: false });
    if (edge.bidirectional === true) adjacency.get(edge.to)?.push({ edge, next: edge.from, reverse: true });
  }
  const endpointStops = [...stopMap.values()].filter(stop => supportsRequestedEndpointMode(stop, mode));
  const weights = needs.wheelchairMode || needs.requireElevator ? PROFILE_WEIGHTS.accessible : PROFILE_WEIGHTS.balanced;
  const walkingCache = new Map();
  const maxWalkMinutes = Math.max(1, Number(needs.maxWalkMinutes || 12));
  const search = {
    maxCandidates: Math.min(32, Math.max(4, Number(candidateSearch.maxCandidates || 32))),
    maxEvaluations: Math.min(64, Math.max(8, Number(candidateSearch.maxEvaluations || 64))),
    limited: false
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

  if (!entries.length || !exits.length) {
    diagnostics.code = search.limited ? "SEARCH_LIMIT_REACHED" : endpointStops.some(stop => !stop.pedestrianNodeId)
      ? "ENDPOINT_CONNECTOR_UNAVAILABLE" : "NO_FEASIBLE_ROUTE";
    return [];
  }
  const exitMap = new Map(exits.map(item => [item.stop.id, item]));
  const searchBudget = { remaining: MAX_LABELS, limited: false, constraint: false, evidence: false };
  for (const { stop: entry, walking: access } of entries) {
    const accessSeconds = walkingSecondsFor(access, entry);
    const transits = transitSearch(entry, exitMap, stopMap, adjacency, needs, startTime + accessSeconds * 1_000, maxWalkMinutes * 60 - accessSeconds, searchBudget);
    for (const [stopId, transit] of transits) {
      const { stop: exit, walking: egress } = exitMap.get(stopId);
      const egressSeconds = walkingSecondsFor(egress, exit);
      const itinerary = {
        key: `${mode}-${entry.id}-${exit.id}-${transit.signature}`,
        label: "Transit route",
        optionLabel: "Alternative",
        entryStop: entry,
        exitStop: exit,
        access,
        egress,
        transit,
        departureTime: departureTime instanceof Date
          ? departureTime.toISOString()
          : new Date(departureTime).toISOString(),
        totalMinutes: (accessSeconds + transit.durationSeconds + transit.totalWaitSeconds + egressSeconds) / 60,
        walkingMinutes: (accessSeconds + transit.walkingSeconds + egressSeconds) / 60,
        transitMinutes: transit.durationSeconds / 60,
        transfers: transit.transfers,
        warnings: [
          ...ferryWarnings(transit.edges),
          ...curbAccessWarnings(entry, exit),
          ...connectorWarnings(entry, exit),
          ...subwayPathWarnings(transit.edges, stopMap)
        ],
        score: accessSeconds / 60
          + transit.scoreSeconds / 60
          + egressSeconds / 60
          + curbUncertaintyPenalty(entry, needs)
          + curbUncertaintyPenalty(exit, needs)
      };
      const validation = validateTransitItinerary(itinerary, { mode, needs, startCoordinates, endCoordinates, stopMap });
      if (validation.valid) itineraries.push(itinerary);
    }
  }
  diagnostics.code = itineraries.length ? "" : search.limited || searchBudget.limited ? "SEARCH_LIMIT_REACHED"
    : searchBudget.evidence ? "INSUFFICIENT_ACCESSIBILITY_EVIDENCE"
      : searchBudget.constraint ? "ACCESSIBILITY_CONSTRAINT_BLOCKED" : "NO_FEASIBLE_ROUTE";
  return rankAlternatives(itineraries, needs).slice(0, 3);
}

export function validateTransitItinerary(itinerary, { mode = null, needs = {}, startCoordinates = null, endCoordinates = null, stopMap = new Map() } = {}) {
  const reasons = [];
  const edges = itinerary?.transit?.edges || [];
  if (!edges.length) reasons.push("itinerary has no transit movement");
  const ids = new Set();
  const logicalEdges = new Set();
  let previousTo = null;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const from = stopMap.get(edge.reverse ? edge.to : edge.from);
    const to = stopMap.get(edge.reverse ? edge.from : edge.to);
    if (!from || !to) reasons.push("transit edge has an unknown stop");
    const logicalId = `${edge.id}:${edge.reverse ? "reverse" : "forward"}`;
    if (ids.has(logicalId)) reasons.push("transit edge is duplicated");
    ids.add(logicalId);
    const logicalEdge = `${edge.mode}:${edge.reverse ? edge.to : edge.from}:${edge.reverse ? edge.from : edge.to}:${edge.tripId || edge.route || ""}`;
    if (logicalEdges.has(logicalEdge)) reasons.push("transit edge is logically duplicated");
    logicalEdges.add(logicalEdge);
    if (!Number.isFinite(Number(edge.minutes)) || Number(edge.minutes) < 0) reasons.push("transit edge has invalid duration");
    if (!validCoordinates(from?.coordinates) || !validCoordinates(to?.coordinates)) reasons.push("transit edge has invalid coordinate order");
    if (previousTo && previousTo !== (edge.reverse ? edge.to : edge.from)) reasons.push("transit edges are disconnected");
    if (edge.mode === "transfer" && (edge.providerConfirmed !== true || edge.geometryVerified !== true)) reasons.push("transfer is not provider-confirmed with real geometry");
    if (edge.mode === "transfer" && (!Number.isFinite(Number(edge.minimumTransferSeconds)) || Number(edge.minimumTransferSeconds) < 0)) reasons.push("transfer has no provider minimum connection time");
    if (edge.mode === "transfer" && from && to && haversineMeters(from.coordinates, to.coordinates) > 750 && !edge.geometryVerified) reasons.push("transfer geometry has an implausible geographic gap");
    if (edge.geometryVerified === true && !geometryConnectsStops(edge.geometry, from, to, edge.reverse)) reasons.push("transit edge geometry does not connect to its stops");
    if (edge.mode !== "transfer" && edge.reverse && edge.bidirectional !== true) reasons.push("transit edge travels against its provider direction");
    if (edge.fromSequence != null && edge.toSequence != null && !edge.reverse && Number(edge.toSequence) <= Number(edge.fromSequence)) reasons.push("transit stop sequence is not forward");
    previousTo = edge.reverse ? edge.from : edge.to;
    if (index === 0 && previousTo == null) reasons.push("itinerary starts with an invalid transit edge");
  }
  const activeModes = [...new Set(edges.filter(edge => TRANSIT_MODES.has(edge.mode)).map(edge => edge.mode))];
  if (!activeModes.length || !matchesSearchMode(mode, activeModes)) reasons.push("itinerary does not match the requested mode");
  const firstEdge = edges[0];
  const lastEdge = edges.at(-1);
  const firstStopId = firstEdge && (firstEdge.reverse ? firstEdge.to : firstEdge.from);
  const lastStopId = lastEdge && (lastEdge.reverse ? lastEdge.from : lastEdge.to);
  if (firstStopId && firstStopId !== itinerary?.entryStop?.id) reasons.push("first transit leg does not begin at the boarding stop");
  if (lastStopId && lastStopId !== itinerary?.exitStop?.id) reasons.push("last transit leg does not end at the exit stop");
  if (!isBoardingStopUsable(itinerary?.entryStop, needs, firstEdge?.mode, { edge: firstEdge })) reasons.push("boarding stop is not usable");
  if (!isExitStopUsable(itinerary?.exitStop, needs, lastEdge?.mode, { edge: lastEdge })) reasons.push("exit stop is not usable");
  if (startCoordinates && (!itinerary?.access?.route?.path?.length || !validStopConnector(itinerary?.entryStop))) reasons.push("access route is incomplete");
  if (endCoordinates && (!itinerary?.egress?.route?.path?.length || !validStopConnector(itinerary?.exitStop))) reasons.push("egress route is incomplete");
  return { valid: reasons.length === 0, reasons };
}

function walkingSecondsFor(walking, stop) {
  return walking.metrics.minutes * 60 + (Number(stop.connectorDistanceMeters) > 1 ? Math.ceil(stop.connectorDistanceMeters / 1.15) : 0);
}

// A label includes time, remaining walking budget, number of boardings and a
// directed trip identity. Earlier arrival may wait, but a later cheap label
// cannot eliminate an earlier one that can make a connection.
function transitSearch(entry, exits, stopMap, adjacency, needs, earliest, walkBudget, budget) {
  const queue = new MinHeap();
  const labels = new Map();
  const results = new Map();
  const initial = { stopId: entry.id, vehicle: null, boardings: 0, time: earliest, walk: 0, penalty: 0, priority: 0, minConnection: 0, previous: null, step: null, alive: true };
  queue.push(initial);
  while (queue.size) {
    if (--budget.remaining < 0) { budget.limited = true; break; }
    const current = queue.pop();
    if (!current.alive) continue;
    const currentStop = stopMap.get(current.stopId);
    const exit = exits.get(current.stopId);
    if (exit && current.stopId !== entry.id && current.vehicle && !results.has(current.stopId)
      && current.walk + walkingSecondsFor(exit.walking, exit.stop) <= walkBudget + .01
      && isExitStopUsable(currentStop, needs, current.step.mode, { edge: current.step })) {
      results.set(current.stopId, summarizeTransit(current));
    }
    if (results.size === exits.size) break;
    for (const { edge, next, reverse } of adjacency.get(current.stopId) || []) {
      const transfer = edge.mode === "transfer";
      if (!serviceAvailable(edge, current.time)) continue;
      const nextStop = stopMap.get(next);
      if (!nextStop || !isPassThroughStopUsable(nextStop)) continue;
      const vehicle = transfer ? null : vehicleKey(edge, reverse);
      const continuing = vehicle && current.vehicle === vehicle
        && (current.step?.toSequence == null || edge.fromSequence == null || current.step.toSequence === edge.fromSequence);
      const boarding = !transfer && !continuing;
      if ((!current.boardings && transfer) || (!boarding && !transfer && current.step?.id === edge.id)) continue;
      if (current.vehicle && !continuing && !isExitStopUsable(currentStop, needs, current.step.mode, { edge: current.step })) continue;
      if (boarding && !isBoardingStopUsable(currentStop, needs, edge.mode, { edge })) { budget.evidence = true; continue; }
      if (boarding && (edge.pickupAllowed === false || edge.boardingSkipped === true)) continue;
      if (needs.wheelchairMode && !transfer && edge.wheelchairAccessible !== true) {
        if (edge.wheelchairAccessible === false) { budget.constraint = true; continue; }
        if (needs.unknownPolicy !== "allow") { budget.evidence = true; continue; }
      }
      const boardings = current.boardings + (boarding ? 1 : 0);
      if (boardings > 4) { budget.limited = true; continue; }
      const duration = Math.round(edge.minutes * 60);
      const walk = current.walk + (transfer ? duration : 0);
      if (walk > walkBudget + .01) continue;
      if (transfer) {
        if (!geometryConnectsStops(edge.geometry, currentStop, nextStop, reverse)) continue;
        const assessment = assessEdge({ ...edge.accessibility, id: edge.id, distanceMeters: 0, minutes: edge.minutes, crossingsUnknown: edge.accessiblePathComplete !== true }, needs);
        if (!assessment.eligible) {
          if (assessment.violations.length) budget.constraint = true;
          else budget.evidence = true;
          continue;
        }
      }
      const minConnection = boarding ? Math.max(Number(edge.minimumBoardingSeconds) || 0, current.boardings ? current.minConnection : 0) : 0;
      const eligible = current.time + minConnection * 1_000;
      const departure = transfer ? { time: current.time, day: "" } : nextBoarding(edge, eligible, continuing ? current.step.serviceDate : null);
      if (!departure || (continuing && departure.time - current.time > 600_000)) continue;
      const time = departure.time + duration * 1_000;
      if (time - earliest > 6 * 3_600_000) { budget.limited = true; continue; }
      const wait = (departure.time - current.time) / 1_000;
      const penalty = current.penalty + (boarding && current.boardings ? needs.minimizeTransfers ? 360 : 150 : 0);
      const priority = (time - earliest) / 1_000 + penalty;
      const requiredAfterWalking = transfer ? Math.max(0, Number(edge.minimumTransferSeconds || 0) - duration) : 0;
      const key = JSON.stringify([next, vehicle, boardings, departure.day, requiredAfterWalking, transfer ? null : edge.toSequence || null]);
      const comparable = labels.get(key) || [];
      if (comparable.some(item => item.alive && item.time <= time && item.walk <= walk && item.penalty <= penalty)) continue;
      for (const item of comparable) if (time <= item.time && walk <= item.walk && penalty <= item.penalty) item.alive = false;
      const step = { ...edge, reverse, serviceDate: departure.day?.replaceAll("-", ""), staySeated: Boolean(continuing),
        scheduledWaitSeconds: wait, minimumBoardingSeconds: minConnection, durationSeconds: duration,
        departureTime: new Date(departure.time).toISOString(), arrivalTime: new Date(time).toISOString(),
        waitSource: transfer ? undefined : edge.frequency && !edge.departures?.length ? "frequency" : "scheduled",
        boardingPath: boarding ? stationPathFor(currentStop, edge, "boarding") : undefined,
        exitPath: !transfer ? stationPathFor(nextStop, edge, "exit") : undefined };
      const label = { stopId: next, vehicle, boardings, time, walk, penalty, priority, previous: current, step, alive: true, minConnection: requiredAfterWalking };
      labels.set(key, [...comparable.filter(item => item.alive), label]);
      queue.push(label);
    }
  }
  return results;
}

function summarizeTransit(label) {
  const edges = [];
  let cursor = label;
  while (cursor.step) { edges.unshift(cursor.step); cursor = cursor.previous; }
  const durationSeconds = edges.reduce((total, edge) => total + edge.durationSeconds, 0);
  return { edges, durationSeconds, totalWaitSeconds: edges.reduce((total, edge) => total + edge.scheduledWaitSeconds, 0),
    scoreSeconds: label.priority, walkingSeconds: label.walk, transitMinutes: (durationSeconds - label.walk) / 60,
    transfers: Math.max(0, label.boardings - 1), signature: edges.map(edge => edge.id + "@" + edge.departureTime).join("|") };
}

function stationPathFor(stop, edge, action) {
  if (!stop || !Array.isArray(stop.accessiblePaths)) return undefined;
  const platformStopId = (action === "exit" ? edge?.toPlatformStopId : edge?.fromPlatformStopId) || edge?.platformStopId || stop.platformStopId;
  return platformStopId ? stop.accessiblePaths.find(path => accessiblePathSupports(path, action, {
    platformStopId, directionId: edge?.directionId || stop.directionId, requireCompletePath: true
  })) : undefined;
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
    .filter(stop => stop.pedestrianNodeId && validStopConnector(stop))
    .filter(stop => isEndpointStopUsable(stop, needs, mode, predicate))
    .filter(stop => edges.some(edge => {
      if (!edgeAllowed(edge, mode)) return false;
      return isAccess
        ? edge.from === stop.id || (edge.bidirectional === true && edge.to === stop.id)
        : edge.to === stop.id || (edge.bidirectional === true && edge.from === stop.id);
    }))
    .sort((a, b) => candidateUsefulnessScore(b, edges, isAccess, needs)
      - candidateUsefulnessScore(a, edges, isAccess, needs)
      || haversineMeters(endpointCoordinates, a.coordinates) - haversineMeters(endpointCoordinates, b.coordinates));
  search.limited ||= connected.length > search.maxEvaluations;
  const candidates = [];
  for (const stop of connected.slice(0, search.maxEvaluations)) {
    const from = isAccess ? endpointId : stop.pedestrianNodeId;
    const to = isAccess ? stop.pedestrianNodeId : endpointId;
    const walking = getWalkingRoute(from, to, kind, cache, nodes, pedestrianEdges, needs, weather, weights);
    if (!walking || walking.metrics.minutes > maxWalkMinutes) continue;
    candidates.push({
      stop,
      walking,
      networkWalkMinutes: walking.metrics.minutes,
      usefulness: candidateUsefulnessScore(stop, edges, isAccess, needs)
    });
  }
  search.limited ||= candidates.length > search.maxCandidates;
  return candidates
    .sort((a, b) => a.networkWalkMinutes + curbUncertaintyPenalty(a.stop, needs)
      - (b.networkWalkMinutes + curbUncertaintyPenalty(b.stop, needs))
      || b.usefulness - a.usefulness
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
  const date = new Date(departureTime);
  return Number.isFinite(+date) && serviceAvailable(edge, +date) && runsOnDay(edge, localDateKey(date))
    && (edge.mode === "transfer" || hasVerifiedSchedule(edge));
}

function serviceAvailable(edge, timestamp) {
  if (!edge || edge.cancelled === true || edge.tripStatus === "cancelled" || edge.serviceActive === false || edge.skipped === true) return false;
  return !(Array.isArray(edge.alerts) && edge.alerts.some(alert => {
    if (alert?.active === false) return false;
    const start = Date.parse(alert?.startsAt), end = Date.parse(alert?.endsAt);
    if ((Number.isFinite(start) && timestamp < start) || (Number.isFinite(end) && timestamp >= end)) return false;
    const effect = String(alert?.effect || alert?.code || "").toLowerCase();
    return ["no_service", "stop_closed", "route_suspended", "trip_cancelled", "station_closed", "path_unavailable"].includes(effect);
  }));
}

function runsOnDay(edge, date) {
  const compact = value => String(value || "").replaceAll("-", "");
  const key = compact(date);
  const exception = (edge.calendarExceptions || []).find(item => compact(item.date) === key);
  if (exception?.type === "removed" || Number(exception?.exceptionType) === 2) return false;
  if (exception?.type === "added" || Number(exception?.exceptionType) === 1) return true;
  if (Array.isArray(edge.serviceDates) && edge.serviceDates.length && !edge.serviceDates.some(value => compact(value) === key)) return false;
  if (edge.serviceStartDate && key < compact(edge.serviceStartDate)) return false;
  if (edge.serviceEndDate && key > compact(edge.serviceEndDate)) return false;
  const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(date + "T12:00:00Z").getUTCDay()];
  return !Array.isArray(edge.serviceDays) || !edge.serviceDays.length
    || edge.serviceDays.some(value => String(value).toLowerCase() === day);
}

function validTransitEdge(edge, stopMap) {
  if (!edge || (edge.mode !== "transfer" && !TRANSIT_MODES.has(edge.mode))) return false;
  if (!stopMap.has(edge.from) || !stopMap.has(edge.to) || edge.from === edge.to) return false;
  if (!Number.isFinite(Number(edge.minutes)) || Number(edge.minutes) < 0) return false;
  if (edge.mode === "transfer") return edge.providerConfirmed === true && edge.geometryVerified === true
    && Number.isFinite(Number(edge.minimumTransferSeconds)) && Number(edge.minimumTransferSeconds) >= 0;
  return Boolean(edge.route && hasVerifiedSchedule(edge)
    && !(edge.fromSequence != null && edge.toSequence != null && Number(edge.toSequence) <= Number(edge.fromSequence)));
}

export function hasVerifiedSchedule(edge) {
  return Boolean(edge?.scheduleVerified === true && edge.scheduleFreshness === "current" && edge.scheduleSource
    && Number.isFinite(Date.parse(edge.scheduleUpdatedAt))
    && ((Array.isArray(edge.departures) && edge.departures.some(value => Number.isFinite(Date.parse(value)))) || validFrequency(edge.frequency)));
}

export function nextBoardingWaitSeconds(edge, arrivalTime = new Date()) {
  const arrival = +new Date(arrivalTime);
  const result = nextBoarding(edge, arrival);
  return result ? (result.time - arrival) / 1_000 : null;
}

function nextBoarding(edge, earliest, continuingDay = null) {
  if (!hasVerifiedSchedule(edge) || !Number.isFinite(earliest)) return null;
  const candidates = [];
  for (const value of (edge.departures || [])) {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time < earliest || time - earliest > 6 * 3_600_000) continue;
    const day = edge.serviceDate?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") || localDateKey(new Date(time));
    if ((!continuingDay || day.replaceAll("-", "") === continuingDay) && runsOnDay(edge, day) && serviceAvailable(edge, time)) candidates.push({ time, day });
  }
  if (validFrequency(edge.frequency)) {
    const today = localDateKey(new Date(earliest));
    for (const day of [shiftDateKey(today, -1), today, shiftDateKey(today, 1)]) {
      if ((continuingDay && day.replaceAll("-", "") !== continuingDay) || !runsOnDay(edge, day)) continue;
      const from = clockSeconds(edge.frequency.startTime);
      let through = clockSeconds(edge.frequency.endTime);
      if (through <= from) through += 86_400;
      const start = serviceInstant(day, from), end = serviceInstant(day, through);
      const headway = edge.frequency.headwaySeconds * 1_000;
      const time = start + Math.max(0, Math.ceil((earliest - start) / headway)) * headway;
      if (time < end && time - earliest <= 6 * 3_600_000 && serviceAvailable(edge, time)) candidates.push({ time, day });
    }
  }
  return candidates.sort((a, b) => a.time - b.time)[0] || null;
}

function clockSeconds(value) {
  if (!/^\d{2,3}:[0-5]\d(?::[0-5]\d)?$/.test(String(value))) return NaN;
  const [hours, minutes, seconds = 0] = value.split(":").map(Number);
  return hours * 3_600 + minutes * 60 + seconds;
}

function validFrequency(value) {
  return value && Number.isFinite(clockSeconds(value.startTime)) && Number.isFinite(clockSeconds(value.endTime))
    && Number.isFinite(Number(value.headwaySeconds)) && Number(value.headwaySeconds) > 0;
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
  if (mode === "mixed") return TRANSIT_MODES.has(edge.mode) || edge.mode === "transfer";
  return edge.mode === mode || edge.mode === "transfer";
}

function vehicleKey(edge, reverse) {
  const direction = reverse ? "reverse" : edge.directionId || edge.direction || "forward";
  return edge.mode + ":" + (edge.tripId || edge.id) + ":" + direction;
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

function exactStopConnector(stop, nearest) {
  return {
    originalCoordinates: [...stop.coordinates],
    pedestrianNodeId: nearest.node.id,
    snapDistanceMeters: nearest.distanceMeters,
    connectorGeometry: null,
    connectorDistanceMeters: 0,
    connectorStatus: "verified",
    connectorSource: "Exact pedestrian graph node"
  };
}

function verifiedStopConnector(stop, pedestrianNodes, options) {
  const supplied = stop.pedestrianConnector || stop.accessConnector;
  const geometry = lineGeometry(supplied?.connectorGeometry || supplied?.geometry);
  if (!geometry || !["verified", "estimated"].includes(supplied?.connectorStatus || supplied?.status)) return null;
  const first = geometry.coordinates[0];
  const last = geometry.coordinates.at(-1);
  if (haversineMeters(stop.coordinates, first) > 12) return null;
  const namedNode = supplied.pedestrianNodeId ? pedestrianNodes?.[supplied.pedestrianNodeId] : null;
  const nearest = namedNode && haversineMeters(last, namedNode.coordinates) <= 3
    ? { node: namedNode, distanceMeters: haversineMeters(stop.coordinates, namedNode.coordinates) }
    : findNearestNode(pedestrianNodes, last, 3);
  if (!nearest?.node) return null;
  const snapDistanceMeters = haversineMeters(stop.coordinates, nearest.node.coordinates);
  const connectorDistanceMeters = geometryDistance(geometry.coordinates);
  const maxConnectorDistanceMeters = Math.max(
    1,
    Number(options.maxConnectorDistanceMeters || options.maxSnapDistanceMeters || 140)
  );
  if (snapDistanceMeters > options.maxSnapDistanceMeters
    || connectorDistanceMeters > maxConnectorDistanceMeters
    || connectorDistanceMeters + 8 < snapDistanceMeters
    || connectorDistanceMeters > snapDistanceMeters * 3 + 40) return null;
  return {
    originalCoordinates: [...stop.coordinates],
    pedestrianNodeId: nearest.node.id,
    snapDistanceMeters,
    connectorGeometry: geometry,
    connectorDistanceMeters,
    connectorStatus: supplied.connectorStatus || supplied.status,
    connectorSource: String(supplied.connectorSource || supplied.source || "Transit topology provider")
  };
}

function validStopConnector(stop) {
  if (!stop?.pedestrianNodeId || !["verified", "estimated"].includes(stop.connectorStatus)) return false;
  if (Number(stop.connectorDistanceMeters || 0) <= 1 && Number(stop.snapDistanceMeters || 0) <= 1) return true;
  const geometry = lineGeometry(stop.connectorGeometry);
  return Boolean(geometry
    && haversineMeters(stop.originalCoordinates || stop.coordinates, geometry.coordinates[0]) <= 12
    && Number(stop.connectorDistanceMeters) > 0);
}

function isStreetEntrance(stop) {
  if (stop.boardingLocationType === "parent_station") return false;
  if (stop.boardingLocationType === "street_entrance") return true;
  return Boolean(stop.entranceId && stop.platformStopId);
}

function candidateUsefulnessScore(stop, edges, isAccess, needs) {
  const relevant = edges.filter(edge => {
    if (edge.mode === "transfer") return edge.from === stop.id || edge.to === stop.id;
    return isAccess
      ? edge.from === stop.id || (edge.bidirectional === true && edge.to === stop.id)
      : edge.to === stop.id || (edge.bidirectional === true && edge.from === stop.id);
  });
  const serviceRoutes = new Set(relevant.filter(edge => edge.mode !== "transfer").map(edge => `${edge.mode}:${edge.route}`)).size;
  const transferUsefulness = relevant.filter(edge => edge.mode === "transfer").length;
  const accessiblePathBonus = stop.accessiblePaths?.some(path =>
    path.complete && path.status === "working" && path.freshness === "current"
  ) ? 6 : 0;
  const curbScore = stop.curbAccess === true ? 4 : stop.curbAccess === false ? -12 : needs.requireVerifiedCurbAccess ? -20 : -2;
  const connectorScore = stop.connectorStatus === "verified" ? 5 : stop.connectorStatus === "estimated" ? 1 : -20;
  return serviceRoutes * 4
    + transferUsefulness * 2
    + accessiblePathBonus
    + curbScore
    + connectorScore
    + Number(stop.providerImportance || stop.importance || 0) * 3;
}

function curbUncertaintyPenalty(stop, needs) {
  if (stop?.curbAccess === true || stop?.curbAccess === false) return 0;
  return needs.wheelchairMode || needs.requireCurb ? 3 : 1.5;
}

function curbAccessWarnings(entry, exit) {
  if ([entry, exit].some(stop => stop?.modes?.includes("bus") && stop.curbAccess !== true && stop.curbAccess !== false)) {
    return ["Curb access could not be verified at one or more bus stops."];
  }
  return [];
}

function connectorWarnings(entry, exit) {
  return [entry, exit].some(stop => stop?.connectorStatus === "estimated")
    ? ["Pedestrian access geometry to one or more transit stops is estimated."]
    : [];
}

function subwayPathWarnings(edges, stopMap) {
  const subwayStops = new Set();
  for (const edge of edges) {
    if (edge.mode !== "subway") continue;
    subwayStops.add(edge.reverse ? edge.to : edge.from);
    subwayStops.add(edge.reverse ? edge.from : edge.to);
  }
  const unverified = [...subwayStops].some(stopId => {
    const stop = stopMap.get(stopId);
    return !stop?.accessiblePaths?.some(path =>
      path.complete
      && path.status === "working"
      && path.freshness === "current"
      && Number.isFinite(Date.parse(path.updatedAt))
    );
  });
  return unverified ? ["The accessible path for this station could not be verified."] : [];
}

function geometryConnectsStops(value, from, to, reverse = false) {
  const geometry = lineGeometry(value);
  if (!geometry || !from || !to) return false;
  const coordinates = reverse ? [...geometry.coordinates].reverse() : geometry.coordinates;
  return haversineMeters(from.coordinates, coordinates[0]) <= 25
    && haversineMeters(to.coordinates, coordinates.at(-1)) <= 25;
}

function geometryDistance(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += haversineMeters(coordinates[index - 1], coordinates[index]);
  }
  return total;
}
