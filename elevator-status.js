"use strict";

import { fetchWithPolicy } from "./fetch-client.js";

const STATUS_VALUES = new Set(["working", "out", "unknown"]);
const FRESHNESS_VALUES = new Set(["current", "stale", "unknown"]);

/**
 * Normalize backend-provided equipment records by stable equipment and path IDs.
 * The browser intentionally does not download or name-match the full MTA asset
 * inventory. Static GTFS, equipment records, and station pathways belong in the
 * application-owned ingestion service.
 */
export function normalizeElevatorStatus(record = {}, options = {}) {
  const equipmentCode = stringValue(record.equipmentCode || record.equipmentId || record.equipment_id || record.assetId);
  const updatedAt = validTimestamp(record.updatedAt || record.updated_at || record.dataAsOf || record.data_as_of);
  const freshness = normalizeFreshness(record.freshness, updatedAt, options);
  return {
    equipmentCode,
    status: normalizeStatus(record.status || record.serviceStatus || record.service_status_code),
    source: stringValue(record.source || options.source || "Transit accessibility provider") || "Transit accessibility provider",
    updatedAt,
    freshness,
    authoritative: record.authoritative !== false && Boolean(updatedAt) && freshness === "current",
    pathIds: stringList(record.pathIds || record.accessiblePathIds),
    providerId: stringValue(record.providerId || record.equipment_id || record.assetId) || null
  };
}

export function normalizeAccessiblePath(path = {}, equipmentByCode = new Map(), options = {}) {
  const equipmentCodes = stringList(path.equipmentCodes || path.equipmentIds);
  const equipment = equipmentCodes.map(code => equipmentByCode.get(code)).filter(Boolean);
  const explicitStatus = normalizeStatus(path.status);
  const status = equipment.some(item => item.status === "out") || explicitStatus === "out"
    ? "out"
    : explicitStatus === "working"
      ? "working"
      : equipment.length && equipment.every(item => item.status === "working")
        ? "working"
        : "unknown";
  const updatedAt = newestTimestamp([path.updatedAt, ...equipment.map(item => item.updatedAt)]);
  const freshness = equipment.some(item => item.freshness === "stale")
    ? "stale"
    : equipment.length && equipment.every(item => item.freshness === "current")
      ? "current"
      : normalizeFreshness(path.freshness, updatedAt, options);
  return {
    id: stringValue(path.id || path.pathId),
    entranceId: nullableString(path.entranceId),
    fareControlAreaId: nullableString(path.fareControlAreaId),
    platformStopIds: stringList(path.platformStopIds || path.platformStopId),
    directionIds: stringList(path.directionIds || path.directionId),
    actions: stringList(path.actions || ["boarding", "exit", "transfer"]),
    equipmentCodes,
    complete: path.complete === true,
    wheelchairAccessible: path.wheelchairAccessible !== false,
    status,
    source: stringValue(path.source || equipment[0]?.source || "Transit accessibility provider"),
    updatedAt,
    freshness
  };
}

export function normalizeStationAccessibility(stop = {}, equipmentRecords = [], options = {}) {
  const equipment = equipmentRecords.map(record => normalizeElevatorStatus(record, options)).filter(record => record.equipmentCode);
  const equipmentByCode = new Map(equipment.map(record => [record.equipmentCode, record]));
  const accessiblePaths = (Array.isArray(stop.accessiblePaths) ? stop.accessiblePaths : [])
    .map(path => normalizeAccessiblePath(path, equipmentByCode, options))
    .filter(path => path.id);
  const usablePaths = accessiblePaths.filter(path =>
    path.complete
    && path.wheelchairAccessible
    && path.status === "working"
    && path.freshness === "current"
    && Number.isFinite(Date.parse(path.updatedAt))
  );
  const status = usablePaths.length ? "working"
    : accessiblePaths.some(path => path.status === "out") ? "out"
      : "unknown";
  const updatedAt = newestTimestamp(accessiblePaths.map(path => path.updatedAt));
  return {
    ...stop,
    stationComplexId: nullableString(stop.stationComplexId),
    parentStationId: nullableString(stop.parentStationId),
    platformStopId: nullableString(stop.platformStopId),
    directionId: nullableString(stop.directionId),
    entranceId: nullableString(stop.entranceId),
    accessiblePaths,
    elevator: {
      status,
      source: stringValue(stop.elevatorStatus?.source || accessiblePaths[0]?.source || "Transit accessibility provider"),
      updatedAt: validTimestamp(stop.elevatorStatus?.updatedAt) || updatedAt,
      freshness: normalizeFreshness(stop.elevatorStatus?.freshness, validTimestamp(stop.elevatorStatus?.updatedAt) || updatedAt, options)
    },
    elevatorStatus: status
  };
}

/**
 * Join normalized equipment records to the station paths that explicitly name
 * their equipment codes. A broken elevator invalidates only the paths it serves.
 */
export function applyMtaElevatorRecords(stops, records, options = {}) {
  return (stops || []).map(stop => normalizeStationAccessibility(stop, records, {
    ...options,
    source: options.source || "MTA asset/status snapshot"
  }));
}

/**
 * Optional application-backend adapter. There is deliberately no default MTA
 * dataset URL: provider keys, GTFS joins, and schema interpretation stay server-side.
 */
export async function refreshMtaElevatorStatuses(stops, options = {}) {
  if (!options.url) throw new Error("An application-owned elevator-status endpoint is required.");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchWithPolicy(options.url, {
    signal: options.signal,
    headers: { Accept: "application/json" }
  }, {
    fetchImpl,
    timeoutMs: 8_000,
    retries: 1,
    source: "Elevator-status provider"
  });
  if (!response.ok) throw new Error(`Elevator status provider returned ${response.status}.`);
  const payload = await response.json();
  const records = Array.isArray(payload?.records) ? payload.records : [];
  return {
    stops: applyMtaElevatorRecords(stops, records, {
      source: payload.source || "Transit accessibility provider",
      now: options.now,
      maxAgeSeconds: payload.maxAgeSeconds
    }),
    source: String(payload.source || "Transit accessibility provider"),
    updatedAt: validTimestamp(payload.updatedAt),
    freshness: normalizeFreshness(payload.freshness, validTimestamp(payload.updatedAt), {
      now: options.now,
      maxAgeSeconds: payload.maxAgeSeconds
    }),
    recordCount: records.length
  };
}

export function accessiblePathSupports(path, action, context = {}) {
  if (!path?.complete || path.wheelchairAccessible === false || path.status !== "working" || path.freshness !== "current") return false;
  if (!Number.isFinite(Date.parse(path.updatedAt))) return false;
  if (context.requireCompletePath !== false) {
    if (!path.entranceId || !path.fareControlAreaId || !path.platformStopIds?.length) return false;
  }
  if (path.actions?.length && !path.actions.includes(action)) return false;
  if (context.platformStopId && path.platformStopIds?.length && !path.platformStopIds.includes(String(context.platformStopId))) return false;
  if (context.directionId && path.directionIds?.length && !path.directionIds.includes(String(context.directionId))) return false;
  return true;
}

function normalizeStatus(value) {
  const candidate = typeof value === "object" ? value?.status : value;
  const text = String(candidate || "").toLowerCase();
  if (STATUS_VALUES.has(text)) return text;
  if (/out|down|closed|unavailable|inactive|failure|oos/.test(text)) return "out";
  if (/working|in service|available|active|operational|open/.test(text)) return "working";
  return "unknown";
}

function normalizeFreshness(value, updatedAt, options = {}) {
  const explicit = String(value || "").toLowerCase();
  if (FRESHNESS_VALUES.has(explicit)) return explicit;
  if (!updatedAt) return "unknown";
  const maxAgeSeconds = Number(options.maxAgeSeconds);
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return "unknown";
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  return now.getTime() - Date.parse(updatedAt) <= maxAgeSeconds * 1000 ? "current" : "stale";
}

function newestTimestamp(values) {
  const timestamps = (values || []).filter(Boolean).map(value => Date.parse(value)).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function validTimestamp(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function stringList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map(stringValue).filter(Boolean);
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function nullableString(value) {
  const result = stringValue(value);
  return result || null;
}
