"use strict";

import { DEFAULT_BOUNDS, NYC_CENTER, isInsideBounds } from "./osm-network.js";
import { fetchWithPolicy } from "./fetch-client.js";

const PHOTON_ENDPOINT = serviceUrl(import.meta.env?.VITE_GEOCODE_FORWARD_URL) || "https://photon.komoot.io/api/";
const PHOTON_REVERSE_ENDPOINT = serviceUrl(import.meta.env?.VITE_GEOCODE_REVERSE_URL) || "https://photon.komoot.io/reverse";
// Public Nominatim disallows autocomplete. A fallback must be an operator-owned
// endpoint with the documented JSON contract and usage permission.
const NOMINATIM_ENDPOINT = serviceUrl(import.meta.env?.VITE_GEOCODE_FALLBACK_URL);
function serviceUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password
    && !url.search && !url.hash && url.hostname !== "nominatim.openstreetmap.org" ? url.href : null; } catch { return null; }
}
const CACHE_TTL_MS = 120_000;
const MAX_CACHE_ENTRIES = 80;
const cache = new Map();

/** @typedef {{ id: string, name: string, subtitle: string, coordinates: [number, number], category?: string, borough?: string, importance?: number, aliases?: string[], source: string }} LocationResult */

export class SearchServiceError extends Error {
  constructor(message = "Location search is temporarily unavailable.") {
    super(message);
    this.name = "SearchServiceError";
  }
}

export async function searchPlaces(query, options = {}) {
  const text = String(query || "").trim();
  const bounds = options.bounds || DEFAULT_BOUNDS;
  const center = normalizeCoordinate(options.center) || NYC_CENTER;
  if (text.length < 2) return [];

  pruneSearchCache();
  const centerBucket = center.map(value => Math.round(value * 50) / 50).join(",");
  const key = `${normalizeSearchText(text)}:${bounds.west},${bounds.south},${bounds.east},${bounds.north}:${centerBucket}`;
  const cached = cache.get(key);
  let remote;
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    remote = cached.places;
    cache.delete(key);
    cache.set(key, cached);
  } else {
    remote = await fetchForwardPlaces(text, { bounds, center, signal: options.signal, fetchImpl: options.fetchImpl });
    cache.set(key, { places: remote, expiresAt: Date.now() + CACHE_TTL_MS });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  return rankPlaces(dedupePlaces(remote), text, { bounds, center });
}

function pruneSearchCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (!entry || entry.expiresAt <= now) cache.delete(key);
  }
}

export async function reverseGeocodePlace(coordinates, options = {}) {
  const point = normalizeCoordinate(coordinates);
  if (!point || !isInsideBounds(point, options.bounds || DEFAULT_BOUNDS)) return null;
  const [lon, lat] = point;
  const params = new URLSearchParams({ lon: String(lon), lat: String(lat), lang: "en", limit: "1" });
  try {
    const response = await fetchWithPolicy(`${PHOTON_REVERSE_ENDPOINT}?${params.toString()}`, {
      headers: { Accept: "application/geo+json, application/json" },
      signal: options.signal
    }, {
      fetchImpl: options.fetchImpl,
      timeoutMs: 9_000,
      retries: 1,
      source: "Photon reverse geocoding"
    });
    if (!response.ok) throw new Error(`Reverse geocoding failed with ${response.status}`);
    const payload = await response.json();
    const result = normalizeProviderResult(payload.features?.find(Boolean), "Photon / OpenStreetMap reverse geocoding");
    return result && isInsideBounds(result.coordinates, options.bounds || DEFAULT_BOUNDS) ? result : null;
  } catch (error) {
    if (error?.name !== "AbortError" && !options.silent) console.warn("Reverse geocoding unavailable; retaining selected coordinates.", error);
    return null;
  }
}

export function isInsideServiceArea(coordinates, bounds = DEFAULT_BOUNDS) {
  return isInsideBounds(coordinates, bounds);
}

export function createMapSelection(coordinates, label = "Selected location") {
  const point = normalizeCoordinate(coordinates);
  if (!point || !isInsideServiceArea(point)) throw new RangeError("Map selection must be inside New York City.");
  return {
    id: `map-pin-${point[0].toFixed(6)}-${point[1].toFixed(6)}`,
    name: label,
    subtitle: `Map pin · ${point[1].toFixed(5)}, ${point[0].toFixed(5)}`,
    coordinates: point,
    source: "Map selection"
  };
}

export async function fetchForwardPlaces(query, options = {}) {
  const bounds = options.bounds || DEFAULT_BOUNDS;
  const center = normalizeCoordinate(options.center) || NYC_CENTER;
  const params = new URLSearchParams({
    q: query,
    limit: "12",
    lang: "en",
    lon: String(center[0]),
    lat: String(center[1]),
    zoom: "14",
    // A deliberately weak geographic hint; text relevance is calculated client-side.
    location_bias_scale: "0.05",
    bbox: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`
  });
  try {
    const response = await fetchWithPolicy(`${PHOTON_ENDPOINT}?${params.toString()}`, {
      headers: { Accept: "application/geo+json, application/json" },
      signal: options.signal
    }, {
      fetchImpl: options.fetchImpl,
      timeoutMs: 9_000,
      retries: 1,
      source: "Photon place search"
    });
    if (!response.ok) throw new SearchServiceError();
    const payload = await response.json();
    const items = Array.isArray(payload?.features) ? payload.features : (Array.isArray(payload?.results) ? payload.results : []);
    const photonPlaces = items
      .map(item => normalizeProviderResult(item))
      .filter(Boolean)
      .filter(place => isInsideBounds(place.coordinates, bounds));
    if (!NOMINATIM_ENDPOINT || !needsSupplementalSearch(query, photonPlaces) || options.fetchImpl) return photonPlaces;
    const supplemental = await fetchNominatimPlaces(query, { bounds, signal: options.signal });
    return dedupePlaces([...photonPlaces, ...supplemental]);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof SearchServiceError) throw error;
    throw new SearchServiceError();
  }
}

async function fetchNominatimPlaces(query, options) {
  const { bounds, signal } = options;
  const params = new URLSearchParams({
    q: `${query}, New York City`,
    format: "geojson",
    limit: "6",
    bounded: "1",
    viewbox: `${bounds.west},${bounds.north},${bounds.east},${bounds.south}`
  });
  try {
    const response = await fetchWithPolicy(`${NOMINATIM_ENDPOINT}?${params.toString()}`, {
      headers: { Accept: "application/geo+json" },
      signal
    }, {
      timeoutMs: 9_000,
      retries: 0,
      source: "Nominatim place search"
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.features || [])
      .map(item => normalizeProviderResult(item, "Nominatim / OpenStreetMap"))
      .filter(Boolean)
      .filter(place => isInsideBounds(place.coordinates, bounds));
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return [];
  }
}

export function normalizeProviderResult(item, source = "Photon / OpenStreetMap") {
  if (!item || typeof item !== "object") return null;
  const properties = item.properties || item;
  const coordinates = normalizeCoordinate(item.center || item.geometry?.coordinates || item.coordinates || [item.lon, item.lat]);
  if (!coordinates) return null;
  const name = cleanText(properties.name || properties.label || properties.title || properties.street || properties.address?.name || "");
  if (!name) return null;
  const subtitle = cleanText(properties.subtitle || properties.display_name || (typeof properties.address === "string" ? properties.address : "") || buildSubtitle(properties) || "New York City");
  const category = cleanText([properties.category, properties.osm_value, properties.type, properties.kind].filter(Boolean).join(" "));
  const aliases = aliasesFor(name, properties.aliases || properties.alt_name || properties.old_name || properties.short_name, category);
  return {
    id: cleanText(String(properties.id || `${properties.osm_type || properties.type || "place"}-${properties.osm_id || properties.place_id || coordinates.join(",")}`)),
    name,
    subtitle,
    coordinates,
    category: category || undefined,
    borough: cleanText(properties.borough || properties.district || "") || undefined,
    importance: clamp(Number(properties.importance ?? properties.rank ?? properties.score ?? 0), 0, 1),
    aliases,
    source
  };
}

export function rankPlaces(places, query, options = {}) {
  const bounds = options.bounds || DEFAULT_BOUNDS;
  const center = normalizeCoordinate(options.center) || NYC_CENTER;
  return dedupePlaces((places || [])
    .filter(place => isInsideBounds(place.coordinates, bounds))
    .map(place => ({ place, score: calculateFinalScore(place, query, center, bounds) }))
    .sort((a, b) => b.score - a.score || a.place.name.localeCompare(b.place.name))
    .map(item => item.place));
}

export function calculateFinalScore(place, query, proximity = NYC_CENTER, bounds = DEFAULT_BOUNDS) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return clamp(Number(place.importance || 0), 0, 1);
  const name = normalizeSearchText(place.name);
  const subtitle = normalizeSearchText(place.subtitle || "");
  const aliases = (place.aliases || []).map(normalizeSearchText);
  const allText = [name, subtitle, ...aliases].filter(Boolean).join(" ");
  const exactMatch = [name, ...aliases].includes(normalizedQuery) ? 1 : 0;
  const prefixMatch = [name, ...aliases].some(value => value.startsWith(normalizedQuery)) ? 1 : 0;
  const textRelevance = calculateTextRelevance(allText, normalizedQuery);
  const providerImportance = clamp(Number(place.importance || 0), 0, 1);
  const insideNYC = isInsideBounds(place.coordinates, bounds) ? 1 : 0;
  const proximityScore = calculateProximityScore(place.coordinates, proximity);
  const stationComplexBonus = /penn station|moynihan|nyp/.test(allText) && /penn/.test(normalizedQuery) ? .08 : 0;
  const categoryBonus = categoryIntentScore(place.category, normalizedQuery) * .12;
  const entrancePenalty = /entrance|platform/.test(`${place.category || ""} ${allText}`) && !/entrance|platform/.test(normalizedQuery) ? .08 : 0;
  return exactMatch * .30 + prefixMatch * .20 + textRelevance * .25 + providerImportance * .10 + insideNYC * .10 + proximityScore * .05 + stationComplexBonus + categoryBonus - entrancePenalty;
}

export function calculateTextRelevance(text, query) {
  const haystack = normalizeSearchText(text);
  const needle = normalizeSearchText(query);
  if (!needle || !haystack) return 0;
  if (haystack === needle) return 1;
  if (haystack.startsWith(needle)) return .92;
  if (haystack.includes(needle)) return .78;
  const queryTokens = new Set(needle.split(" ").filter(Boolean));
  const textTokens = new Set(haystack.split(" ").filter(Boolean));
  let matches = 0;
  for (const token of queryTokens) {
    if ([...textTokens].some(candidate => candidate === token || candidate.startsWith(token) || token.startsWith(candidate))) matches += 1;
  }
  return queryTokens.size ? matches / queryTokens.size * .7 : 0;
}

export function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[–—−-]/g, " ")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\b(st|street)\b/g, " street ")
    .replace(/\b(ave|avenue)\b/g, " avenue ")
    .replace(/\b(blvd|boulevard)\b/g, " boulevard ")
    .replace(/\b(rd|road)\b/g, " road ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCoordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null;
}

function buildSubtitle(properties) {
  return [properties.housenumber, properties.street, properties.district, properties.city, properties.state]
    .filter(Boolean).join(", ");
}

function aliasesFor(name, value, category = "") {
  const aliases = Array.isArray(value) ? value : String(value || "").split(/[;,|]/);
  const penn = /penn|moynihan|nyp|34\s*(st|street).*penn/i.test(name) || aliases.some(alias => /penn|moynihan|nyp/i.test(alias));
  if (penn) aliases.push("Penn Station", "New York Penn Station", "Pennsylvania Station", "Moynihan Train Hall", "NYP", "34 St Penn Station", "34th Street Penn Station");
  if (/john f\.? kennedy/i.test(name)) aliases.push("JFK", "JFK Airport", "John F Kennedy Airport");
  if (/queens center/i.test(name) && /mall/.test(category)) aliases.push("Queens Center Mall");
  return [...new Set(aliases.map(cleanText).filter(Boolean))].slice(0, 12);
}

function needsSupplementalSearch(query, places) {
  const normalized = normalizeSearchText(query);
  const strongest = Math.max(0, ...(places || []).map(place => calculateTextRelevance(`${place.name} ${place.subtitle} ${(place.aliases || []).join(" ")}`, normalized)));
  const requiresPlaceCategory = /airport|mall|museum|zoo|garden|stadium|terminal|university|hospital/.test(normalized);
  const hasMatchingCategory = (places || []).some(place => categoryIntentScore(place.category, normalized) > .5);
  return strongest < .78 || (requiresPlaceCategory && !hasMatchingCategory);
}

function categoryIntentScore(category, query) {
  const text = normalizeSearchText(category || "");
  if (/airport/.test(query)) return /aerodrome|airport|aeroway/.test(text) ? 1 : 0;
  if (/mall/.test(query)) return /mall|shopping/.test(text) ? 1 : 0;
  if (/ferry|terminal/.test(query)) return /ferry|terminal|harbour|port/.test(text) ? 1 : 0;
  if (/stadium/.test(query)) return /stadium|sports/.test(text) ? 1 : 0;
  if (/museum/.test(query)) return /museum/.test(text) ? 1 : 0;
  if (/zoo/.test(query)) return /zoo/.test(text) ? 1 : 0;
  if (/garden/.test(query)) return /garden|park/.test(text) ? 1 : 0;
  if (/university|college/.test(query)) return /university|college|school/.test(text) ? 1 : 0;
  if (/hospital/.test(query)) return /hospital|clinic/.test(text) ? 1 : 0;
  return 0;
}

function calculateProximityScore(coordinates, proximity) {
  const point = normalizeCoordinate(coordinates);
  const center = normalizeCoordinate(proximity);
  if (!point || !center) return .5;
  const lonScale = Math.cos(((point[1] + center[1]) / 2) * Math.PI / 180);
  const dx = (point[0] - center[0]) * lonScale;
  const dy = point[1] - center[1];
  const km = Math.sqrt(dx * dx + dy * dy) * 111.32;
  return 1 / (1 + km / 8);
}

function dedupePlaces(places) {
  const seen = new Set();
  return places.filter(place => {
    const key = `${normalizeSearchText(place.name)}-${place.coordinates.map(value => value.toFixed(4)).join("-")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 180);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}
