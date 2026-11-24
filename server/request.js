// @ts-check
import { coordinate } from "../route-model.js";
import { instant } from "../route-timeline.js";
import { searchMode } from "../transit-modes.js";
import { NYC_BOUNDS, isInsideBounds } from "../osm-network.js";
import { transitError } from "../transit-errors.js";

const BOOL = [
  "wheelchairMode",
  "avoidStairs",
  "requireCurb",
  "requireVerifiedCurbAccess",
  "requireElevator",
  "requireSmooth",
  "preferSmooth",
  "preferShade",
  "preferWellLit",
  "avoidRain",
  "minimizeTransfers",
];
const GRADES = ["maxSlope", "maxUphillSlope", "maxDownhillSlope"];

export function normalizeRequest(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw transitError("INVALID_REQUEST");
  const start =
    Array.isArray(input.start) &&
    input.start.length === 2 &&
    coordinate(input.start);
  const end =
    Array.isArray(input.end) && input.end.length === 2 && coordinate(input.end);
  if (!start || !end || (start[0] === end[0] && start[1] === end[1]))
    throw transitError("INVALID_REQUEST");
  if (![start, end].every((value) => isInsideBounds(value, NYC_BOUNDS)))
    throw transitError("OUTSIDE_TRANSIT_COVERAGE");
  const mode = searchMode(input.mode);
  if (!mode || mode === "walk") throw transitError("UNSUPPORTED_MODE");
  const departure =
    input.departureTime == null ? +now : instant(input.departureTime);
  if (
    departure == null ||
    departure < +now - 86_400_000 ||
    departure > +now + 30 * 86_400_000
  )
    throw transitError("INVALID_REQUEST", {
      reasons: [
        "Use an absolute departure timestamp within the supported planning horizon.",
      ],
    });
  const source = input.needs ?? {};
  if (typeof source !== "object" || Array.isArray(source))
    throw transitError("INVALID_REQUEST");
  const needs = {
    wheelchairMode: false,
    unknownPolicy: "strict",
    maxWalkMinutes: 15,
  };
  for (const key of BOOL) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "boolean") throw transitError("INVALID_REQUEST");
    needs[key] = source[key];
  }
  if (source.unknownPolicy != null) {
    if (!["strict", "allow"].includes(source.unknownPolicy))
      throw transitError("INVALID_REQUEST");
    needs.unknownPolicy = source.unknownPolicy;
  }
  for (const key of [...GRADES, "maxWalkMinutes"]) {
    const value = source[key];
    const walking = key === "maxWalkMinutes";
    if (value == null) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < (walking ? 1 : 0) ||
      value > (walking ? 120 : 30)
    )
      throw transitError("INVALID_REQUEST");
    needs[key] = value;
  }
  return {
    start,
    end,
    mode,
    departureTime: new Date(departure).toISOString(),
    needs,
  };
}
