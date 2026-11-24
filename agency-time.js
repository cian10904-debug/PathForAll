// @ts-check
export const NYC_ZONE = "America/New_York";
const formats = new Map();

/** Calendar arithmetic stays in the agency timezone, independent of host TZ. */
export function localDateKey(value, timeZone = NYC_ZONE) {
  if (!formats.has(timeZone))
    formats.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    );
  const fields = Object.fromEntries(
    formats
      .get(timeZone)
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return fields.year + "-" + fields.month + "-" + fields.day;
}

export function shiftDateKey(key, days) {
  const utc = Date.parse(key + "T00:00:00Z") + days * 86_400_000;
  return new Date(utc).toISOString().slice(0, 10);
}

// GTFS defines a service-day origin as local noon minus twelve elapsed hours
// (especially important on DST changes). Hours over 24 stay in that service day.
export function serviceInstant(key, seconds, timeZone = NYC_ZONE) {
  const targetNoon = Date.parse(key + "T12:00:00Z");
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const fields = Object.fromEntries(
    format.formatToParts(targetNoon).map((part) => [part.type, part.value]),
  );
  const offset =
    Date.parse(
      fields.year +
        "-" +
        fields.month +
        "-" +
        fields.day +
        "T" +
        fields.hour +
        ":" +
        fields.minute +
        ":00Z",
    ) - targetNoon;
  return targetNoon - offset + (seconds - 43_200) * 1_000;
}

/** Convert an NYC wall clock value to an instant. A missing or repeated DST
 * time requires another selection instead of silently picking an offset. */
export function agencyDeparture(value, timeZone = NYC_ZONE) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const base = Date.parse(value + "Z");
  if (!Number.isFinite(base)) return null;
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const matches = [];
  for (let step = -56; step <= 56; step++) {
    const candidate = new Date(base + step * 900_000);
    if (format.format(candidate).replace(" ", "T") === value)
      matches.push(candidate.toISOString());
  }
  return matches.length === 1 ? matches[0] : null;
}
