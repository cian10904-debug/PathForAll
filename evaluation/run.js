import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  parseOverpassGraph,
  connectRouteEndpoints,
  haversineMeters,
  isInsideBounds,
} from "../osm-network.js";
import { dijkstra, PROFILE_WEIGHTS } from "../routing.js";
import { normalizeWalkingRoute } from "../route-model.js";
import { diagnoseNoRoute } from "../routing-diagnostics.js";

const cases = JSON.parse(readFileSync("evaluation/cases.json", "utf8"));
const snapshotBytes = readFileSync(process.env.PFA_OSM_SNAPSHOT || "otp-data/osm-snapshot.json");
const provenance = JSON.parse(
  readFileSync(process.env.PFA_OSM_PROVENANCE || "otp-data/osm-provenance.json", "utf8"),
);
if (
  createHash("sha256").update(snapshotBytes).digest("hex") !== provenance.sha256
)
  throw new Error("OSM snapshot checksum mismatch");
const began = performance.now();
const payload = JSON.parse(snapshotBytes.toString("utf8"));
const graph = parseOverpassGraph(payload);
const constructionMs = performance.now() - began;
const rawWays = new Map(
  payload.elements
    .filter((element) => element.type === "way")
    .map((element) => [element.id, element]),
);
const rawNodes = new Map(
  payload.elements
    .filter((element) => element.type === "node")
    .map((element) => [element.id, element]),
);

// Independent audit reads raw OSM records; it does not call assessEdge or isEdgeAllowed.
function audit(route, graphEdges, needs) {
  const errors = [];
  const map = new Map(graphEdges.map((edge) => [edge.id, edge]));
  for (const step of route.traversals) {
    const edge = map.get(step.edgeId),
      way = rawWays.get(edge.osmWayId),
      tags = way?.tags || {};
    if (!way) errors.push("missing raw source way");
    if (needs.wheelchairMode && tags.wheelchair === "no")
      errors.push("raw OSM wheelchair prohibition");
    if (
      needs.wheelchairMode &&
      ![
        "footway",
        "path",
        "pedestrian",
        "steps",
        "corridor",
        "elevator",
      ].includes(tags.highway)
    )
      errors.push("road centerline accepted for wheelchair travel");
    const points = (way?.nodes || [])
      .map((id) => rawNodes.get(id))
      .filter(Boolean)
      .map((node) => [node.lon, node.lat]);
    for (const point of edge.geometry || []) {
      const onSource = points.slice(1).some((end, index) => {
        const start = points[index],
          dx = end[0] - start[0],
          dy = end[1] - start[1];
        const ratio =
          dx * dx + dy * dy
            ? Math.max(
                0,
                Math.min(
                  1,
                  ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
                    (dx * dx + dy * dy),
                ),
              )
            : 0;
        return (
          Math.hypot(
            point[0] - start[0] - ratio * dx,
            point[1] - start[1] - ratio * dy,
          ) < 1e-7
        );
      });
      if (!onSource) errors.push("route geometry is not on its raw source way");
    }
    // Independently read node tags at the actual segment endpoints. A split
    // edge which never reaches a prohibited node must not inherit that barrier.
    if (needs.wheelchairMode) {
      const traversed = [edge.geometry?.[0], edge.geometry?.at(-1)].filter(Boolean);
      if ((way?.nodes || []).some(id => {
        const node = rawNodes.get(id);
        return node?.tags?.wheelchair === "no" && traversed.some(point => haversineMeters(point, [node.lon, node.lat]) < .05);
      })) errors.push("raw OSM wheelchair prohibition at a node");
    }
    if (needs.avoidStairs && tags.highway === "steps")
      errors.push("raw OSM stairs violation");
    if (Number.isFinite(needs.maxSlope)) {
      const value = String(tags.incline || "").trim();
      const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(%|°)?$/);
      const grade = match
        ? Math.abs(
            match[2] === "°"
              ? Math.tan((Number(match[1]) * Math.PI) / 180) * 100
              : Number(match[1]),
          )
        : null;
      if (grade != null && grade > needs.maxSlope)
        errors.push("raw OSM slope violation");
      if (grade == null && needs.unknownPolicy !== "allow")
        errors.push("unknown slope accepted in strict mode");
    }
    if (
      needs.requireCurb &&
      (tags.footway === "crossing" || tags.crossing != null)
    ) {
      const ends = [
        rawNodes.get(way.nodes[0])?.tags,
        rawNodes.get(way.nodes.at(-1))?.tags,
      ];
      const states = ends.map((tag) => {
        const values = [tag?.kerb, tag?.curb].filter(Boolean);
        if (values.some((v) => ["raised", "rolled", "yes"].includes(v)))
          return "violated";
        if (values.some((v) => ["lowered", "flush", "no"].includes(v)))
          return "satisfied";
        return "unknown";
      });
      if (states.includes("violated")) errors.push("raw OSM curb barrier");
      if (states.includes("unknown") && needs.unknownPolicy !== "allow")
        errors.push("unknown curb accepted in strict mode");
    }
  }
  return [...new Set(errors)];
}
const results = [];
const latencies = [];
for (const item of cases) {
  const startMs = performance.now();
  const result = {
    id: item.id,
    scenario: item.scenario,
    start: item.start,
    end: item.end,
    needs: item.needs,
    expected: item.expected,
    provenance: {
      sha256: provenance.sha256,
      retrievedAt: provenance.retrievedAt,
    },
    status: "pending",
    independentAudit: null,
    fieldVerification: "pending",
    userTrial: "pending",
  };
  try {
    if (!isInsideBounds(item.start) || !isInsideBounds(item.end)) {
      result.status = "incomplete_coverage";
    } else {
      // Freeze a 600 m neighborhood around each endpoint; search results do not
      // constitute a citywide reachability claim.
      const edges = graph.edges.filter((edge) =>
        edge.geometry.some(
          (point) =>
            haversineMeters(point, item.start) <= 600 ||
            haversineMeters(point, item.end) <= 600,
        ),
      );
      const ids = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
      const nodes = Object.fromEntries(
        [...ids].map((id) => [id, graph.nodes[id]]),
      );
      result.graphSize = { nodes: ids.size, edges: edges.length };
      const attached = connectRouteEndpoints(
        nodes,
        edges,
        { coordinates: item.start },
        { coordinates: item.end },
        { ...item.needs, ...item.attachment },
      );
      if (attached.failure) result.status = "incomplete_coverage";
      else {
        const searchStart = performance.now();
        const path = dijkstra(
          attached.nodes,
          attached.edges,
          attached.startId,
          attached.endId,
          item.needs,
          {},
          PROFILE_WEIGHTS.fastest,
        );
        result.searchMs = performance.now() - searchStart;
        if (path) {
          const normalized = normalizeWalkingRoute(
            { key: item.id, route: path },
            { nodes: attached.nodes, edges: attached.edges, needs: item.needs },
          );
          if (!normalized)
            throw new Error(
              "Returned path failed the shared RouteOption contract",
            );
          result.status = "returned";
          result.distanceMeters = normalized.distanceMeters;
          result.estimatedSeconds = normalized.totalDurationSeconds;
          result.generalizedCostMinutes = path.score;
          result.evidenceStatus = normalized.evidence.status;
          result.edgeIds = path.edgeIds;
          result.independentAudit = {
            basis: "raw-map constraint audit",
            errors: audit(path, attached.edges, item.needs),
          };
        } else {
          const diagnosis = diagnoseNoRoute(
            attached.nodes,
            attached.edges,
            attached.startId,
            attached.endId,
            item.needs,
          );
          result.status = {
            INSUFFICIENT_EVIDENCE: "insufficient_evidence",
            NO_FEASIBLE_ROUTE: "known_constraint_failure",
            INCOMPLETE_COVERAGE: "incomplete_coverage",
          }[diagnosis.code];
        }
      }
    }
  } catch (error) {
    result.status =
      error.code === "SEARCH_LIMIT" ? "search_limit" : "software_failure";
    result.error = error.message;
  }
  result.elapsedMs = performance.now() - startMs;
  latencies.push(result.elapsedMs);
  results.push(result);
  console.log(item.id, result.status, Math.round(result.elapsedMs) + "ms");
}
const quantile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const audited = results.filter((result) => result.independentAudit);
const failed = audited.filter(
  (result) => result.independentAudit.errors.length,
);
const summary = {
  recordedAt: new Date().toISOString(),
  evidenceLevel:
    "software evaluation using a frozen real map snapshot; not field verification",
  denominator: results.length,
  outcomes: results.reduce(
    (counts, result) => (
      (counts[result.status] = (counts[result.status] || 0) + 1),
      counts
    ),
    {},
  ),
  returnedConstraintErrorRate: {
    numerator: failed.length,
    denominator: audited.length,
    rate: audited.length ? failed.length / audited.length : null,
    basis:
      "Only returned routes independently audited against raw tags. Not a passability success rate.",
  },
  referenceConnectivityFailures: results
    .filter(
      (result, i) =>
        cases[i].expected.routeRequired && result.status !== "returned",
    )
    .map((result) => result.id),
  performance: {
    hardware: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    snapshotRetrievalMs: provenance.retrievalMilliseconds,
    externalRetrievalSampleSize: 1,
    constructionMs,
    constructionSampleSize: 1,
    fullGraphNodes: Object.keys(graph.nodes).length,
    fullGraphEdges: graph.edges.length,
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    sampleSize: latencies.length,
    cache:
      "One fresh process; snapshot loaded once, graph reused; no route-result cache.",
    rssBytes: process.memoryUsage().rss,
  },
  results,
};
mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/walking-evaluation.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
if (
  failed.length || summary.referenceConnectivityFailures.length ||
  results.some((result) => ["software_failure", "search_limit"].includes(result.status))
)
  process.exitCode = 1;
