# PathForAll — NYC Accessible Navigation

PathForAll is a mobile-first route planner for people whose trips depend on conditions such as step-free access, curb ramps, sidewalk slope, surface quality, elevator status, transfer count, weather exposure, and street-light evidence. The map remains visible while people search, select endpoints, compare routes, and navigate.

## Architecture

The client is a typed-check JavaScript Vite application built around one route contract. Every walking, provider-topology, and server-provider route is normalized into a `RouteOption` containing ordered `legs`, totals in seconds/meters, accessibility evidence, warnings, freshness, expiry, and a data-source label. Cards, map layers, navigation, saved routes, and segment review all consume that shared model.

- `app.js` coordinates the one MapLibre instance, selected places, route-session cancellation, and product screens.
- `search-controller.js` owns the asynchronous combobox and keyboard interaction; `geocoding.js` provides NYC-wide Photon search with bounded Nominatim supplementation and reverse geocoding.
- `osm-network.js` loads a temporary OSM route corridor and admits dedicated paths or roads with explicit pedestrian evidence. It returns connected street/path geometry or no route.
- `route-model.js`, `route-presentation.js`, and `route-layer-data.js` validate and present normalized routes without source-specific UI fields.
- `route-service.js` adapts an application-owned routing service when configured.
- `transit-network-service.js` requests fresh, trip-scoped provider topology and validates namespaced MTA and Statue City Cruises identifiers at the boundary.
- `transit-routing.js` validates service time, scheduled waits, transfer geometry, accessible entrance-to-platform paths, and Bus, Subway, Ferry, or Mixed movement.
- `transit-realtime.js` requests every boarding separately, never generates fake live arrivals, and re-ranks after valid waits are attached.
- `ferry-service.js` recognizes Liberty Island and Ellis Island as ferry-required destinations.
- `storage-adapter.js`, `fetch-client.js`, and the domain stores centralize schema migration, corrupt/quota recovery, timeout, retry, and user-visible errors.

## NYC coverage

The map, search, click selection, GPS validation, and route input use the five-borough boundary:

```text
west -74.2591 · south 40.4774 · east -73.7004 · north 40.9176
```

All coordinates use `[longitude, latitude]`. The visible place marker always remains at the actual searched, GPS, or tapped location. A local route may attach an endpoint only by splitting mapped pedestrian geometry within two meters of the selected point; otherwise it is rejected. No straight or hidden access leg is invented.

## Data and service configuration

Copy the optional example configuration if connecting application-owned services:

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `VITE_ACCESSIBLE_ROUTING_URL` | POST endpoint for normalized walking/transit routes across NYC. It keeps protected provider keys on the server. |
| `VITE_ACCESSIBLE_ROUTING_MODES` | Explicit comma-separated modes supported by that route provider. Safe default: `walk`. |
| `VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL` | Optional capability endpoint for modes, realtime arrivals, complete elevator accessibility paths, Ferry schedules, source, and freshness timestamps. |
| `VITE_TRANSIT_NETWORK_URL` | GET endpoint returning trip-scoped provider-derived `stops` and directed `edges`. |
| `VITE_TRANSIT_ARRIVALS_URL` | GET endpoint returning predictions for each exact transit boarding. |

An accessible routing service receives `{ start, end, needs, mode, departureTime }` with `[longitude, latitude]` coordinates. It must return individual route legs, verified geometry for every non-trivial walking/transfer segment, explicit modes, accessibility metadata, freshness/expiry timestamps, and honest data-source labels. Invalid, stale, disconnected, or mode-mismatched responses are discarded.

When no transit service or provider topology is configured, Bus, Subway, Ferry, and Mixed are disabled. They do not fall back to the Cooper Union teaching fixture or a fabricated transit line.

The Transit Data panel validates these five settings, reports each service independently, and never treats a configured URL as proof of a live connection. With no transit backend, transit modes are disabled and the panel states that Walk remains available from OSM pedestrian data. **Check connections** checks only configured capability/health information; it does not download MTA data. Development builds expose sanitized diagnostics containing configuration booleans, accepted modes, status, source labels, and timestamps—never credentials or complete endpoint URLs.

Configuration URLs must use HTTPS, except for localhost development. Embedded credentials, fragments, credential-like query parameters, unsupported routing modes, orphan capability endpoints, and orphan arrival endpoints are reported as configuration errors.

## What is real today

- Map tiles, NYC place search, reverse geocoding, and corridor street/path geometry use public OpenStreetMap-backed services at runtime.
- Walking route candidates respect the selected profile and one-time requirements where OSM provides enough pedestrian, curb, surface, slope, lighting, and elevator evidence. Strict requirements fail closed on critical unknowns.
- GPS, route preview, local saved routes, field-review notes, and navigation session metrics work locally in the browser.
- Local profiles, saved routes, and reviews are versioned and recover from corrupt or quota-limited browser storage.

## What requires an external provider or backend

- Reliable long-distance/cross-borough accessible routing needs an application-owned routing backend.
- Bus, subway, ferry, and mixed itineraries require fresh provider topology with current schedules; station entrance paths, working-elevator status, transfer geometry, and service alerts require authoritative backend-normalized data.
- Real arrival times require `VITE_TRANSIT_ARRIVALS_URL`; otherwise cards accurately say that arrival times are unavailable.
- Ferry routing requires a verified current Statue City Cruises schedule and route geometry; destination recognition itself works from stable IDs, aliases, and small island geofences.
- Lighting evidence is OSM-tag based unless a provider supplies verified municipal lighting data. It is never presented as a safety guarantee.

## Run locally

```bash
cd /Users/ic/Downloads/pathforall-capstone-v7-pilot
npm ci
npm run dev
```

Use Node.js 22.16 or newer. Open the Vite address, normally `http://localhost:5173`.

## Test and build

```bash
npm test
npm run lint
npm run typecheck
npx playwright install chromium
npm run test:e2e
npm run build
npm run preview
```

`npm test` covers search/geography, route-trust boundaries, storage recovery, profiles, OSM corridor constraints, normalized provider routes, cards/layer data, time-dependent transit, arrival re-ranking, navigation safeguards, and stale request protection. Browser tests cover keyboard search, route-card semantics, dialog focus, background inertness, automated accessibility checks, responsive viewports, and 200% zoom. `npm run build` produces a production Vite bundle in `dist/`; `dist/` and `node_modules/` are intentionally excluded from source delivery.

## Using the product

1. Search for both places, use **Current location**, or choose either endpoint directly on the map.
2. Select Walk, Bus, Subway, Ferry, or Mixed and optionally add one-time trip needs.
3. Compare route cards for duration, distance, data coverage, critical unknowns, lighting, surface/slope evidence, and transit/elevator status.
4. Select a route, then choose **Start navigation** for turn-by-turn instructions, ETA, remaining distance, live GPS, preview movement, and automatic rerouting.
5. Use **Review route data** to save a local field review for a walking segment; marked barriers are excluded on the next calculation.

## Accessibility and safety notes

- Unknown data is not proof that a path is accessible.
- A route with missing walking, transfer, or transit shape data is rejected or the unverified line is omitted; the app never draws a misleading straight segment.
- Phone GPS normally requires HTTPS outside `localhost`; indoor station positioning is not reliable.
- Local field reviews expire after 30 days, remain on this device, and are neither moderated nor shared.
- Automatic off-route detection is active only during a walking step with sufficiently accurate GPS. Vehicle legs do not trigger pedestrian rerouting.
- This project supports research and testing. People should confirm time-sensitive elevator, construction, and service conditions with the relevant transit agency before travel.

## Key files

```text
app.js                       Map UI, selection, planning, navigation, local workflow
search-controller.js         Search requests, combobox state, keyboard behavior
route-model.js               Shared RouteOption validation and adapters
route-service.js             Server-route adapter
transit-network-service.js   Provider topology loader
transit-routing.js           Time-dependent accessibility-aware transit algorithm
transit-realtime.js          Provider-only arrival integration
ferry-service.js             Statue City Cruises destination and terminal policy
route-presentation.js        Safe route-card view model/markup
route-layer-data.js          Verified GeoJSON map features
route-session.js             Abort/stale-request protection
storage-adapter.js           Versioned local-storage recovery and error surface
fetch-client.js              Shared timeout, retry, and HTTP error policy
tests/fixtures/              Test-only Cooper Union teaching data
tests/e2e/                   Playwright keyboard, accessibility, and viewport checks
```
