# Transit setup

PathForAll uses OpenTripPlanner **2.8.1** and its GTFS GraphQL API. The default bootstrap pins the release JAR by SHA-256 and explicitly assigns feed IDs for MTA borough bus, MTA Bus Company, subway and LIRR feeds. It reads each agency's calendar in `America/New_York`. The street source is the BBBike New York City extract of OpenStreetMap. MTA data remains subject to [its terms](https://www.mta.info/developers); the street data is subject to the [ODbL](https://www.openstreetmap.org/copyright).

## Build and run

From the project root, with Java 21 and Python 3.11+ installed:

```sh
python3 scripts/bootstrap-transit.py --directory otp-data --heap 6g
java -Xmx6g -jar otp-data/otp-shaded-2.8.1.jar --load --port 8080 --bindAddress 127.0.0.1 otp-data
```

Allow substantial memory beyond the heap for the OS and JVM. This build can take several minutes and requires space for the JAR, data archives, street graph, and final graph. The default full extract was not validated to completion in the constrained audit environment. The verified pilot used a smaller street extract and all eight GTFS feeds. You can reproduce its footprint as follows, after downloading the same BBBike NewYork PBF into the runtime directory:

```sh
python3 -m venv otp-data/clip-env
otp-data/clip-env/bin/pip install osmium==4.3.2
otp-data/clip-env/bin/python scripts/clip-osm.py otp-data/new-york.osm.pbf otp-data/pilot.osm.pbf --bounds -74.05 40.63 -73.84 40.86
python3 scripts/bootstrap-transit.py --directory otp-data/pilot --heap 4g --osm-file otp-data/pilot.osm.pbf --osm-source https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf
```

Point the Java command and `TRANSIT_MANIFEST` at `otp-data/pilot` for this build. Confirm exact options with `scripts/clip-osm.py --help`. The pilot's street bounds do not cover all five boroughs; feed inventory alone does not prove every stop is street-connected. The optional `--ferry-gtfs` and `--ferry-source` require an authoritative, licensed upload with usable calendar data and a graph containing actual ferry routes. An absent ferry feed leaves the mode disabled.

Configure `OTP_URL` and `TRANSIT_MANIFEST` as described in the README. Keep OTP private; give browsers the PathForAll URL. For an independent backup instance, set `OTP_FALLBACK_URL` and `TRANSIT_FALLBACK_MANIFEST`. Both must describe meaningful applicable coverage. The server does not automatically fall back from a valid no-route result to an unrelated dataset.

## Refresh and evidence

Build refreshes in a staged directory. A failed download can reuse a previously validated, calendar-valid archive in that directory. `--reuse-downloads` skips retrieval for existing inputs; `--reuse-streets` requires the same OSM SHA and OTP version. Never edit an actively serving graph in place. Start the candidate graph, point a test PathForAll backend at its manifest and API, verify readiness and sampled routes, then switch the running service. Keep the previous graph/manifest pair available for replacement while its calendar is valid.

The manifest records each feed's source, hash, retrieval timestamp, version where published, calendar window, and graph build time and hash. An HTTP success does not refresh any observation. OTP routing uses scheduled service without requiring realtime. If an operator provisions OTP realtime updaters, route processing distinguishes realtime state from the scheduled boarding and arrival timestamps and ignores invalid or cancelled itinerary data. A usable official realtime, alerts, and elevator deployment is separate: this release does not provision or verify those pipelines, and missing data cannot confirm accessibility. Operator adapters may supply arrivals or topology if they implement and validate the application contract; bundled fixtures are not sources of service information.

Verify the pinned GraphQL schema with `npm run verify:otp-schema`. Run `npm run evaluate:live` against the running Node API; use `PFA_API_URL`, `PFA_EVAL_DATE`, `PFA_EVAL_TIME` (New York wall time), and `PFA_EVAL_OUTPUT` as needed. The independent schedule audit expects the exact inputs from the graph:

```sh
PFA_EVAL_OUTPUT=evidence/live-transit.json npm run evaluate:live
python3 scripts/audit-gtfs.py evidence/live-transit.json otp-data
```

The script verifies onboard stop sequence and scheduled times against raw GTFS records. It cannot establish land-side passability, live elevator status, or complete geographic coverage. An API client sends `POST /api/routes` with numeric `start`/`end` in longitude/latitude order, `mode` (`bus`, `subway`, `ferry`, `rail`, `mixed`), an ISO departure with offset, and optional normalized `needs`. Results use seconds, meters, and ISO timestamps.
