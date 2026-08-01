"use strict";

import { coordinate, lineGeometry } from "./route-model.js";
import { appStorage } from "./storage-adapter.js";

const SAVED_KEY = "pathforall-saved-v1";
const SAVED_SCHEMA_VERSION = 3;

export function loadSavedRoutes() {
  const value = appStorage.readJson(SAVED_KEY, [], { version: SAVED_SCHEMA_VERSION });
  return Array.isArray(value) ? value.map(normalizeSavedRoute).filter(Boolean) : [];
}

export function saveRoute(route, startPlace, endPlace) {
  if (!route || !startPlace || !endPlace) throw new TypeError("A route and both places are required.");
  const saved = loadSavedRoutes();
  const routeId = String(route.id || route.key || "route");
  const durationSeconds = nonNegative(route.totalDurationSeconds, legacyMinutes(route) * 60);
  const legs = Array.isArray(route.legs) ? route.legs.map(serializeLeg).filter(Boolean) : [];
  const record = {
    id: `${routeId}-${Date.now()}`,
    routeId,
    // `routeKey` is retained for existing local records and any legacy UI code.
    routeKey: routeId,
    mode: validMode(route.mode),
    label: String(route.label || route.optionLabel || "Accessible route").slice(0, 80),
    durationSeconds,
    totalDurationSeconds: durationSeconds,
    totalWalkingMeters: nonNegative(route.totalWalkingMeters),
    totalWaitSeconds: nonNegative(route.totalWaitSeconds),
    transfers: nonNegative(route.transfers),
    minutes: Math.round(durationSeconds / 60),
    distanceMeters: nonNegative(route.distanceMeters),
    legs,
    accessibility: objectValue(route.accessibility),
    trust: objectValue(route.trust),
    dataSource: String(route.dataSource || "Unknown route source").slice(0, 120),
    warnings: stringList(route.warnings),
    start: serializePlace(startPlace),
    end: serializePlace(endPlace),
    savedAt: new Date().toISOString()
  };
  const next = [record, ...saved.filter(item => !(samePlace(item.start, record.start) && samePlace(item.end, record.end)))].slice(0, 30);
  appStorage.writeJson(SAVED_KEY, next, { version: SAVED_SCHEMA_VERSION });
  return record;
}

export function removeSavedRoute(id) {
  const next = loadSavedRoutes().filter(item => item.id !== id);
  appStorage.writeJson(SAVED_KEY, next, { version: SAVED_SCHEMA_VERSION });
  return next;
}

export function clearSavedRoutes() {
  appStorage.remove(SAVED_KEY);
}

function serializePlace(place) {
  const coordinates = coordinate(place?.coordinates);
  return {
    id: place.id || null,
    name: String(place.name || "Saved place").slice(0, 100),
    subtitle: String(place.subtitle || "").slice(0, 140),
    coordinates: coordinates || []
  };
}

function samePlace(a, b) {
  return a?.name === b?.name && a?.coordinates?.[0] === b?.coordinates?.[0] && a?.coordinates?.[1] === b?.coordinates?.[1];
}

function normalizeSavedRoute(value) {
  if (!value || typeof value !== "object") return null;
  const start = serializePlace(value.start || {});
  const end = serializePlace(value.end || {});
  if (!start.coordinates.length || !end.coordinates.length) return null;
  const routeId = value.routeId || value.routeKey || value.id || "saved-route";
  const durationSeconds = nonNegative(value.durationSeconds ?? value.totalDurationSeconds, nonNegative(value.minutes) * 60);
  return {
    id: String(value.id || `${routeId}-${value.savedAt || "saved"}`),
    routeId: String(routeId),
    routeKey: String(value.routeKey || routeId),
    mode: validMode(value.mode),
    label: String(value.label || "Accessible route").slice(0, 80),
    durationSeconds,
    totalDurationSeconds: durationSeconds,
    totalWalkingMeters: nonNegative(value.totalWalkingMeters),
    totalWaitSeconds: nonNegative(value.totalWaitSeconds),
    transfers: nonNegative(value.transfers),
    // Kept for display compatibility while all new saves use seconds as source data.
    minutes: Math.round(durationSeconds / 60),
    distanceMeters: nonNegative(value.distanceMeters),
    legs: Array.isArray(value.legs) ? value.legs.map(serializeLeg).filter(Boolean) : [],
    accessibility: objectValue(value.accessibility),
    trust: objectValue(value.trust),
    dataSource: String(value.dataSource || "Unknown route source").slice(0, 120),
    warnings: stringList(value.warnings),
    start,
    end,
    savedAt: validSavedAt(value.savedAt)
  };
}

function legacyMinutes(route) {
  return nonNegative(route?.totalMinutesWithWait ?? route?.totalMinutes);
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function validMode(value) {
  return ["walk", "bus", "subway", "ferry", "mixed"].includes(value) ? value : null;
}

function stringList(value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.map(item => String(item).slice(0, 180)).filter(Boolean).slice(0, 8);
}

function validSavedAt(value) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

function serializeLeg(value) {
  if (!value || !["walk", "bus", "subway", "ferry", "transfer"].includes(value.mode)) return null;
  const from = serializePlace(value.from);
  const to = serializePlace(value.to);
  if (!from.coordinates.length || !to.coordinates.length) return null;
  const geometry = value.geometry == null ? null : lineGeometry(value.geometry);
  if (value.geometry != null && !geometry) return null;
  return {
    id: String(value.id || "saved-leg"),
    mode: value.mode,
    from,
    to,
    routeId: nullableString(value.routeId),
    routeName: nullableString(value.routeName),
    headsign: nullableString(value.headsign),
    durationSeconds: nonNegative(value.durationSeconds),
    distanceMeters: nonNegative(value.distanceMeters),
    waitSeconds: nonNegative(value.waitSeconds),
    departureTime: validOptionalTimestamp(value.departureTime),
    arrivalTime: validOptionalTimestamp(value.arrivalTime),
    geometry,
    accessibility: objectValue(value.accessibility)
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};
}

function nullableString(value) {
  return value == null || value === "" ? null : String(value).slice(0, 120);
}

function validOptionalTimestamp(value) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
