// @ts-check
import { fetchWithPolicy } from "../fetch-client.js";
import { transitError, TransitProviderError } from "../transit-errors.js";
import { isInsideBounds } from "../osm-network.js";
import { instant } from "../route-timeline.js";
import {
  assertServiceRange,
  feedsForTime,
  itineraryProvenance,
} from "./transit-data.js";
import {
  HEALTH_QUERY,
  PLAN_QUERY,
  planVariables,
  routeModeFromOtp,
} from "./otp-query.js";
import { normalizeOtpItinerary } from "./otp-itinerary.js";

const DEADLINE = "TimeoutError";
const REJECTION_PRIORITY = [
  "PROVIDER_CONTRACT_ERROR",
  "TRANSIT_DATA_STALE",
  "ACCESSIBILITY_CONSTRAINT_BLOCKED",
  "INSUFFICIENT_ACCESSIBILITY_EVIDENCE",
  "ENDPOINT_CONNECTOR_UNAVAILABLE",
  "NO_VALID_TRANSFER",
  "TRIP_CANCELLED",
  "NO_FEASIBLE_ROUTE",
];

export function createOtpProvider({
  url,
  manifest,
  timeoutMs = 11_000,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
}) {
  let cached = null;
  let pending = null;
  async function graphql(query, variables, signal, limitMs = timeoutMs) {
    try {
      const response = await fetchWithPolicy(
        url,
        {
          method: "POST",
          signal,
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            OTPTimeout: String(limitMs),
          },
          body: JSON.stringify({ query, variables }),
        },
        {
          timeoutMs: limitMs,
          maxResponseBytes: 3 * 1024 * 1024,
          fetchImpl,
          retries: 0,
        },
      );
      if (response.status === 429)
        throw transitError("RATE_LIMITED", { retriable: true });
      if (response.status === 408 || response.status === 504)
        throw transitError("PROVIDER_TIMEOUT", { retriable: true });
      if (!response.ok)
        throw transitError("PROVIDER_UNAVAILABLE", {
          retriable: response.status >= 500,
        });
      let body;
      try {
        body = await response.json();
      } catch {
        throw transitError("PROVIDER_CONTRACT_ERROR", {
          reasons: ["OTP did not return valid JSON."],
        });
      }
      if (
        !body?.data ||
        typeof body.data !== "object" ||
        (body.errors && (!Array.isArray(body.errors) || body.errors.length))
      ) {
        throw transitError("PROVIDER_CONTRACT_ERROR", {
          reasons: [
            "OTP returned GraphQL errors or no data. Check the supported OTP schema.",
          ],
        });
      }
      return body.data;
    } catch (error) {
      if (signal?.aborted)
        throw transitError(
          signal.reason?.name === DEADLINE
            ? "PROVIDER_TIMEOUT"
            : "REQUEST_CANCELLED",
        );
      if (error instanceof TransitProviderError) throw error;
      if (error?.code === "FETCH_TIMEOUT")
        throw transitError("PROVIDER_TIMEOUT", { retriable: true });
      if (error?.code === "RESPONSE_TOO_LARGE")
        throw transitError("PROVIDER_CONTRACT_ERROR", {
          reasons: ["OTP response exceeded its size budget."],
        });
      throw transitError("PROVIDER_UNAVAILABLE", { retriable: true });
    }
  }
  async function health() {
    const now = +clock();
    if (cached?.until > now) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      try {
        const data = await graphql(
          HEALTH_QUERY,
          {},
          undefined,
          Math.min(timeoutMs, 3_000),
        );
        if (
          !Number.isFinite(data.serviceTimeRange?.start) ||
          !Number.isFinite(data.serviceTimeRange?.end) ||
          data.serviceTimeRange.end <= data.serviceTimeRange.start ||
          !Array.isArray(data.feeds) ||
          !Array.isArray(data.routes)
        ) {
          throw transitError("PROVIDER_CONTRACT_ERROR", {
            reasons: [
              "OTP has no usable graph service range or route inventory.",
            ],
          });
        }
        const installed = new Map(
          data.feeds
            .filter((feed) => typeof feed?.feedId === "string")
            .map((feed) => [feed.feedId, feed]),
        );
        const feeds = new Set(
          manifest.feeds
            .filter(
              (feed) =>
                installed.get(feed.id)?.agencies?.length &&
                installed
                  .get(feed.id)
                  .agencies.every(
                    (agency) => agency.timezone === feed.timeZone,
                  ),
            )
            .map((feed) => feed.id),
        );
        const routeModes = new Map([...feeds].map((id) => [id, new Set()]));
        for (const route of data.routes) {
          const mode = routeModeFromOtp(route?.mode);
          if (typeof route?.gtfsId !== "string" || !mode || mode === "walk")
            continue;
          routeModes.get(route.gtfsId.split(":")[0])?.add(mode);
        }
        if (![...routeModes.values()].some((modes) => modes.size))
          throw transitError("PROVIDER_UNAVAILABLE", {
            reasons: [
              "The graph has no routes matching the declared feeds and agency timezone.",
            ],
          });
        const value = { ...data.serviceTimeRange, feeds, routeModes };
        cached = { until: now + 35_000, value };
        return value;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  function modesFor(feeds, graph) {
    return [
      ...new Set(
        feeds.flatMap((feed) =>
          feed.modes.filter((mode) => graph.routeModes.get(feed.id)?.has(mode)),
        ),
      ),
    ];
  }

  return {
    async capabilities() {
      const graph = await health();
      const now = clock();
      assertServiceRange(graph, now);
      const feeds = feedsForTime(manifest, graph, now, {
        allowOvernight: true,
      });
      const modes = modesFor(feeds, graph);
      if (!modes.length) throw transitError("TRANSIT_DATA_STALE");
      return {
        ...itineraryProvenance(manifest, feeds, now),
        available: true,
        routeProvider: true,
        modes: [...modes, "mixed"],
        scheduledTransit: true,
        ferrySchedules: modes.includes("ferry"),
        realtimeArrivals: false,
        elevatorAccessibilityPaths: false,
        source: "OpenTripPlanner",
        freshness: "current",
        connectionStatus: "connected",
        checked: true,
        graphServiceFrom: new Date(graph.start * 1000).toISOString(),
        graphServiceThrough: new Date(graph.end * 1000).toISOString(),
        loadedFeedCount: feeds.length,
      };
    },
    async plan(request, { signal = undefined, limitMs = timeoutMs } = {}) {
      if (signal?.aborted) throw transitError("REQUEST_CANCELLED");
      if (
        manifest.osm?.bounds &&
        ![request.start, request.end].every((point) =>
          isInsideBounds(point, manifest.osm.bounds),
        )
      )
        throw transitError("OUTSIDE_TRANSIT_COVERAGE");
      const graph = await health();
      if (signal?.aborted)
        throw transitError(
          signal.reason?.name === DEADLINE
            ? "PROVIDER_TIMEOUT"
            : "REQUEST_CANCELLED",
        );
      const when = new Date(request.departureTime);
      assertServiceRange(graph, when);
      // Include tomorrow's feed when a valid transfer arrives after midnight.
      // Individual legs are still checked against their identified service day.
      const active = new Map(
        [
          ...feedsForTime(manifest, graph, when, { allowOvernight: true }),
          ...feedsForTime(manifest, graph, new Date(+when + 6 * 3_600_000)),
        ].map((feed) => [feed.id, feed]),
      );
      const activeFeeds = [...active.values()];
      if (!activeFeeds.length) throw transitError("TRANSIT_DATA_STALE");
      const availableModes = modesFor(activeFeeds, graph);
      if (
        !availableModes.length ||
        (request.mode !== "mixed" && !availableModes.includes(request.mode))
      )
        throw transitError("UNSUPPORTED_MODE", { modes: availableModes });
      const data = await graphql(
        PLAN_QUERY,
        planVariables(request, availableModes),
        signal,
        Math.min(timeoutMs, limitMs),
      );
      if (
        !Array.isArray(data.planConnection?.edges) ||
        !Array.isArray(data.planConnection?.routingErrors)
      )
        throw transitError("PROVIDER_CONTRACT_ERROR", {
          reasons: [
            "OTP response is missing the itinerary or routing errors array.",
          ],
        });
      const now = clock();
      const metadata = itineraryProvenance(manifest, activeFeeds, now);
      const routes = [];
      const rejected = [];
      for (const [index, edge] of data.planConnection.edges
        .slice(0, 16)
        .entries()) {
        try {
          const route = normalizeOtpItinerary(
            edge?.node,
            request,
            metadata,
            availableModes,
            { now: +now, activeFeeds },
          );
          // Routes whose first vehicle has departed are unsuitable for a new navigation start.
          const firstRide = route.legs.find((leg) => leg.tripId);
          const expiration = Math.min(
            instant(metadata.expiresAt),
            instant(firstRide?.departureTime) ?? Infinity,
          );
          if (expiration > +now)
            route.expiresAt = new Date(expiration).toISOString();
          if (!routes.some((value) => value.id === route.id))
            routes.push(route);
        } catch (error) {
          const code =
            error instanceof TransitProviderError
              ? error.code
              : "PROVIDER_CONTRACT_ERROR";
          const reasons =
            error instanceof TransitProviderError &&
            Array.isArray(error.details?.reasons)
              ? error.details.reasons
                  .slice(0, 6)
                  .map((reason) => String(reason).slice(0, 260))
              : [];
          rejected.push({ index, code, reasons });
        }
      }
      if (!routes.length) {
        const routingCodes = data.planConnection.routingErrors
          .map((error) => error?.code)
          .filter(
            (code) => typeof code === "string" && /^[A-Z_]{1,64}$/.test(code),
          )
          .slice(0, 12);
        // NO_TRANSIT_CONNECTION describes the whole constrained search. It
        // does not establish that scheduled vehicles were absent.
        const genericFailure =
          request.needs.wheelchairMode &&
          routingCodes.includes("NO_TRANSIT_CONNECTION")
            ? "INSUFFICIENT_ACCESSIBILITY_EVIDENCE"
            : "NO_FEASIBLE_ROUTE";
        const code = rejected.length
          ? REJECTION_PRIORITY.find((value) =>
              rejected.some((item) => item.code === value),
            ) || rejected[0].code
          : routingCodes.map((value) => OTP_FAILURES[value]).find(Boolean) ||
            genericFailure;
        throw transitError(code, { rejected, routingCodes });
      }
      routes.sort(
        (a, b) =>
          a.totalDurationSeconds +
          (request.needs.minimizeTransfers ? a.transfers * 420 : 0) -
          (b.totalDurationSeconds +
            (request.needs.minimizeTransfers ? b.transfers * 420 : 0)),
      );
      return { ...metadata, routes: routes.slice(0, 5), rejected };
    },
  };
}

// NO_STOPS_IN_RANGE means unreachable by the search, not absent from the map.
const OTP_FAILURES = Object.freeze({
  OUTSIDE_BOUNDS: "OUTSIDE_TRANSIT_COVERAGE",
  OUTSIDE_SERVICE_PERIOD: "TRANSIT_DATA_STALE",
  LOCATION_NOT_FOUND: "ENDPOINT_CONNECTOR_UNAVAILABLE",
  NO_STOPS_IN_RANGE: "ENDPOINT_CONNECTOR_UNAVAILABLE",
  NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW: "SEARCH_LIMIT_REACHED",
  WALKING_BETTER_THAN_TRANSIT: "NO_FEASIBLE_ROUTE",
});
