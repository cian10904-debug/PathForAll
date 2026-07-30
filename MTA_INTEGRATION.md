# MTA and Statue City Cruises integration contract

## What the repository uses today

The browser does **not** directly download or decode official MTA static GTFS, GTFS-Realtime, Bus Time, service-alert, or elevator inventory feeds. This repository contains no backend ingestion service and no MTA API key.

The production client uses only application-owned, normalized JSON endpoints when they are configured:

| Browser setting | Contract |
| --- | --- |
| `VITE_ACCESSIBLE_ROUTING_URL` | POST a complete normalized itinerary for a mode explicitly listed by the provider capabilities. |
| `VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL` | GET `{ modes, realtimeArrivals, elevatorAccessibilityPaths, ferrySchedules, freshness, updatedAt }`. A generic elevator-status flag does not confirm a complete path. |
| `VITE_TRANSIT_NETWORK_URL` | GET a trip-scoped corridor containing normalized `stops` and directed `edges`. |
| `VITE_TRANSIT_ARRIVALS_URL` | GET normalized predictions for one exact boarding stop, route, trip, mode, and leg index. |

`VITE_ACCESSIBLE_ROUTING_MODES` is the safe capability fallback. Its default is `walk`; configuring a URL no longer implies Bus, Subway, Ferry, or Mixed support. The client rejects a transit network unless its envelope is `freshness: "current"` and contains parseable `updatedAt` and `expiresAt` values.

## Required server-side flow

```text
MTA static GTFS
  → stops, parent stations, routes, trips, stop times, calendars,
    calendar exceptions, shapes, transfers, wheelchair fields

MTA GTFS-Realtime and Bus Time
  → protobuf decoding, feed-group selection, trip updates,
    vehicle positions, skipped stops, cancellations, alerts

MTA station accessibility and elevator asset/status snapshots
  → stable equipment codes joined to entrances, fare-control areas,
    platform directions, and complete accessible paths

Application-owned ingestion and routing service
  → versioned, freshness-checked PathForAll JSON

Browser
  → route comparison, verified map geometry, and navigation
```

Provider credentials and protobuf decoding belong on the server.

## Static GTFS

The backend must construct the routable schedule from static GTFS. Realtime arrivals alone cannot establish stop order, service calendars, transfers, shapes, or a complete transit network.

The normalized itinerary must preserve:

- provider stop, route, and trip IDs;
- parent-station and directional platform stop IDs;
- direction and headsign;
- forward stop sequence;
- service date and calendar exception decisions;
- wheelchair boarding fields where supplied;
- verified shape geometry, or `null` when no verified shape exists.

## Bus identifiers

MTA Bus Time IDs such as `MTA_308209` are normalized only at the provider boundary. The browser adapter emits a namespaced ID such as `mta:bus:stop:308209` and keeps `providerId: "MTA_308209"` for diagnostics. It does not globally add or strip prefixes.

## Subway feed groups and identifiers

The backend is responsible for selecting and decoding the relevant official subway feed group, then joining trip updates to static GTFS by trip and directional stop IDs. A station name is never an arrival key.

Return stable, provider-scoped fields such as:

```js
{
  stationComplexId: "mta:subway:complex:...",
  parentStationId: "mta:subway:station:...",
  platformStopId: "mta:subway:platform:...",
  directionId: "...",
  entranceId: "...",
  accessiblePaths: []
}
```

## Elevator and accessible-path status

The asset inventory is a published snapshot, not second-by-second telemetry. Every normalized equipment record contains:

```js
{
  equipmentCode: "...",
  status: "working" | "out" | "unknown",
  source: "...",
  updatedAt: "..." | null,
  freshness: "current" | "stale" | "unknown",
  pathIds: []
}
```

Equipment codes are joined to explicit accessible paths. A path is usable only when it is complete for the required entrance, fare-control area, platform/direction, and action. One failed elevator invalidates only the paths it serves; another complete working path can keep the station complex usable.

`freshness: "unknown"` and missing timestamps fail closed. OSM elevator mapping is inventory evidence only and never becomes a live working status. The old small station-name alias map and direct browser download were removed.

## Scheduled service and transfers

Every vehicle edge used by the small client router must carry current, verified schedule evidence: a timestamped departure list, a service frequency window, or an explicitly scheduled boarding wait. Service-day and active-alert checks are applied at the arrival time at that edge. Without this evidence, the client returns `SCHEDULE_UNAVAILABLE`.

Transfer edges must include:

- explicit `fromMode` and `toMode`;
- provider confirmation;
- verified pedestrian geometry and duration;
- a complete accessible path for strict trips.

Stop and edge joins use provider/agency/mode compound keys. Ambiguous IDs and cross-provider endpoint collisions are rejected as provider-contract failures.

## Realtime arrivals

PathForAll identifies every boarding group. Bus → Subway, Subway → Bus, and transit → Ferry trips therefore request predictions separately for each boarding.

The backend should return:

```js
{
  source: "MTA normalized provider",
  sourceLabel: "Realtime",
  updatedAt: "...",
  maxAgeSeconds: 180,
  predictions: [{ timestamp: "..." }],
  scheduledPredictions: []
}
```

Stale realtime predictions are not shown as current. Scheduled predictions remain labeled `scheduled`. Missing data never produces a fabricated arrival. After predictions are attached, alternatives are ranked again using final travel time, transfer count, and route trust while retaining stable IDs.

## Service alerts

The backend should apply alerts before returning an itinerary. The small client graph also rejects edges marked cancelled, skipped, inactive, outside their service calendar, or affected by active no-service/closed-path alerts.

Version fields should accompany results:

```js
{
  dataVersion: "...",
  serviceAlertVersion: "...",
  elevatorStatusVersion: "...",
  updatedAt: "..."
}
```

Transit routes are not cached in the browser, so an earlier outage-sensitive result cannot survive later service or elevator changes.

## Ferry

Liberty Island and Ellis Island use **Statue City Cruises**, the National Park Service-authorized operator. IDs are namespaced separately from MTA, for example:

```text
statue-city-cruises:terminal:battery
statue-city-cruises:terminal:liberty-state-park
statue-city-cruises:dock:liberty-island
statue-city-cruises:dock:ellis-island
```

The route provider must include ticket, reservation, security-screening, schedule-source, schedule timestamp/freshness, departure time, and accessibility fields. If a verified current schedule or shape is unavailable, the client returns a controlled unavailable state and does not invent a departure time or draw a direct line across New York Harbor.

## Structured failures

Normalized services may return codes including:

```text
TRANSIT_PROVIDER_UNAVAILABLE
NO_NEARBY_BUS_STOP
NO_ACCESSIBLE_STATION
NO_ACCESSIBLE_SUBWAY_PATH
ELEVATOR_PATH_UNAVAILABLE
NO_SERVICE_AT_THIS_TIME
REALTIME_DATA_STALE
TRIP_CANCELLED
NO_VALID_TRANSFER
FERRY_CLOSED
FERRY_TICKET_REQUIRED
FERRY_SCHEDULE_UNAVAILABLE
SCHEDULE_UNAVAILABLE
TRANSIT_DATA_STALE
PROVIDER_CONTRACT_ERROR
ENDPOINT_CONNECTOR_UNAVAILABLE
```
