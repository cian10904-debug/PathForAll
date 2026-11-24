import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { agencyDeparture, localDateKey, serviceInstant } from "./agency-time.js";
import { createRouteSession } from "./route-session.js";
import { recordNavigationCompletionOnce } from "./navigation.js";
import { recordPilotEvent, recordCompletedJourney, pilotMetrics, loadPilotEvents, clearPilotEvents } from "./pilot-store.js";
import { connectRouteEndpoints, parseOverpassGraph } from "./osm-network.js";
import { dijkstra } from "./routing.js";
import { nextBoardingWaitSeconds, planTransitRoutes } from "./transit-routing.js";
import { normalizeWalkingRoute } from "./route-model.js";
import { fetchWithPolicy } from "./fetch-client.js";

const graph = parseOverpassGraph({ elements: [
  {type:"node", id:1, lon:-73.99, lat:40.73},
  {type:"node", id:2, lon:-73.989, lat:40.73, tags:{wheelchair:"no",barrier:"stile"}},
  {type:"node", id:3, lon:-73.988, lat:40.73},
  {type:"way", id:4, nodes:[1,2,3], tags:{highway:"footway",incline:"0%",surface:"asphalt",wheelchair:"yes"}}
] });
const needs = { wheelchairMode:true, unknownPolicy:"strict", maxSlope:6 };
for (const policy of ["strict","allow"]) {
  for (const pair of [[1,3],[3,1],[2,3],[1,2]]) {
    assert.equal(dijkstra(graph.nodes, graph.edges, ...pair.map(i => "osm-node-"+i), {...needs, unknownPolicy:policy}),null);
  }
}
assert.ok(dijkstra(graph.nodes,graph.edges,"osm-node-1","osm-node-3",{}),"wheelchair prohibition leaves ordinary use intact");
const attached = connectRouteEndpoints(graph.nodes,graph.edges,{coordinates:[-73.9898,40.73]},{coordinates:[-73.9896,40.73]},needs);
const partial = dijkstra(attached.nodes,attached.edges,attached.startId,attached.endId,needs);
assert.ok(partial,"a partial segment not reaching the restricted node can be used");
assert.equal(normalizeWalkingRoute({route:partial},{...attached,needs}).evidence.status,"satisfied");
assert.equal(dijkstra(attached.nodes,attached.edges,attached.startId,"osm-node-3",needs),null,"splitting does not remove the actual restriction");

const phases = [];
const session = createRouteSession(busy => phases.push(busy));
const first = session.begin();
session.cancel(); first.finish();
assert.deepEqual(phases,[true,false]);
const second = session.begin();
const third = session.begin();
second.finish();
assert.equal(second.signal.aborted,true);
assert.equal(phases.at(-1),true);
third.finish();
assert.equal(phases.at(-1),false);

clearPilotEvents();
const gps = {}, preview = {};
recordPilotEvent("navigation_started",{source:"gps"});
assert.equal(recordNavigationCompletionOnce(gps,recordCompletedJourney,{mode:"bus",source:"gps"}),true);
assert.equal(recordNavigationCompletionOnce(gps,recordCompletedJourney,{mode:"bus",source:"gps"}),false);
assert.equal(recordNavigationCompletionOnce(preview,recordCompletedJourney,{mode:"bus",source:"preview"}),true);
assert.equal(pilotMetrics().navigationCompleted,1);
assert.equal(pilotMetrics().previewsCompleted,1);
assert.equal(pilotMetrics().completionRate,1);
assert.equal(loadPilotEvents()[1].type,"navigation_completed");

const overnight = { scheduleVerified:true, scheduleSource:"test", scheduleUpdatedAt:"2026-11-01T15:00:00Z", scheduleFreshness:"current",
  serviceDays:["monday"], frequency:{startTime:"25:00:00",endTime:"26:00:00",headwaySeconds:600} };
assert.equal(nextBoardingWaitSeconds(overnight,new Date("2026-11-24T06:03:00Z")),420);
assert.equal(nextBoardingWaitSeconds({...overnight,calendarExceptions:[{date:"20261123",exceptionType:2}]},
  new Date("2026-11-24T06:03:00Z")),null);
assert.equal(nextBoardingWaitSeconds({...overnight,cancelled:true},new Date("2026-11-24T06:03:00Z")),null);
assert.equal(new Date(serviceInstant("2026-03-08",43200)).toISOString(),"2026-03-08T16:00:00.000Z");
assert.equal(new Date(serviceInstant("2026-11-01",43200)).toISOString(),"2026-11-01T17:00:00.000Z");
assert.equal(agencyDeparture("2026-11-01T01:30"),null);
assert.equal(agencyDeparture("2026-03-08T02:30"),null);
assert.equal(agencyDeparture("2026-11-24T10:00"),"2026-11-24T15:00:00.000Z");
assert.equal(localDateKey(new Date("2026-11-24T03:00:00Z")),"2026-11-23");
const command = `import {nextBoardingWaitSeconds} from "./transit-routing.js";
console.log(nextBoardingWaitSeconds(${JSON.stringify(overnight)},new Date("2026-11-24T06:03:00Z")))`;
for (const TZ of ["Pacific/Honolulu","Europe/Paris","Asia/Shanghai","America/New_York"]) {
  const child = spawnSync(process.execPath,["--input-type=module","-e",command],{env:{...process.env,TZ},encoding:"utf8"});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout.trim(),"420");
}

// An access path that takes eight minutes must exclude the lower-cost 10:03 bus.
const start = new Date("2026-11-24T15:00:00Z");
const fakePoint = (x,id) => ({id,coordinates:[-74+x,40.73]});
const nodes = {a:fakePoint(0,"a"), b:fakePoint(.003,"b"), c:fakePoint(.012,"c")};
const stop = (id,node) => ({id, coordinates:node.coordinates, modes:["bus"], pedestrianNodeId:node.id,connectorStatus:"verified",snapStatus:"valid"});
const edge = {id:"access",from:"a",to:"b",minutes:8,distanceMeters:300, geometry:[nodes.a.coordinates,nodes.b.coordinates]};
const service = {id:"ride",from:"B",to:"C",route:"M8",tripId:"example",mode:"bus",minutes:10,
  scheduleVerified:true,scheduleSource:"fixture",scheduleUpdatedAt:start.toISOString(),scheduleFreshness:"current",
  departures:["2026-11-24T15:03:00Z","2026-11-24T15:09:00Z"]};
const params = {pedestrianNodes:nodes,pedestrianEdges:[edge],startId:"a",endId:"c",mode:"mixed",departureTime:start,
  transitStops:[stop("B",nodes.b),stop("C",nodes.c)],transitEdges:[service]};
assert.equal(planTransitRoutes(params)[0].transit.edges[0].departureTime,"2026-11-24T15:09:00.000Z");
assert.deepEqual(planTransitRoutes({...params,transitEdges:[{...service,departures:[service.departures[0]]}]}), []);

const pre = new AbortController(); pre.abort();
await assert.rejects(fetchWithPolicy("https://example.test",{signal:pre.signal},{fetchImpl(){throw Error("should not start");}}),{name:"AbortError"});
const stream = new ReadableStream({ pull() { return new Promise(()=>{}); } });
await assert.rejects(fetchWithPolicy("https://example.test",{},{timeoutMs:35,fetchImpl:async()=>new Response(stream)}),{code:"FETCH_TIMEOUT"});
await assert.rejects(fetchWithPolicy("https://example.test",{},{maxResponseBytes:1024,fetchImpl:async()=>new Response("x".repeat(1100))}),{code:"RESPONSE_TOO_LARGE"});
let attempts = 0;
const delay = new AbortController();
const waiting = fetchWithPolicy("https://example.test",{signal:delay.signal},{retries:2,fetchImpl:async()=>{
  attempts++;
  return new Response(null,{status:429,headers:{"Retry-After":"2"}});
}});
setTimeout(()=>delay.abort(),35);
await assert.rejects(waiting,{name:"AbortError"});
assert.equal(attempts,1);
console.log("Node barriers, split endpoints, cancellation, metrics, overnight/DST/timezone behavior and fetch deadlines passed.");
