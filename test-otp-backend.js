import assert from "node:assert/strict";
import { createOtpProvider } from "./server/otp-provider.js";
import { createAppServer } from "./server/index.js";
import { loadConfig } from "./server/config.js";
import { normalizeRequest } from "./server/request.js";
import { CLOCK, exampleItinerary, health, issueTime, manifest, mockOtp, rideLeg, start, end } from "./tests/fixtures/otp.js";
import { PLAN_QUERY } from "./server/otp-query.js";
import { validateRouteOption } from "./route-model.js";
import { attachArrivalData, boardingGroups } from "./transit-realtime.js";

const clock = () => CLOCK;
const input = (mode, needs = {}) => ({ start, end, mode, needs: { maxWalkMinutes: 15, ...needs }, departureTime: issueTime(0) });
const request = (mode, needs) => normalizeRequest(input(mode, needs), CLOCK);
const provider = (plans, onQuery, customHealth) => createOtpProvider({
  url: "https://otp.example.test/otp/gtfs/v1", manifest, fetchImpl: mockOtp(plans, onQuery, customHealth), clock,
});
const plan = (values, mode = "mixed", needs = {}) => provider(values).plan(request(mode, needs));
const reject = async (fn, code) => assert.rejects(fn, error => error.code === code);

let queries = 0;
const preferred = provider([exampleItinerary("BUS", { departure: 180 }), exampleItinerary()], (query, variables) => {
  if (query === PLAN_QUERY) {
    assert.equal(variables.preferences.accessibility.wheelchair.enabled, false);
    assert.equal(variables.dateTime.earliestDeparture, issueTime(0));
    assert.deepEqual(variables.origin.location.coordinate, { longitude: start[0], latitude: start[1] });
  } else queries++;
});
assert.ok((await preferred.capabilities()).modes.includes("rail"));
assert.equal((await preferred.capabilities()).updatedAt, manifest.graphBuiltAt);
const { routes: [bus], rejected } = await preferred.plan(request("mixed"));
assert.equal(queries, 1, "readiness is cached across requests");
assert.equal(rejected[0].code, "NO_VALID_TRANSFER", "a bus leaving before the access walk is rejected");
assert.equal(bus.mode, "bus");
assert.equal(bus.requestedMode, "mixed");
assert.deepEqual(bus.actualModes, ["bus"]);
assert.equal(bus.totalWaitSeconds, 60);
assert.equal(bus.totalDurationSeconds, 1200);
assert.equal(bus.observedAt, null);
assert.equal(attachArrivalData(bus, { boardings: [{ legIndex: 1, status: "available", selectedPrediction: { waitSeconds: 30 } }] }).totalWaitSeconds, 60,
  "individual realtime predictions cannot silently change a validated itinerary");
assert.equal((await plan([exampleItinerary("SUBWAY")])).routes[0].mode, "subway");
assert.equal((await plan([exampleItinerary("RAIL")])).routes[0].mode, "rail");
assert.equal((await plan([exampleItinerary("FERRY")])).routes[0].mode, "ferry");
await reject(() => plan([exampleItinerary("BUS", { vehicle: "NOT_POSSIBLE" })], "bus", { wheelchairMode: true, unknownPolicy: "allow" }), "ACCESSIBILITY_CONSTRAINT_BLOCKED");
await reject(() => plan([exampleItinerary()], "bus", { wheelchairMode: true }), "INSUFFICIENT_ACCESSIBILITY_EVIDENCE");
await reject(() => plan([exampleItinerary()], "bus", { maxWalkMinutes: 5 }), "NO_FEASIBLE_ROUTE");
await reject(() => plan([exampleItinerary("SUBWAY")], "subway", { requireElevator: true }), "INSUFFICIENT_ACCESSIBILITY_EVIDENCE");
const alternate = await plan([exampleItinerary("SUBWAY"), exampleItinerary()], "mixed", { requireElevator: true });
assert.deepEqual(alternate.routes.map(route => route.mode), ["bus"], "missing subway access does not reject a bus route");
const noMapped = exampleItinerary(); noMapped.legs[0].legGeometry = null;
await reject(() => plan([noMapped]), "ENDPOINT_CONNECTOR_UNAVAILABLE");
const projected = exampleItinerary();
const boarding = [projected.legs[0].to.lon, projected.legs[0].to.lat];
const projectedStart = [start[0], start[1] + .00024];
projected.legs[0].legGeometry = rideLeg("WALK", projectedStart, boarding, 0, 480).legGeometry;
const projectedRoute = (await plan([projected])).routes[0];
assert.deepEqual(projectedRoute.endpointConnections.start.selectedCoordinates, start);
assert.deepEqual(projectedRoute.endpointConnections.start.accessPointCoordinates, projectedStart);
assert.equal(projectedRoute.endpointConnections.start.connectorGeometry, null);
assert.equal(projectedRoute.endpointConnections.start.connectorStatus, "estimated");
await reject(() => plan([projected], "bus", { requireCurb: true }), "INSUFFICIENT_ACCESSIBILITY_EVIDENCE");
const wrongShape = exampleItinerary("RAIL");
const alighting = wrongShape.legs[1].to;
wrongShape.legs[1].legGeometry = rideLeg("RAIL", boarding, [alighting.lon, alighting.lat + .00045], 540, 1140).legGeometry;
const partialRail = (await plan([wrongShape])).routes[0];
assert.equal(partialRail.legs[1].geometry, null, "a mismatched vehicle shape is omitted rather than drawing a false segment");
assert.equal(partialRail.legs[1].arrivalTime, issueTime(1140));
const invalidGeometry = exampleItinerary(); invalidGeometry.legs[1].legGeometry.points = "!!";
await reject(() => plan([invalidGeometry]), "PROVIDER_CONTRACT_ERROR");
const cancelled = exampleItinerary(); cancelled.legs[1].realtimeState = "CANCELED";
await reject(() => plan([cancelled]), "TRIP_CANCELLED");

const a = [-73.991, 40.732], b = [-73.985, 40.730], c = [-73.981, 40.729], d = [-73.976, 40.727];
const w1 = rideLeg("WALK", start, a, 0, 120);
const r1 = rideLeg("BUS", a, b, 180, 360, { from: "A", to: "B", trip: "first", exit: "NOT_POSSIBLE" });
const r2 = rideLeg("BUS", b, c, 420, 600, { from: "B", to: "C", trip: "second", fromSequence: 2, toSequence: 3, boarding: "NOT_POSSIBLE" });
const r3 = rideLeg("BUS", c, d, 660, 960, { from: "C", to: "D", trip: "third" });
const egress = rideLeg("WALK", d, end, 960, 1020);
const two = (await plan([{ legs: [w1, r1, r2, r3, egress] }])).routes[0];
assert.equal(two.transfers, 2, "different trips on the same route still require new boardings");
assert.equal(boardingGroups(two).length, 3);
const continuation = { ...r2, interlineWithPreviousLeg: true };
const one = (await plan([{ legs: [w1, r1, continuation, r3, egress] }], "bus", { wheelchairMode: true, unknownPolicy: "allow" })).routes[0];
assert.equal(one.transfers, 1, "a stay-seated trip may pass an inaccessible intermediate stop");
const walkTransfer = rideLeg("WALK", b, c, 360, 420);
const tooEarly = rideLeg("SUBWAY", c, d, 440, 960, { from: "C", to: "D", trip: "train" });
await reject(() => plan([{ legs: [w1, r1, walkTransfer, tooEarly, egress] }]), "NO_VALID_TRANSFER");
const feasible = rideLeg("SUBWAY", c, d, 490, 960, { from: "C", to: "D", trip: "train" });
const mixed = (await plan([{ legs: [w1, r1, walkTransfer, feasible, egress] }])).routes[0];
assert.deepEqual(mixed.actualModes, ["bus", "subway"]);
assert.equal(mixed.transfers, 1);
assert.equal(mixed.legs[2].mode, "transfer");
assert.equal(mixed.totalDurationSeconds, 1020);
assert.equal(validateRouteOption(mixed, { now: +CLOCK }).valid, true);
assert.equal(validateRouteOption({ ...mixed, legs: mixed.legs.map((leg, i) => i === 3 ? { ...leg, departureTime: issueTime(300) } : leg) }, { now: +CLOCK }).valid, false);

await reject(() => provider([], undefined, { ...health, feeds: [], routes: [] }).capabilities(), "PROVIDER_UNAVAILABLE");
await reject(() => provider(() => new Response("not JSON")).plan(request("bus")), "PROVIDER_CONTRACT_ERROR");
await reject(() => provider(() => Response.json({ errors: [{ message: "not exposed" }], data: null })).plan(request("bus")), "PROVIDER_CONTRACT_ERROR");
await reject(() => provider(() => Response.json({ data: { planConnection: { edges: [], routingErrors: [{ code: "NO_STOPS_IN_RANGE" }] } } })).plan(request("bus")), "ENDPOINT_CONNECTOR_UNAVAILABLE");
await reject(() => provider(() => Response.json({ data: { planConnection: { edges: [], routingErrors: [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }] } } })).plan(request("bus")), "SEARCH_LIMIT_REACHED");
await reject(() => provider([]).plan({ ...request("bus"), departureTime: "2027-01-03T15:00Z" }), "TRANSIT_DATA_STALE");

const server = createAppServer({
  config: loadConfig({}),
  primary: provider(() => new Response("upstream failed", { status: 503 })),
  fallback: preferred, clock,
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
try {
  assert.equal((await fetch(url + "/api/health")).status, 200);
  assert.equal((await fetch(url + "/api/ready")).status, 200);
  const post = (body, headers = {}) => fetch(url + "/api/routes", { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const response = await post(input("mixed"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.routes[0].mode, "bus");
  assert.deepEqual(payload.attempts, [{ provider: "primary", code: "PROVIDER_UNAVAILABLE" }]);
  assert.equal((await post("broken")).status, 400);
  assert.equal((await post(input("bus"), { Origin: "https://unconfigured.example" })).status, 403);
  assert.equal((await post({ ...input("bus"), start: [null, 40.7] })).status, 400);
  assert.equal((await post({ ...input("bus"), departureTime: "2026-11-24T10:00" })).status, 400);
  assert.equal((await post(" ".repeat(17_000))).status, 413);
} finally { await new Promise(resolve => server.close(resolve)); }

const deadProvider = createOtpProvider({ url: "https://otp.example.test", manifest, clock, timeoutMs: 40,
  fetchImpl: mockOtp(() => new Promise(() => {})) });
await reject(() => deadProvider.plan(request("bus")), "PROVIDER_TIMEOUT");
const controller = new AbortController();
await deadProvider.capabilities();
const pending = deadProvider.plan(request("bus"), { signal: controller.signal });
controller.abort();
await reject(() => pending, "REQUEST_CANCELLED");
console.log("OTP response contract, chronology, transfer identity, accessibility, HTTP fallback, freshness, timeouts and validation passed.");
