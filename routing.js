"use strict";

import { assessEdge, curbEvidence, reverseEdge, summarizeEvidence } from "./accessibility.js";

const PROFILE_WEIGHTS = {
  fastest: {
    label: "Fastest option",
    time: 1,
    slope: 0.12,
    unknownSlope: 0.12,
    surface: 0.10,
    shade: 0.05,
    unknownShade: 0.05,
    rain: 0.12,
    crossing: 0.08,
    uncertainty: 0.18,
    report: 1.0,
    limitedWheelchair: 0.6,
    lighting: 0.1
  },
  balanced: {
    label: "Balanced",
    time: 1,
    slope: 0.75,
    unknownSlope: 0.55,
    surface: 0.9,
    shade: 0.45,
    unknownShade: 0.25,
    rain: 0.8,
    crossing: 0.55,
    uncertainty: 0.8,
    report: 2.0,
    limitedWheelchair: 1.8,
    lighting: 0.6
  },
  accessible: {
    label: "Accessibility preferences",
    time: 0.85,
    slope: 2.8,
    unknownSlope: 1.7,
    surface: 3.1,
    shade: 1.4,
    unknownShade: 0.8,
    rain: 1.8,
    crossing: 1.9,
    uncertainty: 2.3,
    report: 3.0,
    limitedWheelchair: 4.0,
    lighting: 1.4
  },
  lit: {
    label: "Better-lit route",
    time: 0.9,
    slope: 1.35,
    unknownSlope: 1.1,
    surface: 1.7,
    shade: 0.4,
    unknownShade: 0.2,
    rain: 1.0,
    crossing: 1.0,
    uncertainty: 1.8,
    report: 2.5,
    limitedWheelchair: 2.6,
    lighting: 4.2
  }
};

export class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this.#bubbleUp(this.items.length - 1);
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      this.#bubbleDown(0);
    }
    return first;
  }

  get size() {
    return this.items.length;
  }

  #bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  #bubbleDown(index) {
    const length = this.items.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < length && this.items[left].priority < this.items[smallest].priority) smallest = left;
      if (right < length && this.items[right].priority < this.items[smallest].priority) smallest = right;
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}

function buildAdjacency(nodes, edges) {
  const graph = {};
  Object.keys(nodes).forEach(id => { graph[id] = []; });

  for (const edge of edges) {
    if (!graph[edge.from] || !graph[edge.to]) continue;
    graph[edge.from].push({ node: edge.to, edge, reverse: false });
    if (edge.bidirectional !== false) {
      graph[edge.to].push({ node: edge.from, edge, reverse: true });
    }
  }

  return graph;
}

function getSurfacePenalty(surface) {
  if (surface === "rough") return 3.5;
  if (surface === "uneven") return 1.8;
  if (surface === "unknown") return 0.9;
  return 0;
}

/** @param {import('./domain.js').Edge} edge @param {import('./domain.js').Needs} needs */
function isEdgeAllowed(edge, needs = {}) { return assessEdge(edge, needs).eligible; }

/**
 * Generalized minutes: continuous condition multipliers * elapsed minutes,
 * plus discrete event minutes. Coefficients are preferences, not probabilities.
 * @param {import('./domain.js').Edge} edge
 * @param {import('./domain.js').Needs} needs
 * @param {import('./domain.js').Weather} weather
 * @param {import('./domain.js').Weights} weights
 * @param {Set<string>} seenEvents
 */
function edgeCost(edge, needs = {}, weather = {}, weights = PROFILE_WEIGHTS.balanced, seenEvents = new Set()) {
  if (!isEdgeAllowed(edge, needs) || !Number.isFinite(edge.minutes) || edge.minutes < 0
    || !Number.isFinite(edge.distanceMeters) || edge.distanceMeters < 0
    || Object.values(weights).some(value => typeof value === "number" && (!Number.isFinite(value) || value < 0))) return Infinity;
  let rate = weights.time;
  rate += Number.isFinite(edge.slope) ? Math.max(0, Math.abs(edge.slope) - 1.5) * weights.slope : weights.unknownSlope;
  if (needs.preferSmooth) rate += getSurfacePenalty(edge.surface || "unknown") * weights.surface;
  if (needs.preferShade || weather.temperatureF >= 82) rate += Number.isFinite(edge.shade)
    ? Math.max(0, .65 - clamp(edge.shade, 0, 1)) * 6 * weights.shade : weights.unknownShade;
  if (needs.avoidRain && weather.isRaining && !edge.covered) rate += 3.2 * weights.rain;
  if (needs.wheelchairMode && edge.wheelchairStatus === "limited") rate += weights.limitedWheelchair;
  rate += edge.lit === false ? 5.5 * weights.lighting : edge.lit == null ? 1.6 * weights.lighting : 0;
  // Unknown exposure is distance/time-based; mapped confidence is only a heuristic.
  rate += (1 - clamp(Number.isFinite(edge.confidence) ? edge.confidence : .4, 0, 1)) * 6 * weights.uncertainty;
  let discrete = 0;
  const crossingId = edge.crossingEventId || `crossing:${edge.id}`;
  if (edge.crossing && !seenEvents.has(crossingId)) {
    discrete += Math.max(0, edge.crossing) * weights.crossing;
    if (!needs.requireCurb && needs.curbPolicy !== "required" && edge.requiresCurbRamp) {
      const curb = curbEvidence(edge);
      if (curb.state === "violated") discrete += 8 * weights.crossing;
      if (curb.state === "unknown") discrete += 3 * weights.uncertainty;
    }
  }
  if (!seenEvents.has(edge.reportEventId || `report:${edge.id}`)) discrete += Math.max(0, edge.reports || 0) * weights.report;
  const cost = edge.minutes * rate + discrete;
  return Number.isFinite(cost) && cost >= 0 ? cost : Infinity;
}

function eventsFor(edge) {
  return [...(edge.crossing ? [edge.crossingEventId || `crossing:${edge.id}`] : []),
    ...(edge.reports ? [edge.reportEventId || `report:${edge.id}`] : [])];
}

/**
 * Labels include repeated event identities; charging once per real event is
 * path-dependent. Unique events need no state. Nonnegative costs preserve
 * Dijkstra correctness on this expanded graph.
 * @param {import('./domain.js').Nodes} nodes
 * @param {import('./domain.js').Edge[]} edges
 * @param {string} startId @param {string} endId
 * @param {import('./domain.js').Needs} needs
 * @param {import('./domain.js').Weather} weather
 * @param {import('./domain.js').Weights} weights
 */
function dijkstra(nodes, edges, startId, endId, needs = {}, weather = {}, weights = PROFILE_WEIGHTS.balanced) {
  if (!nodes[startId] || !nodes[endId]) return null;
  const ids = new Set();
  for (const edge of edges) {
    if (ids.has(edge.id)) throw new TypeError(`Duplicate edge ID: ${edge.id}`);
    ids.add(edge.id);
  }
  const graph = buildAdjacency(nodes, edges);
  // Remove vertices that cannot reach the destination under the actual hard
  // constraints before expanding event histories. Disconnected urban components
  // must return no path without enumerating arbitrary crossing combinations.
  const incoming = new Map(Object.keys(nodes).map(id => [id, []]));
  for (const [from, neighbors] of Object.entries(graph)) {
    graph[from] = neighbors.filter(neighbor => {
      const oriented = neighbor.reverse ? reverseEdge(neighbor.edge) : neighbor.edge;
      if (!Number.isFinite(edgeCost(oriented, needs, weather, weights))) return false;
      incoming.get(neighbor.node).push({ node: from, minimum: edgeCost(oriented, needs, weather, weights, new Set(eventsFor(oriented))) });
      return true;
    });
  }
  // Reverse Dijkstra supplies an admissible, consistent A* lower bound: all
  // future event charges are free, while continuous exposure remains payable.
  const lowerBounds = new Map([[endId, 0]]);
  const lowerHeap = new MinHeap();
  lowerHeap.push({ node: endId, priority: 0 });
  while (lowerHeap.size) {
    const current = lowerHeap.pop();
    if (current.priority !== lowerBounds.get(current.node)) continue;
    for (const neighbor of incoming.get(current.node)) {
      const candidate = current.priority + neighbor.minimum;
      if (candidate < (lowerBounds.get(neighbor.node) ?? Infinity)) {
        lowerBounds.set(neighbor.node, candidate);
        lowerHeap.push({ node: neighbor.node, priority: candidate });
      }
    }
  }
  if (!lowerBounds.has(startId)) return null;
  const counts = new Map();
  for (const edge of edges) for (const event of eventsFor(edge)) counts.set(event, (counts.get(event) || 0) + 1);
  const repeated = new Set([...counts].filter(([, count]) => count > 1).map(([event]) => event));
  // A label can only benefit from its previously paid events by their remaining
  // event charges. This conservative upper bound permits exact dominance
  // pruning, including cycles, without discarding a potentially better route.
  const eventPrices = new Map();
  for (const edge of edges) for (const event of eventsFor(edge)) {
    if (!repeated.has(event)) continue;
    for (const oriented of [edge, reverseEdge(edge)]) {
      const unpaid = edgeCost(oriented, needs, weather, weights);
      const paid = edgeCost(oriented, needs, weather, weights, new Set([event]));
      if (Number.isFinite(unpaid) && Number.isFinite(paid)) eventPrices.set(event, Math.max(eventPrices.get(event) || 0, unpaid - paid));
    }
  }
  const dominates = (a, b) => {
    let possibleSaving = 0;
    for (const event of b.seen) if (!a.seen.has(event)) possibleSaving += eventPrices.get(event) || 0;
    return a.priority + possibleSaving < b.priority - 1e-9;
  };
  const keyFor = (node, seen) => JSON.stringify([node, [...seen].sort()]);
  const startKey = keyFor(startId, new Set());
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  const initial = { node: startId, key: startKey, seen: new Set(), priority: 0 };
  const labels = new Map([[startId, [initial]]]);
  const activeLabels = new Set([startKey]);
  heap.push({ ...initial, priority: lowerBounds.get(startId), distance: 0 });
  let destination = null;
  while (heap.size) {
    const current = heap.pop();
    if (!current || !activeLabels.has(current.key) || current.distance !== distances.get(current.key)) continue;
    if (current.node === endId) { destination = current; break; }
    for (const neighbor of graph[current.node] || []) {
      if (!lowerBounds.has(neighbor.node)) continue;
      const edge = neighbor.reverse ? reverseEdge(neighbor.edge) : neighbor.edge;
      const cost = edgeCost(edge, needs, weather, weights, current.seen);
      if (!Number.isFinite(cost)) continue;
      const seen = new Set(current.seen);
      for (const event of eventsFor(edge)) if (repeated.has(event)) seen.add(event);
      const key = keyFor(neighbor.node, seen);
      const candidate = current.distance + cost;
      if (candidate < (distances.get(key) ?? Infinity)) {
        const label = { node: neighbor.node, key, seen, priority: candidate };
        const others = labels.get(neighbor.node) || [];
        if (others.some(other => dominates(other, label))) continue;
        const retained = others.filter(other => {
          if (other.key === key || dominates(label, other)) { activeLabels.delete(other.key); return false; }
          return true;
        });
        labels.set(neighbor.node, [...retained, label]);
        activeLabels.add(key);
        if (distances.size >= 100_000 && !distances.has(key)) throw Object.assign(new Error("The route search exceeded its state budget; reduce the searched area."), { code: "SEARCH_LIMIT" });
        distances.set(key, candidate);
        previous.set(key, { key: current.key, node: current.node, edgeId: edge.id, reverse: neighbor.reverse });
        heap.push({ ...label, priority: candidate + lowerBounds.get(neighbor.node), distance: candidate });
      }
    }
  }
  if (!destination) return null;
  const path = [endId];
  const traversals = [];
  let cursor = destination.key;
  while (cursor !== startKey) {
    const step = previous.get(cursor);
    if (!step) return null;
    path.unshift(step.node);
    traversals.unshift({ edgeId: step.edgeId, reverse: step.reverse });
    cursor = step.key;
  }
  return { path, traversals, edgeIds: traversals.map(item => item.edgeId), score: destination.distance };
}

function summarizeRoute(result, edges) {
  if (!result) return null;
  const edgeMap = new Map(edges.map(edge => [edge.id, edge]));
  const routeEdges = result.traversals.map(item => { const edge = edgeMap.get(item.edgeId); return edge && item.reverse ? reverseEdge(edge) : edge; }).filter(Boolean);
  const crossingEvents = new Set();
  const reportEvents = new Set();

  const metrics = routeEdges.reduce((acc, edge) => {
    acc.minutes += edge.minutes;
    acc.distanceMeters += edge.distanceMeters;
    if (Number.isFinite(edge.slope)) {
      acc.knownSlopeSegments += 1;
      acc.maxSlope = acc.maxSlope == null ? Math.abs(edge.slope) : Math.max(acc.maxSlope, Math.abs(edge.slope));
    } else {
      acc.unknownSlopeSegments += 1;
    }
    acc.roughSegments += edge.surface === "rough" ? 1 : 0;
    acc.unevenSegments += edge.surface === "uneven" ? 1 : 0;
    acc.unknownSurfaceSegments += edge.surface === "unknown" ? 1 : 0;
    acc.uncoveredSegments += edge.covered ? 0 : 1;
    const crossingId = edge.crossingEventId || `crossing:${edge.id}`;
    if (!crossingEvents.has(crossingId)) acc.crossings += edge.crossing || 0;
    crossingEvents.add(crossingId);
    if (Number.isFinite(edge.shade)) {
      acc.shadeWeighted += edge.shade * edge.distanceMeters;
      acc.shadeKnownDistance += edge.distanceMeters;
    }
    acc.confidenceWeighted += (edge.confidence ?? 0.4) * edge.distanceMeters;
    const reportId = edge.reportEventId || `report:${edge.id}`;
    if (!reportEvents.has(reportId)) acc.reportCount += edge.reports || 0;
    reportEvents.add(reportId);
    if (edge.lit === true) acc.litDistance += edge.distanceMeters;
    else if (edge.lit == null) acc.unknownLightingDistance += edge.distanceMeters;
    const lightingSource = edge.lightingSource || "missing";
    acc.lightingSources[lightingSource] = (acc.lightingSources[lightingSource] || 0) + edge.distanceMeters;
    return acc;
  }, {
    minutes: 0,
    distanceMeters: 0,
    maxSlope: null,
    knownSlopeSegments: 0,
    unknownSlopeSegments: 0,
    roughSegments: 0,
    unevenSegments: 0,
    unknownSurfaceSegments: 0,
    uncoveredSegments: 0,
    crossings: 0,
    shadeWeighted: 0,
    shadeKnownDistance: 0,
    confidenceWeighted: 0,
    reportCount: 0,
    litDistance: 0,
    unknownLightingDistance: 0,
    lightingSources: {}
  });

  metrics.shade = metrics.shadeKnownDistance ? metrics.shadeWeighted / metrics.shadeKnownDistance : null;
  metrics.shadeCoverage = metrics.distanceMeters ? metrics.shadeKnownDistance / metrics.distanceMeters : 0;
  metrics.confidence = metrics.distanceMeters ? metrics.confidenceWeighted / metrics.distanceMeters : 0;
  metrics.litCoverage = metrics.distanceMeters ? metrics.litDistance / metrics.distanceMeters : 0;
  metrics.unknownLightingCoverage = metrics.distanceMeters ? metrics.unknownLightingDistance / metrics.distanceMeters : 0;
  metrics.edges = routeEdges;
  return metrics;
}

function getReasonList(metrics, weather) {
  const reasons = [];
  if (metrics.maxSlope != null) reasons.push(`Steepest mapped grade: ${metrics.maxSlope.toFixed(1)}%; ${metrics.unknownSlopeSegments ? "some slopes are unknown" : "all segments have slope tags"}.`);
  else reasons.push("avoids claiming a slope value where OSM has no incline tag");

  if (metrics.roughSegments === 0) reasons.push("avoids OSM segments tagged as rough");
  if (metrics.reportCount === 0) reasons.push("avoids currently reported problem segments");
  if (weather.isRaining && metrics.uncoveredSegments <= 2) reasons.push("reduces uncovered exposure during rain");
  if (metrics.confidence >= 0.65) reasons.push("uses relatively better-documented OSM segments");
  if (metrics.litCoverage >= 0.65) reasons.push("prioritizes segments tagged as lit");
  return reasons.slice(0, 3);
}

function planAllRoutes(nodes, edges, startId, endId, needs, weather, context = {}) {
  const lightingRequested = needs.preferWellLit === true || isNightTime(context.departureTime);
  return Object.entries(PROFILE_WEIGHTS)
    .filter(([key]) => key !== "lit" || lightingRequested)
    .map(([key, weights]) => {
      const route = dijkstra(nodes, edges, startId, endId, needs, weather, weights);
      if (!route) return { key, label: weights.label, route: null, metrics: null, reasons: [] };
      const metrics = summarizeRoute(route, edges);
      metrics.evidence = summarizeEvidence(metrics.edges, needs);
      const reasons = getReasonList(metrics, weather);
      if (key === "lit" && metrics.unknownLightingCoverage > 0) {
        reasons.push("Lighting data unavailable for some segments");
      }
      return {
        key,
        label: weights.label,
        route,
        metrics,
        reasons: reasons.slice(0, 4)
      };
    });
}

function isNightTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const hour = date.getHours();
  return hour < 6 || hour >= 19;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export {
  PROFILE_WEIGHTS,
  buildAdjacency,
  isEdgeAllowed,
  edgeCost,
  dijkstra,
  summarizeRoute,
  planAllRoutes,
  isNightTime
};
