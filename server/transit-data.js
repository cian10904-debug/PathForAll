// @ts-check
import { readFile } from "node:fs/promises";
import { instant } from "../route-timeline.js";
import { localDateKey, NYC_ZONE, shiftDateKey } from "../agency-time.js";
import { VEHICLE_MODES } from "../transit-modes.js";
import { transitError } from "../transit-errors.js";
import { OTP_VERSION } from "./otp-query.js";

export async function loadTransitManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (
    manifest.schema !== 1 ||
    manifest.otpVersion !== OTP_VERSION ||
    !Number.isFinite(instant(manifest.graphBuiltAt)) ||
    !Array.isArray(manifest.feeds) ||
    !manifest.feeds.length ||
    manifest.feeds.length > 24
  ) {
    throw new Error(
      "Invalid transit manifest or OTP version. Build a graph using the documented bootstrap.",
    );
  }
  const ids = new Set();
  for (const feed of manifest.feeds) {
    if (
      !feed ||
      typeof feed.id !== "string" ||
      !/^[a-z0-9_-]{1,40}$/i.test(feed.id) ||
      ids.has(feed.id) ||
      feed.timeZone !== NYC_ZONE ||
      !Number.isFinite(instant(feed.retrievedAt)) ||
      instant(feed.retrievedAt) > instant(manifest.graphBuiltAt) + 60_000 ||
      !validDate(feed.validFrom) ||
      !validDate(feed.validThrough) ||
      feed.validFrom > feed.validThrough ||
      !/^[a-f0-9]{64}$/.test(feed.sha256 || "") ||
      !Array.isArray(feed.modes) ||
      !feed.modes.length ||
      feed.modes.some((mode) => !VEHICLE_MODES.has(mode))
    ) {
      throw new Error(
        "Invalid provenance or validity in the transit manifest.",
      );
    }
    ids.add(feed.id);
  }
  return manifest;
}

function validDate(value) {
  return typeof value === "string" && instant(value + "T00:00:00Z") != null;
}

export function feedsForTime(
  manifest,
  health,
  when,
  { allowOvernight = false } = {},
) {
  const date = localDateKey(when);
  const earliestDay = allowOvernight ? shiftDateKey(date, -1) : date;
  return manifest.feeds.filter(
    (feed) =>
      health.feeds.has(feed.id) &&
      feed.validFrom <= date &&
      earliestDay <= feed.validThrough,
  );
}

export function assertServiceRange(health, when) {
  if (+when < health.start * 1000 || +when >= health.end * 1000)
    throw transitError("TRANSIT_DATA_STALE");
}

export function itineraryProvenance(manifest, feeds, clock) {
  const oldest = Math.min(...feeds.map((feed) => instant(feed.retrievedAt)));
  const cached = +clock - oldest > 14 * 86_400_000;
  return {
    dataVersion: feeds
      .map((feed) => feed.id + ":" + feed.sha256.slice(0, 12))
      .sort()
      .join(","),
    retrievedAt: new Date(oldest).toISOString(),
    updatedAt: manifest.graphBuiltAt,
    graphBuiltAt: manifest.graphBuiltAt,
    expiresAt: new Date(+clock + 120_000).toISOString(),
    scheduleStatus: cached ? "calendar-valid-cache" : "calendar-valid",
    dataFreshness: "current",
    // Request success is not evidence of when a realtime or facility event was observed.
    observedAt: null,
    receivedAt: clock.toISOString(),
    provenance: {
      engine: "OpenTripPlanner " + OTP_VERSION,
      graphBuiltAt: manifest.graphBuiltAt,
      osm: manifest.osm || null,
      schedules: feeds.map(
        ({
          id,
          version,
          sha256,
          retrievedAt,
          validFrom,
          validThrough,
          timeZone,
        }) => ({
          id,
          version,
          sha256,
          retrievedAt,
          validFrom,
          validThrough,
          timeZone,
        }),
      ),
      realtimeObservedAt: null,
      alertsObservedAt: null,
      elevatorObservedAt: null,
    },
  };
}
