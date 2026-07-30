"use strict";

const PROFILE_WEIGHTS = {
  fastest: {
    label: "Fastest Accessible",
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
    label: "Most Accessible",
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
    label: "Best-lit route",
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

class MinHeap {
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

function isEdgeAllowed(edge, needs) {
  if (edge.blocked) return false;
  if (needs.avoidStairs && edge.stairs) return false;
  if (needs.wheelchairMode && edge.wheelchairStatus === "no") return false;
  if (needs.wheelchairMode && edge.roadCenterline) return false;
  if (needs.wheelchairMode && (!edge.pedestrianEvidence || edge.pedestrianEvidence === "none")) return false;
  const curbPolicy = needs.curbPolicy || (needs.requireCurb ? "required" : "preferred");
  if (curbPolicy === "required" && edge.requiresCurbRamp && edge.curbRamp !== true) return false;
  if (Number.isFinite(needs.maxSlope) && Number.isFinite(edge.slope) && edge.slope > needs.maxSlope) return false;
  if (needs.requireElevator && edge.requiresElevator && !hasCurrentAuthoritativeElevator(edge)) return false;
  return true;
}

function edgeCost(edge, needs, weather, weights) {
  if (!isEdgeAllowed(edge, needs)) return Infinity;

  let cost = edge.minutes * weights.time;

  if (Number.isFinite(edge.slope)) {
    const slopeDiscomfort = Math.max(0, edge.slope - 1.5);
    cost += slopeDiscomfort * weights.slope;
  } else {
    cost += weights.unknownSlope;
  }

  if (needs.preferSmooth) {
    cost += getSurfacePenalty(edge.surface) * weights.surface;
  }

  const curbPolicy = needs.curbPolicy || (needs.requireCurb ? "required" : "preferred");
  if (curbPolicy === "preferred" && edge.requiresCurbRamp) {
    if (edge.curbRamp === false) cost += 8 * weights.crossing;
    else if (edge.curbRamp == null) cost += 3 * weights.uncertainty;
  }

  const hot = weather.temperatureF >= 82;
  if (needs.preferShade || hot) {
    if (Number.isFinite(edge.shade)) {
      if (edge.shade < 0.65) cost += (0.65 - edge.shade) * 6 * weights.shade;
    } else {
      cost += weights.unknownShade;
    }
  }

  if (needs.avoidRain && weather.isRaining && !edge.covered) {
    cost += 3.2 * weights.rain;
  }

  if (needs.wheelchairMode && edge.wheelchairStatus === "limited") {
    cost += weights.limitedWheelchair;
  }

  if (weights.lighting) {
    if (edge.lit === false) cost += 5.5 * weights.lighting;
    else if (edge.lit == null) cost += 1.6 * weights.lighting;
  }

  cost += (edge.crossing || 0) * weights.crossing;
  cost += (1 - clamp(edge.confidence ?? 0.4, 0, 1)) * 6 * weights.uncertainty;
  cost += (edge.reports || 0) * weights.report;
  return cost;
}

function hasCurrentAuthoritativeElevator(edge) {
  const status = edge?.elevator;
  return status?.status === "working"
    && status?.authoritative === true
    && status?.freshness === "current"
    && Number.isFinite(Date.parse(status?.updatedAt));
}

function dijkstra(nodes, edges, startId, endId, needs, weather, weights) {
  if (!nodes[startId] || !nodes[endId]) return null;

  const graph = buildAdjacency(nodes, edges);
  const distances = Object.fromEntries(Object.keys(nodes).map(id => [id, Infinity]));
  const previous = {};
  const heap = new MinHeap();

  distances[startId] = 0;
  heap.push({ node: startId, priority: 0 });

  while (heap.size) {
    const currentItem = heap.pop();
    if (!currentItem) break;
    const current = currentItem.node;
    if (currentItem.priority !== distances[current]) continue;
    if (current === endId) break;

    for (const neighbor of graph[current] || []) {
      const cost = edgeCost(neighbor.edge, needs, weather, weights);
      if (!Number.isFinite(cost)) continue;

      const candidate = distances[current] + cost;
      if (candidate < distances[neighbor.node]) {
        distances[neighbor.node] = candidate;
        previous[neighbor.node] = {
          node: current,
          edgeId: neighbor.edge.id,
          reverse: neighbor.reverse
        };
        heap.push({ node: neighbor.node, priority: candidate });
      }
    }
  }

  if (!Number.isFinite(distances[endId])) return null;

  const path = [];
  const traversals = [];
  let cursor = endId;

  while (cursor) {
    path.unshift(cursor);
    if (cursor === startId) break;
    const step = previous[cursor];
    if (!step) return null;
    traversals.unshift({ edgeId: step.edgeId, reverse: step.reverse });
    cursor = step.node;
  }

  return {
    path,
    traversals,
    edgeIds: traversals.map(item => item.edgeId),
    score: distances[endId]
  };
}

function summarizeRoute(result, edges) {
  if (!result) return null;
  const edgeMap = new Map(edges.map(edge => [edge.id, edge]));
  const routeEdges = result.traversals.map(item => edgeMap.get(item.edgeId)).filter(Boolean);

  const metrics = routeEdges.reduce((acc, edge) => {
    acc.minutes += edge.minutes;
    acc.distanceMeters += edge.distanceMeters;
    if (Number.isFinite(edge.slope)) {
      acc.knownSlopeSegments += 1;
      acc.maxSlope = acc.maxSlope == null ? edge.slope : Math.max(acc.maxSlope, edge.slope);
    } else {
      acc.unknownSlopeSegments += 1;
    }
    acc.roughSegments += edge.surface === "rough" ? 1 : 0;
    acc.unevenSegments += edge.surface === "uneven" ? 1 : 0;
    acc.unknownSurfaceSegments += edge.surface === "unknown" ? 1 : 0;
    acc.uncoveredSegments += edge.covered ? 0 : 1;
    acc.crossings += edge.crossing || 0;
    if (Number.isFinite(edge.shade)) {
      acc.shadeWeighted += edge.shade * edge.distanceMeters;
      acc.shadeKnownDistance += edge.distanceMeters;
    }
    acc.confidenceWeighted += (edge.confidence ?? 0.4) * edge.distanceMeters;
    acc.reportCount += edge.reports || 0;
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
  if (metrics.maxSlope != null) reasons.push(`uses a steepest tagged segment of ${metrics.maxSlope.toFixed(1)}%`);
  else reasons.push("avoids claiming a slope value where OSM has no incline tag");

  if (metrics.roughSegments === 0) reasons.push("avoids OSM segments tagged as rough");
  if (metrics.reportCount === 0) reasons.push("avoids currently reported problem segments");
  if (weather.isRaining && metrics.uncoveredSegments <= 2) reasons.push("reduces uncovered exposure during rain");
  if (metrics.confidence >= 0.65) reasons.push("uses relatively better-documented OSM segments");
  if (metrics.litCoverage >= 0.65) reasons.push("prioritizes segments tagged as lit");
  return reasons.slice(0, 3);
}

function planAllRoutes(nodes, edges, startId, endId, needs, weather) {
  return Object.entries(PROFILE_WEIGHTS).map(([key, weights]) => {
    const route = dijkstra(nodes, edges, startId, endId, needs, weather, weights);
    if (!route) return { key, label: weights.label, route: null, metrics: null, reasons: [] };
    const metrics = summarizeRoute(route, edges);
    return {
      key,
      label: weights.label,
      route,
      metrics,
      reasons: getReasonList(metrics, weather)
    };
  });
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
  planAllRoutes
};
