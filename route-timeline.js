// @ts-check
import { continuesRide, VEHICLE_MODES } from "./transit-modes.js";

/** Parse an absolute timestamp, rejecting ambiguous local times and normalized invalid dates. */
export function instant(value) {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(
      value,
    );
  if (!match) return null;
  const [, y, m, d] = match;
  const calendar = new Date(y + "-" + m + "-" + d + "T00:00:00Z");
  if (
    calendar.getUTCDate() !== Number(d) ||
    calendar.getUTCMonth() + 1 !== Number(m)
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Absolute leg times describe movement; each gap preceding a leg is counted once.
 * Minimum transfer slack is in addition to walking, inclusive of any board/alight slack. */
export function inspectTimeline(
  legs,
  { departedAt = null, required = false, deriveWaits = false } = {},
) {
  const hasAnyTime = legs.some(
    (leg) => leg.departureTime != null || leg.arrivalTime != null,
  );
  if (!required && !hasAnyTime)
    return { status: "unknown", issues: [], legs, arrivalTime: null };
  const issues = [];
  let cursor = instant(departedAt);
  let previous = null;
  let boardings = 0;
  let bufferSeconds = 0;
  const output = [];
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    const from = instant(leg.departureTime),
      to = instant(leg.arrivalTime);
    const vehicle = VEHICLE_MODES.has(leg.mode);
    const continuation = vehicle && continuesRide(previous, leg);
    if (leg.staySeated && !continuation)
      issues.push("Leg " + i + " has an invalid stay-seated continuation.");
    if (from == null || to == null || to < from) {
      issues.push("Leg " + i + " has missing or invalid absolute times.");
      previous = leg;
      continue;
    }
    const durationSeconds = (to - from) / 1_000;
    if (
      !Number.isFinite(leg.durationSeconds) ||
      Math.abs(durationSeconds - leg.durationSeconds) > 1
    )
      issues.push("Leg " + i + " duration does not match its timestamps.");
    const waitSeconds =
      cursor == null ? leg.waitSeconds || 0 : (from - cursor) / 1_000;
    if (waitSeconds < 0)
      issues.push("Leg " + i + " departs before the traveler can reach it.");
    if (!deriveWaits && Math.abs((leg.waitSeconds || 0) - waitSeconds) > 1)
      issues.push("Leg " + i + " wait does not match the preceding arrival.");
    bufferSeconds += Math.max(0, waitSeconds);
    if (vehicle && !continuation) {
      const minimum = Math.max(
        leg.minimumBoardingSeconds || 0,
        boardings ? leg.minimumTransferSeconds || 0 : 0,
      );
      if (bufferSeconds < minimum)
        issues.push(
          "Leg " + i + " does not meet the minimum boarding or transfer time.",
        );
      boardings += 1;
    }
    if (vehicle) bufferSeconds = 0;
    cursor = to;
    previous = leg;
    output.push(deriveWaits ? { ...leg, waitSeconds, durationSeconds } : leg);
  }
  return {
    status: issues.length ? "invalid" : "verified",
    issues,
    legs: output,
    arrivalTime: cursor == null ? null : new Date(cursor).toISOString(),
  };
}
