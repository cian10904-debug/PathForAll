"use strict";

import express from "express";
import cors from "cors";
import polyline from "@mapbox/polyline";

const app = express();

const PORT = Number(process.env.PORT || 8787);
const OTP_URL =
  process.env.OTP_URL ||
  "http://localhost:8080/otp/gtfs/v1";

const SUPPORTED_MODES = new Set([
  "bus",
  "subway",
  "mixed"
]);

app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]
}));

app.use(express.json({
  limit: "100kb"
}));

app.get("/api/capabilities", async (_request, response) => {
  const checkedAt = new Date().toISOString();

  try {
    const otpResponse = await fetch(OTP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: "query HealthCheck { __typename }"
      })
    });

    const payload = await otpResponse.json();

    if (
      !otpResponse.ok ||
      Array.isArray(payload.errors)
    ) {
      throw new Error("OpenTripPlanner is unavailable.");
    }

    response.json({
      available: true,
      modes: ["bus", "subway", "mixed"],
      realtimeArrivals: false,
      elevatorStatus: false,
      elevatorAccessibilityPaths: false,
      ferrySchedules: false,
      source: "Local OpenTripPlanner",
      checked: true,
      connectionStatus: "connected",
      freshness: "current",
      updatedAt: checkedAt
    });
  } catch (error) {
    response.status(503).json({
      available: false,
      modes: [],
      realtimeArrivals: false,
      elevatorStatus: false,
      elevatorAccessibilityPaths: false,
      ferrySchedules: false,
      source: "Local OpenTripPlanner",
      checked: true,
      connectionStatus: "unavailable",
      freshness: "unknown",
      updatedAt: checkedAt,
      message: error.message
    });
  }
});

app.post("/api/routes", async (request, response) => {
  try {
    const {
      start,
      end,
      needs = {},
      mode
    } = request.body || {};

    validateCoordinates(start, "start");
    validateCoordinates(end, "end");

    if (!SUPPORTED_MODES.has(mode)) {
      return response.status(400).json({
        code: "UNSUPPORTED_MODE",
        message: `Unsupported transit mode: ${mode}`
      });
    }

    const dateTime = new Date();

    const otpPayload = await requestOtpPlan({
      start,
      end,
      needs,
      mode,
      departureTime: dateTime
    });

    const rawItineraries =
      otpPayload?.data?.plan?.itineraries || [];

    const routes = rawItineraries
      .map((itinerary, index) =>
        normalizeOtpItinerary(
          itinerary,
          index,
          mode
        )
      )
      .filter(Boolean);

    if (!routes.length) {
      return response.status(404).json({
        code: "NO_SERVICE_AT_THIS_TIME",
        message:
          "No matching accessible transit itinerary was found.",
        routingErrors:
          otpPayload?.data?.plan?.routingErrors || []
      });
    }

    const updatedAt = new Date().toISOString();

    response.json({
      routes,
      dataVersion: "local-otp-mta-static",
      dataFreshness: "current",
      updatedAt,
      expiresAt: new Date(
        Date.now() + 10 * 60 * 1000
      ).toISOString()
    });
  } catch (error) {
    console.error(error);

    response.status(
      error.statusCode || 500
    ).json({
      code:
        error.code ||
        "TRANSIT_PROVIDER_UNAVAILABLE",
      message:
        error.message ||
        "Transit routing is unavailable."
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `PathForAll transit server running at http://localhost:${PORT}`
  );
});

async function requestOtpPlan({
  start,
  end,
  needs,
  mode,
  departureTime
}) {
  const [startLongitude, startLatitude] = start;
  const [endLongitude, endLatitude] = end;

  const {
    date,
    time
  } = formatNewYorkDateTime(departureTime);

  const transportModes =
    otpTransportModes(mode)
      .map(item => `{ mode: ${item} }`)
      .join(", ");

  const maxTransfers =
    needs.minimizeTransfers ? 1 : 3;

  const wheelchair =
    needs.wheelchairMode !== false;

  const query = `
    query PlanPathForAll {
      plan(
        fromPlace:
          "${startLatitude},${startLongitude}"
        toPlace:
          "${endLatitude},${endLongitude}"
        date: "${date}"
        time: "${time}"
        numItineraries: 5
        maxTransfers: ${maxTransfers}
        wheelchair: ${wheelchair}
        walkReluctance: 2.0
        transferPenalty:
          ${needs.minimizeTransfers ? 900 : 300}
        transportModes: [
          ${transportModes}
        ]
      ) {
        itineraries {
          duration
          walkDistance
          waitingTime
          numberOfTransfers
          accessibilityScore
          start
          end

          legs {
            legId: id
            mode
            duration
            distance
            transitLeg
            headsign
            startTime
            endTime
            realTime

            legGeometry {
              points
            }

            from {
              name
              lat
              lon

              stop {
                gtfsId
                wheelchairBoarding
              }
            }

            to {
              name
              lat
              lon

              stop {
                gtfsId
                wheelchairBoarding
              }
            }

            route {
              gtfsId
              shortName
              longName
              mode
            }

            trip {
              gtfsId
              tripHeadsign
              wheelchairAccessible
            }
          }
        }

        routingErrors {
          code
          description
          inputField
        }
      }
    }
  `;

  const otpResponse = await fetch(OTP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      OTPTimeout: "180000"
    },
    body: JSON.stringify({ query })
  });

  if (!otpResponse.ok) {
    const error = new Error(
      `OpenTripPlanner returned ${otpResponse.status}.`
    );
    error.code = "OTP_REQUEST_FAILED";
    error.statusCode = 502;
    throw error;
  }

  const payload = await otpResponse.json();

  if (payload.errors?.length) {
    const error = new Error(
      payload.errors
        .map(item => item.message)
        .join("; ")
    );

    error.code = "OTP_GRAPHQL_ERROR";
    error.statusCode = 502;
    throw error;
  }

  return payload;
}

function normalizeOtpItinerary(
  itinerary,
  index,
  requestedMode
) {
  const legs = (itinerary.legs || [])
    .map((leg, legIndex) =>
      normalizeOtpLeg(leg, legIndex)
    )
    .filter(Boolean);

  if (!legs.length) return null;

  const transitModes = new Set(
    legs
      .map(leg => leg.mode)
      .filter(mode =>
        ["bus", "subway", "ferry"].includes(mode)
      )
  );

  if (
    requestedMode === "bus" &&
    (
      !transitModes.has("bus") ||
      transitModes.size !== 1
    )
  ) {
    return null;
  }

  if (
    requestedMode === "subway" &&
    (
      !transitModes.has("subway") ||
      transitModes.size !== 1
    )
  ) {
    return null;
  }

  if (
    requestedMode === "mixed" &&
    !(
      transitModes.has("bus") &&
      transitModes.has("subway")
    )
  ) {
    return null;
  }

  const unknownAccessibility = legs.some(
    leg =>
      leg.mode !== "walk" &&
      leg.accessibility
        .wheelchairAccessible === "unknown"
  );

  const distanceMeters = legs.reduce(
    (sum, leg) =>
      sum + Number(leg.distanceMeters || 0),
    0
  );

  return {
    id: `otp-${requestedMode}-${index}`,
    mode: requestedMode,
    label:
      index === 0
        ? "Recommended accessible route"
        : `Accessible alternative ${index + 1}`,
    legs,
    totalDurationSeconds:
      Number(itinerary.duration || 0),
    totalWalkingMeters:
      Number(itinerary.walkDistance || 0),
    totalWaitSeconds:
      Number(itinerary.waitingTime || 0),
    transfers:
      Number(itinerary.numberOfTransfers || 0),
    distanceMeters,
    accessibility: {
      wheelchairAccessible:
        unknownAccessibility
          ? "unknown"
          : true,
      confidence:
        Number.isFinite(
          Number(itinerary.accessibilityScore)
        )
          ? Number(itinerary.accessibilityScore)
          : 0.6
    },
    dataConfidence:
      Number.isFinite(
        Number(itinerary.accessibilityScore)
      )
        ? Number(itinerary.accessibilityScore)
        : 0.6,
    warnings: unknownAccessibility
      ? [
          "Some stop or vehicle accessibility data is unavailable."
        ]
      : [],
    dataSource:
      "OpenTripPlanner with MTA GTFS",
    dataFreshness: "current",
    updatedAt: new Date().toISOString()
  };
}

function normalizeOtpLeg(leg, index) {
  const mode = normalizeOtpMode(leg.mode);

  if (!mode) return null;

  const geometry =
    decodeOtpPolyline(
      leg.legGeometry?.points
    );

  const wheelchairAccessible =
    normalizeWheelchairStatus(
      leg.trip?.wheelchairAccessible,
      leg.from?.stop?.wheelchairBoarding,
      leg.to?.stop?.wheelchairBoarding
    );

  return {
    id:
      leg.legId ||
      `otp-leg-${index}`,
    mode,

    from: {
      id:
        leg.from?.stop?.gtfsId ||
        `otp-from-${index}`,
      name:
        leg.from?.name ||
        "Starting point",
      coordinates: [
        Number(leg.from?.lon),
        Number(leg.from?.lat)
      ]
    },

    to: {
      id:
        leg.to?.stop?.gtfsId ||
        `otp-to-${index}`,
      name:
        leg.to?.name ||
        "Destination",
      coordinates: [
        Number(leg.to?.lon),
        Number(leg.to?.lat)
      ]
    },

    routeId:
      leg.route?.gtfsId ||
      undefined,

    routeName:
      leg.route?.shortName ||
      leg.route?.longName ||
      undefined,

    tripId:
      leg.trip?.gtfsId ||
      undefined,

    headsign:
      leg.headsign ||
      leg.trip?.tripHeadsign ||
      undefined,

    durationSeconds:
      Number(leg.duration || 0),

    distanceMeters:
      Number(leg.distance || 0),

    waitSeconds: 0,

    departureTime:
      millisecondsToIso(
        leg.startTime
      ),

    arrivalTime:
      millisecondsToIso(
        leg.endTime
      ),

    geometry:
      geometry
        ? {
            type: "LineString",
            coordinates: geometry
          }
        : undefined,

    geometryVerified:
      Boolean(geometry),

    accessibility: {
      wheelchairAccessible,
      elevatorStatus: "unknown"
    },

    wheelchairAccessible,

    waitSource:
      leg.realTime
        ? "realtime"
        : "scheduled"
  };
}

function otpTransportModes(mode) {
  if (mode === "bus") {
    return ["WALK", "BUS"];
  }

  if (mode === "subway") {
    return ["WALK", "SUBWAY"];
  }

  if (mode === "mixed") {
    return [
      "WALK",
      "BUS",
      "SUBWAY"
    ];
  }

  throw new Error(
    `Unsupported mode: ${mode}`
  );
}

function normalizeOtpMode(value) {
  const mode =
    String(value || "").toUpperCase();

  if (mode === "WALK") return "walk";

  if (
    mode === "BUS" ||
    mode === "COACH"
  ) {
    return "bus";
  }

  if (
    mode === "SUBWAY" ||
    mode === "RAIL" ||
    mode === "TRAM"
  ) {
    return "subway";
  }

  if (mode === "FERRY") return "ferry";

  return null;
}

function decodeOtpPolyline(points) {
  if (!points) return null;

  try {
    const decoded =
      polyline.decode(points);

    if (decoded.length < 2) {
      return null;
    }

    return decoded.map(
      ([latitude, longitude]) => [
        longitude,
        latitude
      ]
    );
  } catch {
    return null;
  }
}

function normalizeWheelchairStatus(
  tripStatus,
  fromStatus,
  toStatus
) {
  const values = [
    tripStatus,
    fromStatus,
    toStatus
  ].map(value =>
    String(value || "").toUpperCase()
  );

  if (
    values.some(value =>
      [
        "NOT_POSSIBLE",
        "NO",
        "INACCESSIBLE"
      ].includes(value)
    )
  ) {
    return false;
  }

  if (
    values.every(value =>
      [
        "POSSIBLE",
        "YES",
        "ACCESSIBLE"
      ].includes(value)
    )
  ) {
    return true;
  }

  return "unknown";
}

function validateCoordinates(
  value,
  name
) {
  const valid =
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1])) &&
    Math.abs(Number(value[0])) <= 180 &&
    Math.abs(Number(value[1])) <= 90;

  if (!valid) {
    const error = new Error(
      `Invalid ${name} coordinates.`
    );

    error.code =
      "INVALID_COORDINATES";

    error.statusCode = 400;

    throw error;
  }
}

function millisecondsToIso(value) {
  const milliseconds = Number(value);

  if (!Number.isFinite(milliseconds)) {
    return undefined;
  }

  return new Date(
    milliseconds
  ).toISOString();
}

function formatNewYorkDateTime(date) {
  const dateParts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(date);

  const timeParts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "America/New_York",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }
    ).formatToParts(date);

  const read = (parts, type) =>
    parts.find(
      part => part.type === type
    )?.value;

  return {
    date: [
      read(dateParts, "year"),
      read(dateParts, "month"),
      read(dateParts, "day")
    ].join("-"),

    time: [
      read(timeParts, "hour"),
      read(timeParts, "minute"),
      read(timeParts, "second")
    ].join(":")
  };
}