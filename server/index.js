// @ts-check
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { normalizeRequest } from "./request.js";
import { createOtpProvider } from "./otp-provider.js";
import { loadTransitManifest } from "./transit-data.js";
import {
  allowOrigin,
  readJson,
  sendError,
  sendJson,
  serveStatic,
} from "./http.js";
import { transitError, TransitProviderError } from "../transit-errors.js";

const FALLBACK_CODES = new Set([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_CONTRACT_ERROR",
  "RATE_LIMITED",
  "UNSUPPORTED_MODE",
  "TRANSIT_DATA_STALE",
  "OUTSIDE_TRANSIT_COVERAGE",
  "NO_FEASIBLE_ROUTE",
  "NO_SERVICE_AT_THIS_TIME",
  "ENDPOINT_CONNECTOR_UNAVAILABLE",
  "SEARCH_LIMIT_REACHED",
  "INSUFFICIENT_ACCESSIBILITY_EVIDENCE",
  "ACCESSIBILITY_CONSTRAINT_BLOCKED",
]);
const ROUTE_BUDGET_MS = 16_500;

export function createAppServer({
  config = loadConfig({}),
  primary = null,
  fallback = null,
  clock = () => new Date(),
} = {}) {
  const active = new Set();
  const hits = new Map();
  let draining = false;
  const providers = [primary, fallback].filter(Boolean);

  const rateLimited = (address) => {
    const window = Math.floor(+clock() / 60_000);
    for (const [key, value] of hits)
      if (value.window !== window) hits.delete(key);
    if (hits.size >= 2_000 && !hits.has(address)) return true;
    const value = hits.get(address) || { window, count: 0 };
    value.count += 1;
    hits.set(address, value);
    return value.count > config.maxPerMinute;
  };

  async function capabilities() {
    if (!providers.length)
      return {
        available: false,
        modes: [],
        source: "PathForAll",
        checked: true,
        connectionStatus: "not-configured",
        code: "TRANSIT_NOT_CONFIGURED",
      };
    const results = await Promise.allSettled(
      providers.map((provider) => provider.capabilities()),
    );
    const connected = results.flatMap((result) =>
      result.status === "fulfilled" && result.value.available
        ? [result.value]
        : [],
    );
    if (connected.length) {
      const first = connected[0];
      const modes = [...new Set(connected.flatMap((item) => item.modes))];
      return { ...first, modes, ferrySchedules: modes.includes("ferry") };
    }
    const error = results.find((result) => result.status === "rejected");
    const code =
      error?.status === "rejected" &&
      error.reason instanceof TransitProviderError
        ? error.reason.code
        : "PROVIDER_UNAVAILABLE";
    return {
      available: false,
      modes: [],
      source: "OpenTripPlanner",
      checked: true,
      freshness: code === "TRANSIT_DATA_STALE" ? "stale" : "unknown",
      connectionStatus: code === "TRANSIT_DATA_STALE" ? "stale" : "unavailable",
      code,
    };
  }

  const server = createServer(
    {
      requestTimeout: 18_000,
      headersTimeout: 5_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 12_288,
    },
    async (request, response) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      try {
        const path = new URL(request.url || "/", "http://pathforall.invalid")
          .pathname;
        if (
          path.startsWith("/api/") &&
          !allowOrigin(request, response, config.allowedOrigins)
        )
          return sendJson(response, 403, {
            code: "INVALID_REQUEST",
            message: "Origin is not permitted.",
          });
        if (path.startsWith("/api/") && request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === "GET" && path === "/api/health")
          return sendJson(response, draining ? 503 : 200, { alive: !draining });
        if (
          request.method === "GET" &&
          (path === "/api/capabilities" || path === "/api/ready")
        ) {
          if (rateLimited(request.socket.remoteAddress || "unknown"))
            throw transitError("RATE_LIMITED");
          const report = await capabilities();
          return sendJson(
            response,
            path === "/api/ready" && (!report.available || draining)
              ? 503
              : 200,
            report,
          );
        }
        if (request.method === "POST" && path === "/api/routes") {
          if (draining || !providers.length) {
            request.resume();
            throw transitError(
              draining ? "PROVIDER_UNAVAILABLE" : "TRANSIT_NOT_CONFIGURED",
            );
          }
          if (
            rateLimited(request.socket.remoteAddress || "unknown") ||
            active.size >= config.concurrency
          ) {
            request.resume();
            throw transitError("RATE_LIMITED");
          }
          const controller = new AbortController();
          const deadline = AbortSignal.timeout(ROUTE_BUDGET_MS);
          const signal = AbortSignal.any([deadline, controller.signal]);
          const started = performance.now();
          const disconnected = () => {
            if (!response.writableEnded) controller.abort();
          };
          response.once("close", disconnected);
          active.add(controller);
          try {
            const body = normalizeRequest(
              await readJson(request, signal),
              clock(),
            );
            const attempts = [];
            for (const [index, provider] of providers.entries()) {
              if (signal.aborted) throw signal.reason;
              const remaining = ROUTE_BUDGET_MS - (performance.now() - started);
              if (remaining < 500)
                throw transitError("PROVIDER_TIMEOUT", { attempts });
              try {
                const limitMs =
                  index === 0 && providers.length > 1
                    ? Math.min(7_000, remaining)
                    : Math.min(config.timeoutMs, remaining);
                const payload = await provider.plan(body, { signal, limitMs });
                return sendJson(response, 200, { ...payload, attempts });
              } catch (error) {
                if (!(error instanceof TransitProviderError)) throw error;
                attempts.push({
                  provider: index === 0 ? "primary" : "fallback",
                  code: error.code,
                });
                if (
                  signal.aborted ||
                  index === providers.length - 1 ||
                  !FALLBACK_CODES.has(error.code)
                ) {
                  error.details = { ...error.details, attempts };
                  throw error;
                }
              }
            }
          } catch (error) {
            if (deadline.aborted) throw transitError("PROVIDER_TIMEOUT");
            if (controller.signal.aborted)
              throw transitError("REQUEST_CANCELLED");
            throw error;
          } finally {
            response.off("close", disconnected);
            active.delete(controller);
          }
        }
        if (await serveStatic(path, request, response, config.dist)) return;
        return sendJson(response, 404, {
          code: "NOT_FOUND",
          message: "Resource not found.",
        });
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return Object.assign(server, {
    shutdown() {
      draining = true;
      for (const controller of active) controller.abort();
      server.close();
      server.closeIdleConnections();
    },
  });
}

export async function startServer() {
  const config = loadConfig();
  const makeProvider = async (url, path) =>
    url
      ? createOtpProvider({
          url,
          manifest: await loadTransitManifest(path),
          timeoutMs: config.timeoutMs,
        })
      : null;
  const [primary, fallback] = await Promise.all([
    makeProvider(config.otpUrl, config.manifestPath),
    makeProvider(config.fallbackUrl, config.fallbackManifestPath),
  ]);
  const server = createAppServer({ config, primary, fallback });
  server.listen(config.port, config.host, () =>
    console.log("PathForAll HTTP service listening on port " + config.port),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => server.shutdown());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer().catch((error) => {
    console.error(
      "PathForAll startup failed:",
      error instanceof SyntaxError
        ? "Invalid JSON in transit configuration."
        : error.message,
    );
    process.exitCode = 1;
  });
}
