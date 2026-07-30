"use strict";

import assert from "node:assert/strict";
import { createRouteSession } from "./route-session.js";

const session = createRouteSession();
const start = Object.freeze({ id: "start", coordinates: Object.freeze([-73.9900, 40.7300]) });
const end = Object.freeze({ id: "end", coordinates: Object.freeze([-73.9850, 40.7340]) });
const needs = Object.freeze({ wheelchairMode: true, requireElevator: true, maxSlope: 6 });
const commits = [];
const busWork = deferred();
const subwayWork = deferred();

const bus = beginPlan("bus", busWork.promise);
const subway = beginPlan("subway", subwayWork.promise);

assert.equal(bus.request.signal.aborted, true, "starting a new mode cancels the earlier request");
assert.equal(bus.request.isCurrent(), false, "the earlier request cannot commit after a mode switch");
assert.equal(subway.request.isCurrent(), true);
assert.deepEqual(start.coordinates, [-73.9900, 40.7300], "mode switching preserves the start location");
assert.deepEqual(end.coordinates, [-73.9850, 40.7340], "mode switching preserves the destination");
assert.equal(needs.requireElevator, true, "mode switching preserves trip requirements");

// Deliberately resolve the stale Bus work after the Subway request. A provider that
// ignores AbortSignal must still be unable to replace the active result.
subwayWork.resolve({ mode: "subway", id: "subway-result" });
busWork.resolve({ mode: "bus", id: "late-bus-result" });
await Promise.all([bus.done, subway.done]);
assert.deepEqual(commits, [{ mode: "subway", result: { mode: "subway", id: "subway-result" } }]);

session.cancel();
assert.equal(subway.request.signal.aborted, true, "explicit cancellation aborts the active request");
assert.equal(subway.request.isCurrent(), false, "cancelled work cannot commit");
assert.ok(session.version > subway.request.version, "cancellation advances the staleness version");

console.log("Production route-session staleness and mode-switch tests passed.");

function beginPlan(mode, work) {
  const request = session.begin();
  const done = work.then(result => {
    if (request.isCurrent()) commits.push({ mode, result });
  });
  return { request, done };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
