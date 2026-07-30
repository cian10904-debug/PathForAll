"use strict";

const ROUTE_MODES = Object.freeze(["walk", "bus", "subway", "ferry", "mixed"]);
const TRANSIT_MODES = Object.freeze(["bus", "subway", "ferry", "mixed"]);
const STATUS_SET = new Set(["Connected", "Not configured", "Unavailable", "Stale", "Unknown"]);
const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|token|secret|password|passwd|authorization|auth[-_]?key|signature)/i;

export const TRANSIT_CONNECTION_STATUSES = Object.freeze([
  "Connected",
  "Not configured",
  "Unavailable",
  "Stale",
  "Unknown"
]);

export const transitEnvironment = validateTransitEnvironment(import.meta.env || {});

export function validateTransitEnvironment(env = {}) {
  const issues = [];
  const endpoints = {
    routeProvider: validateEndpoint(env.VITE_ACCESSIBLE_ROUTING_URL, "VITE_ACCESSIBLE_ROUTING_URL", issues),
    capabilities: validateEndpoint(
      env.VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL,
      "VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL",
      issues
    ),
    transitNetwork: validateEndpoint(env.VITE_TRANSIT_NETWORK_URL, "VITE_TRANSIT_NETWORK_URL", issues),
    realtimeArrivals: validateEndpoint(env.VITE_TRANSIT_ARRIVALS_URL, "VITE_TRANSIT_ARRIVALS_URL", issues)
  };

  const rawModes = String(env.VITE_ACCESSIBLE_ROUTING_MODES || "walk")
    .split(",")
    .map(mode => mode.trim().toLowerCase())
    .filter(Boolean);
  const unsupportedModes = [...new Set(rawModes.filter(mode => !ROUTE_MODES.includes(mode)))];
  if (unsupportedModes.length) {
    issues.push({
      variable: "VITE_ACCESSIBLE_ROUTING_MODES",
      code: "UNSUPPORTED_MODE",
      message: `Unsupported routing mode${unsupportedModes.length === 1 ? "" : "s"}: ${unsupportedModes.join(", ")}.`
    });
  }
  const modes = [...new Set(rawModes.filter(mode => ROUTE_MODES.includes(mode)))];
  if (!modes.length) modes.push("walk");

  if (endpoints.capabilities.configured && !endpoints.routeProvider.valid) {
    endpoints.capabilities.valid = false;
    endpoints.capabilities.url = "";
    issues.push({
      variable: "VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL",
      code: "ORPHAN_CAPABILITIES_URL",
      message: "A capabilities endpoint requires a valid accessible-routing endpoint."
    });
  }

  const hasTransitRoute = endpoints.routeProvider.valid && modes.some(mode => TRANSIT_MODES.includes(mode));
  if (endpoints.realtimeArrivals.valid && !endpoints.transitNetwork.valid && !hasTransitRoute) {
    issues.push({
      variable: "VITE_TRANSIT_ARRIVALS_URL",
      code: "ORPHAN_ARRIVALS_URL",
      message: "Realtime arrivals require a transit network or a transit-capable route provider."
    });
  }

  return {
    valid: issues.length === 0,
    modes,
    issues,
    endpoints
  };
}

export function buildTransitConnectionReport({
  environment = transitEnvironment,
  routeCapabilities = {},
  routeProviderState = null,
  transitNetworkState = null,
  realtimeState = null,
  checkedAt = new Date().toISOString()
} = {}) {
  const routeProvider = routeProviderConnection(environment, routeCapabilities, routeProviderState);
  const transitNetwork = configuredConnection(
    environment.endpoints.transitNetwork,
    transitNetworkState,
    "Transit network provider"
  );
  const realtimeArrivals = featureConnection({
    endpoint: environment.endpoints.realtimeArrivals,
    observation: realtimeState,
    claimed: routeCapabilities.realtimeArrivals === true || transitNetworkState?.capabilities?.realtimeArrivals === true,
    providers: [routeProvider, transitNetwork],
    source: routeCapabilities.realtimeArrivals ? routeCapabilities.source : transitNetworkState?.source
  });
  const elevatorAccessibilityPaths = featureConnection({
    observation: null,
    claimed:
      routeCapabilities.elevatorAccessibilityPaths === true ||
      transitNetworkState?.capabilities?.elevatorAccessibilityPaths === true,
    providers: [routeProvider, transitNetwork],
    source: routeCapabilities.elevatorAccessibilityPaths ? routeCapabilities.source : transitNetworkState?.source,
    knownUnsupported:
      routeCapabilities.checked === true &&
      !environment.endpoints.transitNetwork.configured,
    unknownWhenConfigured:
      environment.endpoints.routeProvider.valid || environment.endpoints.transitNetwork.valid
  });
  const ferrySchedules = featureConnection({
    observation: null,
    claimed: routeCapabilities.ferrySchedules === true || transitNetworkState?.capabilities?.ferrySchedules === true,
    providers: [routeProvider, transitNetwork],
    source: routeCapabilities.ferrySchedules ? routeCapabilities.source : transitNetworkState?.source,
    knownUnsupported:
      routeCapabilities.checked === true &&
      !environment.endpoints.transitNetwork.configured,
    unknownWhenConfigured:
      environment.endpoints.routeProvider.valid || environment.endpoints.transitNetwork.valid
  });

  const connections = {
    routeProvider,
    transitNetwork,
    realtimeArrivals,
    elevatorAccessibilityPaths,
    ferrySchedules
  };
  const availability = transitModeAvailability(
    { connections },
    environment,
    routeCapabilities,
    transitNetworkState
  );
  const transitConfigured =
    TRANSIT_MODES.some(mode => availability[mode]) ||
    environment.endpoints.realtimeArrivals.configured ||
    routeCapabilities.realtimeArrivals === true ||
    routeCapabilities.elevatorAccessibilityPaths === true ||
    routeCapabilities.ferrySchedules === true;
  const copy = reportCopy(connections, environment, transitConfigured);

  return {
    checkedAt: timestamp(checkedAt) || new Date().toISOString(),
    walkAvailable: true,
    transitConfigured,
    summary: copy.summary,
    detail: copy.detail,
    overallStatus: copy.overallStatus,
    connections,
    modeAvailability: availability,
    configurationIssues: environment.issues.map(issue => ({
      variable: issue.variable,
      code: issue.code,
      message: issue.message
    }))
  };
}

export function transitModeAvailability(
  _report,
  environment = transitEnvironment,
  routeCapabilities = {},
  transitNetworkState = null
) {
  const availability = { walk: true, bus: false, subway: false, ferry: false, mixed: false };
  if (environment.endpoints.routeProvider.valid) {
    const providerModes = routeCapabilities.available
      ? routeCapabilities.supportedModes || routeCapabilities.modes || []
      : environment.modes;
    providerModes.forEach(mode => {
      if (TRANSIT_MODES.includes(mode)) availability[mode] = true;
    });
  }
  if (environment.endpoints.transitNetwork.valid) {
    const verifiedModes = transitNetworkState?.capabilities?.modes;
    const networkModes = Array.isArray(verifiedModes) && verifiedModes.length
      ? verifiedModes
      : TRANSIT_MODES;
    networkModes.forEach(mode => {
      if (TRANSIT_MODES.includes(mode)) availability[mode] = true;
    });
  }
  return availability;
}

export function sanitizedTransitDiagnostics(report) {
  const environment = report?.environment || transitEnvironment;
  const connectionReport = report?.connections ? report : buildTransitConnectionReport({ environment });
  return {
    checkedAt: connectionReport.checkedAt,
    environment: {
      VITE_ACCESSIBLE_ROUTING_URL: endpointDiagnostic(environment.endpoints.routeProvider),
      VITE_ACCESSIBLE_ROUTING_MODES: {
        configured: environment.endpoints.routeProvider.configured,
        valid: environment.modes.every(mode => ROUTE_MODES.includes(mode)),
        acceptedModes: [...environment.modes]
      },
      VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL: endpointDiagnostic(environment.endpoints.capabilities),
      VITE_TRANSIT_NETWORK_URL: endpointDiagnostic(environment.endpoints.transitNetwork),
      VITE_TRANSIT_ARRIVALS_URL: endpointDiagnostic(environment.endpoints.realtimeArrivals)
    },
    connections: Object.fromEntries(
      Object.entries(connectionReport.connections).map(([key, connection]) => [
        key,
        {
          status: connection.status,
          source: connection.source || null,
          updatedAt: connection.updatedAt || null
        }
      ])
    ),
    configurationIssues: connectionReport.configurationIssues || environment.issues.map(issue => ({
      variable: issue.variable,
      code: issue.code,
      message: issue.message
    }))
  };
}

function validateEndpoint(rawValue, variable, issues) {
  const raw = String(rawValue || "").trim();
  const result = { variable, configured: Boolean(raw), valid: false, url: "" };
  if (!raw) return result;
  try {
    const parsed = new URL(raw);
    const localHttp =
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) {
      throw new Error("Use HTTPS, except for a localhost development endpoint.");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Embedded URL credentials are not permitted in browser configuration.");
    }
    if (parsed.hash) throw new Error("URL fragments are not valid service endpoints.");
    if ([...parsed.searchParams.keys()].some(key => SENSITIVE_QUERY_KEY.test(key))) {
      throw new Error("Credential-like query parameters must remain on the application server.");
    }
    result.valid = true;
    result.url = parsed.toString();
  } catch (error) {
    issues.push({
      variable,
      code: "INVALID_URL",
      message: error instanceof TypeError ? "Enter a valid HTTPS endpoint URL." : error.message
    });
  }
  return result;
}

function routeProviderConnection(environment, capabilities, observation) {
  const endpoint = environment.endpoints.routeProvider;
  if (!endpoint.configured) return connection("Not configured");
  if (!endpoint.valid) return connection("Unavailable");
  const explicit = normalizeStatus(capabilities.connectionStatus);
  if (explicit && explicit !== "Unknown") {
    return connection(explicit, capabilities.source, capabilities.updatedAt);
  }
  if (observation) return observedConnection(observation, capabilities.source);
  if (capabilities.freshness === "stale") {
    return connection("Stale", capabilities.source, capabilities.updatedAt);
  }
  if (capabilities.checked === true && capabilities.freshness === "current" && capabilities.available) {
    return connection("Connected", capabilities.source, capabilities.updatedAt);
  }
  return connection("Unknown", capabilities.source, capabilities.updatedAt);
}

function configuredConnection(endpoint, observation, defaultSource) {
  if (!endpoint.configured) return connection("Not configured");
  if (!endpoint.valid) return connection("Unavailable");
  if (!observation) return connection("Unknown");
  return observedConnection(observation, defaultSource);
}

function featureConnection({
  endpoint = null,
  observation = null,
  claimed = false,
  providers = [],
  source = null,
  knownUnsupported = false,
  unknownWhenConfigured = false
}) {
  if (endpoint?.configured && !endpoint.valid) return connection("Unavailable");
  if (observation) return observedConnection(observation, source);
  if (claimed) {
    if (providers.some(provider => provider.status === "Stale")) {
      const provider = providers.find(item => item.status === "Stale");
      return connection("Stale", source || provider.source, provider.updatedAt);
    }
    if (providers.some(provider => provider.status === "Connected")) {
      const provider = providers.find(item => item.status === "Connected");
      return connection("Connected", source || provider.source, provider.updatedAt);
    }
    if (providers.some(provider => provider.status === "Unavailable")) {
      const provider = providers.find(item => item.status === "Unavailable");
      return connection("Unavailable", source || provider.source, provider.updatedAt);
    }
    return connection("Unknown", source);
  }
  if (knownUnsupported) return connection("Not configured");
  if (endpoint?.valid || unknownWhenConfigured) return connection("Unknown");
  return connection("Not configured");
}

function observedConnection(observation, fallbackSource) {
  const freshness = String(observation.freshness || "").toLowerCase();
  const status =
    freshness === "stale"
      ? "Stale"
      : normalizeStatus(observation.status) || (freshness === "current" ? "Connected" : "Unknown");
  return connection(status, observation.source || fallbackSource, observation.updatedAt);
}

function connection(status, source = null, updatedAt = null) {
  return {
    status: STATUS_SET.has(status) ? status : "Unknown",
    source: safeSource(source),
    updatedAt: timestamp(updatedAt)
  };
}

function normalizeStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  return (
    {
      connected: "Connected",
      available: "Connected",
      current: "Connected",
      "not-configured": "Not configured",
      "not configured": "Not configured",
      unavailable: "Unavailable",
      stale: "Stale",
      unknown: "Unknown"
    }[text] || null
  );
}

function reportCopy(connections, environment, transitConfigured) {
  if (!transitConfigured) {
    return {
      summary: "Transit services are not connected",
      detail: "Walk remains available using OpenStreetMap pedestrian data.",
      overallStatus: "Not configured"
    };
  }
  if (!environment.valid) {
    return {
      summary: "Transit configuration needs attention",
      detail: "Review the development diagnostics. Walk remains available using OpenStreetMap pedestrian data.",
      overallStatus: "Unavailable"
    };
  }
  const statuses = Object.values(connections).map(item => item.status);
  if (statuses.includes("Stale")) {
    return {
      summary: "Transit connection data is stale",
      detail: "Time-sensitive transit or accessibility information will not be treated as current.",
      overallStatus: "Stale"
    };
  }
  if (statuses.includes("Connected")) {
    return {
      summary: "Transit connections checked",
      detail: "Use the rows below to confirm which services are connected and current.",
      overallStatus: "Connected"
    };
  }
  if (statuses.includes("Unavailable")) {
    return {
      summary: "Transit services are unavailable",
      detail: "Configured services could not be verified. Walk remains available using OpenStreetMap pedestrian data.",
      overallStatus: "Unavailable"
    };
  }
  return {
    summary: "Transit connections are not yet verified",
    detail: "Connection checks do not download MTA data. Trip-specific services are verified when a route is requested.",
    overallStatus: "Unknown"
  };
}

function endpointDiagnostic(endpoint) {
  return {
    configured: endpoint.configured,
    valid: endpoint.valid
  };
}

function safeSource(value) {
  if (!value) return null;
  return String(value)
    .replace(/https?:\/\/\S+/gi, "[endpoint]")
    .replace(/(?:token|secret|password|api[-_]?key)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 120);
}

function timestamp(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
