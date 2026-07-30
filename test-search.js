import assert from "node:assert/strict";
import {
  SearchServiceError,
  calculateFinalScore,
  createMapSelection,
  normalizeCoordinate,
  normalizeProviderResult,
  normalizeSearchText,
  rankPlaces,
  reverseGeocodePlace,
  searchPlaces
} from "./geocoding.js";
import { isInsideBounds } from "./osm-network.js";

const boroughPlaces = [
  place("Columbia University", [-73.9626, 40.8075], "university", .94),
  place("Barclays Center", [-73.9754, 40.6827], "stadium", .91),
  place("Flushing Main Street", [-73.8310, 40.7590], "train_station", .84),
  place("Yankee Stadium", [-73.9262, 40.8296], "stadium", .92),
  place("St. George Ferry Terminal", [-74.0736, 40.6437], "ferry_terminal", .93)
];
assert.ok(boroughPlaces.every(item => isInsideBounds(item.coordinates)), "every borough must retain valid NYC results");

const nearbyButUnrelated = place("University Place", [-73.9935, 40.7295], "street", .3);
assert.equal(rankPlaces([nearbyButUnrelated, boroughPlaces[0]], "Columbia University", { center: nearbyButUnrelated.coordinates })[0].name, "Columbia University", "exact relevance must outrank proximity");
assert.equal(rankPlaces([place("Pennsylvania Plaza", [-73.9931, 40.7505], "place", .7), nearbyButUnrelated], "Penn", { center: nearbyButUnrelated.coordinates })[0].name, "Pennsylvania Plaza", "prefix relevance must outrank nearby unrelated results");

const penn = place("New York Penn Station", [-73.9935, 40.7506], "train_station", .99, ["Penn Station", "NYP", "34 St Penn Station"]);
const newark = place("Newark Penn Station", [-74.1724, 40.7347], "train_station", .99, ["Penn Station"]);
assert.equal(rankPlaces([newark, penn], "Penn Station")[0].name, "New York Penn Station", "NYC-only search must not rank Newark Penn Station first");

const jfk = normalizeProviderResult({ geometry: { coordinates: [-73.7794, 40.6429] }, properties: { name: "John F. Kennedy International Airport", category: "aeroway", type: "aerodrome", importance: .59 } });
const jfkParking = place("JFK Airport Employee Parking", [-73.8220, 40.6620], "parking", .2);
assert.equal(rankPlaces([jfkParking, jfk], "JFK Airport")[0].name, "John F. Kennedy International Airport", "the airport complex must outrank airport parking");
const queensCenter = normalizeProviderResult({ geometry: { coordinates: [-73.8700, 40.7346] }, properties: { name: "Queens Center", category: "shop", type: "mall", importance: .31 } });
assert.equal(rankPlaces([place("Tower Auto Mall", [-73.9346, 40.7458], "car", .3), queensCenter], "Queens Center Mall")[0].name, "Queens Center", "mall aliases and categories must strengthen landmark ranking");

assert.equal(normalizeSearchText("34th Street–Penn Station"), "34 street penn station");
assert.equal(normalizeSearchText("Moynihan—Train Hall"), "moynihan train hall");
assert.deepEqual(normalizeCoordinate([-73.9935, 40.7506]), [-73.9935, 40.7506], "coordinates must remain [longitude, latitude]");
assert.deepEqual(normalizeProviderResult({ center: [-73.9857, 40.7580], properties: { name: "Times Square", importance: .9 } }).coordinates, [-73.9857, 40.7580]);
assert.deepEqual(normalizeProviderResult({ lon: -73.7781, lat: 40.6413, name: "JFK Airport" }).coordinates, [-73.7781, 40.6413]);

const brooklynPin = createMapSelection([-73.9442, 40.6782]);
const queensPin = createMapSelection([-73.8310, 40.7590]);
const bronxPin = createMapSelection([-73.9018, 40.8506]);
const statenIslandPin = createMapSelection([-74.1502, 40.5795]);
assert.deepEqual(brooklynPin.coordinates, [-73.9442, 40.6782]);
assert.deepEqual(queensPin.coordinates, [-73.8310, 40.7590]);
assert.deepEqual(bronxPin.coordinates, [-73.9018, 40.8506]);
assert.deepEqual(statenIslandPin.coordinates, [-74.1502, 40.5795]);

await assert.rejects(
  searchPlaces("Penn Station", { fetchImpl: async () => { throw new Error("offline"); } }),
  SearchServiceError,
  "provider failure must not silently return a Cooper Union fallback"
);
assert.equal(await reverseGeocodePlace(brooklynPin.coordinates, { fetchImpl: async () => { throw new Error("offline"); }, silent: true }), null, "reverse-geocoding failure must leave the original map pin untouched");

const staleController = new AbortController();
const staleRequest = searchPlaces("Columbia", {
  signal: staleController.signal,
  fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))))
});
staleController.abort();
await assert.rejects(staleRequest, error => error.name === "AbortError", "cancelled searches must not produce a replacement result");

assert.ok(calculateFinalScore(penn, "Penn Station", [-73.99, 40.729]) > calculateFinalScore(nearbyButUnrelated, "Penn Station", [-73.99, 40.729]));
console.log("All NYC location-search ranking, normalization, selection, and failure tests passed.");

function place(name, coordinates, category, importance, aliases = []) {
  return { id: name.toLowerCase().replaceAll(" ", "-"), name, subtitle: "New York City", coordinates, category, importance, aliases, source: "test" };
}
