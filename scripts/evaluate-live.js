// Explicit live validation. These are sampled trips, not a service-wide claim.
import { mkdir, writeFile } from "node:fs/promises";
import { agencyDeparture, localDateKey } from "../agency-time.js";
import { validateRouteOption } from "../route-model.js";

const backend = new URL(process.env.PFA_API_URL || "http://127.0.0.1:8787");
const clock = new Date();
const day = process.env.PFA_EVAL_DATE || localDateKey(clock);
const at = agencyDeparture(day + "T" + (process.env.PFA_EVAL_TIME || "16:30"));
if (!at) throw new Error("Use a valid New York date and unambiguous time.");
const readyResponse = await fetch(new URL("/api/ready", backend), {
  signal: AbortSignal.timeout(7_000),
});
const readiness = await readyResponse.json();
if (!readyResponse.ok || !readiness.available)
  throw new Error("Transit graph not ready: " + readiness.code);

// Approximate public waypoints intentionally exercise actual street access.
const west8 = [-73.9952, 40.73163],
  east10 = [-73.97729, 40.7257];
const penn = [-73.99365, 40.7502],
  atlantic = [-73.97735, 40.68462];
const timesSq = [-73.98704, 40.75536],
  astor = [-73.99146, 40.73019];
const queens = [-73.90292, 40.74544],
  woodside = [-73.90248, 40.74594];
const yorkville = [-73.9477, 40.77779],
  lowerEast = [-73.98525, 40.71895];
/** @type {{id: string, mode: string, start: number[], end: number[], requires?: string, needs?: import('../domain.d.ts').Needs, expected?: string, expectsRoute?: boolean}[]} */
const examples = [
  {
    id: "M8-street-to-street",
    mode: "bus",
    start: west8,
    end: east10,
    requires: "bus",
  },
  {
    id: "Manhattan-bus-transfers",
    mode: "bus",
    start: lowerEast,
    end: yorkville,
    requires: "bus",
  },
  {
    id: "Longer-bus-cross-borough",
    mode: "bus",
    start: timesSq,
    end: queens,
    requires: "bus",
  },
  {
    id: "Manhattan-to-Brooklyn-subway",
    mode: "subway",
    start: timesSq,
    end: atlantic,
    requires: "subway",
  },
  {
    id: "All-Transit",
    mode: "mixed",
    start: astor,
    end: penn,
    requires: "mixed",
  },
  {
    id: "LIRR-Woodside-Penn",
    mode: "rail",
    start: woodside,
    end: penn,
    requires: "rail",
  },
  {
    id: "Ferry-coverage",
    mode: "ferry",
    start: [-74.00981, 40.70337],
    end: [-73.99502, 40.70224],
    requires: "ferry",
    expectsRoute: process.env.PFA_EVAL_REQUIRE_FERRY === "1",
  },
  {
    id: "strict-wheelchair",
    mode: "bus",
    start: west8,
    end: east10,
    requires: "bus",
    needs: {
      wheelchairMode: true,
      avoidStairs: true,
      requireCurb: true,
      maxSlope: 6,
      unknownPolicy: "strict",
    },
  },
  {
    id: "outside-NYC",
    mode: "bus",
    start: [-74.4, 40.8],
    end: penn,
    expected: "OUTSIDE_TRANSIT_COVERAGE",
  },
];
if (process.env.PFA_EVAL_EXTENDED_NYC === "1")
  examples.push(
    {
      id: "Bronx-Grand-Concourse",
      mode: "bus",
      start: [-73.922795, 40.826453],
      end: [-73.897531, 40.86223],
      expectsRoute: true,
    },
    {
      id: "Staten-Island-Victory-Richmond",
      mode: "bus",
      start: [-74.076746, 40.637834],
      end: [-74.117264, 40.640799],
      expectsRoute: true,
    },
  );

const results = [];
for (const item of examples) {
  const { id, mode, start, end } = item;
  if (item.requires && !readiness.modes.includes(item.requires)) {
    results.push({ id, mode, status: "unsupported" });
    continue;
  }
  const needs = { maxWalkMinutes: 30, ...(item.needs || {}) };
  const began = performance.now();
  const response = await fetch(new URL("/api/routes", backend), {
    method: "POST",
    signal: AbortSignal.timeout(18_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, start, end, needs, departureTime: at }),
  });
  const payload = await response.json();
  const elapsedMs = Number((performance.now() - began).toFixed(1));
  if (!response.ok) {
    results.push({
      id,
      mode,
      status: "refused",
      code: payload.code,
      details: payload.details,
      expected: item.expected,
      elapsedMs,
    });
    continue;
  }
  const routes = payload.routes.map((route) => {
    const check = validateRouteOption(route, {
      start,
      end,
      needs,
      departureTime: at,
      requestedMode: mode,
      requireTimeline: true,
    });
    return {
      id: route.id,
      actualModes: route.actualModes,
      validation: check,
      transfers: route.transfers,
      walkMeters: Math.round(route.totalWalkingMeters),
      durationSeconds: route.totalDurationSeconds,
      arrivalTime: route.arrivalTime,
      evidenceStatus: route.evidence.status,
      rides: route.legs
        .filter((leg) => leg.tripId)
        .map((leg) => ({
          mode: leg.mode,
          line: leg.routeName,
          tripId: leg.tripId,
          fromId: leg.from.id,
          toId: leg.to.id,
          sequence: [leg.fromSequence, leg.toSequence],
          serviceDate: leg.serviceDate,
          scheduledDepartureTime: leg.scheduledDepartureTime,
          scheduledArrivalTime: leg.scheduledArrivalTime,
        })),
    };
  });
  results.push({
    id,
    mode,
    status: "returned",
    elapsedMs,
    routes,
    rejected: payload.rejected,
    scheduleVersion: payload.dataVersion,
    graphBuiltAt: payload.graphBuiltAt,
  });
}
const output = {
  recordedAt: clock.toISOString(),
  departureTime: at,
  readiness,
  results,
};
await mkdir("evidence", { recursive: true });
await writeFile(
  process.env.PFA_EVAL_OUTPUT || "evidence/live-transit.json",
  JSON.stringify(output, null, 2) + "\n",
);
for (const { id, status, elapsedMs, code, routes } of results)
  console.log(
    id,
    status,
    code || "-",
    elapsedMs ?? "-",
    routes?.map((r) => r.actualModes.join("+") + ":" + r.transfers).join(",") ||
      "-",
  );
if (
  examples.some(
    (example) =>
      example.expectsRoute &&
      !results.some(
        (result) => result.id === example.id && result.status === "returned",
      ),
  ) ||
  results.some(
    (result) =>
      result.routes?.some((route) => !route.validation.valid) ||
      (result.expected && result.code !== result.expected),
  ) ||
  !results.some(
    (result) =>
      result.id === "M8-street-to-street" && result.status === "returned",
  ) ||
  !results.some(
    (result) =>
      result.mode === "bus" &&
      result.routes?.some((route) => route.transfers > 0),
  )
)
  process.exitCode = 1;
