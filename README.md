# PathForAll

PathForAll plans trips in New York City with mobility preferences in mind. It compares routes, shows where the accessibility data comes from, and distinguishes a known barrier from a gap in the data. Route guidance is based on maps and agency data; it is not an assessment of whether a particular person can safely take a route.

| Feature | What it uses |
| --- | --- |
| Walking | A bounded OpenStreetMap pedestrian graph. Paths, crossings, slope, curbs, and surface are evaluated when the data supports them. |
| Bus, subway, and All Transit | A configured OpenTripPlanner (OTP) graph with calendar-valid feeds. All Transit can return a trip using a single mode. |
| LIRR and ferry | Separate modes, enabled only when the running graph reports usable service for them. The default graph includes LIRR. An optional official NYC Ferry feed was verified separately. |
| Search, map, and guidance | NYC address and place search, reverse lookup, location and map pins, route comparison, and on-device navigation. |
| Profiles, saved routes, and reviews | Stored in the browser. A trip can apply different requirements without changing its saved profile. Reviews are local. |

See the [engineering handoff](docs/engineering-handoff.md) for measured coverage, verification, and release limitations.

## Run the app

Use the Node version in [`.nvmrc`](.nvmrc). A transit graph additionally requires Java 21, Python 3.11 or newer with time-zone data, and disk and memory for OTP. From the `PathForAll` directory:

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

Open `http://127.0.0.1:8787`. This starts the walking app and its API. Transit modes remain unavailable until the provider is ready. Search and map data use external sources even in walking-only mode.

To enable transit, build and start OTP as described in [Transit setup](MTA_INTEGRATION.md), then set these server variables in `.env` and restart PathForAll:

```dotenv
OTP_URL=http://127.0.0.1:8080/otp/gtfs/v1
TRANSIT_MANIFEST=otp-data/manifest.json
```

```sh
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/ready
npm run evaluate:live
```

For development, use `npm run dev:server` and `npm run dev` in separate terminals. Uncomment the two same-origin `VITE_ACCESSIBLE_ROUTING_…` URLs in `.env`. Vite proxies `/api/` to the configured local server port. Vite alone supports frontend development without a transit graph.

## Deploy

Run OTP on a private address, with its graph and matching manifest on operator-managed storage. Build the frontend with `npm ci && npm run build` and run `npm start` as an unprivileged service behind an HTTPS reverse proxy. Forward the original host to Node and keep the frontend and `/api/` on the same origin. Serving only `dist/` does not run the API. See [`.env.example`](.env.example) for timeouts, rate limits, and split hosting. For split hosting, explicitly allow exact frontend origins through `ALLOWED_ORIGINS` and set the frontend service URLs before building. Do not put credentials in `VITE_*`.

`/api/health` checks the process. `/api/ready` checks OTP's graph, its route/feed inventory, and schedule dates. Gate a transit deployment on readiness and representative route requests. For a deliberate walking-only deployment, use liveness. The built-in limiter is per observed peer address per process; configure an appropriate rate limit at the reverse proxy when it shares a peer address across clients. Review the usage terms and replace public development geocoding, tiles, and pedestrian data endpoints with services authorized for the deployment volume.

## Accessibility and privacy

A route can contain confirmed accessible features, confirmed barriers, unknown evidence, stale observations, or unavailable data. Strict constraints reject known barriers and required evidence gaps. A user can elect to see routes containing unknowns; doing so does not permit known barriers. Endpoint coordinates and mapped access points are separate. An unverified short gap is disclosed without drawing a walk across it. A live elevator feed or a transit agency's accessible-station label does not establish the condition of a specific connecting path.

Search text and map coordinates are sent to the configured geocoder, map and street data services, and transit provider as needed. Optional weather retrieval also sends coordinates. Browser location access requires permission and a secure origin. Profiles, saved routes, route reviews, and pilot interaction data stay in browser storage; use the app's available clear controls or site settings to remove them. The Node API has no user database and does not log itinerary coordinates or preferences. Operators should apply the same restraint to proxy access logs. Public tile and geocoding services are subject to their own terms and privacy policies.

## Verify and troubleshoot

```sh
npm run syntax
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm audit
npm run package
```

Use `npm run verify` to run the deterministic local checks and package the source. The Playwright install is a separate step; on supported hosts, an existing compatible headless executable can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. CI's `release-gate` requires the quality and browser jobs. These checks use fixtures and do not require production API credentials. The separate live evaluation uses the actual configured graph.

- **Transit is disabled:** inspect `/api/capabilities` and `/api/ready`. Verify the GraphQL API is running at the configured GTFS endpoint, the manifest matches the graph, and the feed dates are usable.
- **No result:** the app distinguishes unavailable service, a provider failure, a disconnected access path, an accessibility restriction, and an inconclusive search. Try another mapped entrance or departure time if the message supports that action.
- **Map or search is blank:** check tile/geocoding connectivity, quota, and usage permissions. The bundled map worker is served from the application origin.
- **Search, routing, or verification seems time dependent:** time input and schedule output use New York time. A nonexistent DST wall time is rejected; repeated wall times use the earlier occurrence for the wall-time UI. An explicit offset disambiguates API requests.

Data attribution: [OpenStreetMap contributors (ODbL)](https://www.openstreetmap.org/copyright), [BBBike extracts](https://download.bbbike.org/osm/bbbike/), [MTA developer resources](https://www.mta.info/developers), [NYC Ferry developer resources](https://www.ferry.nyc/developer-tools/), [Photon](https://github.com/komoot/photon), [Open-Meteo](https://open-meteo.com/), and [OpenTripPlanner](https://www.opentripplanner.org/). Source and runtime data have different terms. See [architecture](docs/architecture.md) and [transit setup](MTA_INTEGRATION.md) for provider boundaries and known limits.
