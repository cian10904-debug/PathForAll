"use strict";

import { APP_VERSION } from "./app-version.js";
import { appStorage, reportStorageError } from "./storage-adapter.js";

const PILOT_KEY = "pathforall-v7-pilot-events";

export function loadPilotEvents() {
  const value = appStorage.readJson(PILOT_KEY, [], { version: 2 });
  return Array.isArray(value) ? value : [];
}

export function recordPilotEvent(type, details = {}) {
  const events = loadPilotEvents();
  const event = {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    type,
    at: new Date().toISOString(),
    details: sanitize(details)
  };
  events.push(event);
  const trimmed = events.slice(-1000);
  try {
    appStorage.writeJson(PILOT_KEY, trimmed, { version: 2 });
  } catch (error) {
    if (!reportStorageError(error)) throw error;
  }
  return event;
}

export function pilotMetrics(events = loadPilotEvents()) {
  const count = type => events.filter(event => event.type === type).length;
  const completed = count("navigation_completed");
  const started = count("navigation_started");
  return {
    routesPlanned: count("routes_planned"),
    navigationStarted: started,
    navigationCompleted: completed,
    completionRate: started ? completed / started : 0,
    reroutes: count("automatic_reroute"),
    segmentReviews: count("segment_review"),
    barriersFound: events.filter(event => event.type === "segment_review" && event.details?.status === "barrier").length,
    searches: count("place_selected"),
    totalEvents: events.length
  };
}

export function exportPilotPayload(extra = {}) {
  const events = loadPilotEvents();
  return {
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    metrics: pilotMetrics(events),
    events,
    ...sanitize(extra)
  };
}

export function clearPilotEvents() {
  appStorage.remove(PILOT_KEY);
}

function sanitize(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}
