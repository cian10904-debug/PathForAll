"use strict";

export const TRANSIT_ERROR_MESSAGES = Object.freeze({
  UNSUPPORTED_MODE: "The connected route provider does not support this travel mode.",
  TRANSIT_PROVIDER_UNAVAILABLE: "Transit data is temporarily unavailable. Try again later.",
  NO_NEARBY_BUS_STOP: "No usable bus stop is available within the selected walking limit.",
  NO_ACCESSIBLE_STATION: "No accessible subway station is available within the selected walking limit.",
  NO_ACCESSIBLE_SUBWAY_PATH: "No complete accessible path is available to the required subway platform.",
  ELEVATOR_PATH_UNAVAILABLE: "A required elevator path is currently unavailable.",
  NO_SERVICE_AT_THIS_TIME: "No scheduled service is available for this trip at the selected time.",
  SCHEDULE_UNAVAILABLE: "A verified schedule is unavailable for this trip.",
  TRANSIT_DATA_STALE: "Transit service or accessibility data is too old to use safely.",
  REALTIME_DATA_STALE: "Realtime arrival data is too old to use.",
  TRIP_CANCELLED: "The selected trip has been cancelled.",
  NO_VALID_TRANSFER: "No accessible transfer is available for this itinerary.",
  FERRY_REQUIRED: "This destination requires an authorized ferry connection.",
  FERRY_CLOSED: "Ferry service is currently unavailable.",
  FERRY_TICKET_REQUIRED: "A Statue City Cruises ticket and security screening are required.",
  FERRY_SCHEDULE_UNAVAILABLE: "Check the current ferry schedule and ticket availability before departing.",
  PROVIDER_CONTRACT_ERROR: "The connected provider returned incomplete or inconsistent route data.",
  ENDPOINT_CONNECTOR_UNAVAILABLE: "A verified pedestrian connection to the selected place is unavailable."
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
