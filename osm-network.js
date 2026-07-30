"use strict";

import { fetchWithPolicy } from "./fetch-client.js";

// Validation and search boundary for all five NYC boroughs. Coordinates are [longitude, latitude].
export const NYC_BOUNDS = Object.freeze({
  south: 40.4774,
  west: -74.2591,
  north: 40.9176,
  east: -73.7004
});

export const NYC_CENTER = Object.freeze([-73.935242, 40.73061]);
export const DEFAULT_BOUNDS = NYC_BOUNDS;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

const DEDICATED_PEDESTRIAN_HIGHWAYS = new Set([
  "footway", "path", "pedestrian", "steps", "corridor", "elevator"
]);

const SHARED_STREET_HIGHWAYS = new Set([
  "living_street", "residential", "service", "unclassified",
  "tertiary", "secondary", "primary"
]);

export async function loadLiveOsmGraph(bounds, options = {}) {
  if (!bounds || bounds === NYC_BOUNDS || bounds === DEFAULT_BOUNDS) {
    throw new TypeError("loadLiveOsmGraph requires a bounded route corridor; full-NYC graph loading is disabled.");
  }
  const query = buildOverpassQuery(bounds);
  const endpoints = options.endpoints || OVERPASS_ENDPOINTS;
  const timeoutMs = options.timeoutMs || 24000;
  const errors = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithPolicy(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}`,
        signal: options.signal
      }, {
        fetchImpl: options.fetchImpl,
        timeoutMs,
        retries: 0,
        source: "OpenStreetMap Overpass"
      });

      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload = await response.json();
      const graph = parseOverpassGraph(payload, { preserveComponents: options.preserveComponents === true });
      if (graph.edges.length < 20) throw new Error("The returned pedestrian graph was unexpectedly small.");
      return { ...graph, source: "OpenStreetMap via Overpass API", endpoint };
    } catch (error) {
      if (options.signal?.aborted || error?.name === "AbortError") throw new DOMException("Route network request cancelled.", "AbortError");
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Unable to load live OpenStreetMap network. ${errors.join(" | ")}`);
}

export function buildOverpassQuery(bounds) {
  if (bounds?.type === "corridor") {
    const radius = Math.max(250, Math.min(2200, Number(bounds.radiusMeters || 1000)));
    const areas = (bounds.points || []).map(([lon, lat]) => `  way(around:${Math.round(radius)},${lat},${lon})["highway"~"^(footway|path|pedestrian|steps|corridor|elevator|living_street|residential|service|unclassified|tertiary|secondary|primary)$"]["area"!="yes"]["access"!~"^(private|no)$"]["foot"!~"^(private|no)$"];
  node(around:${Math.round(radius)},${lat},${lon})["entrance"]["access"!~"^(private|no)$"];
  node(around:${Math.round(radius)},${lat},${lon})["railway"="subway_entrance"];
  node(around:${Math.round(radius)},${lat},${lon})["public_transport"="entrance"];`).join("\n");
    if (!areas) throw new TypeError("A route corridor needs at least one coordinate.");
    return `[out:json][timeout:25];
(
${areas}
);
(._;>;);
out body qt;`;
  }
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  return `[out:json][timeout:25];
(
  way
    ["highway"~"^(footway|path|pedestrian|steps|corridor|elevator|living_street|residential|service|unclassified|tertiary|secondary|primary)$"]
    ["area"!="yes"]
    ["access"!~"^(private|no)$"]
    ["foot"!~"^(private|no)$"]
    (${bbox});
);
(._;>;);
out body qt;`;
}

export function buildRouteCorridor(start, end, options = {}) {
  if (!isInsideBounds(start, NYC_BOUNDS) || !isInsideBounds(end, NYC_BOUNDS)) {
    throw new RangeError("Route endpoints must be inside New York City.");
  }
  const distance = haversineMeters(start, end);
  const spacing = Math.max(600, Number(options.spacingMeters || 1100));
  const pointCount = Math.min(30, Math.max(2, Math.ceil(distance / spacing) + 1));
  const points = Array.from({ length: pointCount }, (_, index) => {
    const progress = index / (pointCount - 1);
    return [start[0] + (end[0] - start[0]) * progress, start[1] + (end[1] - start[1]) * progress];
  });
  return {
    type: "corridor",
    points,
    radiusMeters: Math.max(700, Math.min(1800, Number(options.radiusMeters || 1150))),
    distanceMeters: distance
  };
}

export function isInsideBounds(coordinates, bounds = NYC_BOUNDS) {
  const [lon, lat] = coordinates || [];
  return Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

export function parseOverpassGraph(payload, options = {}) {
  if (!payload || !Array.isArray(payload.elements)) {
    throw new TypeError("Invalid Overpass response.");
  }

  const osmNodes = new Map();
  const ways = [];

  for (const element of payload.elements) {
    if (element.type === "node" && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
      osmNodes.set(element.id, {
        id: `osm-node-${element.id}`,
        osmId: element.id,
        name: element.tags?.name || `OSM node ${element.id}`,
        coordinates: [element.lon, element.lat],
        tags: element.tags || {}
      });
    } else if (element.type === "way" && Array.isArray(element.nodes)) {
      ways.push(element);
    }
  }

  const nodes = {};
  const edges = [];

  for (const way of ways) {
    const tags = way.tags || {};
    if (!isWalkableWay(tags)) continue;

    for (let index = 0; index < way.nodes.length - 1; index += 1) {
      const fromOsm = osmNodes.get(way.nodes[index]);
      const toOsm = osmNodes.get(way.nodes[index + 1]);
      if (!fromOsm || !toOsm) continue;

      nodes[fromOsm.id] = fromOsm;
      nodes[toOsm.id] = toOsm;

      const distanceMeters = haversineMeters(fromOsm.coordinates, toOsm.coordinates);
      if (distanceMeters < 0.2) continue;

      const endpointTags = [fromOsm.tags, toOsm.tags];
      const crossing = isCrossing(tags, endpointTags);
      const kerbState = inferKerbState(endpointTags);
      const slope = parseInclinePercent(tags.incline);
      const surface = classifySurface(tags.surface, tags.smoothness);
      const shade = inferShade(tags);
      const wheelchairStatus = tags.wheelchair || null;
      const stairs = tags.highway === "steps" || wheelchairStatus === "no";
      const requiresElevator = tags.highway === "elevator" || endpointTags.some(item => item.highway === "elevator");
      const covered = tags.covered === "yes" || tags.indoor === "yes" || tags.tunnel === "building_passage" || tags.highway === "corridor";
      const lit = parseLit(tags.lit);
      const confidence = calculateConfidence({ tags, slope, surface, crossing, kerbState, shade });
      const pedestrianEvidence = pedestrianEvidenceFor(tags);
      const roadCenterline = SHARED_STREET_HIGHWAYS.has(tags.highway);

      edges.push({
        id: `osm-way-${way.id}-${index}`,
        osmWayId: way.id,
        from: fromOsm.id,
        to: toOsm.id,
        name: buildEdgeName(tags, way.id),
        highway: tags.highway,
        pedestrianEvidence,
        roadCenterline,
        geometry: [fromOsm.coordinates, toOsm.coordinates],
        minutes: distanceMeters / 75,
        distanceMeters,
        slope,
        surface,
        stairs,
        wheelchairStatus,
        requiresCurbRamp: crossing,
        // `null` means no mapped curb evidence. It must never satisfy a strict
        // curb-ramp requirement.
        curbRamp: crossing ? kerbState : true,
        shade,
        covered,
        lit,
        lightingSource: lit == null ? "missing" : "openstreetmap",
        crossing: crossing ? 1 : 0,
        requiresElevator,
        // OSM can show that an elevator exists, but not that it is operating.
        elevatorStatus: requiresElevator ? "unknown" : null,
        elevator: requiresElevator ? {
          status: "unknown",
          source: "OpenStreetMap infrastructure mapping",
          updatedAt: null,
          freshness: "unknown",
          authoritative: false
        } : null,
        confidence,
        bidirectional: tags["oneway:foot"] !== "yes",
        blocked: false,
        reports: 0,
        tags
      });
    }
  }

  const connected = options.preserveComponents === true ? { nodes, edges } : keepLargestConnectedComponent(nodes, edges);
  const accessPoints = [...osmNodes.values()]
    .filter(node => isAccessPoint(node.tags))
    .map(node => ({
      id: node.id,
      osmId: node.osmId,
      name: node.name,
      coordinates: [...node.coordinates],
      connectorSource: accessPointSource(node.tags),
      connectorStatus: "verified",
      priority: accessPointPriority(node.tags)
    }));
  return {
    nodes: connected.nodes,
    edges: connected.edges,
    accessPoints,
    metadata: {
      rawNodeCount: osmNodes.size,
      rawWayCount: ways.length,
      nodeCount: Object.keys(connected.nodes).length,
      edgeCount: connected.edges.length
    }
  };
}

function isWalkableWay(tags) {
  if (!DEDICATED_PEDESTRIAN_HIGHWAYS.has(tags.highway) && !SHARED_STREET_HIGHWAYS.has(tags.highway)) return false;
  if (["no", "private"].includes(tags.foot)) return false;
  if (["no", "private"].includes(tags.access)) return false;
  if (tags.motorroad === "yes") return false;
  if (DEDICATED_PEDESTRIAN_HIGHWAYS.has(tags.highway)) return true;
  // A motor-road centerline is retained only when OSM explicitly documents
  // pedestrian use. Strict wheelchair routing still excludes the centerline
  // because it is not side-specific sidewalk geometry.
  return pedestrianEvidenceFor(tags) !== "none";
}

function pedestrianEvidenceFor(tags = {}) {
  if (DEDICATED_PEDESTRIAN_HIGHWAYS.has(tags.highway)) return "dedicated";
  if (tags.highway === "living_street" && tags.foot !== "no") return "shared-space";
  if (["designated", "yes"].includes(tags.foot)) return "explicit-foot";
  const sidewalkValues = [
    tags.sidewalk,
    tags["sidewalk:both"],
    tags["sidewalk:left"],
    tags["sidewalk:right"]
  ].map(value => String(value || "").toLowerCase());
  if (sidewalkValues.some(value => ["yes", "both", "left", "right", "separate"].includes(value))) return "sidewalk-tag";
  return "none";
}

function buildEdgeName(tags, wayId) {
  if (tags.name) return tags.name;
  if (tags.ref) return `${humanize(tags.highway)} ${tags.ref}`;
  if (tags.footway === "crossing") return "Pedestrian crossing";
  return `${humanize(tags.highway || "path")} · OSM way ${wayId}`;
}

function humanize(value) {
  return String(value || "path")
    .replaceAll("_", " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function isCrossing(wayTags, endpointTags) {
  return wayTags.footway === "crossing"
    || wayTags.crossing != null
    || endpointTags.some(tags => tags.highway === "crossing" || tags.crossing != null);
}

function inferKerbState(endpointTags) {
  const values = endpointTags
    .map(tags => tags.kerb || tags.curb)
    .filter(Boolean);

  if (values.some(value => ["flush", "lowered", "no"].includes(value))) return true;
  if (values.some(value => ["raised", "rolled", "yes"].includes(value))) return false;
  return null;
}

export function parseInclinePercent(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  const numeric = Number.parseFloat(text.replace(",", "."));
  if (!Number.isFinite(numeric)) return null;
  if (text.includes("°")) return Math.abs(Math.tan(numeric * Math.PI / 180) * 100);
  return Math.abs(numeric);
}

function classifySurface(surfaceValue, smoothnessValue) {
  const surface = String(surfaceValue || "").toLowerCase();
  const smoothness = String(smoothnessValue || "").toLowerCase();

  if (["bad", "very_bad", "horrible", "very_horrible", "impassable"].includes(smoothness)) return "rough";
  if (["intermediate"].includes(smoothness)) return "uneven";
  if (["excellent", "good"].includes(smoothness)) return "smooth";

  if (["dirt", "earth", "ground", "grass", "mud", "sand", "gravel", "unhewn_cobblestone", "cobblestone"].includes(surface)) return "rough";
  if (["sett", "paving_stones", "pebblestone", "fine_gravel", "compacted", "wood", "metal", "concrete:plates"].includes(surface)) return "uneven";
  if (["asphalt", "concrete", "concrete:lanes", "paved"].includes(surface)) return "smooth";
  return "unknown";
}

function inferShade(tags) {
  if (tags.covered === "yes" || tags.indoor === "yes" || tags.tunnel === "building_passage" || tags.highway === "corridor") return 0.95;
  if (tags.tree_lined === "yes") return 0.7;
  return null;
}

function parseLit(value) {
  const text = String(value || "").toLowerCase();
  if (["yes", "automatic", "24/7", "sunset-sunrise"].includes(text)) return true;
  if (["no", "limited", "disused"].includes(text)) return false;
  return null;
}

function isAccessPoint(tags = {}) {
  return Boolean(
    tags.entrance
    || tags.railway === "subway_entrance"
    || tags.public_transport === "entrance"
  );
}

function accessPointSource(tags = {}) {
  if (tags.railway === "subway_entrance" || tags.public_transport === "entrance") {
    return "OpenStreetMap transit entrance";
  }
  if (tags.entrance) return "OpenStreetMap entrance";
  return "OpenStreetMap pedestrian access point";
}

function accessPointPriority(tags = {}) {
  const accessibleBonus = tags.wheelchair === "yes" ? 2 : 0;
  if (tags.entrance && tags.railway !== "subway_entrance" && tags.public_transport !== "entrance") {
    return 50 + accessibleBonus;
  }
  if (tags.railway === "subway_entrance" || tags.public_transport === "entrance") {
    return 40 + accessibleBonus;
  }
  return 10 + accessibleBonus;
}

function calculateConfidence({ tags, slope, surface, crossing, kerbState, shade }) {
  let score = 0.42;
  if (tags.name) score += 0.04;
  if (tags.wheelchair) score += 0.12;
  if (slope != null) score += 0.12;
  if (surface !== "unknown") score += 0.10;
  if (!crossing || kerbState != null) score += 0.10;
  if (shade != null) score += 0.04;
  if (tags.lit) score += 0.03;
  return Math.min(0.95, score);
}

function keepLargestConnectedComponent(nodes, edges) {
  const adjacency = new Map();
  for (const nodeId of Object.keys(nodes)) adjacency.set(nodeId, []);
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }

  const visited = new Set();
  let largest = new Set();

  for (const nodeId of adjacency.keys()) {
    if (visited.has(nodeId)) continue;
    const component = new Set();
    const queue = [nodeId];
    visited.add(nodeId);

    while (queue.length) {
      const current = queue.shift();
      component.add(current);
      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    if (component.size > largest.size) largest = component;
  }

  const filteredNodes = {};
  for (const nodeId of largest) filteredNodes[nodeId] = nodes[nodeId];
  const filteredEdges = edges.filter(edge => largest.has(edge.from) && largest.has(edge.to));
  return { nodes: filteredNodes, edges: filteredEdges };
}

export function findNearestNode(nodes, coordinates, maxDistanceMeters = Infinity) {
  let best = null;
  let bestDistance = Infinity;

  for (const node of Object.values(nodes)) {
    const distance = haversineMeters(coordinates, node.coordinates);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }

  if (!best || bestDistance > maxDistanceMeters) return null;
  return { node: best, distanceMeters: bestDistance };
}

/**
 * Attach selected coordinates to existing OSM pedestrian geometry. The
 * connector is a split of a mapped pedestrian edge, not a direct line to an
 * arbitrary nearby node. A small projection tolerance only absorbs coordinate
 * precision differences; anything farther away fails closed.
 */
export function connectRouteEndpoints(nodes, edges, startPlace, endPlace, options = {}) {
  const maxProjectionDistanceMeters = Math.max(0.25, Number(options.maxProjectionDistanceMeters || 3));
  let graph = { nodes: { ...(nodes || {}) }, edges: [...(edges || [])] };
  const start = attachEndpoint(graph, startPlace, "start", { ...options, maxProjectionDistanceMeters });
  if (!start.connected) return { ...graph, startId: null, endId: null, failure: start };
  graph = { nodes: start.nodes, edges: start.edges };
  const end = attachEndpoint(graph, endPlace, "end", { ...options, maxProjectionDistanceMeters });
  if (!end.connected) return { ...graph, startId: start.nodeId, endId: null, failure: end };
  return {
    nodes: end.nodes,
    edges: end.edges,
    startId: start.nodeId,
    endId: end.nodeId,
    connectors: [start.connector, end.connector].filter(Boolean),
    endpointConnections: {
      start: start.connector,
      end: end.connector
    },
    failure: null
  };
}

function attachEndpoint(graph, place, endpointType, options) {
  const coordinates = place?.coordinates;
  if (!validCoordinate(coordinates)) return { ...graph, connected: false, endpointType, reason: "invalid-coordinate" };
  const exactNode = Object.values(graph.nodes).find(node => haversineMeters(node.coordinates, coordinates) <= .35);
  if (exactNode) {
    return {
      ...graph,
      connected: true,
      nodeId: exactNode.id,
      connector: endpointConnection(place, exactNode.coordinates, {
        endpointType,
        edgeId: null,
        connectorDistanceMeters: 0,
        connectorSource: "Exact OpenStreetMap pedestrian node",
        connectorStatus: "verified"
      })
    };
  }

  let best = bestPedestrianProjection(graph.edges, coordinates, options);
  let accessPoint = null;
  if (!best || best.distanceMeters > options.maxProjectionDistanceMeters) {
    accessPoint = bestEndpointAccessPoint(place, options.accessPoints, graph, options);
    if (accessPoint) best = accessPoint.projection;
  }

  if (!best || (!accessPoint && best.distanceMeters > options.maxProjectionDistanceMeters)) {
    return {
      ...graph,
      connected: false,
      endpointType,
      reason: "no-verified-pedestrian-connector",
      distanceMeters: best?.distanceMeters ?? Infinity,
      maxDistanceMeters: options.maxProjectionDistanceMeters
    };
  }

  const accessCoordinates = accessPoint?.coordinates || best.coordinate;
  const nodeId = `selected-${endpointType}-${coordinateKey(accessCoordinates)}`;
  const splitPoint = [...best.coordinate];
  const fromGeometry = [
    ...best.geometry.slice(0, best.segmentIndex + 1),
    splitPoint
  ];
  const toGeometry = [
    splitPoint,
    ...best.geometry.slice(best.segmentIndex + 1)
  ];
  const fromDistance = geometryDistance(fromGeometry);
  const toDistance = geometryDistance(toGeometry);
  const totalDistance = Math.max(.01, fromDistance + toDistance);
  const sourceMinutes = Number(best.edge.minutes || 0);
  const base = {
    ...best.edge,
    endpointConnector: true,
    connectorEvidence: "OpenStreetMap pedestrian edge",
    selectionOffsetMeters: best.distanceMeters
  };
  const before = {
    ...base,
    id: `${best.edge.id}--${endpointType}-before`,
    to: nodeId,
    geometry: fromGeometry,
    distanceMeters: fromDistance,
    minutes: sourceMinutes * fromDistance / totalDistance
  };
  const after = {
    ...base,
    id: `${best.edge.id}--${endpointType}-after`,
    from: nodeId,
    geometry: toGeometry,
    distanceMeters: toDistance,
    minutes: sourceMinutes * toDistance / totalDistance
  };
  const edges = graph.edges.filter(edge => edge.id !== best.edge.id);
  if (fromDistance > .05) edges.push(before);
  if (toDistance > .05) edges.push(after);
  return {
    nodes: {
      ...graph.nodes,
      [nodeId]: {
        id: nodeId,
        name: place.name || `${endpointType} point`,
        coordinates: splitPoint,
        selectedPlaceId: place.id || null,
        selectedCoordinates: [...coordinates]
      }
    },
    edges,
    connected: true,
    nodeId,
    connector: endpointConnection(place, splitPoint, {
      endpointType,
      edgeId: best.edge.id,
      connectorGeometry: accessPoint?.connectorGeometry || null,
      connectorDistanceMeters: accessPoint
        ? haversineMeters(coordinates, accessCoordinates)
        : haversineMeters(coordinates, splitPoint),
      connectorSource: accessPoint?.connectorSource || "OpenStreetMap pedestrian edge",
      connectorStatus: accessPoint?.connectorStatus || (best.distanceMeters <= .75 ? "verified" : "estimated"),
      selectionOffsetMeters: haversineMeters(coordinates, splitPoint)
    })
  };
}

function bestPedestrianProjection(edges, coordinates, options) {
  let best = null;
  for (const edge of edges) {
    if (!edgeEligibleForEndpoint(edge, options)) continue;
    const geometry = Array.isArray(edge.geometry) ? edge.geometry : [];
    for (let index = 1; index < geometry.length; index += 1) {
      const projection = projectToSegment(coordinates, geometry[index - 1], geometry[index]);
      const distanceMeters = haversineMeters(coordinates, projection.coordinate);
      if (!best || distanceMeters < best.distanceMeters) {
        best = { edge, geometry, segmentIndex: index - 1, ...projection, distanceMeters };
      }
    }
  }
  return best;
}

function bestEndpointAccessPoint(place, values, graph, options) {
  const maximum = Math.max(5, Number(options.maxAccessPointDistanceMeters || 160));
  const candidates = [
    ...(Array.isArray(place?.accessPoints) ? place.accessPoints : []),
    ...(Array.isArray(values) ? values : [])
  ].map(normalizeEndpointAccessPoint).filter(Boolean)
    .filter(item => haversineMeters(place.coordinates, item.coordinates) <= maximum)
    .map(item => ({
      ...item,
      projection: bestPedestrianProjection(graph.edges, item.coordinates, {
        ...options,
        maxProjectionDistanceMeters: Math.min(3, options.maxProjectionDistanceMeters)
      })
    }))
    .filter(item => item.projection && item.projection.distanceMeters <= Math.min(3, options.maxProjectionDistanceMeters))
    .sort((a, b) => b.priority - a.priority
      || haversineMeters(place.coordinates, a.coordinates) - haversineMeters(place.coordinates, b.coordinates));
  return candidates[0] || null;
}

function normalizeEndpointAccessPoint(value) {
  if (!validCoordinate(value?.coordinates)) return null;
  const source = String(value.connectorSource || value.source || "Mapped pedestrian access point");
  const priority = Number(value.priority || (
    /openstreetmap transit entrance/i.test(source) ? 40
      : /openstreetmap.*entrance/i.test(source) ? 50
        : /transit entrance/i.test(source) ? 40
          : /building entrance/i.test(source) ? 30
            : /footway/i.test(source) ? 20
              : /sidewalk/i.test(source) ? 10 : 1
  ));
  const connectorGeometry = validLineGeometry(value.connectorGeometry) ? {
    type: "LineString",
    coordinates: value.connectorGeometry.type === "LineString"
      ? value.connectorGeometry.coordinates.map(point => [...point])
      : value.connectorGeometry.map(point => [...point])
  } : null;
  return {
    coordinates: [...value.coordinates],
    connectorGeometry,
    connectorSource: source,
    connectorStatus: value.connectorStatus === "verified" && connectorGeometry ? "verified" : "estimated",
    priority
  };
}

function endpointConnection(place, accessPointCoordinates, details) {
  return {
    endpointType: details.endpointType,
    edgeId: details.edgeId || null,
    selectedCoordinates: [...place.coordinates],
    accessPointCoordinates: [...accessPointCoordinates],
    connectorGeometry: details.connectorGeometry || null,
    connectorDistanceMeters: Number(details.connectorDistanceMeters || 0),
    connectorSource: details.connectorSource,
    connectorStatus: details.connectorStatus,
    selectionOffsetMeters: Number(details.selectionOffsetMeters || 0)
  };
}

function edgeEligibleForEndpoint(edge, options = {}) {
  if (!edge || edge.blocked || !Array.isArray(edge.geometry) || edge.geometry.length < 2) return false;
  if (!["dedicated", "shared-space", "explicit-foot", "sidewalk-tag"].includes(edge.pedestrianEvidence)) return false;
  if (options.avoidStairs && edge.stairs) return false;
  if (options.wheelchairMode && edge.roadCenterline) return false;
  return true;
}

function projectToSegment(point, start, end) {
  const referenceLat = ((point[1] + start[1] + end[1]) / 3) * Math.PI / 180;
  const scaleX = Math.cos(referenceLat);
  const px = point[0] * scaleX;
  const py = point[1];
  const ax = start[0] * scaleX;
  const ay = start[1];
  const bx = end[0] * scaleX;
  const by = end[1];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return { coordinate: [(ax + t * dx) / scaleX, ay + t * dy], progress: t };
}

function geometryDistance(coordinates) {
  let distance = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    distance += haversineMeters(coordinates[index - 1], coordinates[index]);
  }
  return distance;
}

function coordinateKey(coordinates) {
  return coordinates.map(value => Number(value).toFixed(6).replace("-", "m").replace(".", "p")).join("-");
}

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2
    && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function validLineGeometry(value) {
  const coordinates = value?.type === "LineString" ? value.coordinates : value;
  return Array.isArray(coordinates)
    && coordinates.length >= 2
    && coordinates.every(validCoordinate);
}

export function networkToGeoJSON(edges) {
  return {
    type: "FeatureCollection",
    features: edges.map(edge => ({
      type: "Feature",
      id: edge.id,
      properties: {
        id: edge.id,
        name: edge.name,
        osmWayId: edge.osmWayId || "unknown",
        highway: edge.highway || "path",
        surface: edge.surface || "unknown",
        slope: edge.slope == null ? "unknown" : edge.slope.toFixed(1),
        wheelchair: edge.wheelchairStatus || "unknown",
        confidence: Math.round((edge.confidence || 0) * 100),
        blocked: edge.blocked ? 1 : 0
      },
      geometry: {
        type: "LineString",
        coordinates: edge.geometry || []
      }
    }))
  };
}

export function haversineMeters(a, b) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const lat1Rad = toRadians(lat1);
  const lat2Rad = toRadians(lat2);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
