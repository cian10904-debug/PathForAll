// @ts-check
export const VEHICLE_MODES = new Set(["bus", "subway", "ferry", "rail"]);
export const ROUTE_MODES = new Set(["walk", ...VEHICLE_MODES, "mixed"]);
export const LEG_MODES = new Set(["walk", "transfer", ...VEHICLE_MODES]);

export function searchMode(value) {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  return mode === "all-transit" ? "mixed" : ROUTE_MODES.has(mode) ? mode : null;
}

export function modeLabel(mode) {
  return (
    {
      walk: "Walk",
      bus: "Bus",
      subway: "Subway",
      ferry: "Ferry",
      rail: "Rail",
      mixed: "All Transit",
    }[mode] || "Transit"
  );
}

export function actualVehicleModes(legs) {
  return [
    ...new Set(
      legs.map((leg) => leg.mode).filter((mode) => VEHICLE_MODES.has(mode)),
    ),
  ];
}

export function matchesSearchMode(requested, actual) {
  if (!requested) return true;
  if (requested === "mixed") return actual.length > 0;
  if (requested === "walk") return actual.length === 0;
  return actual.length === 1 && actual[0] === requested;
}

/** An explicit interline continuation, or the same trip on the same service day
 * and in the same direction, can keep a rider on board. A shared line cannot. */
export function continuesRide(previous, current) {
  if (!VEHICLE_MODES.has(previous?.mode) || !VEHICLE_MODES.has(current?.mode))
    return false;
  if (previous.to?.id !== current.from?.id || !current.from?.id) return false;
  if (current.staySeated === true) return true;
  return Boolean(
    previous.tripId &&
    current.tripId === previous.tripId &&
    current.mode === previous.mode &&
    (current.serviceDate || null) === (previous.serviceDate || null) &&
    (current.directionId || null) === (previous.directionId || null) &&
    (previous.toSequence == null ||
      current.fromSequence == null ||
      previous.toSequence === current.fromSequence),
  );
}
