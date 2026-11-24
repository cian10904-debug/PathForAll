"use strict";

export const TRANSIT_ERROR_MESSAGES = Object.freeze({
  TRANSIT_NOT_CONFIGURED: "Transit planning is not connected. Walking can still be planned.",
  UNSUPPORTED_MODE: "The connected provider does not support this travel mode.",
  PROVIDER_UNAVAILABLE: "Transit planning is temporarily unavailable. Try shortly.",
  PROVIDER_TIMEOUT: "Transit planning took too long. Try shortly or choose a shorter trip.",
  TRANSIT_PROVIDER_UNAVAILABLE: "Transit data is temporarily unavailable. Try again later.",
  PROVIDER_CONTRACT_ERROR: "The connected provider returned incomplete or inconsistent route data.",
  TRANSIT_DATA_STALE: "The loaded timetable does not cover this departure. Try a date within the available schedule.",
  OUTSIDE_TRANSIT_COVERAGE: "The loaded transit map does not cover one of the selected locations.",
  NO_NEARBY_STOP: "No stop for this mode is mapped near one of the selected locations.",
  ENDPOINT_CONNECTOR_UNAVAILABLE: "The route to a stop or between the selected places could not be confirmed. Try a mapped entrance.",
  NO_SERVICE_AT_THIS_TIME: "No scheduled connection was found within the provider's service search. Try another time.",
  NO_VALID_TRANSFER: "A connection was found, but the transfer could not be made in time.",
  ACCESSIBILITY_CONSTRAINT_BLOCKED: "The options found conflict with one or more of your accessibility requirements.",
  INSUFFICIENT_ACCESSIBILITY_EVIDENCE: "The options found are missing evidence required by your accessibility settings. Review the missing conditions or choose another route.",
  SEARCH_LIMIT_REACHED: "The search reached its time or coverage limit. Try a shorter trip or a different departure time.",
  NO_FEASIBLE_ROUTE: "No usable route was found within the searched area and your trip limits.",
  REQUEST_CANCELLED: "Route calculation cancelled.",
  RATE_LIMITED: "Route planning is busy. Try again shortly.",
  INVALID_REQUEST: "Check the selected locations and departure time.",
  NO_NEARBY_BUS_STOP: "No usable bus stop is available within the selected walking limit.",
  NO_ACCESSIBLE_STATION: "No accessible subway station is available within the selected walking limit.",
  NO_ACCESSIBLE_SUBWAY_PATH: "No complete accessible path is available to the required subway platform.",
  ELEVATOR_PATH_UNAVAILABLE: "A required elevator path is currently unavailable.",
  SCHEDULE_UNAVAILABLE: "A verified schedule is unavailable for this trip.",
  REALTIME_DATA_STALE: "Realtime arrival data is too old to use.",
  TRIP_CANCELLED: "The selected trip has been cancelled.",
  FERRY_REQUIRED: "This destination requires an authorized ferry connection.",
  FERRY_CLOSED: "Ferry service is currently unavailable.",
  FERRY_TICKET_REQUIRED: "A Statue City Cruises ticket and security screening are required.",
  FERRY_SCHEDULE_UNAVAILABLE: "Check the current ferry schedule and ticket availability before departing."
});

export class TransitProviderError extends Error {
  constructor(code, message = TRANSIT_ERROR_MESSAGES[code] || "Transit routing is unavailable.", details = {}) {
    super(message);
    this.name = "TransitProviderError";
    this.code = code;
    this.details = details;
    this.retriable = details.retriable === true;
  }
}

export function transitError(code, details = {}, message) {
  return new TransitProviderError(code, message || TRANSIT_ERROR_MESSAGES[code], details);
}
