# V7.1.0 repair summary

## Transit connection status repair

- Replaced the misleading combined elevator/Ferry message with five independent connection rows for routing, schedules, arrivals, accessible elevator paths, and Ferry schedules.
- Renamed all remaining elevator-specific refresh identifiers to capability/connection language; the action now says **Check connections** and never implies that it downloads MTA data.
- Disabled Bus, Subway, Ferry, and Mixed when no transit backend is configured while keeping OSM-based Walk available.
- Added current source/timestamp display and the exact states Connected, Not configured, Unavailable, Stale, and Unknown.
- Added HTTPS, credential, secret-query, mode, and cross-field validation for all five supported environment variables.
- Added development-only sanitized diagnostics with Copy diagnostics; complete URLs, credentials, response bodies, and error causes are excluded.
- Added five connection-scenario tests and a browser test for the unconfigured state.

## Route correctness and data trust

- OSM elevators now default to unknown. Strict elevator routing accepts only current, timestamped, authoritative status for a complete entrance/fare-control/platform path.
- Local endpoints attach only to mapped pedestrian geometry within two meters; routes fail closed instead of hiding a long snap or inventing a straight connector.
- Unsupported motor-road centerlines and unknown critical curb ramps are excluded from strict wheelchair routes.
- Provider responses now require explicit leg modes, matching requested/actual mode, connected geometry, and fresh transit timestamps.
- Transit routing uses schedule/frequency waits at the requested departure time, validates every transfer, and re-ranks after boarding waits are enriched.
- Ferry-required destinations are resolved by provider ID, alias, or a small Liberty/Ellis Island geofence. Ferry legs require a verified current schedule.

## Product and accessibility

- Added distinct Wheelchair, Limited mobility, Older adult, and Custom preference presets without forcing wheelchair constraints.
- Replaced unexplained probability-like scores with data coverage, reviewed distance, source age, known barriers, and critical unknowns.
- Added keyboard-complete search comboboxes, roving travel-mode controls, semantic route selection, focus-managed overlays/dialogs, inert background content, safe-area layout, forced-color support, and 320px/200%-zoom browser checks.
- Kept the map visible behind Saved and Profile screens and added a real collapsible planner sheet.
- Added current/unknown weather handling, explicit provider status, controlled empty/loading/error states, privacy disclosures, and granular local-data deletion.
- Navigation now reroutes only on an accurate pedestrian GPS step, preserves the active route if rerouting fails, refreshes arrivals while active, and records completion once.

## Engineering and delivery

- Added a versioned storage adapter with migration, corruption recovery, quota fallback, and user-visible errors.
- Added a shared HTTP client with timeout, retry, abort, and typed failure handling.
- Split search interaction into its own controller and preserved domain modules for routing, transit, Ferry, navigation, profiles, trust, presentation, and storage.
- Added ESLint, Stylelint, HTML validation, type checking, Playwright, axe accessibility checks, CI, storage/safety regression tests, and patched dependency versions.
- Removed all production behavior tied to Cooper Union fixture graphs; fixtures remain test-only.
- Source delivery excludes `node_modules`, `dist`, and macOS metadata.
