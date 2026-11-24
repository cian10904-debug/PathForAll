# Engineering handoff: PathForAll 8.0.0

This branch repairs startup, walking evidence, and scheduled transit routing. It is suitable for review and a controlled transit pilot with the tested graph. It does not establish citywide production readiness or a guarantee of physical accessibility.

## Audited baseline

The audit re-fetched four relevant branch tips on 2026-11-24. The base was `main` at `095ff57678686d16818acb389d0890384fc37b33`. `add-real-transit` at `07de74917a70668942c4395fa4b3eb5d340520b1` was four commits ahead and one behind. `agent/repair-production-routing` at `4700412e58888cd28ddd9932b67d2190c122a152` and `manual-walk-fix` at `d0570aec0268bb2134399f063cf7fb236e29f5c5` were already ancestors. There were no open PRs when inspected. The latest five available Actions runs failed. In the inspected default and transit-branch runs, install passed, lint failed, and later checks were skipped. Archived job logs returned HTTP 410; these failures were reproduced from the checked-out sources.

The default branch had duplicate declarations and object keys, including a missing comma in `osm-network.js`. The transit branch still failed lint and its post-response elevator logic referenced block-scoped request variables. The branches were compared, rather than merged. The routing ideas were consolidated into a modular backend, and the user's reviewed v8 archive supplied validated walking, evidence, and browser work that was absent from GitHub. There is no archived server or dataset in the branch.

| Finding | Status | Change and evidence |
| --- | --- | --- |
| Startup, lint, packaging | Fixed | Removed invalid duplicates and syntax. Canonical, size-checked source archive works outside a Git checkout. |
| Default branch had no transit provider; Bus could report the wrong failure | Fixed for configured data | Private OTP 2.8.1, structured errors with candidate rejection causes, distinct health/readiness, tested fallback. Valid but bounded empty searches remain inconclusive where appropriate. |
| Transit began before access walk; same-line trips could collapse into one | Fixed | Chronology checks requested departure, access, waits, transfers, and dwell. Trip identity and explicit continuation determine whether another boarding is required. |
| Mixed required multiple modes | Fixed | All Transit accepts bus-only, subway-only, and multimodal results. The request mode and actual modes are separate; saved `mixed` selections stay compatible. |
| Browser clock affected service calendars | Fixed for supported NYC agencies | Absolute API times, NYC wall-time UI, GTFS service-day handling including midnight, DST, frequency, and exceptions. Deterministic regressions exercise multiple machine time zones. |
| Curb and route-cost distortion | Fixed | Both curbs evaluated; unknown and inaccessible differ. Continuous costs scale with travel exposure; discrete crossing costs are charged once. Endpoint projections are disclosed instead of drawn as invented paths. |
| Coverage, physical accessibility, and live disruption data | Mitigated; broader verification deferred | Report unknown and unavailable evidence, require it under strict settings, reject reported cancellations, keep scheduled trips available when realtime is absent. No deployed official elevator, realtime, or alerts pipeline was verified. |
| Unbounded or unsafe I/O and public defaults | Mitigated | Body, time, and concurrency bounds, cancellation, schema checks, retry policy, external URL validation, escaped UI strings, opt-in authorized geocoding fallback. Dependency remediation removed the baseline findings (14 on the default lockfile at review time). This was a code and dependency review; external penetration and load testing were not performed. |
| UI, type checking, and deployment | Improved | Extracted helpers and enabled `checkJs` for root production JavaScript, server, scripts, and evaluation. Type annotations still have room to tighten. `app.js` remains the main coordinator. Browser checks cover keyboard/focus, 200% CSS zoom reflow, route cards, stored data, mobile map picking, and navigation lifecycle. Human screen-reader and field tests remain open. |

Key paths: `server/` contains HTTP, configuration, OTP, and data modules. `route-model.js`, `route-timeline.js`, `agency-time.js`, and `accessibility.js` define shared rules. `route-service.js` and `route-session.js` orchestrate browser requests. `scripts/bootstrap-transit.py`, `scripts/evaluate-live.js`, `scripts/audit-gtfs.py`, and `evaluation/` support reproducible checks. See [architecture](architecture.md), [startup](../README.md#run-the-app), and [transit setup](../MTA_INTEGRATION.md).

## Verification and measured samples

Local verification used Node 24.22.3, OTP 2.8.1, and headless Chromium 158. The build and quality gates cover syntax, ESLint/Stylelint/HTML validation and formatting, TypeScript checks, 23 unit/integration scripts, nine browser scenarios, Vite build, npm audit, and source packaging. The OTP operations were checked against the pinned release's GraphQL schema. In this workspace the Playwright CDN returned HTTP 403; the browser checks used an independently installed matching headless executable. The GitHub gate uses the usual Playwright installation. Browser fixtures use simulated geocoding, tiles, and provider responses; the live evaluation below exercises the real backend, graph and feeds separately.

The pilot used a clipped BBBike NY street extract and eight official MTA feeds, matching the bootstrap manifest. Bounds were longitude −74.05 to −73.84, latitude 40.63 to 40.86; the graph reports 452,676 vertices and 15,552 transit stops, some outside the usable street coverage. The full extract attempt was killed by the host while indexing streets. Test departures were November 24, 2026 at 4:30 p.m. New York time. Six supported cases returned five alternatives each:

| Sample | Result | Request time |
| --- | --- | ---: |
| Manhattan M8, street to street | Direct bus | 3,748 ms (first request) |
| Lower East Side to Yorkville | Direct bus alternatives | 539 ms |
| Times Square to Queens | Bus alternatives, including two transfers | 1,230 ms |
| Manhattan to Brooklyn | Subway | 698 ms |
| Astor Place to Penn Station, All Transit | Subway-only accepted | 656 ms |
| Woodside to Penn Station | LIRR; mismatched optional vehicle shape excluded | 310 ms |

The independent GTFS check matched all 32 ride occurrences across the returned alternatives to the original stop order and clock times. The first returned route in each supported case took approximately 19–72 minutes and included 70–1,101 m of mapped walking. These are individual local API timings on a shared host, with no load test. A strict wheelchair sample was refused because the endpoint walk could not be verified; an out-of-coverage sample returned `OUTSIDE_TRANSIT_COVERAGE`. Ferry was disabled because the graph had no usable ferry feed.

A separate frozen real OSM evaluation of 32 walking cases returned 24 routes, with three insufficient-evidence cases, one known constraint failure, and four incomplete-coverage cases. Auditing raw tags found zero constraint errors among the 24 returned routes and no reference-connectivity failures. On the sampled host, routing p50/p95 were 64/153 ms after the graph was loaded; construction took 1.06 s and the recorded external snapshot retrieval took 19.14 s. These results measure software behavior against mapped data, without field/user verification.

## Size and release limits

| Measurement | Baseline | This release candidate |
| --- | ---: | ---: |
| Tracked source blobs | 64 files, 702,831 bytes | Approximately 0.93 MB |
| Hosting/local Git storage | GitHub reported 397 KB; initial local clone 284,581 bytes | Local checkout approximately 0.58 MB before packing; GitHub's cached size updates independently |
| Production output | No successful build to compare | 1.98 MB across HTML, CSS, main JS and worker; about 0.54 MB compressed |
| Installed npm tree | Approximately 208 MB on the audited transit branch | Approximately 185 MB, including development tools |
| Runtime transit data | No working graph on the default branch | Pilot runtime 581 MB including engine, inputs, street graph and final graph; final graph 253 MB |

The build emits a chunk-size warning for the map/application bundle; there is no field measurement of initial load on mobile networks. Runtime inputs, dependencies and output are excluded from source control and packaging.

Before a prospective full public release, verify the complete deployment and street coverage; provision and validate a refresh process, any promised ferry and realtime/elevator feeds, reverse-proxy limits, and end-user accessibility checks. Set up the actual production data providers under appropriate usage terms. Validate representative accessible routes in the field. No deployment or merge is part of this branch. The pull request records delivery and remote CI status.
