"use strict";

import { appStorage } from "./storage-adapter.js";

const REVIEW_KEY = "pathforall-v7-segment-reviews";

export function loadSegmentReviews() {
  const value = appStorage.readJson(REVIEW_KEY, {}, { version: 2 });
  return value && typeof value === "object" ? value : {};
}

export function saveSegmentReview(edgeId, status, note = "") {
  const allowed = new Set(["passable", "barrier", "needs-review"]);
  if (!edgeId || !allowed.has(status)) throw new TypeError("Invalid segment review.");
  const reviews = loadSegmentReviews();
  reviews[edgeId] = {
    edgeId,
    status,
    note: String(note || "").trim().slice(0, 180),
    reviewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    sourceType: "local-field-review",
    sourceLabel: "Local, unmoderated field review"
  };
  appStorage.writeJson(REVIEW_KEY, reviews, { version: 2 });
  return reviews[edgeId];
}

export function clearSegmentReviews() {
  appStorage.remove(REVIEW_KEY);
}

export function applyTrustMetadata(edges, reviews = loadSegmentReviews()) {
  return (edges || []).map(edge => {
    const storedReview = reviews[edge.id];
    const review = storedReview && Number.isFinite(Date.parse(storedReview.expiresAt))
      && Date.parse(storedReview.expiresAt) > Date.now()
      ? storedReview
      : null;
    const sourceType = edge.osmWayId ? "openstreetmap" : "demo";
    const sourceLabel = edge.osmWayId ? "OpenStreetMap" : "Demo dataset";
    const mappedFields = countMappedAccessibilityFields(edge);
    let confidence = Number(edge.confidence ?? (sourceType === "openstreetmap" ? 0.45 : 0.25));
    let verificationStatus = mappedFields >= 3 ? "mapped" : "unverified";
    let blocked = Boolean(edge.blocked);
    let lastChecked = edge.lastChecked || null;
    let effectiveSourceType = sourceType;
    let effectiveSourceLabel = sourceLabel;

    if (review) {
      effectiveSourceType = "local-field-review";
      effectiveSourceLabel = "Local, unmoderated field review";
      lastChecked = review.reviewedAt;
      verificationStatus = review.status;
      if (review.status === "passable") confidence = Math.max(confidence, 0.9);
      if (review.status === "needs-review") confidence = Math.max(confidence, 0.55);
      if (review.status === "barrier") {
        confidence = 0.96;
        blocked = true;
      }
    }

    return {
      ...edge,
      confidence: Math.min(0.99, Math.max(0.05, confidence)),
      blocked,
      dataSourceType: effectiveSourceType,
      dataSourceLabel: effectiveSourceLabel,
      verificationStatus,
      lastChecked,
      review: review || null,
      sourceExpiresAt: review?.expiresAt || null,
      mappedAccessibilityFields: mappedFields
    };
  });
}

export function summarizeRouteTrust(routeResult, edges) {
  const ids = routeEdgeIds(routeResult);
  const edgeMap = new Map((edges || []).map(edge => [edge.id, edge]));
  const routeEdges = ids.map(id => edgeMap.get(id)).filter(Boolean);
  const totalDistance = routeEdges.reduce((sum, edge) => sum + Number(edge.distanceMeters || 0), 0);
  const reviewedDistance = routeEdges
    .filter(edge => edge.dataSourceType === "local-field-review")
    .reduce((sum, edge) => sum + Number(edge.distanceMeters || 0), 0);
  const mappedDistance = routeEdges
    .filter(edge => edge.verificationStatus === "mapped")
    .reduce((sum, edge) => sum + Number(edge.distanceMeters || 0), 0);
  const unknownSegments = routeEdges.filter(edge => edge.verificationStatus === "unverified").length;
  const barrierSegments = routeEdges.filter(edge => edge.verificationStatus === "barrier" || edge.blocked).length;
  const confidence = totalDistance
    ? routeEdges.reduce((sum, edge) => sum + Number(edge.confidence || 0) * Number(edge.distanceMeters || 0), 0) / totalDistance
    : 0;
  return {
    edgeCount: routeEdges.length,
    totalDistance,
    reviewedDistance,
    mappedDistance,
    reviewedPercent: totalDistance ? reviewedDistance / totalDistance : 0,
    documentedPercent: totalDistance ? (reviewedDistance + mappedDistance) / totalDistance : 0,
    unknownSegments,
    barrierSegments,
    criticalUnknowns: unknownSegments,
    coverageLevel: coverageLevel(totalDistance, reviewedDistance + mappedDistance, unknownSegments, barrierSegments),
    confidence,
    sources: sourceCounts(routeEdges)
  };
}

function coverageLevel(totalDistance, documentedDistance, unknownSegments, barrierSegments) {
  if (barrierSegments > 0) return "Known barrier";
  if (!totalDistance || unknownSegments > 0) return "Critical gaps";
  const ratio = documentedDistance / totalDistance;
  if (ratio >= .9) return "Broad coverage";
  if (ratio >= .5) return "Partial coverage";
  return "Limited coverage";
}

export function routeEdgeIds(routeOption) {
  if (!routeOption) return [];
  if (Array.isArray(routeOption.legs)) {
    const ids = [];
    for (const leg of routeOption.legs) {
      // OSM field reviews apply to walking/transfer infrastructure, not an
      // opaque provider bus or subway shape.
      if (leg?.mode !== "walk" && leg?.mode !== "transfer") continue;
      if (leg.edgeId) ids.push(leg.edgeId);
      if (Array.isArray(leg.edgeIds)) ids.push(...leg.edgeIds);
      if (Array.isArray(leg.accessibility?.edgeIds)) ids.push(...leg.accessibility.edgeIds);
    }
    return [...new Set(ids.map(String).filter(Boolean))];
  }
  if (routeOption.kind === "walk") return [...(routeOption.edgeIds || [])];
  const access = routeOption.access?.route?.edgeIds || [];
  const egress = routeOption.egress?.route?.edgeIds || [];
  const direct = routeOption.edgeIds || routeOption.route?.edgeIds || [];
  return [...new Set([...direct, ...access, ...egress].map(String).filter(Boolean))];
}

function countMappedAccessibilityFields(edge) {
  let count = 0;
  if (edge.wheelchairStatus != null) count += 1;
  if (edge.surface && edge.surface !== "unknown") count += 1;
  if (Number.isFinite(edge.slope)) count += 1;
  if (edge.curbRamp != null || !edge.requiresCurbRamp) count += 1;
  if (edge.covered) count += 1;
  return count;
}

function sourceCounts(edges) {
  return edges.reduce((counts, edge) => {
    const key = edge.dataSourceType || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}
