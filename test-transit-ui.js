"use strict";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, css, app] = await Promise.all([
  readFile("index.html", "utf8"),
  readFile("styles.css", "utf8"),
  readFile("app.js", "utf8")
]);

for (const mode of ["walk", "bus", "subway", "ferry", "mixed"]) {
  assert.match(html, new RegExp(`data-mode="${mode}"`), `${mode} has a mode control`);
}
assert.match(css, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/, "all five modes share the responsive row");
assert.match(html, /class="mode-row"[^>]*aria-describedby="transitModeAvailability"/, "mode availability guidance describes the travel-mode group");
assert.match(html, /Route line legend/);
assert.match(html, />Ferry</);
assert.match(app, /selected-ferry/);
assert.match(app, /\["selected-walk", "selected-bus", "selected-subway", "selected-ferry"\]/, "all map layers are cleared together");
assert.equal((app.match(/new maplibregl\.Map/g) || []).length, 1, "the application initializes one map");
assert.doesNotMatch(html, /Checking elevator information/, "provider status does not claim an elevator check that is not occurring");
assert.match(css, /\.bottom-nav\s*\{[^}]*position:\s*fixed/s, "primary navigation remains fixed at the bottom");

assert.match(html, /id="transitDataSummary"[^>]*role="status"[^>]*>Transit services are not connected</, "the initial summary accurately reports disconnected services");
assert.match(html, /id="transitDataDetail"[^>]*>Walk remains available using OpenStreetMap pedestrian data\.</, "the summary explains that OSM walking remains available");
assert.match(html, /id="transitConnectionBadge"[^>]*>Not configured</, "the connection badge uses an allowed visible status");
assert.match(html, /id="checkTransitConnectionsButton"[^>]*aria-controls="transitConnectionList"[^>]*>Check connections</, "the connection check is accurately labelled");
assert.match(html, /id="transitConnectionList"[^>]*class="transit-connection-list"/, "the service statuses are exposed as one semantic list");
assert.match(html, /id="transitModeAvailability"/, "configuration-required mode guidance is present");

const connectionRows = [
  ["route-provider", "Route provider"],
  ["transit-network", "Transit network and schedules"],
  ["realtime-arrivals", "Realtime arrivals"],
  ["elevator-accessibility", "Elevator accessibility paths"],
  ["ferry-schedules", "Ferry schedules"]
];
for (const [connection, label] of connectionRows) {
  const rowPattern = new RegExp(`data-transit-connection="${connection}"[\\s\\S]*?${label}[\\s\\S]*?data-connection-status[^>]*data-status="not-configured"[^>]*>Not configured<`);
  assert.match(html, rowPattern, `${label} has its own visible initial status`);
}
assert.equal((html.match(/data-transit-connection=/g) || []).length, 5, "exactly five transit connection rows are rendered");
assert.equal((html.match(/data-connection-meta/g) || []).length, 5, "every connection row can display source and update metadata");

assert.match(html, /id="transitDiagnostics"[^>]*hidden/, "development diagnostics are hidden by default");
assert.match(html, /id="copyTransitDiagnosticsButton"[^>]*>Copy diagnostics</, "development diagnostics include a Copy button");
assert.match(html, /id="copyTransitDiagnosticsStatus"[^>]*role="status"/, "copy feedback is available to assistive technology");
assert.match(
  app,
  /(?:transitDiagnostics[\s\S]{0,300}import\.meta\.env\??\.DEV|import\.meta\.env\??\.DEV[\s\S]{0,300}transitDiagnostics)/,
  "diagnostics are revealed only through the Vite development-mode gate"
);

assert.doesNotMatch(html, />\s*Refresh\s*</, "the connection button never implies that it downloads agency data");
assert.doesNotMatch(html, /Elevator status unavailable\s*·\s*Ferry schedules require provider confirmation/, "the legacy combined status is removed");
assert.doesNotMatch(
  html,
  /(?:elevatorDataStatus|elevatorDataDetail|elevatorBadge|refreshElevatorButton)/,
  "legacy elevator-specific status IDs are removed"
);
assert.match(app, /async function refreshTransitCapabilities\(/, "capability checks use the accurate function name");
assert.doesNotMatch(app, /refreshElevatorData/, "the old elevator-download function name is absent");
assert.match(css, /\.transit-connection-list\s*\{/, "connection rows have dedicated responsive styling");
assert.match(css, /\[data-status="connected"\]/, "connection state styling supports the allowed Connected status");
assert.match(css, /\[data-status="stale"\]/, "connection state styling supports the allowed Stale status");

console.log("Production transit and Ferry UI contract tests passed.");
