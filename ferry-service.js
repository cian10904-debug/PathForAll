"use strict";

import { haversineMeters } from "./osm-network.js";

export const FERRY_OPERATOR = "Statue City Cruises";
export const FERRY_SCHEDULE_URL = "https://www.cityexperiences.com/new-york/city-cruises/statue/";
export const FERRY_POLICY_SOURCE = "National Park Service transportation guidance";
export const FERRY_POLICY_REVIEWED_AT = "2026-07-29";

export const FERRY_TERMINALS = Object.freeze([
  Object.freeze({
    id: "statue-city-cruises:terminal:battery",
    terminalId: "statue-city-cruises:terminal:battery",
    name: "The Battery ferry terminal",
    subtitle: "Castle Clinton, The Battery, Manhattan",
    coordinates: Object.freeze([-74.0169, 40.7034]),
    operator: FERRY_OPERATOR,
    metadataSource: FERRY_POLICY_SOURCE,
    metadataReviewedAt: FERRY_POLICY_REVIEWED_AT,
    region: "nyc",
    securityScreeningRequired: true,
    ticketRequired: true
  }),
  Object.freeze({
    id: "statue-city-cruises:terminal:liberty-state-park",
    terminalId: "statue-city-cruises:terminal:liberty-state-park",
    name: "Liberty State Park ferry terminal",
    subtitle: "Central Railroad of New Jersey Terminal, Jersey City",
    coordinates: Object.freeze([-74.0553, 40.7037]),
    operator: FERRY_OPERATOR,
    metadataSource: FERRY_POLICY_SOURCE,
    metadataReviewedAt: FERRY_POLICY_REVIEWED_AT,
    region: "new-jersey",
    securityScreeningRequired: true,
    ticketRequired: true
  })
]);

export const FERRY_DESTINATIONS = Object.freeze([
  Object.freeze({
    id: "statue-city-cruises:dock:liberty-island",
    dockId: "statue-city-cruises:dock:liberty-island",
    kind: "liberty-island",
    name: "Liberty Island",
    coordinates: Object.freeze([-74.0450, 40.6897]),
    providerIds: Object.freeze([
      "statue-city-cruises:dock:liberty-island",
      "nps:place:liberty-island"
    ]),
    // Small land-focused geofence. It prevents a map pin on the island from
    // being treated as walkable from Manhattan without classifying the harbor.
    geofence: Object.freeze([
      Object.freeze([-74.0492, 40.6880]),
      Object.freeze([-74.0478, 40.6869]),
      Object.freeze([-74.0430, 40.6870]),
      Object.freeze([-74.0418, 40.6894]),
      Object.freeze([-74.0430, 40.6921]),
      Object.freeze([-74.0476, 40.6919])
    ]),
    metadataSource: FERRY_POLICY_SOURCE,
    metadataReviewedAt: FERRY_POLICY_REVIEWED_AT,
    aliases: Object.freeze([
      "statue of liberty",
      "liberty island",
      "statue of liberty national monument",
      "statue of liberty museum"
    ])
  }),
  Object.freeze({
    id: "statue-city-cruises:dock:ellis-island",
    dockId: "statue-city-cruises:dock:ellis-island",
    kind: "ellis-island",
    name: "Ellis Island",
    coordinates: Object.freeze([-74.0396, 40.6995]),
    providerIds: Object.freeze([
      "statue-city-cruises:dock:ellis-island",
      "nps:place:ellis-island"
    ]),
    geofence: Object.freeze([
      Object.freeze([-74.0438, 40.6970]),
      Object.freeze([-74.0408, 40.6962]),
      Object.freeze([-74.0362, 40.6980]),
      Object.freeze([-74.0360, 40.7008]),
      Object.freeze([-74.0390, 40.7020]),
      Object.freeze([-74.0430, 40.7007])
    ]),
    metadataSource: FERRY_POLICY_SOURCE,
    metadataReviewedAt: FERRY_POLICY_REVIEWED_AT,
    aliases: Object.freeze([
      "ellis island",
      "ellis island national museum of immigration",
      "national museum of immigration"
    ])
  })
]);

export const FERRY_ACCESSIBILITY_WARNINGS = Object.freeze([
  "Security screening is required before boarding.",
  "Ticket and reservation requirements apply.",
  "Confirm current gangway assistance and vessel accessibility with Statue City Cruises.",
  "Upper decks may require stairs.",
  "Onboard restroom accessibility may vary by vessel."
]);

export function resolveFerryDestination(place) {
  const identifiers = [
    place?.id,
    place?.providerId,
    place?.dockId,
    place?.destinationId
  ].map(value => String(value || "").toLowerCase()).filter(Boolean);
  const identifierMatch = FERRY_DESTINATIONS.find(destination =>
    destination.providerIds.some(id => identifiers.includes(id.toLowerCase()))
  );
  if (identifierMatch) return identifierMatch;
  if (validCoordinates(place?.coordinates)) {
    const geofenceMatch = FERRY_DESTINATIONS.find(destination => pointInPolygon(place.coordinates, destination.geofence));
    if (geofenceMatch) return geofenceMatch;
  }
  const text = normalizeText([place?.name, place?.subtitle, place?.label].filter(Boolean).join(" "));
  if (!text) return null;
  return FERRY_DESTINATIONS.find(destination => destination.aliases.some(alias => text.includes(alias))) || null;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  const [x, y] = point;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [xi, yi] = polygon[index];
    const [xj, yj] = polygon[previous];
    const intersects = ((yi > y) !== (yj > y))
      && x < (xj - xi) * (y - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function validCoordinates(value) {
  return Array.isArray(value)
    && Number.isFinite(value[0])
    && Number.isFinite(value[1])
    && Math.abs(value[0]) <= 180
    && Math.abs(value[1]) <= 90;
}

export function isFerryRequiredDestination(place) {
  return Boolean(resolveFerryDestination(place));
}

export function rankFerryTerminals(startPlace) {
  const start = startPlace?.coordinates;
  if (!Array.isArray(start)) return [...FERRY_TERMINALS];
  return [...FERRY_TERMINALS].sort((a, b) => haversineMeters(start, a.coordinates) - haversineMeters(start, b.coordinates));
}

export function ferryUnavailableMessage(destination) {
  const name = destination?.name || "this island destination";
  return `${name} requires ${FERRY_OPERATOR}. Check the current schedule and ticket availability; detailed ferry routing is unavailable until a connected provider supplies an itinerary.`;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
