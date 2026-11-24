// @ts-check
import { createHash } from "node:crypto";
import { haversineMeters } from "../osm-network.js";
import { coordinate, normalizeRouteOption } from "../route-model.js";
import { inspectTimeline, instant } from "../route-timeline.js";
import { VEHICLE_MODES } from "../transit-modes.js";
import { transitError } from "../transit-errors.js";
import {
  BOARD_SECONDS,
  routeModeFromOtp,
  TRANSFER_SECONDS,
} from "./otp-query.js";

const safeString = (value) =>
  typeof value === "string"
    ? Array.from(value.slice(0, 240), (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          ? " "
          : character,
      ).join("")
    : undefined;
const toIso = (ms) => new Date(ms).toISOString();
const epoch = (value) => instant(value);
const contract = (message) =>
  transitError("PROVIDER_CONTRACT_ERROR", { reasons: [message] });

function location(place) {
  const coords = coordinate([place?.lon, place?.lat]);
  if (!coords)
    throw contract("A route contains an invalid stop or walking endpoint.");
  return {
    id: safeString(place.stop?.gtfsId),
    name: safeString(place.name),
    coordinates: coords,
  };
}

function boardingEvidence(...states) {
  const no = (v) =>
    v === "NOT_POSSIBLE" ||
    v === "NOT_ACCESSIBLE" ||
    v === "NOT_ALLOWED" ||
    v === false ||
    v === 2;
  const yes = (v) =>
    v === "POSSIBLE" || v === "ACCESSIBLE" || v === true || v === 1;
  return states.some(no) ? false : states.every(yes) ? true : "unknown";
}

export function normalizeOtpItinerary(
  itinerary,
  request,
  metadata,
  allowedModes,
  { now = Date.now(), activeFeeds = [] } = {},
) {
  const inputLegs = itinerary?.legs;
  if (!Array.isArray(inputLegs) || !inputLegs.length || inputLegs.length > 25)
    throw contract("The itinerary has an invalid number of legs.");
  let previousVehicle = false;
  const warnings = new Set();
  const endpointConnections = {};
  const snapEndpoint = (label, place, point) => {
    const selected = request[label];
    const gap = haversineMeters(selected, point);
    if (gap <= 3) return;
    if (gap > 35 || haversineMeters(selected, place.coordinates) > 3) {
      throw transitError("ENDPOINT_CONNECTOR_UNAVAILABLE", {
        reasons: ["The walking route does not reach the selected location."],
      });
    }
    if (
      request.needs.unknownPolicy !== "allow" &&
      (request.needs.wheelchairMode ||
        request.needs.avoidStairs ||
        request.needs.requireCurb ||
        request.needs.requireSmooth ||
        request.needs.requireElevator ||
        [
          request.needs.maxSlope,
          request.needs.maxUphillSlope,
          request.needs.maxDownhillSlope,
        ].some(Number.isFinite))
    ) {
      throw transitError("INSUFFICIENT_ACCESSIBILITY_EVIDENCE", {
        reasons: [
          "The path between the selected place and the mapped access point is unknown.",
        ],
      });
    }
    endpointConnections[label] = {
      selectedCoordinates: selected,
      accessPointCoordinates: point,
      connectorStatus: "estimated",
      connectorGeometry: null,
      connectorDistanceMeters: gap,
      connectorSource: "OpenTripPlanner street graph projection",
    };
    place.coordinates = point;
    warnings.add(
      "The mapped " +
        (label === "start" ? "start" : "end") +
        " is " +
        Math.round(gap) +
        " m from your selected point. Travel time does not include this unverified connection.",
    );
  };
  const legs = inputLegs.map((raw, index) => {
    const mode = routeModeFromOtp(raw?.mode);
    if (!mode || (mode !== "walk" && !allowedModes.includes(mode)))
      throw contract("An itinerary used a mode outside the configured search.");
    const vehicle = VEHICLE_MODES.has(mode);
    const from = location(raw.from),
      to = location(raw.to);
    const scheduledFrom = epoch(raw.start?.scheduledTime),
      scheduledTo = epoch(raw.end?.scheduledTime);
    const start = raw.start?.estimated
      ? epoch(raw.start.estimated.time)
      : scheduledFrom;
    const end = raw.end?.estimated
      ? epoch(raw.end.estimated.time)
      : scheduledTo;
    const isEstimate = Boolean(raw.start?.estimated || raw.end?.estimated);
    if (
      start == null ||
      end == null ||
      scheduledFrom == null ||
      scheduledTo == null ||
      !Number.isFinite(raw.duration) ||
      !Number.isFinite(raw.distance) ||
      raw.distance < 0
    )
      throw contract("The itinerary has missing times or distances.");
    if (vehicle && raw.realtimeState === "CANCELED")
      throw transitError("TRIP_CANCELLED");
    if (
      vehicle &&
      (!from.id ||
        !to.id ||
        !safeString(raw.trip?.gtfsId) ||
        !safeString(raw.route?.gtfsId))
    )
      throw contract(
        "A vehicle leg is missing its trip, route, or stop identity.",
      );
    const serviceDay =
      typeof raw.serviceDate === "string"
        ? raw.serviceDate.replaceAll("-", "")
        : "";
    if (vehicle && activeFeeds.length) {
      const feedId = raw.trip.gtfsId.split(":")[0];
      const feed = activeFeeds.find(
        (item) => item.id === feedId && item.modes.includes(mode),
      );
      const day = serviceDay.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      if (
        !feed ||
        !/^\d{8}$/.test(serviceDay) ||
        day < feed.validFrom ||
        day > feed.validThrough
      )
        throw transitError("TRANSIT_DATA_STALE", {
          reasons: ["A trip lies outside its identified feed calendar."],
        });
    }
    const fromSequence = raw.from?.stopPosition?.position;
    const toSequence = raw.to?.stopPosition?.position;
    if (
      vehicle &&
      fromSequence != null &&
      toSequence != null &&
      !(fromSequence < toSequence)
    )
      throw contract("The boarding and alighting stops are out of sequence.");
    let decoded =
      raw.legGeometry?.points == null
        ? null
        : decodePolyline(raw.legGeometry.points);
    if (raw.legGeometry?.points != null && !decoded)
      throw contract("A route contains malformed provider geometry.");
    if (!vehicle && raw.distance > 1 && !decoded)
      throw transitError("ENDPOINT_CONNECTOR_UNAVAILABLE");
    if (decoded && !vehicle) {
      if (index === 0 && !raw.from?.stop)
        snapEndpoint("start", from, decoded[0]);
      if (index === inputLegs.length - 1 && !raw.to?.stop)
        snapEndpoint("end", to, decoded.at(-1));
      if (
        haversineMeters(from.coordinates, decoded[0]) > 25 ||
        haversineMeters(to.coordinates, decoded.at(-1)) > 25
      )
        throw transitError("ENDPOINT_CONNECTOR_UNAVAILABLE", {
          reasons: [
            "Walking geometry does not reach its boarding or exit location.",
          ],
        });
    } else if (
      decoded &&
      (haversineMeters(from.coordinates, decoded[0]) > 25 ||
        haversineMeters(to.coordinates, decoded.at(-1)) > 25)
    ) {
      // A valid scheduled ride can have a provider shape that ends elsewhere
      // on a long platform. Keep the trip and stops; do not draw the mismatched shape.
      decoded = null;
      warnings.add(
        "One vehicle shape does not align with its stops and is omitted from the map.",
      );
    }
    if (isEstimate)
      warnings.add(
        "OTP supplied estimated times. The observation timestamp was not available.",
      );
    for (const alert of Array.isArray(raw.alerts)
      ? raw.alerts.slice(0, 6)
      : []) {
      if (
        Number.isFinite(alert?.effectiveEndDate) &&
        alert.effectiveEndDate * 1000 < start
      )
        continue;
      if (
        Number.isFinite(alert?.effectiveStartDate) &&
        alert.effectiveStartDate * 1000 > end
      )
        continue;
      if (alert?.alertEffect === "NO_SERVICE")
        throw transitError("TRIP_CANCELLED");
      const title = safeString(
        alert?.alertHeaderText || alert?.alertDescriptionText,
      );
      if (title) warnings.add("Service alert: " + title);
    }
    const result = {
      id: "leg-" + index,
      mode:
        mode === "walk" &&
        previousVehicle &&
        inputLegs
          .slice(index + 1)
          .some((l) => VEHICLE_MODES.has(routeModeFromOtp(l?.mode)))
          ? "transfer"
          : mode,
      from,
      to,
      durationSeconds: raw.duration,
      distanceMeters: raw.distance,
      waitSeconds: 0,
      departureTime: toIso(start),
      arrivalTime: toIso(end),
      scheduledDepartureTime: toIso(scheduledFrom),
      scheduledArrivalTime: toIso(scheduledTo),
      routeId: safeString(raw.route?.gtfsId),
      routeName: safeString(raw.route?.shortName || raw.route?.longName),
      tripId: safeString(raw.trip?.gtfsId),
      directionId: safeString(raw.trip?.directionId),
      headsign: safeString(raw.headsign),
      serviceDate: serviceDay,
      fromSequence,
      toSequence,
      staySeated: raw.interlineWithPreviousLeg === true,
      minimumBoardingSeconds: vehicle ? BOARD_SECONDS : 0,
      minimumTransferSeconds: vehicle ? TRANSFER_SECONDS : 0,
      geometry: decoded ? { type: "LineString", coordinates: decoded } : null,
      stopCount: Array.isArray(raw.stopCalls)
        ? Math.max(0, raw.stopCalls.length - 1)
        : undefined,
      accessibility: vehicle
        ? {
            wheelchairAccessible: boardingEvidence(
              raw.trip?.wheelchairAccessible,
              raw.from?.stop?.wheelchairBoarding,
              raw.to?.stop?.wheelchairBoarding,
            ),
            vehicleWheelchairAccessible: boardingEvidence(
              raw.trip?.wheelchairAccessible,
            ),
            boardingAccessible: boardingEvidence(
              raw.from?.stop?.wheelchairBoarding,
            ),
            exitAccessible: boardingEvidence(raw.to?.stop?.wheelchairBoarding),
            boardingCurb: null,
            exitCurb: null,
          }
        : {
            // Street geometry proves a connection, not curb, grade, stairs, or sidewalk condition.
            crossingsUnknown: true,
          },
      scheduleSource: vehicle ? "OpenTripPlanner timetable" : undefined,
      scheduleUpdatedAt: metadata.updatedAt,
      scheduleStatus: vehicle ? "verified" : undefined,
      scheduleFreshness: metadata.dataFreshness,
      waitSource: isEstimate ? "realtime" : "scheduled",
    };
    previousVehicle ||= vehicle;
    return result;
  });
  const timeline = inspectTimeline(legs, {
    required: true,
    departedAt: request.departureTime,
    deriveWaits: true,
  });
  if (timeline.issues.length) {
    const missed = timeline.issues.every((reason) =>
      /traveler can reach|minimum boarding or transfer/.test(reason),
    );
    throw transitError(
      missed ? "NO_VALID_TRANSFER" : "PROVIDER_CONTRACT_ERROR",
      { reasons: timeline.issues },
    );
  }
  if (metadata.scheduleStatus === "calendar-valid-cache")
    warnings.add(
      "A cached timetable is in use. Its service dates cover these trips.",
    );
  if (legs.some((leg) => leg.mode === "walk" || leg.mode === "transfer"))
    warnings.add(
      "Walking connections are mapped by OTP. Surface, grade, curbs, and step-free access may be unknown.",
    );
  if (legs.some((leg) => ["subway", "rail"].includes(leg.mode)))
    warnings.add(
      "Complete station access paths and current elevator status are not connected.",
    );
  const id = createHash("sha256")
    .update(
      JSON.stringify(
        legs.map((leg) => [
          leg.mode,
          leg.tripId,
          leg.from.id || leg.from.coordinates,
          leg.to.id || leg.to.coordinates,
          leg.departureTime,
        ]),
      ),
    )
    .digest("hex")
    .slice(0, 20);
  /** @type {Error | null} */
  let rejected = null;
  const route = normalizeRouteOption(
    {
      ...metadata,
      id: "otp-" + id,
      requestedMode: request.mode,
      legs: timeline.legs,
      endpointConnections,
      warnings: [...warnings],
      dataSource: "OpenTripPlanner with agency GTFS and OpenStreetMap",
    },
    {
      start: request.start,
      end: request.end,
      needs: request.needs,
      requestedMode: request.mode,
      departureTime: request.departureTime,
      requireTimeline: true,
      now,
      onInvalid(reasons, codes) {
        rejected = transitError(codes[0] || "PROVIDER_CONTRACT_ERROR", {
          reasons,
          codes,
        });
      },
    },
  );
  if (!route)
    throw (
      rejected || contract("The itinerary does not satisfy the route contract.")
    );
  return route;
}

/** Google encoded polylines are delta encoded in latitude, then longitude. */
export function decodePolyline(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 500_000)
    return null;
  let i = 0,
    lat = 0,
    lon = 0;
  const points = [];
  const delta = () => {
    let encoded = 0;
    for (let shift = 0; shift <= 30 && i < value.length; shift += 5) {
      const next = value.charCodeAt(i++) - 63;
      if (next < 0 || next > 63) return null;
      encoded += (next & 31) * 2 ** shift;
      if (next < 32)
        return encoded % 2 ? -(Math.floor(encoded / 2) + 1) : encoded / 2;
    }
    return null;
  };
  while (i < value.length && points.length < 60_000) {
    const dy = delta(),
      dx = delta();
    if (dy == null || dx == null) return null;
    lat += dy;
    lon += dx;
    const point = coordinate([lon / 100_000, lat / 100_000]);
    if (!point) return null;
    points.push(point);
  }
  return i === value.length && points.length >= 2 ? points : null;
}
