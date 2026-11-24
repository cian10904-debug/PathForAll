"use strict";

import { routeGeometrySegments } from "./route-model.js";

/** Build MapLibre sources from normalized, verified LineString legs only. */
export function routeLayerData(route) {
  const grouped = { walk: [], bus: [], subway: [], ferry: [], rail: [] };
  for (const segment of routeGeometrySegments(route)) {
    const mode = segment.mode === "transfer" ? "walk" : segment.mode;
    if (!grouped[mode] || !isValidLine(segment.coordinates)) continue;
    grouped[mode].push({ type: "Feature", properties: { legId: segment.leg.id }, geometry: { type: "LineString", coordinates: segment.coordinates } });
  }
  return Object.fromEntries(Object.entries(grouped).map(([mode, features]) => [mode, { type: "FeatureCollection", features }]));
}

export function isValidLine(coordinates) {
  return Array.isArray(coordinates) && coordinates.length >= 2 && coordinates.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
}
