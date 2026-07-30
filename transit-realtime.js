"use strict";

import { calculateRouteTotals, transitLegs } from "./route-model.js";
import { fetchWithPolicy } from "./fetch-client.js";
import { transitEnvironment } from "./transit-connections.js";

const BACKEND_URL = transitEnvironment.endpoints.realtimeArrivals.url;
const VEHICLE_MODES = new Set(["bus", "subway", "ferry"]);

export function hasTransitArrivalService(url = BACKEND_URL) {
  return Boolean(url);
}

export function boardingGroups(route) {
  const groups = [];
  let active = null;
  for (const [legIndex, leg] of (route?.legs || []).entries()) {
    if (!VEHICLE_MODES.has(leg.mode)) {
      active = null;
      continue;
    }
    const key = vehicleKey(leg);
    if (!active || active.key !== key) {
      active = {
        key,
        legIndex,
        legIndexes: [],
        stopId: leg.from.id,
        routeId: leg.routeId || null,
        tripId: leg.tripId || null,
        mode: leg.mode,
        routeName: leg.routeName || leg.routeId || leg.operator || "Transit",
        stopName: leg.from.name
      };
      groups.push(active);
    }
    active.legIndexes.push(legIndex);
  }
  return groups;
}

/**
 * Request predictions independently for every vehicle boarding. The backend
 * returns normalized JSON; official GTFS-Realtime protobuf decoding and static
 * GTFS joins remain server-side.
 */
export async function getTransitArrivals(route, now = new Date(), options = {}) {
  const groups = boardingGroups(route);
  const url = options.url ?? BACKEND_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!groups.length) return unavailableArrivals([]);
  if (!url) return unavailableArrivals(groups);
  const fetchedBoardings = await Promise.all(groups.map(group => fetchBoarding(group, now, {
    ...options,
    url,
    fetchImpl
  })));
  const boardings = alignBoardingPredictions(route, fetchedBoardings, now);
  const available = boardings.filter(boarding => boarding.status === "available" && boarding.selectedPrediction);
  const stale = boardings.some(boarding => boarding.status === "stale");
  const first = available[0] || null;
  return {
    status: available.length ? "available" : stale ? "stale" : "unavailable",
    source: first?.source || (stale ? "stale" : "unavailable"),
    sourceLabel: first?.sourceLabel || (stale ? "Data may be stale" : "Unavailable"),
    boardings,
    primary: first?.selectedPrediction ? {
      ...first.selectedPrediction,
      route: first.routeName,
      mode: first.mode,
      stopName: first.stopName,
      sourceLabel: first.sourceLabel
    } : null,
    message: available.length ? null : stale ? "Realtime arrival data is stale." : "Arrival information unavailable"
  };
}

async function fetchBoarding(group, now, options) {
  try {
    const endpoint = new URL(options.url, options.baseUrl || "https://pathforall.local");
    endpoint.searchParams.set("stopId", group.stopId);
    endpoint.searchParams.set("routeId", group.routeId || "");
    endpoint.searchParams.set("route", group.routeId || group.routeName || "");
    endpoint.searchParams.set("tripId", group.tripId || "");
    endpoint.searchParams.set("mode", group.mode);
    endpoint.searchParams.set("legIndex", String(group.legIndex));
    const response = await fetchWithPolicy(endpoint, {
      headers: { Accept: "application/json" },
      signal: options.signal
    }, {
      fetchImpl: options.fetchImpl,
      timeoutMs: 8_000,
      retries: 1,
      source: "Transit arrival provider"
    });
    if (!response.ok) throw new Error(`Transit arrival provider returned ${response.status}.`);
    const data = await response.json();
    const updatedAt = validTimestamp(data.feedTimestamp || data.updatedAt);
    const freshness = predictionFreshness(data.freshness, updatedAt, data.maxAgeSeconds ?? options.maxAgeSeconds ?? 180, now);
    if (freshness === "stale") return unavailableBoarding(group, "stale", data, updatedAt, freshness);
    const realtime = normalizePredictions(data.predictions || data.arrivals || [], now, { kind: "realtime" });
    const scheduled = realtime.length ? [] : normalizePredictions(data.scheduledPredictions || [], now, { kind: "scheduled" });
    const predictions = realtime.length ? realtime : scheduled;
    if (!predictions.length) return unavailableBoarding(group, "unavailable", data, updatedAt, freshness);
    return {
      ...group,
      status: "available",
      predictions,
      selectedPrediction: predictions[0],
      source: String(data.source || "provider"),
      sourceLabel: String(data.sourceLabel || (predictions[0].kind === "scheduled" ? "Scheduled" : "Provider")),
      updatedAt,
      freshness
    };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.warn(`Transit arrivals unavailable for ${group.mode} boarding:`, error);
    return unavailableBoarding(group);
  }
}

/**
 * Put each boarding wait on the first leg of its group exactly once. Later legs
 * in the same ride have zero wait, so refreshes cannot double-count it.
 */
export function attachArrivalData(route, arrivals) {
  const groups = boardingGroups(route);
  if (!groups.length) return { ...route, arrivals: unavailableArrivals([]), boardings: [] };
  const arrivalByLeg = new Map((arrivals?.boardings || []).map(boarding => [boarding.legIndex, boarding]));
  const legs = route.legs.map(leg => ({ ...leg }));
  const normalizedBoardings = [];
  for (const group of groups) {
    const result = arrivalByLeg.get(group.legIndex);
    const firstLeg = legs[group.legIndex];
    const scheduledWait = Number(firstLeg.scheduledWaitSeconds ?? (firstLeg.waitSource === "scheduled" ? firstLeg.waitSeconds : 0));
    const selectedWait = result?.status === "available"
      ? Number(result.selectedPrediction?.waitSeconds)
      : Number.isFinite(scheduledWait) ? scheduledWait : 0;
    firstLeg.waitSeconds = Number.isFinite(selectedWait) && selectedWait >= 0 ? selectedWait : 0;
    firstLeg.waitSource = result?.status === "available" ? result.selectedPrediction?.kind || "realtime" : scheduledWait > 0 ? "scheduled" : "unavailable";
    for (const legIndex of group.legIndexes.slice(1)) legs[legIndex].waitSeconds = 0;
    normalizedBoardings.push({
      legIndex: group.legIndex,
      stopId: group.stopId,
      routeId: group.routeId,
      tripId: group.tripId,
      mode: group.mode,
      predictions: result?.predictions || [],
      selectedPrediction: result?.selectedPrediction || null,
      source: result?.source || "unavailable",
      sourceLabel: result?.sourceLabel || "Unavailable",
      updatedAt: result?.updatedAt || null,
      freshness: result?.freshness || "unknown",
      status: result?.status || "unavailable"
    });
  }
  const retimedLegs = retimeLegs(legs, route, groups);
  const totals = calculateRouteTotals(retimedLegs);
  return {
    ...route,
    legs: retimedLegs,
    ...totals,
    boardings: normalizedBoardings,
    arrivals: arrivals || unavailableArrivals(groups)
  };
}

/**
 * Re-rank only after every boarding has a final scheduled/realtime wait. Route
 * IDs remain unchanged so a UI can restore the person's selection.
 */
export function rankRoutesAfterArrivals(routes, needs = {}, selectedRouteId = null) {
  const ranked = [...(routes || [])].sort((a, b) => finalRouteScore(a, needs) - finalRouteScore(b, needs)
    || String(a.id).localeCompare(String(b.id)));
  return {
    routes: ranked.map((route, index) => ({
      ...route,
      label: index === 0 ? "Recommended" : route.label === "Recommended" ? "Accessible alternative" : route.label
    })),
    selectedIndex: selectedRouteId
      ? Math.max(0, ranked.findIndex(route => route.id === selectedRouteId))
      : 0
  };
}

function finalRouteScore(route, needs) {
  const criticalUnknowns = Number(route?.trust?.criticalUnknowns ?? route?.trust?.unknownSegments ?? 0);
  const barrierSegments = Number(route?.trust?.barrierSegments || 0);
  const trustPenalty = criticalUnknowns * 240 + barrierSegments * 10_000;
  const transferPenalty = Number(route?.transfers || 0) * (needs.minimizeTransfers ? 420 : 180);
  return Number(route?.totalDurationSeconds || 0) + transferPenalty + trustPenalty;
}

export function unavailableArrival(leg, message = "Arrival information unavailable") {
  return {
    status: "unavailable",
    source: "unavailable",
    sourceLabel: "Unavailable",
    stopId: leg?.from?.id || null,
    stopName: leg?.from?.name || null,
    route: leg?.routeName || leg?.routeId || null,
    mode: leg?.mode || null,
    predictions: [],
    message
  };
}

export function normalizePredictions(items, now = new Date(), options = {}) {
  return (items || []).map(item => {
    const timestamp = item.timestamp || item.arrivalTime || item.departureTime;
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    const explicitWait = Number(item.waitSeconds ?? (item.minutes == null ? undefined : Number(item.minutes) * 60));
    const waitSeconds = Number.isFinite(explicitWait) ? explicitWait : (Number.isFinite(parsed) ? (parsed - now.getTime()) / 1000 : NaN);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0) return null;
    return {
      waitSeconds: Math.round(waitSeconds),
      minutes: Math.ceil(waitSeconds / 60),
      timestamp: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
      kind: item.kind === "scheduled" || options.kind === "scheduled" ? "scheduled" : "realtime"
    };
  }).filter(Boolean).sort((a, b) => a.waitSeconds - b.waitSeconds).slice(0, 3);
}

export function predictionFreshness(explicit, updatedAt, maxAgeSeconds = 180, now = new Date()) {
  if (["current", "stale", "unknown"].includes(explicit)) return explicit;
  if (!updatedAt) return "unknown";
  const current = now instanceof Date ? now : new Date(now);
  return current.getTime() - Date.parse(updatedAt) <= Number(maxAgeSeconds) * 1000 ? "current" : "stale";
}

function unavailableArrivals(groups) {
  return {
    status: "unavailable",
    source: "unavailable",
    sourceLabel: "Unavailable",
    boardings: groups.map(group => unavailableBoarding(group)),
    primary: null,
    message: "Arrival information unavailable"
  };
}

function unavailableBoarding(group, status = "unavailable", data = {}, updatedAt = null, freshness = "unknown") {
  return {
    ...group,
    status,
    predictions: [],
    selectedPrediction: null,
    source: String(data.source || status),
    sourceLabel: String(data.sourceLabel || (status === "stale" ? "Data may be stale" : "Unavailable")),
    updatedAt,
    freshness
  };
}

function vehicleKey(leg) {
  return `${leg.mode}:${leg.routeId || leg.routeName || leg.operator || leg.id}:${leg.tripId || leg.directionId || leg.headsign || ""}`;
}

function alignBoardingPredictions(route, boardings, now) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) return boardings;
  const byLeg = new Map(boardings.map(boarding => [boarding.legIndex, boarding]));
  let cursor = current.getTime();
  for (const [legIndex, leg] of (route?.legs || []).entries()) {
    const boarding = byLeg.get(legIndex);
    let waitSeconds = Number(leg.waitSeconds || 0);
    if (boarding?.status === "available") {
      const predictions = boarding.predictions.map(prediction => {
        if (!prediction.timestamp) return prediction;
        const adjustedWait = (Date.parse(prediction.timestamp) - cursor) / 1000;
        if (!Number.isFinite(adjustedWait) || adjustedWait < 0) return null;
        return {
          ...prediction,
          waitSeconds: Math.round(adjustedWait),
          minutes: Math.ceil(adjustedWait / 60)
        };
      }).filter(Boolean).sort((a, b) => a.waitSeconds - b.waitSeconds);
      if (predictions.length) {
        boarding.predictions = predictions;
        boarding.selectedPrediction = predictions[0];
        waitSeconds = predictions[0].waitSeconds;
      } else {
        boarding.status = "unavailable";
        boarding.predictions = [];
        boarding.selectedPrediction = null;
      }
    }
    cursor += (Math.max(0, waitSeconds) + Math.max(0, Number(leg.durationSeconds || 0))) * 1000;
  }
  return boardings;
}

function retimeLegs(legs, route, groups) {
  const firstOriginal = route?.legs?.[0];
  const firstDeparture = Date.parse(firstOriginal?.departureTime);
  if (!Number.isFinite(firstDeparture)) return legs;
  let cursor = firstDeparture - Math.max(0, Number(firstOriginal?.waitSeconds || 0)) * 1000;
  const boardingLegs = new Set(groups.map(group => group.legIndex));
  return legs.map((leg, index) => {
    const waitSeconds = boardingLegs.has(index) ? Math.max(0, Number(leg.waitSeconds || 0)) : 0;
    const departureTime = cursor + waitSeconds * 1000;
    const arrivalTime = departureTime + Math.max(0, Number(leg.durationSeconds || 0)) * 1000;
    cursor = arrivalTime;
    return {
      ...leg,
      departureTime: new Date(departureTime).toISOString(),
      arrivalTime: new Date(arrivalTime).toISOString()
    };
  });
}

function validTimestamp(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// Retained as a named export for route-model consumers and tests.
export { transitLegs };
