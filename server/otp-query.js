// @ts-check
import { VEHICLE_MODES } from "../transit-modes.js";

export const OTP_VERSION = "2.8.1";
export const OTP_RELEASE_SHA256 =
  "eb4224cb0f59ed913ee240d17838091a0e6da2d81d8216c31c07c51502831697";
export const BOARD_SECONDS = 30;
export const TRANSFER_SECONDS = 60;

export const HEALTH_QUERY = `
query PathForAllReadiness {
  serviceTimeRange { start end }
  feeds { feedId agencies { gtfsId timezone } }
  routes { gtfsId mode }
}
`;

export const PLAN_QUERY = `
query PathForAllPlan(
  $origin: PlanLabeledLocationInput!, $destination: PlanLabeledLocationInput!,
  $dateTime: PlanDateTimeInput!, $modes: PlanModesInput!,
  $preferences: PlanPreferencesInput!, $first: Int!, $window: Duration!
) {
  planConnection(origin: $origin, destination: $destination, dateTime: $dateTime,
    modes: $modes, preferences: $preferences, first: $first, searchWindow: $window) {
    routingErrors { code inputField }
    edges { node {
      start end
      legs {
        id mode duration distance headsign serviceDate interlineWithPreviousLeg realtimeState
        start { scheduledTime estimated { time } }
        end { scheduledTime estimated { time } }
        from { name lon lat stop { gtfsId wheelchairBoarding } stopPosition { ... on PositionAtStop { position } } }
        to { name lon lat stop { gtfsId wheelchairBoarding } stopPosition { ... on PositionAtStop { position } } }
        route { gtfsId shortName longName mode }
        trip { gtfsId directionId wheelchairAccessible }
        legGeometry { points }
        stopCalls { stopLocation { __typename } }
        alerts { alertEffect alertHeaderText alertDescriptionText effectiveStartDate effectiveEndDate }
      }
    } }
  }
}
`;

const OTP_MODES = {
  bus: ["BUS", "COACH"],
  subway: ["SUBWAY"],
  ferry: ["FERRY"],
  rail: ["RAIL", "TRAM", "MONORAIL"],
};

export function routeModeFromOtp(mode) {
  return (
    [...VEHICLE_MODES].find((item) => OTP_MODES[item].includes(mode)) ||
    (mode === "WALK" ? "walk" : null)
  );
}

export function planVariables(request, availableModes) {
  const location = ([longitude, latitude]) => ({
    location: { coordinate: { longitude, latitude } },
  });
  return {
    origin: location(request.start),
    destination: location(request.end),
    dateTime: { earliestDeparture: request.departureTime },
    modes: {
      transitOnly: true,
      transit: {
        access: ["WALK"],
        egress: ["WALK"],
        transfer: ["WALK"],
        transit: (request.mode === "mixed"
          ? availableModes
          : [request.mode]
        ).flatMap((mode) =>
          (OTP_MODES[mode] || []).map((value) => ({ mode: value })),
        ),
      },
    },
    preferences: {
      accessibility: {
        wheelchair: { enabled: request.needs.wheelchairMode === true },
      },
      transit: {
        board: { slack: "PT" + BOARD_SECONDS + "S" },
        transfer: {
          maximumTransfers: 3,
          cost: request.needs.minimizeTransfers ? 600 : 120,
          slack: "PT" + TRANSFER_SECONDS + "S",
        },
      },
    },
    window: "PT90M",
    first: 12,
  };
}
