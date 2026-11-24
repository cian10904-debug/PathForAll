// Deterministic provider response data. No production path imports this module.
import { PLAN_QUERY, HEALTH_QUERY } from "../../server/otp-query.js";

export const CLOCK = new Date("2026-11-24T15:00:00Z");
export const issueTime = seconds => new Date(+CLOCK + seconds * 1_000).toISOString();
export const start = [-73.997, 40.734];
export const end = [-73.973, 40.724];
export const manifest = {
  schema: 1, otpVersion: "2.8.1", graphBuiltAt: "2026-11-23T15:00:00Z",
  feeds: [{ id: "sample", timeZone: "America/New_York", retrievedAt: "2026-11-22T15:00:00Z",
    validFrom: "2026-11-01", validThrough: "2026-12-31", modes: ["bus", "subway", "rail", "ferry"], sha256: "a".repeat(64), version: "fixture" }]
};
export const health = {
  serviceTimeRange: { start: +new Date("2026-11-01T04:00Z") / 1_000, end: +new Date("2027-01-02T05:00Z") / 1_000 },
  feeds: [{ feedId: "sample", agencies: [{ timezone: "America/New_York" }] }],
  routes: ["BUS", "SUBWAY", "RAIL", "FERRY"].map(mode => ({ gtfsId: "sample:" + mode, mode })),
};

export function rideLeg(mode, from, to, departure, arrival, ids = {}) {
  const vehicle = mode !== "WALK";
  return {
    id: ids.trip || "example-leg", mode, duration: arrival - departure, distance: ids.distance ?? (vehicle ? 750 : 75),
    serviceDate: vehicle ? "20261124" : null, realtimeState: "SCHEDULED",
    start: { scheduledTime: issueTime(departure) }, end: { scheduledTime: issueTime(arrival) },
    from: { lon: from[0], lat: from[1], name: "Start", stop: vehicle ? { gtfsId: "sample:" + (ids.from || "A"), wheelchairBoarding: ids.boarding || "POSSIBLE" } : null, stopPosition: vehicle ? { position: ids.fromSequence ?? 1 } : null },
    to: { lon: to[0], lat: to[1], name: "End", stop: vehicle ? { gtfsId: "sample:" + (ids.to || "B"), wheelchairBoarding: ids.exit || "POSSIBLE" } : null, stopPosition: vehicle ? { position: ids.toSequence ?? 2 } : null },
    route: vehicle ? { gtfsId: "sample:M8", shortName: "M8", mode } : null,
    trip: vehicle ? { gtfsId: "sample:" + (ids.trip || "trip1"), wheelchairAccessible: ids.vehicle || "POSSIBLE" } : null,
    legGeometry: { points: encodePolyline([from, to]) },
    stopCalls: vehicle ? [{}, {}] : [],
  };
}

export function exampleItinerary(mode = "BUS", options = {}) {
  const boarding = [-73.993, 40.733];
  const alight = [-73.974, 40.726];
  const dep = options.departure ?? 540;
  return { legs: [rideLeg("WALK", start, boarding, 0, 480, { distance: 600 }),
    rideLeg(mode, boarding, alight, dep, dep + 600, options), rideLeg("WALK", alight, end, dep + 600, dep + 660)] };
}

export function mockOtp(plan, onQuery = () => {}, overrideHealth = health) {
  return async (_url, init) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const { query, variables } = JSON.parse(init.body);
    onQuery(query, variables);
    if (query === HEALTH_QUERY) return Response.json({ data: overrideHealth });
    if (query !== PLAN_QUERY) throw new Error("Unexpected fixture query.");
    if (typeof plan === "function") return plan(variables, init);
    return Response.json({ data: { planConnection: { edges: plan.map(node => ({ node })), routingErrors: [] } } });
  };
}

function encodePolyline(points) {
  let previous = [0, 0];
  return points.map(([lon, lat]) => {
    const next = [Math.round(lat * 1e5), Math.round(lon * 1e5)];
    const result = next.map((value, i) => {
      const diff = value - previous[i];
      let encoded = diff < 0 ? -2 * diff - 1 : 2 * diff;
      let text = "";
      while (encoded >= 32) { text += String.fromCharCode((encoded % 32 | 32) + 63); encoded = Math.floor(encoded / 32); }
      return text + String.fromCharCode(encoded + 63);
    }).join("");
    previous = next;
    return result;
  }).join("");
}
