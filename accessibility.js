// @ts-check
/**
 * Shared evidence and eligibility rules. Percent grades are signed in the
 * edge's from -> to direction. Unknown never means flat or compliant.
 * @typedef {"satisfied"|"violated"|"unknown"} EvidenceState
 * @typedef {{state: EvidenceState, reason: string, source?: string}} Evidence
 * @typedef {{id: string, evidence: Evidence}} EndpointEvidence
 * @typedef {{state: EvidenceState, reason: string, endpoints: EndpointEvidence[]}} CurbEvidence
 */

/** @param {EvidenceState} state @param {string} reason @returns {Evidence} */
export function evidence(state, reason) {
  return { state, reason };
}

/** @param {Record<string, string> | undefined} tags @returns {Evidence} */
function endpointKerb(tags) {
  if (!tags) return evidence("unknown", "Curb endpoint is missing.");
  const values = [tags.kerb, tags.curb]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  const good = values.some((value) =>
    ["flush", "lowered", "no"].includes(value),
  );
  const bad = values.some((value) =>
    ["raised", "rolled", "yes"].includes(value),
  );
  if (good && bad)
    return evidence("unknown", "Conflicting lowered and raised curb tags.");
  if (bad)
    return evidence(
      "violated",
      "Endpoint is tagged with a raised or rolled curb.",
    );
  if (good)
    return evidence(
      "satisfied",
      "Endpoint is tagged with a lowered or flush curb.",
    );
  return evidence(
    "unknown",
    values.length
      ? "Unrecognized curb tag."
      : "No curb evidence at this endpoint.",
  );
}

/**
 * The caller must supply the two physical ends of the crossing, not arbitrary
 * internal subdivision nodes. A known violation wins over missing evidence.
 * @param {(Record<string, string>|undefined)[]} tags
 * @param {string[]} ids
 * @returns {CurbEvidence}
 */
export function inferKerbState(tags, ids = []) {
  const endpoints = [0, 1].map((i) => ({
    id: ids[i] || `endpoint-${i}`,
    evidence: endpointKerb(tags[i]),
  }));
  if (endpoints.some((end) => end.evidence.state === "violated"))
    return {
      state: "violated",
      reason:
        "At least one crossing endpoint violates the lowered-curb requirement.",
      endpoints,
    };
  if (
    tags.length !== 2 ||
    endpoints.some((end) => end.evidence.state === "unknown")
  )
    return {
      state: "unknown",
      reason:
        endpoints
          .filter((end) => end.evidence.state === "unknown")
          .map((end) => `${end.id}: ${end.evidence.reason}`)
          .join(" ") || "Crossing endpoint association is incomplete.",
      endpoints,
    };
  return {
    state: "satisfied",
    reason: "Both crossing endpoints have lowered-curb evidence.",
    endpoints,
  };
}

/** @param {import('./domain.js').Needs} needs */
export function unknownPolicy(needs = {}) {
  return needs.unknownPolicy === "allow" ? "allow" : "strict";
}

/** @param {import('./domain.js').Edge} edge @returns {Evidence} */
export function curbEvidence(edge) {
  if (edge.curbEvidence)
    return ["satisfied", "violated", "unknown"].includes(
      edge.curbEvidence.state,
    ) && typeof edge.curbEvidence.reason === "string"
      ? edge.curbEvidence
      : evidence(
          "unknown",
          "Provider curb evidence has an invalid state or reason.",
        );
  // Backward-compatible provider assertion. New OSM edges always carry both ends.
  return edge.curbRamp === true
    ? evidence("satisfied", "Provider asserts lowered access at both ends.")
    : edge.curbRamp === false
      ? evidence("violated", "Provider reports a curb barrier.")
      : evidence("unknown", "Both crossing endpoints are not documented.");
}

/** @param {import('./domain.js').Edge} edge @param {number} now @returns {Evidence} */
export function elevatorEvidence(edge, now = Date.now()) {
  const status = edge.elevator;
  if (status?.status === "out" || edge.elevatorStatus === "out")
    return evidence(
      "violated",
      "Required elevator is reported out of service.",
    );
  const observed = Date.parse(status?.updatedAt || "");
  const expires = Date.parse(status?.expiresAt || "");
  if (
    status?.status === "working" &&
    status.authoritative === true &&
    status.freshness === "current" &&
    Number.isFinite(observed) &&
    observed <= now + 60_000 &&
    now - observed <= 300_000 &&
    (!Number.isFinite(expires) || expires > now)
  )
    return evidence(
      "satisfied",
      "Required elevator has a current authoritative working status.",
    );
  return evidence(
    "unknown",
    "Required elevator status is missing, expired, or not authoritative.",
  );
}

/**
 * Optional comfort attributes do not become hard requirements. Wheelchair mode
 * implies no stairs, lowered crossing ends, pedestrian geometry and working lifts.
 * @param {import('./domain.js').Edge} edge
 * @param {import('./domain.js').Needs} needs
 * @param {{reverse?: boolean, now?: number}} options
 */
export function assessEdge(edge, needs = {}, options = {}) {
  /** @type {Record<string, Evidence>} */
  const requirements = {};
  if (edge.blocked)
    requirements.blockage = evidence(
      "violated",
      "Segment has a reported blockage.",
    );
  for (const item of Array.isArray(edge.nodeRestrictions)
    ? edge.nodeRestrictions
    : []) {
    if (item.pedestrian || (needs.wheelchairMode && item.wheelchair))
      requirements["node:" + item.nodeId] = evidence(
        "violated",
        (item.pedestrian ? "Pedestrian access" : "Wheelchair access") +
          " is prohibited at " +
          item.nodeId +
          " (" +
          item.source +
          ").",
      );
  }
  if (needs.wheelchairMode) {
    requirements.pedestrian = edge.roadCenterline
      ? evidence("violated", "Road centerline is not sidewalk geometry.")
      : edge.pedestrianEvidence && edge.pedestrianEvidence !== "none"
        ? evidence("satisfied", "Mapped pedestrian geometry.")
        : evidence("unknown", "Pedestrian access is undocumented.");
    if (edge.wheelchairStatus === "no")
      requirements.wheelchair = evidence(
        "violated",
        "Wheelchair access is explicitly prohibited.",
      );
  }
  if (needs.avoidStairs || needs.wheelchairMode)
    requirements.stairs =
      edge.stairs === true
        ? evidence("violated", "Segment contains stairs.")
        : edge.stairs === false
          ? evidence("satisfied", "Mapped segment is step-free.")
          : evidence("unknown", "Stair presence is undocumented.");
  if (
    (needs.requireCurb ||
      needs.curbPolicy === "required" ||
      needs.wheelchairMode) &&
    (edge.requiresCurbRamp || edge.crossingsUnknown)
  )
    requirements.curb = edge.crossingsUnknown
      ? evidence(
          "unknown",
          "Crossing locations and curb access are not documented for this connection.",
        )
      : curbEvidence(edge);
  const slope = Number.isFinite(edge.slope)
    ? edge.slope * (options.reverse ? -1 : 1)
    : null;
  const uphill = needs.maxUphillSlope ?? needs.maxSlope;
  const downhill = needs.maxDownhillSlope ?? needs.maxSlope;
  if (Number.isFinite(uphill) || Number.isFinite(downhill)) {
    const violates =
      slope != null &&
      ((slope >= 0 && Number.isFinite(uphill) && slope > uphill) ||
        (slope < 0 && Number.isFinite(downhill) && -slope > downhill));
    requirements.slope =
      slope == null
        ? evidence(
            "unknown",
            "Slope is not mapped; the selected limit cannot be confirmed.",
          )
        : evidence(
            violates ? "violated" : "satisfied",
            `Tagged ${slope}% grade in this travel direction.`,
          );
  }
  if (needs.requireSmooth)
    requirements.surface =
      edge.surface === "smooth"
        ? evidence("satisfied", "Surface is tagged smooth.")
        : ["rough", "uneven"].includes(edge.surface)
          ? evidence(
              "violated",
              "Surface does not meet the required smooth condition.",
            )
          : evidence("unknown", "Surface condition is undocumented.");
  if ((needs.requireElevator || needs.wheelchairMode) && edge.requiresElevator)
    requirements.elevator = elevatorEvidence(edge, options.now);
  const violations = Object.entries(requirements).filter(
    ([, value]) => value.state === "violated",
  );
  const unknowns = Object.entries(requirements).filter(
    ([, value]) => value.state === "unknown",
  );
  return {
    requirements,
    violations,
    unknowns,
    status: violations.length
      ? "violated"
      : unknowns.length
        ? "unknown"
        : "satisfied",
    eligible:
      !violations.length &&
      (unknownPolicy(needs) === "allow" || !unknowns.length),
  };
}

/** @param {import('./domain.js').Edge} edge */
export function reverseEdge(edge) {
  return {
    ...edge,
    from: edge.to,
    to: edge.from,
    slope: Number.isFinite(edge.slope) ? -edge.slope : null,
    geometry: edge.geometry ? [...edge.geometry].reverse() : undefined,
    curbEvidence:
      edge.curbEvidence && Array.isArray(edge.curbEvidence.endpoints)
        ? {
            ...edge.curbEvidence,
            endpoints: [...edge.curbEvidence.endpoints].reverse(),
          }
        : edge.curbEvidence,
  };
}

/** @param {import('./domain.js').Edge[]} edges @param {import('./domain.js').Needs} needs */
export function summarizeEvidence(edges, needs = {}) {
  const segments = edges.map((edge) => ({
    edgeId: edge.id,
    distanceMeters: edge.distanceMeters,
    ...assessEdge(edge, needs),
  }));
  const distanceMeters = edges.reduce(
    (sum, edge) => sum + edge.distanceMeters,
    0,
  );
  const unknownDistanceMeters = segments
    .filter((segment) => segment.unknowns.length)
    .reduce((sum, segment) => sum + segment.distanceMeters, 0);
  const requirements = [
    ...new Set(
      segments.flatMap((segment) => Object.keys(segment.requirements)),
    ),
  ];
  return {
    policy: unknownPolicy(needs),
    status: segments.some((segment) => segment.violations.length)
      ? "violated"
      : segments.some((segment) => segment.unknowns.length)
        ? "unknown"
        : "satisfied",
    distanceMeters,
    unknownDistanceMeters,
    knownFraction: distanceMeters
      ? 1 - unknownDistanceMeters / distanceMeters
      : null,
    requirements,
    segments: segments.filter(
      (segment) => segment.unknowns.length || segment.violations.length,
    ),
  };
}
