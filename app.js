import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { planAllRoutes } from "./routing.js";
import {
  DEFAULT_BOUNDS,
  NYC_CENTER,
  buildRouteCorridor,
  connectRouteEndpoints,
  findNearestNode,
  loadLiveOsmGraph,
  haversineMeters
} from "./osm-network.js";
import { reverseGeocodePlace, createMapSelection, isInsideServiceArea } from "./geocoding.js";
import {
  applyMobilityPreset,
  clearProfile,
  loadProfile,
  saveProfile,
  signOutProfile,
  profileNeedsToLabels
} from "./profile-store.js";
import {
  buildRouteNavigationSteps,
  routeCoordinates,
  splitRouteGeometrySegments,
  isPedestrianOffRouteEligible,
  recordNavigationCompletionOnce,
  findNavigationProgress,
  remainingMinutes,
  distanceToRouteMeters
} from "./navigation.js";
import { applyTrustMetadata, clearSegmentReviews, loadSegmentReviews, saveSegmentReview, summarizeRouteTrust, routeEdgeIds } from "./trust-store.js";
import { clearPilotEvents, recordPilotEvent, pilotMetrics, exportPilotPayload } from "./pilot-store.js";
import { clearSavedRoutes, loadSavedRoutes, removeSavedRoute, saveRoute } from "./saved-store.js";
import { reportStorageError } from "./storage-adapter.js";
import {
  configuredRoutingCapabilities,
  hasAccessibleRoutingService,
  loadRoutingCapabilities,
  planServerRoutes,
  routeSourceForMode
} from "./route-service.js";
import { hasTransitNetworkService, loadTransitNetwork } from "./transit-network-service.js";
import { prepareTransitStops, planTransitRoutes } from "./transit-routing.js";
import { attachArrivalData, getTransitArrivals, rankRoutesAfterArrivals } from "./transit-realtime.js";
import { normalizeLocalTransitRoute, normalizeWalkingRoute } from "./route-model.js";
import { routeCardMarkup } from "./route-presentation.js";
import { routeLayerData } from "./route-layer-data.js";
import { createRouteSession } from "./route-session.js";
import { isFerryRequiredDestination, resolveFerryDestination, ferryUnavailableMessage } from "./ferry-service.js";
import { TransitProviderError, TRANSIT_ERROR_MESSAGES } from "./transit-errors.js";
import { fetchWithPolicy } from "./fetch-client.js";
import { createSearchController } from "./search-controller.js";
import {
  buildTransitConnectionReport,
  sanitizedTransitDiagnostics,
  transitEnvironment,
  transitModeAvailability
} from "./transit-connections.js";

"use strict";

const state = {
  map: null,
  mapLoaded: false,
  nodes: {},
  edges: [],
  networkReady: false,
  networkSource: "loading",
  networkCorridorKey: null,
  networkAbortController: null,
  routeSession: createRouteSession(),
  routeProviderCapabilities: configuredRoutingCapabilities(),
  routeProviderCapabilitiesPromise: null,
  startPlace: null,
  endPlace: null,
  startId: null,
  endId: null,
  endpointMarkers: { start: null, end: null },
  transitStopMarkers: [],
  travelMode: "walk",
  weather: { temperatureF: null, precipitation: null, isRaining: null, source: "unavailable", updatedAt: null, freshness: "unknown" },
  profile: loadProfile(),
  customNeedsDraft: [],
  routes: [],
  selectedRouteIndex: 0,
  segmentReviews: loadSegmentReviews(),
  transitDataStatus: { source: "loading", sourceLabel: "Checking", freshness: "unknown", elevatorStatus: false },
  transitConnectionReport: null,
  transitConnectionObservations: {
    routeProviderState: null,
    transitNetworkState: null,
    realtimeState: null
  },
  savedRoutes: loadSavedRoutes(),
  searchController: null,
  weatherTimer: null,
  weatherController: null,
  dialogTrigger: null,
  pageTrigger: null,
  mapPickType: null,
  tripNeeds: emptyTripNeeds(),
  navigation: {
    active: false,
    steps: [],
    stepIndex: 0,
    currentPosition: null,
    accuracy: null,
    watchId: null,
    demoTimer: null,
    clockTimer: null,
    arrivalTimer: null,
    demoIndex: 0,
    coordinates: [],
    currentMarker: null,
    lastSpokenStepId: null,
    offRouteCount: 0,
    rerouting: false,
    rerouteState: "idle",
    priorRouteSnapshot: null,
    selectedRouteKey: null,
    completedRecorded: false
  }
};

const els = {};

initializeApp();

function initializeApp() {
  cacheElements();
  bindEvents();
  state.customNeedsDraft = [...state.profile.needs.customNeeds];
  renderProfile();
  renderActiveNeeds();
  renderTemporaryNeeds();
  renderPilotMetrics();
  renderTransitConnectionStatus();
  setPlaceInput("start", null);
  setPlaceInput("end", null);
  initializeMap();
  fetchWeather();
  refreshTransitCapabilities({ silent: true });
}

function cacheElements() {
  const ids = [
    "networkBadge", "headerAvatarFallback", "headerAvatarImage", "profileAvatarFallback", "profileAvatarImage",
    "profileDisplayName", "profileEmailDisplay", "mapMessage", "mapPickBanner", "mapPickText", "cancelMapPickButton", "useMapCenterButton",
    "startSearch", "endSearch", "startSuggestions", "endSuggestions", "setStartOnMapButton", "setEndOnMapButton",
    "useLocationButton", "swapButton", "activeNeeds", "planButton", "plannerMessage", "resultsPanel",
    "resultsTitle", "routeCards", "closeResultsButton", "avatarPickerButton", "avatarTextButton", "avatarInput",
    "accountForm", "nameInput", "emailInput", "signOutButton", "needsForm", "savedStatus",
    "mobilityProfile", "avoidStairs", "requireCurb", "preferSmooth", "requireElevator", "preferShade", "avoidRain", "minimizeTransfers",
    "maxSlope", "maxSlopeOutput", "maxWalkMinutes", "maxWalkOutput", "customNeedInput", "addCustomNeedButton",
    "customNeedList", "tripAvoidStairs", "tripRequireElevator", "tripPreferSmooth", "tripPreferShade",
    "tripAvoidRain", "tripMinimizeTransfers", "speechLanguage", "tripNeedsInput", "voiceNeedsButton",
    "applyTripNeedsButton", "clearTripNeedsButton", "tripNeedsSummary", "startNavigationButton", "arrivalSourceNote",
    "navigationOverlay", "navigationTurnIcon", "navigationDistance", "navigationInstruction", "navigationDetail",
    "navigationEta", "navigationRemaining", "navigationAccuracy", "upcomingSteps", "recenterButton", "demoMovementButton",
    "endNavigationButton", "navigationMessage", "transitConnectionBadge", "transitDataSummary", "transitDataDetail",
    "checkTransitConnectionsButton", "transitConnectionList", "transitModeAvailability", "routeTrustSummary", "reviewSegmentsButton", "saveRouteButton", "savedPlacesList",
    "verificationPanel", "closeVerificationButton", "verificationList", "exportPilotButton", "metricRoutes",
    "metricCompleted", "metricReroutes", "metricReviews", "pilotMetricNote", "transitDiagnostics", "transitDiagnosticsJson",
    "copyTransitDiagnosticsButton", "copyTransitDiagnosticsStatus",
    "sheetToggleButton", "plannerContent", "searchStatus", "deleteSavedDataButton", "deleteReviewsButton",
    "deleteEventsButton", "deleteAllDataButton", "storageStatus", "navigatePage", "savedPage", "profilePage"
  ];
  ids.forEach(id => { els[id] = document.getElementById(id); });
  if (import.meta.env?.DEV) {
    const missing = ids.filter(id => !els[id]);
    if (missing.length) throw new Error(`Missing required DOM elements: ${missing.join(", ")}`);
  }
}

function bindEvents() {
  document.querySelectorAll("[data-page-target]").forEach(button => {
    button.addEventListener("click", () => {
      state.pageTrigger = button;
      showPage(button.dataset.pageTarget);
    });
  });

  const modeButtons = [...document.querySelectorAll(".mode-chip")];
  modeButtons.forEach(button => {
    button.addEventListener("click", () => setTravelMode(button.dataset.mode));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const enabledButtons = modeButtons.filter(candidate => !candidate.disabled);
      const current = enabledButtons.indexOf(button);
      if (current < 0 || !enabledButtons.length) return;
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const targetIndex = event.key === "Home" ? 0 : event.key === "End" ? enabledButtons.length - 1 : (current + direction + enabledButtons.length) % enabledButtons.length;
      const target = enabledButtons[targetIndex];
      target.focus();
      setTravelMode(target.dataset.mode);
    });
  });

  state.searchController = createSearchController({
    inputs: { start: els.startSearch, end: els.endSearch },
    panels: { start: els.startSuggestions, end: els.endSuggestions },
    statusElement: els.searchStatus,
    bounds: DEFAULT_BOUNDS,
    defaultCenter: NYC_CENTER,
    getMapCenter: () => {
      const center = state.map?.getCenter();
      return center ? [center.lng, center.lat] : null;
    },
    onSelect: selectPlace
  });
  state.searchController.bind();
  els.setStartOnMapButton.addEventListener("click", () => toggleMapPointSelection("start"));
  els.setEndOnMapButton.addEventListener("click", () => toggleMapPointSelection("end"));
  els.cancelMapPickButton.addEventListener("click", cancelMapPointSelection);
  els.useMapCenterButton.addEventListener("click", selectMapCenter);
  els.useLocationButton.addEventListener("click", useCurrentLocation);
  els.swapButton.addEventListener("click", swapEndpoints);
  els.planButton.addEventListener("click", calculateRoutes);
  els.closeResultsButton.addEventListener("click", closeResultsPanel);
  els.applyTripNeedsButton.addEventListener("click", applyTemporaryNeeds);
  els.clearTripNeedsButton.addEventListener("click", clearTemporaryNeeds);
  els.voiceNeedsButton.addEventListener("click", startVoiceNeedsInput);
  ["tripAvoidStairs", "tripRequireElevator", "tripPreferSmooth", "tripPreferShade", "tripAvoidRain", "tripMinimizeTransfers"]
    .forEach(id => els[id].addEventListener("change", applyTemporaryNeeds));
  els.startNavigationButton.addEventListener("click", startNavigation);
  els.endNavigationButton.addEventListener("click", endNavigation);
  els.recenterButton.addEventListener("click", recenterNavigation);
  els.demoMovementButton.addEventListener("click", toggleDemoMovement);
  els.checkTransitConnectionsButton.addEventListener("click", refreshTransitCapabilities);
  els.copyTransitDiagnosticsButton.addEventListener("click", copyTransitDiagnostics);
  els.saveRouteButton.addEventListener("click", saveSelectedRoute);
  els.savedPlacesList.addEventListener("click", handleSavedRouteAction);
  els.reviewSegmentsButton.addEventListener("click", openVerificationPanel);
  els.closeVerificationButton.addEventListener("click", closeVerificationPanel);
  els.verificationPanel.addEventListener("click", event => {
    if (event.target === els.verificationPanel) closeVerificationPanel();
    const action = event.target.closest("[data-review-status]");
    if (action) reviewSegment(action.dataset.edgeId, action.dataset.reviewStatus);
  });
  els.verificationPanel.addEventListener("keydown", trapVerificationFocus);
  els.exportPilotButton.addEventListener("click", exportPilotData);
  els.sheetToggleButton.addEventListener("click", togglePlannerSheet);
  els.deleteSavedDataButton.addEventListener("click", deleteSavedData);
  els.deleteReviewsButton.addEventListener("click", deleteReviewData);
  els.deleteEventsButton.addEventListener("click", deleteEventData);
  els.deleteAllDataButton.addEventListener("click", deleteAllLocalData);

  els.accountForm.addEventListener("submit", saveAccount);
  els.signOutButton.addEventListener("click", signOut);
  els.avatarPickerButton.addEventListener("click", () => els.avatarInput.click());
  els.avatarTextButton.addEventListener("click", () => els.avatarInput.click());
  els.avatarInput.addEventListener("change", updateAvatar);
  els.needsForm.addEventListener("submit", saveDefaultNeeds);
  els.mobilityProfile.addEventListener("change", applySelectedMobilityPreset);
  els.maxSlope.addEventListener("input", updateSliderOutputs);
  els.maxWalkMinutes.addEventListener("input", updateSliderOutputs);
  els.addCustomNeedButton.addEventListener("click", addCustomNeed);
  els.customNeedInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustomNeed();
    }
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".search-control")) state.searchController.hideAll();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.mapPickType) cancelMapPointSelection();
    if (event.key === "Escape" && !els.verificationPanel.hidden) closeVerificationPanel();
  });
  document.addEventListener("pathforall-storage-error", event => {
    const message = event.detail?.message || "Browser storage is unavailable.";
    els.storageStatus.textContent = message;
    setPlannerMessage(message, "warning");
  });
}

function showPage(pageName) {
  const keepsMapVisible = pageName === "saved" || pageName === "profile";
  document.querySelectorAll(".page").forEach(page => {
    const visible = page.dataset.page === pageName || (keepsMapVisible && page.dataset.page === "navigate");
    const background = keepsMapVisible && page.dataset.page === "navigate";
    page.classList.toggle("active", visible);
    page.inert = background;
    page.setAttribute("aria-hidden", String(!visible || background));
  });
  document.querySelectorAll(".bottom-nav-button").forEach(button => {
    const active = button.dataset.pageTarget === pageName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  if (pageName === "saved") renderSavedRoutes();
  if (keepsMapVisible) {
    const overlay = pageName === "saved" ? els.savedPage : els.profilePage;
    setTimeout(() => overlay.querySelector("h1, button, input")?.focus(), 0);
  } else if (state.pageTrigger && document.contains(state.pageTrigger)) {
    setTimeout(() => state.pageTrigger.focus(), 0);
  }
  requestMapResize();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function requestMapResize() {
  const resize = () => setTimeout(() => state.map?.resize(), 80);
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(resize);
  else resize();
}

function openResultsPanel() {
  els.resultsPanel.classList.add("open");
  els.resultsPanel.inert = false;
  els.resultsPanel.setAttribute("aria-hidden", "false");
  requestMapResize();
  setTimeout(() => els.resultsTitle.focus(), 0);
}

function closeResultsPanel(options = {}) {
  els.resultsPanel.classList.remove("open");
  els.resultsPanel.inert = true;
  els.resultsPanel.setAttribute("aria-hidden", "true");
  requestMapResize();
  if (options.restoreFocus !== false) els.planButton.focus();
}

function setTravelMode(mode) {
  const requestedButton = document.querySelector(`.mode-chip[data-mode="${mode}"]`);
  if (mode !== "walk" && requestedButton?.disabled) {
    setPlannerMessage(
      "This transit mode requires an application-owned route or transit service. Check the connection details below or continue with Walk.",
      "warning"
    );
    return;
  }
  state.routeSession.cancel();
  state.travelMode = mode;
  document.querySelectorAll(".mode-chip").forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  state.routes = [];
  clearSelectedRoute();
  els.startNavigationButton.disabled = true;
  els.saveRouteButton.disabled = true;
  closeResultsPanel({ restoreFocus: false });
  const label = mode === "walk" ? "walking" : mode === "ferry" ? "authorized ferry" : `${mode} transit`;
  setPlannerMessage(`Ready to find ${label} routes.`, "neutral");
  requestMapResize();
}

function selectPlace(type, place, options = {}) {
  if (state.mapPickType) cancelMapPointSelection();
  if (!isInsideServiceArea(place.coordinates)) {
    setPlannerMessage("That result is outside the New York City service area. Choose a location in one of the five boroughs.", "warning");
    return;
  }
  if (type === "start") state.startPlace = place;
  else state.endPlace = place;
  state.routeSession.cancel();
  state.routes = [];
  state.selectedRouteIndex = 0;
  clearSelectedRoute();
  closeResultsPanel({ restoreFocus: false });
  els.startNavigationButton.disabled = true;
  els.saveRouteButton.disabled = true;
  recordPilotEvent("place_selected", { type, placeId: place.id || null, name: place.name || "" });
  renderPilotMetrics();
  setPlaceInput(type, place);
  state.searchController.hideAll();
  // The marker represents the selected place, not a later routing snap.
  updateEndpointMarker(type);
  snapEndpoint(type, null, { silent: true });
  if (type === "start") scheduleWeatherRefresh();
  if (options.focusMap !== false) state.map?.flyTo({ center: place.coordinates, zoom: 15.3, essential: true });
}

function setPlaceInput(type, place) {
  const input = type === "start" ? els.startSearch : els.endSearch;
  input.value = place?.name || "";
}

function toggleMapPointSelection(type) {
  if (!state.mapLoaded) {
    setPlannerMessage("The map is still loading. Try again in a moment.", "warning");
    return;
  }
  if (state.mapPickType === type) {
    cancelMapPointSelection();
    return;
  }
  beginMapPointSelection(type);
}

function beginMapPointSelection(type) {
  state.mapPickType = type;
  state.searchController.hideAll();
  els.mapPickBanner.hidden = false;
  els.mapPickText.textContent = type === "start"
    ? "Tap anywhere on the map to set the starting point."
    : "Tap anywhere on the map to set the destination.";
  els.setStartOnMapButton.classList.toggle("active", type === "start");
  els.setEndOnMapButton.classList.toggle("active", type === "end");
  els.setStartOnMapButton.setAttribute("aria-pressed", String(type === "start"));
  els.setEndOnMapButton.setAttribute("aria-pressed", String(type === "end"));
  state.map.getCanvas().classList.add("map-picking");
  setPlannerMessage(type === "start" ? "Tap the map to choose your starting point." : "Tap the map to choose your destination.", "neutral");
  requestMapResize();
}

function selectMapCenter() {
  if (!state.mapPickType || !state.map) return;
  handleMapPointClick({ lngLat: state.map.getCenter() });
}

function cancelMapPointSelection() {
  state.mapPickType = null;
  els.mapPickBanner.hidden = true;
  els.setStartOnMapButton.classList.remove("active");
  els.setEndOnMapButton.classList.remove("active");
  els.setStartOnMapButton.setAttribute("aria-pressed", "false");
  els.setEndOnMapButton.setAttribute("aria-pressed", "false");
  state.map?.getCanvas().classList.remove("map-picking");
  requestMapResize();
}

async function handleMapPointClick(event) {
  const type = state.mapPickType;
  if (!type) return;

  const coordinates = [event.lngLat.lng, event.lngLat.lat];
  if (!isInsideServiceArea(coordinates)) {
    setPlannerMessage("That point is outside the New York City service area. Tap within one of the five boroughs.", "warning");
    return;
  }
  const selectionName = type === "start" ? "Pinned starting point" : "Pinned destination";
  const place = createMapSelection(coordinates, selectionName);
  const pointId = place.id;

  cancelMapPointSelection();
  selectPlace(type, place, { focusMap: false });
  const snappedId = type === "start" ? state.startId : state.endId;
  const snappedNode = state.nodes[snappedId];
  const snapDistance = snappedNode ? Math.round(haversineMeters(coordinates, snappedNode.coordinates)) : null;
  setPlannerMessage(`${type === "start" ? "Starting point" : "Destination"} set from the map${snapDistance == null ? "." : ". Route calculation will connect it to a nearby walkable street."}`, "success");

  const resolved = await reverseGeocodePlace(coordinates);
  const currentPlace = type === "start" ? state.startPlace : state.endPlace;
  if (resolved && currentPlace?.id === pointId) {
    const namedPlace = { ...currentPlace, name: resolved.name, subtitle: resolved.subtitle, source: resolved.source };
    if (type === "start") state.startPlace = namedPlace;
    else state.endPlace = namedPlace;
    setPlaceInput(type, namedPlace);
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    setPlannerMessage("Location is not supported in this browser.", "warning");
    return;
  }
  setPlannerMessage("Getting your location…", "neutral");
  navigator.geolocation.getCurrentPosition(position => {
    const coordinates = [position.coords.longitude, position.coords.latitude];
    if (!isInsideServiceArea(coordinates)) {
      setPlannerMessage("Your location is outside the New York City service area.", "warning");
      return;
    }
    selectPlace("start", { id: "device-location", name: "My location", subtitle: "Device location", coordinates });
    setPlannerMessage("Starting point updated to your location.", "success");
  }, () => setPlannerMessage("Location permission was not available. Search for a starting place instead.", "warning"), {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 60000
  });
}

function swapEndpoints() {
  [state.startPlace, state.endPlace] = [state.endPlace, state.startPlace];
  [state.startId, state.endId] = [state.endId, state.startId];
  state.routeSession.cancel();
  state.routes = [];
  state.selectedRouteIndex = 0;
  setPlaceInput("start", state.startPlace);
  setPlaceInput("end", state.endPlace);
  updateEndpointMarker("start");
  updateEndpointMarker("end");
  clearSelectedRoute();
  scheduleWeatherRefresh();
}

function initializeMap() {
  state.map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    },
    center: NYC_CENTER,
    zoom: 10.2,
    maxZoom: 19,
    attributionControl: true
  });

  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  state.map.on("click", handleMapPointClick);
  state.map.on("load", () => {
    state.mapLoaded = true;
    setMapMessage("Map ready · choose two places to load accessible street data", "success");
    addRouteLayers();
    updateEndpointMarker("start");
    updateEndpointMarker("end");
  });
  state.map.on("error", event => {
    if (event?.error?.message) console.warn("MapLibre:", event.error.message);
  });
}

async function ensureRouteNetwork(options = {}) {
  const start = state.startPlace?.coordinates;
  const end = state.endPlace?.coordinates;
  if (!start || !end) return false;
  const corridor = buildRouteCorridor(start, end);
  const corridorKey = corridor.points.map(point => point.map(value => value.toFixed(3)).join(",")).join("|");
  if (state.networkReady && state.networkCorridorKey === corridorKey) return true;
  return loadStreetNetwork(corridor, { ...options, corridorKey });
}

async function loadStreetNetwork(corridor, options = {}) {
  state.networkAbortController?.abort();
  const controller = new AbortController();
  state.networkAbortController = controller;
  const abortFromRoute = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromRoute, { once: true });
  state.networkReady = false;
  setNetworkBadge("Loading OSM streets…", "loading");
  try {
    const live = await loadLiveOsmGraph(corridor, {
      timeoutMs: 28000,
      signal: controller.signal,
      preserveComponents: ["ferry", "mixed"].includes(state.travelMode) && isFerryRequiredDestination(state.endPlace)
    });
    if (controller.signal.aborted) return false;
    const endpointGraph = connectRouteEndpoints(
      live.nodes,
      live.edges,
      state.startPlace,
      state.endPlace,
      {
        maxProjectionDistanceMeters: 40,
        wheelchairMode: getEffectiveNeeds().wheelchairMode,
        avoidStairs: getEffectiveNeeds().avoidStairs
      }
    );
    if (endpointGraph.failure || !endpointGraph.startId || !endpointGraph.endId) {
      state.nodes = live.nodes;
      state.edges = applyTrustMetadata(live.edges, state.segmentReviews);
      state.startId = endpointGraph.startId;
      state.endId = endpointGraph.endId;
      throw new RouteAvailabilityError(
        `A verified pedestrian connector is unavailable for the selected ${endpointGraph.failure?.endpointType || "place"}. Choose a point directly on a mapped pedestrian path or use a connected routing provider.`,
        "ENDPOINT_CONNECTOR_UNAVAILABLE"
      );
    }
    state.nodes = endpointGraph.nodes;
    state.edges = applyTrustMetadata(endpointGraph.edges, state.segmentReviews);
    state.startId = endpointGraph.startId;
    state.endId = endpointGraph.endId;
    state.networkSource = "live";
    setNetworkBadge(`${Object.keys(state.nodes).length.toLocaleString()} OSM nodes`, "success");
    setMapMessage("Live OSM pedestrian graph connected", "success");
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") return false;
    console.warn(error);
    state.nodes = {};
    state.edges = [];
    state.networkSource = "unavailable";
    setNetworkBadge("Street data unavailable", "warning");
    setMapMessage("Street data could not be loaded for this route corridor", "warning");
    return false;
  }

  state.networkReady = true;
  state.networkCorridorKey = options.corridorKey || null;
  refreshTransitCapabilities({ silent: true });
  options.signal?.removeEventListener("abort", abortFromRoute);
  return true;
}

function snapEndpoint(type, forcedId = null, options = {}) {
  if (!state.networkReady) return;
  const place = type === "start" ? state.startPlace : state.endPlace;
  if (!place) return;
  const nearest = forcedId ? { node: state.nodes[forcedId], distanceMeters: 0 } : findNearestNode(state.nodes, place.coordinates, 40);
  if (!nearest?.node) {
    if (!options.silent) setPlannerMessage(`Could not connect ${type} to the pedestrian graph.`, "warning");
    if (type === "start") state.startId = null;
    else state.endId = null;
    updateEndpointMarker(type);
    return;
  }
  if (type === "start") state.startId = nearest.node.id;
  else state.endId = nearest.node.id;
  updateEndpointMarker(type);
}

function updateEndpointMarker(type) {
  const id = type === "start" ? state.startId : state.endId;
  const node = state.nodes[id];
  const place = type === "start" ? state.startPlace : state.endPlace;
  // Keep the visible marker at the location the person chose. Graph snapping is routing-only.
  const coordinates = place?.coordinates || node?.coordinates;
  if (!coordinates || !state.mapLoaded) return;
  state.endpointMarkers[type]?.remove();
  const element = document.createElement("div");
  element.className = `endpoint-marker ${type}`;
  element.title = type === "start" ? "Starting point" : "Destination";
  state.endpointMarkers[type] = new maplibregl.Marker({ element })
    .setLngLat(coordinates)
    .addTo(state.map);
}

function addRouteLayers() {
  if (!state.map.getSource("selected-walk")) {
    state.map.addSource("selected-walk", { type: "geojson", data: emptyFeatureCollection() });
    state.map.addLayer({
      id: "selected-walk",
      type: "line",
      source: "selected-walk",
      paint: { "line-color": "#374151", "line-width": 5, "line-opacity": .9, "line-dasharray": [1.4, 1.2] }
    });
  }
  if (!state.map.getSource("selected-bus")) {
    state.map.addSource("selected-bus", { type: "geojson", data: emptyFeatureCollection() });
    state.map.addLayer({ id: "selected-bus", type: "line", source: "selected-bus", paint: { "line-color": "#087a55", "line-width": 7, "line-opacity": .95 } });
  }
  if (!state.map.getSource("selected-subway")) {
    state.map.addSource("selected-subway", { type: "geojson", data: emptyFeatureCollection() });
    state.map.addLayer({ id: "selected-subway", type: "line", source: "selected-subway", paint: { "line-color": "#3155d8", "line-width": 7, "line-opacity": .95 } });
  }
  if (!state.map.getSource("selected-ferry")) {
    state.map.addSource("selected-ferry", { type: "geojson", data: emptyFeatureCollection() });
    state.map.addLayer({
      id: "selected-ferry",
      type: "line",
      source: "selected-ferry",
      paint: {
        "line-color": "#7c3aed",
        "line-width": 7,
        "line-opacity": .95,
        "line-dasharray": [2.2, 1.1]
      }
    });
  }
}

async function calculateRoutes(options = {}) {
  const calculationOptions = options?.type ? {} : (options || {});
  if (!state.startPlace || !state.endPlace) {
    setPlannerMessage("Choose both a starting point and destination before finding a route.", "warning");
    return;
  }
  applyTemporaryNeeds(false);
  const needs = getEffectiveNeeds();
  const previousRouteState = calculationOptions.navigationReroute ? {
    routes: state.routes,
    selectedRouteIndex: state.selectedRouteIndex,
    navigationSteps: state.navigation.steps,
    navigationCoordinates: state.navigation.coordinates,
    selectedRouteKey: state.navigation.selectedRouteKey
  } : null;
  const request = state.routeSession.begin();
  setPlannerMessage("Calculating personalized routes…", "neutral");
  els.planButton.disabled = true;
  els.planButton.setAttribute("aria-busy", "true");
  els.resultsPanel.setAttribute("aria-busy", "true");
  els.startNavigationButton.disabled = true;

  try {
    // Transit, alert, elevator, and arrival state can change independently.
    // Route responses are deliberately not cached in the browser.
    const plannedRoutes = await planRouteOptions({ needs, request });
    if (!request.isCurrent()) return;

    if (!plannedRoutes.length) {
      if (previousRouteState) {
        restorePreviousRouteState(previousRouteState);
        state.navigation.rerouteState = "failed";
        setNavigationMessage("Rerouting failed. The previous route remains visible; return to the last verified walking segment or end navigation.");
        return false;
      }
      state.routes = [];
      els.routeCards.innerHTML = '<div class="empty-card"><strong>No matching route</strong><span>Try increasing maximum walking time or selecting another travel mode. Incomplete accessibility tags may also remove possible paths.</span></div>';
      els.resultsTitle.textContent = "No route found";
      if (!calculationOptions.navigationReroute) {
        openResultsPanel();
        requestMapResize();
      }
      setPlannerMessage("No route matched the profile and one-time requirements.", "warning");
      clearSelectedRoute();
      return false;
    }

    state.routes = plannedRoutes;
    state.selectedRouteIndex = 0;
    recordPilotEvent("routes_planned", {
      mode: state.travelMode,
      optionCount: state.routes.length,
      networkSource: state.networkSource,
      transitDataSource: state.transitDataStatus.source
    });
    renderPilotMetrics();
    renderRouteCards();
    selectRoute(0);
    els.resultsTitle.textContent = `${state.startPlace.name} → ${state.endPlace.name}`;
    if (!calculationOptions.navigationReroute) {
      openResultsPanel();
      requestMapResize();
    }
    els.startNavigationButton.disabled = false;
    setPlannerMessage(`${state.routes.length} accessible option${state.routes.length === 1 ? "" : "s"} found.`, "success");
    if (calculationOptions.navigationReroute) {
      state.navigation.rerouteState = "succeeded";
      resumeNavigationAfterReroute();
    }
    return true;
  } catch (error) {
    if (!request.isCurrent() || error?.name === "AbortError") return;
    const controlled = error instanceof RouteAvailabilityError || error instanceof TransitProviderError;
    if (!controlled) console.error(error);
    if (previousRouteState) {
      restorePreviousRouteState(previousRouteState);
      state.navigation.rerouteState = "failed";
      setNavigationMessage(`Rerouting failed: ${error.message || "no replacement route was available"}. The previous route remains visible.`);
      return false;
    }
    els.routeCards.innerHTML = '<div class="empty-card"><strong>Route unavailable</strong><span>We could not find a verified street-aligned route for these locations. Your selected places are still on the map.</span></div>';
    els.resultsTitle.textContent = "Route unavailable";
    if (!calculationOptions.navigationReroute) {
      openResultsPanel();
      requestMapResize();
    }
    clearSelectedRoute();
    const providerMessage = error instanceof TransitProviderError
      ? error.message || TRANSIT_ERROR_MESSAGES[error.code]
      : null;
    setPlannerMessage(error instanceof RouteAvailabilityError
      ? error.message
      : providerMessage || "Route calculation is unavailable right now. Your selected places are still on the map.", "warning");
    return false;
  } finally {
    if (request.isCurrent()) {
      els.planButton.disabled = false;
      els.planButton.setAttribute("aria-busy", "false");
      els.resultsPanel.setAttribute("aria-busy", "false");
    }
  }
}

function restorePreviousRouteState(snapshot) {
  state.routes = snapshot.routes;
  state.selectedRouteIndex = snapshot.selectedRouteIndex;
  state.navigation.steps = snapshot.navigationSteps;
  state.navigation.coordinates = snapshot.navigationCoordinates;
  state.navigation.selectedRouteKey = snapshot.selectedRouteKey;
  renderRouteCards();
  drawSelectedRoute(state.routes[state.selectedRouteIndex]);
}

class RouteAvailabilityError extends Error {
  constructor(message, code = "TRANSIT_PROVIDER_UNAVAILABLE") {
    super(message);
    this.name = "RouteAvailabilityError";
    this.code = code;
  }
}

async function planRouteOptions({ needs, request }) {
  const mode = state.travelMode;
  const ferryDestination = resolveFerryDestination(state.endPlace);
  if (ferryDestination && !["ferry", "mixed"].includes(mode)) {
    throw new RouteAvailabilityError(
      `${ferryDestination.name} requires Statue City Cruises. Choose Ferry or Mixed mode.`,
      "FERRY_REQUIRED"
    );
  }

  const capabilities = await ensureRoutingCapabilities(request.signal);
  if (!request.isCurrent()) return [];
  const selectedSource = routeSourceForMode(mode, capabilities, { transitNetwork: hasTransitNetworkService() });
  let providerFailure = null;
  if (selectedSource === "route-provider") {
    try {
      const routes = await planServerRoutes({
        start: state.startPlace,
        end: state.endPlace,
        needs,
        mode,
        signal: request.signal
      }, { capabilities });
      if (!request.isCurrent()) return [];
      if (routes.length) {
        const providerRoute = routes[0];
        state.transitConnectionObservations.routeProviderState = {
          status: providerRoute.dataFreshness === "stale" ? "Stale" : "Connected",
          freshness: providerRoute.dataFreshness || "current",
          source: providerRoute.dataSource || capabilities.source,
          updatedAt: providerRoute.updatedAt || providerRoute.providerUpdatedAt || capabilities.updatedAt
        };
        renderTransitConnectionStatus();
        state.networkSource = "server";
        const enriched = (await Promise.all(routes.map(route => enrichRoute(route, request)))).filter(Boolean);
        return rankRoutesAfterArrivals(enriched, needs).routes;
      }
      providerFailure = new TransitProviderError("NO_SERVICE_AT_THIS_TIME", "The route provider returned no usable itinerary for this mode.");
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      state.transitConnectionObservations.routeProviderState = {
        status: error?.code === "TRANSIT_DATA_STALE" ? "Stale" : "Unavailable",
        source: capabilities.source,
        updatedAt: capabilities.updatedAt
      };
      renderTransitConnectionStatus();
      providerFailure = error;
    }
  }
  if (mode !== "walk" && !hasTransitNetworkService()) {
    if (providerFailure) throw providerFailure;
    if (mode === "ferry" && ferryDestination) {
      throw new RouteAvailabilityError(ferryUnavailableMessage(ferryDestination), "FERRY_SCHEDULE_UNAVAILABLE");
    }
    throw new RouteAvailabilityError("Accessible transit routing is currently unavailable. Try walking mode or try again later.");
  }

  const networkLoaded = await ensureRouteNetwork({ signal: request.signal });
  if (!request.isCurrent()) return [];
  if (!networkLoaded || !state.startId || !state.endId) throw new RouteAvailabilityError(
    "A verified pedestrian connection to one of the selected places is unavailable. Choose a point directly on a mapped pedestrian path or use a connected routing provider.",
    "ENDPOINT_CONNECTOR_UNAVAILABLE"
  );
  if (state.startId === state.endId) throw new RouteAvailabilityError("Choose two different places to find a route.");
  if (mode === "walk") {
    const planned = planAllRoutes(state.nodes, state.edges, state.startId, state.endId, needs, state.weather);
    return Promise.all(planned.map(item => normalizeWalkingRoute(item, { nodes: state.nodes, edges: state.edges, start: state.startPlace, end: state.endPlace, trust: summarizeRouteTrust(item.route, state.edges) })).filter(Boolean).map(route => enrichRoute(route, request))).then(routes => routes.filter(Boolean));
  }

  let network = null;
  try {
    network = await ensureTransitNetwork(request.signal, mode, needs);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (providerFailure) throw providerFailure;
    throw error;
  }
  if (!request.isCurrent()) return [];
  if (!network) {
    if (mode === "ferry" && ferryDestination) throw new RouteAvailabilityError(ferryUnavailableMessage(ferryDestination), "FERRY_SCHEDULE_UNAVAILABLE");
    if (providerFailure) throw providerFailure;
    throw new RouteAvailabilityError("Accessible transit routing is currently unavailable. Try walking mode or try again later.");
  }
  const stops = prepareTransitStops(state.nodes, network.stops, { maxSnapDistanceMeters: network.maxSnapDistanceMeters });
  const localRoutes = planTransitRoutes({
    pedestrianNodes: state.nodes,
    pedestrianEdges: state.edges,
    startId: state.startId,
    endId: state.endId,
    needs,
    weather: state.weather,
    mode,
    transitStops: stops,
    transitEdges: network.edges,
    departureTime: new Date(),
    candidateSearch: network.candidateSearch
  });
  if (!localRoutes.length && providerFailure) throw providerFailure;
  if (!localRoutes.length && mode === "ferry" && ferryDestination) throw new RouteAvailabilityError(ferryUnavailableMessage(ferryDestination), "FERRY_SCHEDULE_UNAVAILABLE");
  if (!localRoutes.length) {
    const code = mode === "bus" ? "NO_NEARBY_BUS_STOP"
      : mode === "subway" ? "NO_ACCESSIBLE_STATION"
        : mode === "mixed" ? "NO_VALID_TRANSFER"
          : "NO_SERVICE_AT_THIS_TIME";
    throw new RouteAvailabilityError(TRANSIT_ERROR_MESSAGES[code], code);
  }
  const enrichedRoutes = (await Promise.all(localRoutes.map(itinerary => {
    const route = normalizeLocalTransitRoute(itinerary, {
      mode,
      start: state.startPlace,
      end: state.endPlace,
      pedestrianNodes: state.nodes,
      pedestrianEdges: state.edges,
      transitStops: stops,
      trust: summarizeRouteTrust({ edgeIds: [...(itinerary.access?.route?.edgeIds || []), ...(itinerary.egress?.route?.edgeIds || [])] }, state.edges),
      dataSource: network.dataSource,
      dataVersion: network.dataVersion,
      serviceAlertVersion: network.serviceAlertVersion,
      elevatorStatusVersion: network.elevatorStatusVersion,
      providerUpdatedAt: network.updatedAt,
      dataFreshness: network.freshness,
      updatedAt: network.updatedAt,
      expiresAt: network.expiresAt
    });
    return route ? enrichRoute(route, request) : null;
  }))).filter(Boolean);
  return rankRoutesAfterArrivals(enrichedRoutes, needs).routes;
}

async function ensureTransitNetwork(signal, mode, needs) {
  if (!hasTransitNetworkService()) return null;
  try {
    const network = await loadTransitNetwork({
      signal,
      start: state.startPlace.coordinates,
      end: state.endPlace.coordinates,
      mode,
      maxWalkMinutes: needs.maxWalkMinutes,
      departureTime: new Date()
    });
    state.networkSource = "transit-provider";
    state.transitConnectionObservations.transitNetworkState = {
      status: "Connected",
      freshness: network.freshness,
      source: network.dataSource,
      updatedAt: network.updatedAt,
      expiresAt: network.expiresAt,
      capabilities: network.capabilities
    };
    renderTransitConnectionStatus();
    return network;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    state.transitConnectionObservations.transitNetworkState = {
      status: error?.code === "TRANSIT_DATA_STALE" ? "Stale" : "Unavailable",
      freshness: error?.details?.freshness || "unknown",
      source: error?.details?.source || "Transit network provider",
      updatedAt: error?.details?.updatedAt || null,
      expiresAt: error?.details?.expiresAt || null
    };
    renderTransitConnectionStatus();
    throw error;
  }
}

async function ensureRoutingCapabilities(signal) {
  if (!hasAccessibleRoutingService()) {
    state.routeProviderCapabilities = configuredRoutingCapabilities({ url: "" });
    renderTransitConnectionStatus();
    return state.routeProviderCapabilities;
  }
  if (!state.routeProviderCapabilitiesPromise) {
    state.routeProviderCapabilitiesPromise = loadRoutingCapabilities({ signal })
      .then(capabilities => {
        state.routeProviderCapabilities = capabilities;
        renderTransitConnectionStatus();
        return capabilities;
      })
      .finally(() => { state.routeProviderCapabilitiesPromise = null; });
  }
  return state.routeProviderCapabilitiesPromise;
}

async function enrichRoute(route, request) {
  let enriched = route;
  if (route.mode !== "walk") {
    const arrivals = await getTransitArrivals(route, new Date(), { signal: request.signal });
    if (!request.isCurrent()) return null;
    const availableBoarding = arrivals.boardings?.find(boarding => boarding.status === "available");
    state.transitConnectionObservations.realtimeState = {
      status: arrivals.status === "available" ? "Connected" : arrivals.status === "stale" ? "Stale" : "Unavailable",
      freshness: arrivals.status === "available" ? availableBoarding?.freshness || "current" : arrivals.status,
      source: availableBoarding?.source || arrivals.sourceLabel || "Realtime arrival provider",
      updatedAt: availableBoarding?.updatedAt || null
    };
    renderTransitConnectionStatus();
    enriched = attachArrivalData(route, arrivals);
  }
  return { ...enriched, navigationSteps: buildRouteNavigationSteps(enriched, state.endPlace.name) };
}

function renderRouteCards() {
  els.routeCards.innerHTML = state.routes.map((route, index) => routeCardMarkup(route, index, escapeHtml, index === state.selectedRouteIndex)).join("");
  els.routeCards.querySelectorAll("[data-route-index]").forEach(card => card.addEventListener("click", () => selectRoute(Number(card.dataset.routeIndex))));
}

function selectRoute(index) {
  state.selectedRouteIndex = index;
  renderRouteCards();
  const route = state.routes[index];
  drawSelectedRoute(route);
  renderRouteTrust(route);
  els.startNavigationButton.disabled = !route;
  els.reviewSegmentsButton.disabled = !route || routeEdgeIds(route).length === 0;
  els.saveRouteButton.disabled = !route;
  if (route?.arrivals?.status === "available") {
    const available = (route.boardings || []).filter(boarding => boarding.status === "available").length;
    const total = (route.boardings || []).length;
    els.arrivalSourceNote.textContent = `Provider arrival information is available for ${available} of ${total} boarding${total === 1 ? "" : "s"}. Scheduled and realtime estimates are labeled separately.`;
  } else if (route?.arrivals?.status === "stale") {
    els.arrivalSourceNote.textContent = "Arrival data is stale and is not being shown as current. The scheduled itinerary may still be usable.";
  } else if (route?.mode !== "walk") {
    els.arrivalSourceNote.textContent = "Arrival information is unavailable. Only provider-supplied scheduled waits remain in the itinerary; no live times were generated.";
  } else {
    els.arrivalSourceNote.textContent = "Turn-by-turn instructions are generated from the selected OSM route. Accessibility data may be incomplete.";
  }
}

function saveSelectedRoute() {
  const route = state.routes[state.selectedRouteIndex];
  if (!route) return;
  try {
    saveRoute(route, state.startPlace, state.endPlace);
  } catch (error) {
    if (!reportStorageError(error)) throw error;
    return;
  }
  state.savedRoutes = loadSavedRoutes();
  els.saveRouteButton.textContent = "Saved";
  setTimeout(() => { els.saveRouteButton.textContent = "Save route"; }, 1600);
  setPlannerMessage("Route saved on this device.", "success");
}

function renderSavedRoutes() {
  const saved = state.savedRoutes = loadSavedRoutes();
  if (!saved.length) {
    els.savedPlacesList.innerHTML = '<div class="empty-card"><strong>No saved routes yet</strong><span>Choose a route on the map and save it here for quick access.</span></div>';
    return;
  }
  els.savedPlacesList.innerHTML = saved.map(item => `
    <article class="saved-route-card">
      <div><span class="route-label">${escapeHtml(item.label || "Accessible route")}</span><h2>${escapeHtml(item.start?.name || "Start")} <span aria-hidden="true">→</span> ${escapeHtml(item.end?.name || "Destination")}</h2><p>${Math.max(0, Number(item.minutes || 0))} min${item.distanceMeters ? ` · ${formatDistance(item.distanceMeters)}` : ""}</p></div>
      <div class="saved-route-actions"><button type="button" data-use-saved-route="${escapeHtml(item.id)}">Use route</button><button type="button" data-remove-saved-route="${escapeHtml(item.id)}" aria-label="Remove saved route">×</button></div>
    </article>`).join("");
}

function handleSavedRouteAction(event) {
  const useButton = event.target.closest("[data-use-saved-route]");
  const removeButton = event.target.closest("[data-remove-saved-route]");
  if (removeButton) {
    try {
      state.savedRoutes = removeSavedRoute(removeButton.dataset.removeSavedRoute);
    } catch (error) {
      if (!reportStorageError(error)) throw error;
      return;
    }
    renderSavedRoutes();
    return;
  }
  if (!useButton) return;
  const item = state.savedRoutes.find(route => route.id === useButton.dataset.useSavedRoute);
  if (!item?.start?.coordinates?.length || !item?.end?.coordinates?.length) return;
  selectPlace("start", item.start);
  selectPlace("end", item.end);
  showPage("navigate");
  setPlannerMessage("Saved route loaded. Find routes to refresh current accessibility and transit information.", "neutral");
}

function drawSelectedRoute(route) {
  if (!state.mapLoaded) return;
  const grouped = routeLayerData(route || {});
  state.map.getSource("selected-walk")?.setData(grouped.walk);
  state.map.getSource("selected-bus")?.setData(grouped.bus);
  state.map.getSource("selected-subway")?.setData(grouped.subway);
  state.map.getSource("selected-ferry")?.setData(grouped.ferry);
  drawTransitStopMarkers(route);

  const allCoordinates = Object.values(grouped).flatMap(collection => collection.features).flatMap(feature => feature.geometry.coordinates);
  if (allCoordinates.length) {
    const bounds = allCoordinates.reduce((box, coordinate) => box.extend(coordinate), new maplibregl.LngLatBounds(allCoordinates[0], allCoordinates[0]));
    state.map.fitBounds(bounds, { padding: { top: 150, bottom: 210, left: 40, right: 40 }, maxZoom: 16, duration: 700 });
  }
}

function clearSelectedRoute() {
  if (els.routeTrustSummary) {
    els.routeTrustSummary.hidden = true;
    els.routeTrustSummary.innerHTML = "";
  }
  if (els.reviewSegmentsButton) els.reviewSegmentsButton.disabled = true;
  if (els.saveRouteButton) els.saveRouteButton.disabled = true;
  if (!state.mapLoaded) return;
  ["selected-walk", "selected-bus", "selected-subway", "selected-ferry"].forEach(id => state.map.getSource(id)?.setData(emptyFeatureCollection()));
  clearTransitStopMarkers();
}

function drawTransitStopMarkers(route) {
  clearTransitStopMarkers();
  const seen = new Set();
  for (const leg of route?.legs || []) {
    if (!["bus", "subway", "ferry"].includes(leg.mode)) continue;
    for (const place of [leg.from, leg.to]) {
      if (!place?.coordinates || seen.has(place.id)) continue;
      seen.add(place.id);
      const element = document.createElement("div");
      element.className = `transit-stop-marker ${leg.mode}`;
      element.textContent = leg.mode === "bus" ? "B" : leg.mode === "subway" ? "S" : "F";
      element.title = place.name;
      state.transitStopMarkers.push(new maplibregl.Marker({ element }).setLngLat(place.coordinates).addTo(state.map));
    }
  }
}

function clearTransitStopMarkers() {
  state.transitStopMarkers.forEach(marker => marker.remove());
  state.transitStopMarkers = [];
}

function getEffectiveNeeds() {
  const needs = JSON.parse(JSON.stringify(state.profile.needs));
  applyNeedTextsToObject(needs, needs.customNeeds || []);

  const trip = state.tripNeeds;
  ["avoidStairs", "requireElevator", "preferSmooth", "preferShade", "avoidRain", "minimizeTransfers", "requireCurb", "wheelchairMode"]
    .forEach(key => {
      if (trip[key] === true) needs[key] = true;
    });
  if (Number.isFinite(trip.maxSlope)) needs.maxSlope = Math.min(needs.maxSlope, trip.maxSlope);
  needs.customNeeds = [...(needs.customNeeds || []), ...(trip.customNeeds || [])];
  applyNeedTextsToObject(needs, trip.customNeeds || []);
  return needs;
}

function emptyTripNeeds() {
  return {
    avoidStairs: false,
    requireElevator: false,
    preferSmooth: false,
    preferShade: false,
    avoidRain: false,
    minimizeTransfers: false,
    requireCurb: false,
    wheelchairMode: false,
    maxSlope: null,
    customNeeds: []
  };
}

function applyTemporaryNeeds(invalidateRoutes = true) {
  const trip = emptyTripNeeds();
  trip.avoidStairs = els.tripAvoidStairs.checked;
  trip.requireElevator = els.tripRequireElevator.checked;
  trip.preferSmooth = els.tripPreferSmooth.checked;
  trip.preferShade = els.tripPreferShade.checked;
  trip.avoidRain = els.tripAvoidRain.checked;
  trip.minimizeTransfers = els.tripMinimizeTransfers.checked;

  const text = els.tripNeedsInput.value.trim();
  if (text) trip.customNeeds = [text];
  applyNeedTextsToObject(trip, trip.customNeeds);
  state.tripNeeds = trip;
  renderTemporaryNeeds();
  if (invalidateRoutes !== false) {
    state.routeSession.cancel();
    state.routes = [];
    clearSelectedRoute();
    closeResultsPanel({ restoreFocus: false });
    els.startNavigationButton.disabled = true;
    setPlannerMessage("Temporary needs will apply only to the next route calculation.", "success");
  }
}

function clearTemporaryNeeds() {
  state.tripNeeds = emptyTripNeeds();
  els.tripNeedsInput.value = "";
  ["tripAvoidStairs", "tripRequireElevator", "tripPreferSmooth", "tripPreferShade", "tripAvoidRain", "tripMinimizeTransfers"]
    .forEach(id => { els[id].checked = false; });
  renderTemporaryNeeds();
  state.routeSession.cancel();
  state.routes = [];
  clearSelectedRoute();
  closeResultsPanel({ restoreFocus: false });
  els.startNavigationButton.disabled = true;
  setPlannerMessage("One-time needs cleared. Profile defaults still apply.", "neutral");
}

function renderTemporaryNeeds() {
  const labels = [];
  const needs = state.tripNeeds;
  if (needs.avoidStairs) labels.push("No stairs this trip");
  if (needs.requireElevator) labels.push("Working elevator");
  if (needs.preferSmooth) labels.push("Smooth surfaces");
  if (needs.preferShade) labels.push("Shade");
  if (needs.avoidRain) labels.push("Covered paths");
  if (needs.minimizeTransfers) labels.push("Fewer transfers");
  if (Number.isFinite(needs.maxSlope)) labels.push(`Slope ≤ ${needs.maxSlope}%`);
  if (needs.customNeeds?.length) labels.push("Natural-language request applied");
  els.tripNeedsSummary.innerHTML = labels.map(label => `<span class="need-chip">${escapeHtml(label)}</span>`).join("");
}

function applyNeedTextsToObject(needs, texts) {
  for (const value of texts || []) {
    const text = String(value).toLowerCase();
    if (/wheelchair|wheel chair|轮椅|silla de ruedas/.test(text)) {
      needs.wheelchairMode = true;
      needs.avoidStairs = true;
      needs.requireCurb = true;
      needs.requireElevator = true;
    }
    if (/stairs|steps|step-free|楼梯|台阶|escaleras/.test(text)) needs.avoidStairs = true;
    if (/elevator|lift|电梯|ascensor/.test(text)) needs.requireElevator = true;
    if (/curb|kerb|坡道|路缘|rampa/.test(text)) needs.requireCurb = true;
    if (/rough|uneven|smooth|surface|颠簸|平滑|路面|superficie/.test(text)) needs.preferSmooth = true;
    if (/shade|heat|sun|阴凉|遮阴|高温|sombra|calor/.test(text)) needs.preferShade = true;
    if (/rain|covered|dry|下雨|避雨|有顶棚|lluvia|cubierto/.test(text)) needs.avoidRain = true;
    if (/transfer|crowd|少换乘|拥挤|换乘|transbordo|multitud/.test(text)) needs.minimizeTransfers = true;
    const slope = text.match(/(?:slope|incline|坡度|斜坡|pendiente)[^0-9]{0,14}(\d{1,2})\s*%?/);
    if (slope) {
      const value = Math.min(12, Math.max(2, Number(slope[1])));
      needs.maxSlope = Number.isFinite(needs.maxSlope) ? Math.min(needs.maxSlope, value) : value;
    }
  }
}

function startVoiceNeedsInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setPlannerMessage("Speech recognition is not supported in this browser. Type the temporary need instead.", "warning");
    return;
  }
  const recognition = new Recognition();
  recognition.lang = els.speechLanguage.value || "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  els.voiceNeedsButton.classList.add("listening");
  els.voiceNeedsButton.textContent = "■";
  setPlannerMessage("Listening for a one-time accessibility request…", "neutral");
  recognition.onresult = event => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    els.tripNeedsInput.value = transcript;
    applyTemporaryNeeds();
  };
  recognition.onerror = () => setPlannerMessage("Voice input was not available. You can type the request.", "warning");
  recognition.onend = () => {
    els.voiceNeedsButton.classList.remove("listening");
    els.voiceNeedsButton.textContent = "🎙";
  };
  recognition.start();
}

function startNavigation() {
  const route = state.routes[state.selectedRouteIndex];
  if (!route) return;
  const startCheck = navigationStartCheck(route);
  if (!startCheck.valid) {
    setPlannerMessage(startCheck.message, "warning");
    return;
  }
  const steps = route.navigationSteps || [];
  if (!steps.length) {
    setPlannerMessage("This route does not contain navigation steps.", "warning");
    return;
  }

  stopNavigationWatchers();
  state.navigation.active = true;
  state.navigation.steps = steps;
  state.navigation.stepIndex = 0;
  state.navigation.currentPosition = state.startPlace.coordinates;
  state.navigation.accuracy = null;
  state.navigation.coordinates = routeCoordinates(route);
  state.navigation.demoIndex = 0;
  state.navigation.lastSpokenStepId = null;
  state.navigation.offRouteCount = 0;
  state.navigation.rerouting = false;
  state.navigation.rerouteState = "idle";
  state.navigation.selectedRouteKey = route.id || null;
  state.navigation.completedRecorded = false;
  recordPilotEvent("navigation_started", { mode: route.mode, routeKey: route.id || null });
  renderPilotMetrics();

  document.body.classList.add("navigation-active");
  els.navigationOverlay.hidden = false;
  closeResultsPanel({ restoreFocus: false });
  setTimeout(() => state.map?.resize(), 40);
  updateCurrentLocationMarker(state.navigation.currentPosition);
  updateNavigationUI();
  recenterNavigation();
  state.navigation.clockTimer = setInterval(updateNavigationUI, 30000);
  if (route.mode !== "walk") {
    state.navigation.arrivalTimer = setInterval(refreshNavigationArrivals, 60_000);
  }

  if (!navigator.geolocation) {
    setNavigationMessage("GPS is unavailable. Use route preview to explore the trip.");
    return;
  }
  if (!window.isSecureContext && location.hostname !== "localhost") {
    setNavigationMessage("Live GPS requires HTTPS on a phone. Use route preview or open the app on an HTTPS host.");
    return;
  }

  state.navigation.watchId = navigator.geolocation.watchPosition(
    position => updateLiveNavigationPosition(position),
    error => setNavigationMessage(`GPS unavailable: ${error.message}. Route preview is still available.`),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 }
  );
  setNavigationMessage("Live GPS started. Keep the screen open while navigating.");
}

function navigationStartCheck(route) {
  if (route.mode === "walk") return { valid: true };
  if (route.dataFreshness !== "current") {
    return { valid: false, message: "Transit data is not current. Refresh the route before navigation." };
  }
  if (!route.updatedAt || !route.expiresAt || Date.parse(route.expiresAt) <= Date.now()) {
    return { valid: false, message: "This transit itinerary has expired. Find routes again before navigation." };
  }
  return { valid: true };
}

async function refreshNavigationArrivals() {
  if (!state.navigation.active) return;
  const index = state.routes.findIndex(route => route.id === state.navigation.selectedRouteKey);
  const route = state.routes[index];
  if (!route || route.mode === "walk") return;
  if (route.expiresAt && Date.parse(route.expiresAt) <= Date.now()) {
    setNavigationMessage("Transit itinerary expired. Find a refreshed route before continuing.");
    return;
  }
  try {
    const arrivals = await getTransitArrivals(route, new Date());
    if (!state.navigation.active) return;
    if (arrivals.status !== "available") {
      setNavigationMessage(arrivals.status === "stale"
        ? "Arrival predictions expired and are no longer shown as current."
        : "Arrival refresh unavailable. Follow the verified schedule and replan if service changes.");
      return;
    }
    const refreshed = attachArrivalData(route, arrivals);
    state.routes[index] = refreshed;
    state.navigation.steps = buildRouteNavigationSteps(refreshed, state.endPlace.name);
    setNavigationMessage("Arrival predictions refreshed.");
    updateNavigationUI();
  } catch (error) {
    if (error?.name !== "AbortError") setNavigationMessage("Arrival refresh failed. Expired predictions will not be shown as current.");
  }
}

function updateLiveNavigationPosition(position) {
  const coordinates = [position.coords.longitude, position.coords.latitude];
  state.navigation.currentPosition = coordinates;
  state.navigation.accuracy = Number(position.coords.accuracy || 0);
  updateCurrentLocationMarker(coordinates);
  updateNavigationUI();
  monitorOffRoute(coordinates);
  state.map?.easeTo({ center: coordinates, zoom: Math.max(state.map.getZoom(), 16.5), duration: 450, essential: true });
}

function updateNavigationUI() {
  const navigation = state.navigation;
  if (!navigation.active || !navigation.steps.length) return;

  if (navigation.currentPosition) {
    const progress = findNavigationProgress(navigation.currentPosition, navigation.steps, navigation.stepIndex);
    navigation.stepIndex = Math.max(navigation.stepIndex, progress.stepIndex);
  }

  const step = navigation.steps[Math.min(navigation.stepIndex, navigation.steps.length - 1)];
  const distance = navigation.currentPosition && step.targetCoordinate
    ? haversineMeters(navigation.currentPosition, step.targetCoordinate)
    : step.distanceMeters;
  els.navigationTurnIcon.textContent = step.icon || "↑";
  els.navigationInstruction.textContent = step.instruction;
  els.navigationDetail.textContent = dynamicStepDetail(step);
  els.navigationDistance.textContent = step.type === "board"
    ? dynamicStepDetail(step)
    : distance < 20 ? "Now" : `${formatNavigationDistance(distance)} ahead`;

  const minutes = remainingMinutes(navigation.steps, navigation.stepIndex);
  const eta = new Date(Date.now() + minutes * 60_000);
  els.navigationEta.textContent = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  els.navigationRemaining.textContent = `${Math.max(0, Math.round(minutes))} min`;
  els.navigationAccuracy.textContent = Number.isFinite(navigation.accuracy) ? `±${Math.round(navigation.accuracy)} m` : "Preview";
  renderUpcomingNavigationSteps();
  speakNavigationStep(step);
  if (step.type === "arrive" && distance < 25) {
    const recorded = recordNavigationCompletionOnce(navigation, recordPilotEvent, {
      mode: state.travelMode,
      source: Number.isFinite(navigation.accuracy) ? "gps" : "demo"
    });
    if (recorded) renderPilotMetrics();
  }
}

function dynamicStepDetail(step) {
  if (step.type === "board" && step.arrival?.timestamp) {
    const remainingMs = Date.parse(step.arrival.timestamp) - Date.now();
    if (remainingMs < 0) return `Arrival prediction expired at ${step.arrival.stopName}. Refresh or replan before boarding.`;
    const minutes = Math.round(remainingMs / 60_000);
    return `${step.arrival.sourceLabel} arrival in ${minutes} min at ${step.arrival.stopName}`;
  }
  return step.detail || "";
}

function renderUpcomingNavigationSteps() {
  const start = state.navigation.stepIndex;
  const visible = state.navigation.steps.slice(start, start + 4);
  els.upcomingSteps.innerHTML = visible.map((step, offset) => `
    <li class="${offset === 0 ? "active" : ""}">
      <span class="upcoming-step-icon">${escapeHtml(step.icon || "↑")}</span>
      <span>${escapeHtml(step.instruction)}</span>
      <small>${step.distanceMeters ? formatNavigationDistance(step.distanceMeters) : ""}</small>
    </li>`).join("");
}

function speakNavigationStep(step) {
  if (!window.speechSynthesis || state.navigation.lastSpokenStepId === step.id) return;
  state.navigation.lastSpokenStepId = step.id;
  const utterance = new SpeechSynthesisUtterance(step.instruction);
  utterance.lang = els.speechLanguage.value || "en-US";
  utterance.rate = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function recenterNavigation() {
  const center = state.navigation.currentPosition || state.navigation.coordinates.find(point => Array.isArray(point));
  if (!center || !state.map) return;
  state.map.easeTo({ center, zoom: 17, pitch: 42, bearing: 0, duration: 650, essential: true });
}

function toggleDemoMovement() {
  if (state.navigation.demoTimer) {
    clearInterval(state.navigation.demoTimer);
    state.navigation.demoTimer = null;
    els.demoMovementButton.textContent = "▶ Preview movement";
    setNavigationMessage("Route preview paused.");
    return;
  }
  const preview = demoNavigationPoints();
  const points = preview.points;
  if (!points.length) return;
  els.demoMovementButton.textContent = "Ⅱ Pause preview";
  setNavigationMessage("Route preview is moving along the selected route.");
  state.navigation.demoTimer = setInterval(() => {
    const point = points[Math.min(state.navigation.demoIndex, points.length - 1)];
    state.navigation.currentPosition = point;
    state.navigation.accuracy = null;
    updateCurrentLocationMarker(point);
    updateNavigationUI();
    state.map?.easeTo({ center: point, zoom: 17, duration: 500, essential: true });
    state.navigation.demoIndex += 1;
    if (state.navigation.demoIndex >= points.length) {
      clearInterval(state.navigation.demoTimer);
      state.navigation.demoTimer = null;
      els.demoMovementButton.textContent = "▶ Preview movement";
      if (preview.hasGeometryGap) {
        setNavigationMessage("Preview stopped at an unverified geometry gap. Movement is not simulated across the gap.");
      } else {
        state.navigation.stepIndex = state.navigation.steps.length - 1;
        updateNavigationUI();
        const recorded = recordNavigationCompletionOnce(state.navigation, recordPilotEvent, { mode: state.travelMode, source: "demo" });
        if (recorded) renderPilotMetrics();
        setNavigationMessage("Route preview completed.");
      }
    }
  }, 1100);
}

function demoNavigationPoints() {
  const segments = splitRouteGeometrySegments(state.navigation.coordinates || []);
  const routePoints = segments[0] || [];
  if (routePoints.length <= 24) return { points: routePoints, hasGeometryGap: segments.length > 1 };
  const sampleStep = Math.max(1, Math.floor(routePoints.length / 24));
  const sampled = routePoints.filter((_, index) => index % sampleStep === 0);
  if (sampled.at(-1) !== routePoints.at(-1)) sampled.push(routePoints.at(-1));
  return { points: sampled, hasGeometryGap: segments.length > 1 };
}

function updateCurrentLocationMarker(coordinates) {
  if (!state.mapLoaded || !coordinates) return;
  if (!state.navigation.currentMarker) {
    const element = document.createElement("div");
    element.className = "current-location-marker";
    state.navigation.currentMarker = new maplibregl.Marker({ element }).setLngLat(coordinates).addTo(state.map);
  } else {
    state.navigation.currentMarker.setLngLat(coordinates);
  }
}

function endNavigation() {
  stopNavigationWatchers();
  state.navigation.active = false;
  state.navigation.currentMarker?.remove();
  state.navigation.currentMarker = null;
  els.navigationOverlay.hidden = true;
  document.body.classList.remove("navigation-active");
  window.speechSynthesis?.cancel();
  if (state.map) {
    state.map.easeTo({ pitch: 0, bearing: 0, duration: 350 });
    setTimeout(() => {
      state.map.resize();
      const route = state.routes[state.selectedRouteIndex];
      if (route) drawSelectedRoute(route);
    }, 80);
  }
}

function stopNavigationWatchers() {
  if (state.navigation.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(state.navigation.watchId);
  if (state.navigation.demoTimer) clearInterval(state.navigation.demoTimer);
  if (state.navigation.clockTimer) clearInterval(state.navigation.clockTimer);
  if (state.navigation.arrivalTimer) clearInterval(state.navigation.arrivalTimer);
  state.navigation.watchId = null;
  state.navigation.demoTimer = null;
  state.navigation.clockTimer = null;
  state.navigation.arrivalTimer = null;
  els.demoMovementButton.textContent = "▶ Preview movement";
}

function setNavigationMessage(message) {
  els.navigationMessage.textContent = message;
}

function formatNavigationDistance(meters) {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 30) return `${Math.max(1, Math.round(meters))} m`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1609.344).toFixed(1)} mi`;
}


async function refreshTransitCapabilities(options = {}) {
  els.checkTransitConnectionsButton.disabled = true;
  els.checkTransitConnectionsButton.setAttribute("aria-busy", "true");
  try {
    await ensureRoutingCapabilities();
    const report = renderTransitConnectionStatus();
    if (!options.silent) {
      const messageType = report.overallStatus === "Connected" ? "neutral" : "warning";
      setPlannerMessage(report.detail, messageType);
    }
  } catch (error) {
    console.warn("Transit provider status unavailable:", error);
    state.transitConnectionObservations.routeProviderState = {
      status: "Unavailable",
      source: state.routeProviderCapabilities?.source,
      updatedAt: state.routeProviderCapabilities?.updatedAt
    };
    renderTransitConnectionStatus();
    if (!options.silent) {
      setPlannerMessage(
        "Configured transit connections could not be verified. Walk remains available using OpenStreetMap pedestrian data.",
        "warning"
      );
    }
  } finally {
    els.checkTransitConnectionsButton.disabled = false;
    els.checkTransitConnectionsButton.removeAttribute("aria-busy");
  }
}

function renderTransitConnectionStatus() {
  const routeCapabilities = state.routeProviderCapabilities || configuredRoutingCapabilities();
  const report = buildTransitConnectionReport({
    environment: transitEnvironment,
    routeCapabilities,
    ...state.transitConnectionObservations
  });
  state.transitConnectionReport = report;

  state.transitDataStatus = {
    source: report.transitConfigured ? "provider-connections" : "not-configured",
    sourceLabel: report.summary,
    freshness: report.overallStatus === "Stale" ? "stale" : report.overallStatus === "Connected" ? "current" : "unknown",
    elevatorStatus: report.connections.elevatorAccessibilityPaths.status === "Connected"
  };

  els.transitDataSummary.textContent = report.summary;
  els.transitDataDetail.textContent = report.detail;
  setConnectionBadge(report.overallStatus);
  const connectionKeys = {
    "route-provider": "routeProvider",
    "transit-network": "transitNetwork",
    "realtime-arrivals": "realtimeArrivals",
    "elevator-accessibility": "elevatorAccessibilityPaths",
    "ferry-schedules": "ferrySchedules"
  };
  els.transitConnectionList.querySelectorAll("[data-transit-connection]").forEach(row => {
    const connection = report.connections[connectionKeys[row.dataset.transitConnection]];
    const status = row.querySelector("[data-connection-status]");
    const meta = row.querySelector("[data-connection-meta]");
    status.textContent = connection.status;
    status.dataset.status = statusToken(connection.status);
    const metadata = [
      connection.source,
      connection.updatedAt ? `Updated ${formatConnectionTime(connection.updatedAt)}` : null
    ].filter(Boolean);
    meta.textContent = metadata.join(" · ");
    meta.hidden = metadata.length === 0;
  });
  updateTransitModeAvailability(report, routeCapabilities);

  if (import.meta.env?.DEV) {
    els.transitDiagnostics.hidden = false;
    els.transitDiagnosticsJson.textContent = JSON.stringify(
      sanitizedTransitDiagnostics({ ...report, environment: transitEnvironment }),
      null,
      2
    );
  } else {
    els.transitDiagnostics.hidden = true;
    els.transitDiagnosticsJson.textContent = "";
  }
  return report;
}

function updateTransitModeAvailability(report, routeCapabilities) {
  const availability = transitModeAvailability(
    report,
    transitEnvironment,
    routeCapabilities,
    state.transitConnectionObservations.transitNetworkState
  );
  let selectedModeDisabled = false;
  document.querySelectorAll(".mode-chip").forEach(button => {
    const mode = button.dataset.mode;
    const available = availability[mode] === true;
    button.disabled = !available;
    button.setAttribute("aria-disabled", String(!available));
    if (!available) button.tabIndex = -1;
    if (button.getAttribute("aria-checked") === "true" && !available) selectedModeDisabled = true;
  });
  if (selectedModeDisabled) setTravelMode("walk");
  const enabledTransitModes = ["bus", "subway", "ferry", "mixed"].filter(mode => availability[mode]);
  els.transitModeAvailability.textContent = enabledTransitModes.length
    ? `Configured services allow ${enabledTransitModes.map(capitalize).join(", ")} routing. Connection rows distinguish verified, stale, and unverified services.`
    : "Walk uses OSM data. Connect an application-owned transit service to use Bus, Subway, Ferry, or Mixed routing.";
}

function setConnectionBadge(status) {
  els.transitConnectionBadge.textContent = status;
  els.transitConnectionBadge.dataset.status = statusToken(status);
}

function statusToken(status) {
  return String(status || "Unknown").toLowerCase().replaceAll(" ", "-");
}

function formatConnectionTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

async function copyTransitDiagnostics() {
  if (!import.meta.env?.DEV) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(els.transitDiagnosticsJson.textContent);
    els.copyTransitDiagnosticsStatus.textContent = "Diagnostics copied.";
  } catch {
    els.copyTransitDiagnosticsStatus.textContent = "Could not copy diagnostics. Select the diagnostics text instead.";
  }
}

function capitalize(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function renderRouteTrust(route) {
  if (!route) {
    els.routeTrustSummary.hidden = true;
    return;
  }
  const trust = route.trust || summarizeRouteTrust({ edgeIds: routeEdgeIds(route) }, state.edges);
  route.trust = trust;
  const sourceLabels = Object.entries(trust.sources || {}).map(([source, count]) => `${sourceLabel(source)} ${count}`).join(" · ");
  els.routeTrustSummary.hidden = false;
  els.routeTrustSummary.innerHTML = `
    <div><span class="section-kicker">DATA COVERAGE</span><strong>${escapeHtml(trust.coverageLevel || "Limited coverage")}</strong><small>${formatDistance(trust.reviewedDistance || 0)} locally reviewed · ${trust.unknownSegments} critical unknown segment${trust.unknownSegments === 1 ? "" : "s"}</small></div>
    <div class="trust-source-row">${escapeHtml(sourceLabels || "No walking data")}</div>
    <p>${trust.barrierSegments ? "A local review records a barrier on this route; recalculate before navigation." : "Coverage describes mapped fields, not the probability of successful or safe passage. Unknown does not mean accessible."}</p>`;
}

function sourceLabel(source) {
  return ({ "local-field-review": "Local review", openstreetmap: "OSM", demo: "Test fixture", unknown: "Unknown" })[source] || source;
}

function openVerificationPanel() {
  const route = state.routes[state.selectedRouteIndex];
  if (!route) return;
  const edgeMap = new Map(state.edges.map(edge => [edge.id, edge]));
  const edges = routeEdgeIds(route).map(id => edgeMap.get(id)).filter(Boolean);
  if (!edges.length) return;
  els.verificationList.innerHTML = edges.map(edge => {
    const status = edge.verificationStatus || "unverified";
    const checked = edge.lastChecked ? new Date(edge.lastChecked).toLocaleString() : "Not reviewed locally";
    return `<article class="verification-item ${status === "barrier" ? "barrier" : ""}">
      <div class="verification-item-heading"><div><strong>${escapeHtml(edge.name || "Pedestrian segment")}</strong><small>${formatDistance(edge.distanceMeters)} · ${escapeHtml(edge.surface || "unknown surface")} · ${Number.isFinite(edge.slope) ? `${edge.slope.toFixed(1)}% slope` : "unknown slope"}</small></div><span class="verification-status">${escapeHtml(status.replaceAll("-", " "))}</span></div>
      <p>Source: ${escapeHtml(edge.dataSourceLabel || "Unknown")} · mapped accessibility fields ${Number(edge.mappedAccessibilityFields || 0)} · ${escapeHtml(checked)}${edge.sourceExpiresAt ? ` · expires ${escapeHtml(new Date(edge.sourceExpiresAt).toLocaleDateString())}` : ""}</p>
      <div class="verification-actions">
        <button type="button" data-edge-id="${escapeHtml(edge.id)}" data-review-status="passable">Passable</button>
        <button type="button" data-edge-id="${escapeHtml(edge.id)}" data-review-status="needs-review">Not sure</button>
        <button class="barrier-button" type="button" data-edge-id="${escapeHtml(edge.id)}" data-review-status="barrier">Barrier</button>
      </div>
    </article>`;
  }).join("");
  state.dialogTrigger = document.activeElement;
  document.querySelector(".app-frame").inert = true;
  els.verificationPanel.hidden = false;
  setTimeout(() => document.getElementById("verificationTitle")?.focus(), 0);
}

function closeVerificationPanel() {
  els.verificationPanel.hidden = true;
  document.querySelector(".app-frame").inert = false;
  if (state.dialogTrigger && document.contains(state.dialogTrigger)) state.dialogTrigger.focus();
  state.dialogTrigger = null;
}

function trapVerificationFocus(event) {
  if (event.key !== "Tab") return;
  const focusable = [...els.verificationPanel.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(element => !element.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement?.id === "verificationTitle")) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function reviewSegment(edgeId, status) {
  try {
    saveSegmentReview(edgeId, status);
  } catch (error) {
    if (!reportStorageError(error)) throw error;
    return;
  }
  state.segmentReviews = loadSegmentReviews();
  state.edges = applyTrustMetadata(state.edges, state.segmentReviews);
  recordPilotEvent("segment_review", { edgeId, status });
  renderPilotMetrics();
  closeVerificationPanel();
  setPlannerMessage(status === "barrier" ? "Barrier saved. Recalculating without that segment…" : "Review saved. Updating route trust…", status === "barrier" ? "warning" : "success");
  await calculateRoutes();
}

function monitorOffRoute(coordinates) {
  const navigation = state.navigation;
  if (!navigation.active || navigation.rerouting || !navigation.coordinates.length) return;
  const step = navigation.steps[navigation.stepIndex];
  if (!isPedestrianOffRouteEligible(step, navigation.accuracy)) {
    navigation.offRouteCount = 0;
    return;
  }
  const distance = distanceToRouteMeters(coordinates, step.coordinates);
  if (distance > 48) navigation.offRouteCount += 1;
  else navigation.offRouteCount = 0;
  if (navigation.offRouteCount >= 3) rerouteActiveNavigation(coordinates);
}

async function rerouteActiveNavigation(coordinates) {
  const navigation = state.navigation;
  if (navigation.rerouting) return;
  navigation.rerouting = true;
  navigation.rerouteState = "pending";
  navigation.offRouteCount = 0;
  state.startId = null;
  state.startPlace = { id: "reroute-location", name: "Current location", subtitle: "Automatic reroute", coordinates };
  setPlaceInput("start", state.startPlace);
  updateEndpointMarker("start");
  setNavigationMessage("Off route detected. Recalculating an accessible route…");
  recordPilotEvent("automatic_reroute", { mode: state.travelMode, distanceFromRouteMeters: Math.round(distanceToRouteMeters(coordinates, navigation.coordinates)) });
  renderPilotMetrics();
  try {
    const succeeded = await calculateRoutes({ navigationReroute: true });
    if (!succeeded && navigation.rerouteState !== "failed") navigation.rerouteState = "failed";
  } catch (error) {
    navigation.rerouteState = "failed";
    setNavigationMessage(`Rerouting failed: ${error.message || "unknown error"}. The previous route remains active.`);
  } finally {
    navigation.rerouting = false;
  }
}

function resumeNavigationAfterReroute() {
  const route = state.routes[state.selectedRouteIndex];
  if (!route) return;
  state.navigation.steps = route.navigationSteps || [];
  state.navigation.stepIndex = 0;
  state.navigation.coordinates = routeCoordinates(route);
  state.navigation.demoIndex = 0;
  state.navigation.lastSpokenStepId = null;
  state.navigation.selectedRouteKey = route.id || null;
  updateNavigationUI();
  setNavigationMessage("Accessible route updated from your current position.");
}

function renderPilotMetrics() {
  const metrics = pilotMetrics();
  if (!els.metricRoutes) return;
  els.metricRoutes.textContent = String(metrics.routesPlanned);
  els.metricCompleted.textContent = String(metrics.navigationCompleted);
  els.metricReroutes.textContent = String(metrics.reroutes);
  els.metricReviews.textContent = String(metrics.segmentReviews);
  els.pilotMetricNote.textContent = metrics.navigationStarted
    ? `${Math.round(metrics.completionRate * 100)}% recorded completion rate across ${metrics.navigationStarted} started trip${metrics.navigationStarted === 1 ? "" : "s"}. Events stay on this device until exported.`
    : "No pilot trips recorded yet. Events stay on this device until exported.";
}

function exportPilotData() {
  const payload = exportPilotPayload({
    segmentReviews: state.segmentReviews,
    networkSource: state.networkSource,
    transitDataStatus: state.transitDataStatus
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pathforall-pilot-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function togglePlannerSheet() {
  const collapsed = !els.plannerContent.hidden;
  els.plannerContent.hidden = collapsed;
  els.sheetToggleButton.setAttribute("aria-expanded", String(!collapsed));
  els.sheetToggleButton.querySelector(".visually-hidden").textContent = collapsed
    ? "Expand trip planner"
    : "Collapse trip planner";
  document.querySelector(".planner-sheet").classList.toggle("collapsed", collapsed);
  requestMapResize();
}

function deleteSavedData() {
  clearSavedRoutes();
  state.savedRoutes = [];
  renderSavedRoutes();
  els.storageStatus.textContent = "Saved routes deleted from this device.";
}

function deleteReviewData() {
  clearSegmentReviews();
  state.segmentReviews = {};
  state.edges = applyTrustMetadata(state.edges, {});
  renderPilotMetrics();
  els.storageStatus.textContent = "Local route reviews deleted.";
}

function deleteEventData() {
  clearPilotEvents();
  renderPilotMetrics();
  els.storageStatus.textContent = "Navigation and planning events deleted.";
}

function deleteAllLocalData() {
  if (!window.confirm("Delete the on-device profile, saved routes, reviews, and navigation events? This cannot be undone.")) return;
  clearProfile();
  clearSavedRoutes();
  clearSegmentReviews();
  clearPilotEvents();
  state.profile = loadProfile();
  state.savedRoutes = [];
  state.segmentReviews = {};
  state.edges = applyTrustMetadata(state.edges, {});
  renderProfile();
  renderActiveNeeds();
  renderSavedRoutes();
  renderPilotMetrics();
  els.storageStatus.textContent = "All PathForAll local data deleted.";
}

function renderProfile() {
  const profile = state.profile;
  els.nameInput.value = profile.signedIn ? profile.name : "";
  els.emailInput.value = profile.email;
  els.profileDisplayName.textContent = profile.signedIn ? profile.name : "Guest";
  els.profileEmailDisplay.textContent = profile.signedIn && profile.email ? profile.email : "On-device profile";
  renderAvatars();

  const needs = profile.needs;
  els.mobilityProfile.value = needs.mobilityProfile || (needs.wheelchairMode ? "wheelchair" : "custom");
  ["avoidStairs", "requireCurb", "preferSmooth", "requireElevator", "preferShade", "avoidRain", "minimizeTransfers"]
    .forEach(key => { els[key].checked = Boolean(needs[key]); });
  els.maxSlope.value = needs.maxSlope;
  els.maxWalkMinutes.value = needs.maxWalkMinutes;
  state.customNeedsDraft = [...needs.customNeeds];
  updateSliderOutputs();
  renderCustomNeeds();
}

function renderAvatars() {
  const initial = (state.profile.name || "Guest").trim().charAt(0).toUpperCase() || "G";
  els.headerAvatarFallback.textContent = initial;
  els.profileAvatarFallback.textContent = initial;
  for (const [image, fallback] of [[els.headerAvatarImage, els.headerAvatarFallback], [els.profileAvatarImage, els.profileAvatarFallback]]) {
    if (state.profile.avatar) {
      image.src = state.profile.avatar;
      image.hidden = false;
      fallback.hidden = true;
    } else {
      image.hidden = true;
      fallback.hidden = false;
    }
  }
}

function saveAccount(event) {
  event.preventDefault();
  const name = els.nameInput.value.trim();
  const email = els.emailInput.value.trim();
  if (!name) {
    els.profileEmailDisplay.textContent = "Enter a display name to save this on-device profile.";
    return;
  }
  try {
    state.profile = saveProfile({ ...state.profile, signedIn: true, name, email });
  } catch (error) {
    if (!reportStorageError(error)) throw error;
    state.profile = { ...state.profile, signedIn: true, name, email };
  }
  renderProfile();
  renderActiveNeeds();
  els.savedStatus.textContent = "Account saved";
}

function signOut() {
  try {
    state.profile = signOutProfile(state.profile);
  } catch (error) {
    if (!reportStorageError(error)) throw error;
    state.profile = { ...state.profile, signedIn: false, name: "Guest", email: "", avatar: "" };
  }
  renderProfile();
  renderActiveNeeds();
  els.savedStatus.textContent = "Signed out";
}

async function updateAvatar(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return;
  if (file.size > 5_000_000) {
    els.profileEmailDisplay.textContent = "Choose an image smaller than 5 MB.";
    return;
  }
  try {
    const avatar = await compressAvatar(file);
    state.profile = saveProfile({ ...state.profile, avatar });
    renderAvatars();
    els.profileEmailDisplay.textContent = "Photo saved on this device.";
  } catch (error) {
    if (!reportStorageError(error)) {
      console.warn("Avatar could not be processed:", error);
      els.profileEmailDisplay.textContent = "The photo could not be processed. Try another image.";
    }
  } finally {
    event.target.value = "";
  }
}

function saveDefaultNeeds(event) {
  event.preventDefault();
  const mobilityProfile = els.mobilityProfile.value;
  const nextProfile = {
    ...state.profile,
    needs: {
      ...state.profile.needs,
      mobilityProfile,
      wheelchairMode: mobilityProfile === "wheelchair"
        ? true
        : mobilityProfile === "custom"
          ? Boolean(state.profile.needs.wheelchairMode)
          : false,
      avoidStairs: els.avoidStairs.checked,
      requireCurb: els.requireCurb.checked,
      curbPolicy: els.requireCurb.checked ? "preffered" : mobilityProfile === "custom" ? "allowUnknown" : "preferred",
      preferSmooth: els.preferSmooth.checked,
      requireElevator: els.requireElevator.checked,
      preferShade: els.preferShade.checked,
      avoidRain: els.avoidRain.checked,
      minimizeTransfers: els.minimizeTransfers.checked,
      maxSlope: Number(els.maxSlope.value),
      maxWalkMinutes: Number(els.maxWalkMinutes.value),
      customNeeds: [...state.customNeedsDraft]
    }
  };
  try {
    state.profile = saveProfile(nextProfile);
  } catch (error) {
    if (!reportStorageError(error)) throw error;
    state.profile = nextProfile;
  }
  els.savedStatus.textContent = "Saved just now";
  renderActiveNeeds();
  setPlannerMessage("Your default needs will be used in every new route.", "success");
}

function applySelectedMobilityPreset() {
  const needs = applyMobilityPreset(els.mobilityProfile.value, state.profile.needs);
  ["avoidStairs", "requireCurb", "preferSmooth", "requireElevator", "preferShade", "avoidRain", "minimizeTransfers"]
    .forEach(key => { els[key].checked = Boolean(needs[key]); });
  els.maxSlope.value = needs.maxSlope;
  els.maxWalkMinutes.value = needs.maxWalkMinutes;
  updateSliderOutputs();
  els.savedStatus.textContent = "Preset applied · save to keep";
}

async function compressAvatar(file) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Invalid image."));
      element.src = sourceUrl;
    });
    const maximum = 256;
    const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = .82;
    let result = canvas.toDataURL("image/jpeg", quality);
    while (result.length > 180_000 && quality > .42) {
      quality -= .1;
      result = canvas.toDataURL("image/jpeg", quality);
    }
    if (result.length > 180_000) throw new Error("Compressed avatar is still too large.");
    return result;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function updateSliderOutputs() {
  els.maxSlopeOutput.textContent = `${els.maxSlope.value}%`;
  els.maxWalkOutput.textContent = `${els.maxWalkMinutes.value} min`;
}

function addCustomNeed() {
  const value = els.customNeedInput.value.trim();
  if (!value) return;
  if (!state.customNeedsDraft.some(item => item.toLowerCase() === value.toLowerCase())) {
    state.customNeedsDraft.push(value.slice(0, 80));
  }
  els.customNeedInput.value = "";
  renderCustomNeeds();
}

function renderCustomNeeds() {
  if (!state.customNeedsDraft.length) {
    els.customNeedList.innerHTML = '<span class="helper-message">No additional needs added.</span>';
    return;
  }
  els.customNeedList.innerHTML = state.customNeedsDraft.map((need, index) => `
    <span class="custom-need-chip">${escapeHtml(need)}<button type="button" data-remove-need="${index}" aria-label="Remove ${escapeHtml(need)}">×</button></span>`).join("");
  els.customNeedList.querySelectorAll("[data-remove-need]").forEach(button => {
    button.addEventListener("click", () => {
      state.customNeedsDraft.splice(Number(button.dataset.removeNeed), 1);
      renderCustomNeeds();
    });
  });
}

function renderActiveNeeds() {
  const labels = profileNeedsToLabels(state.profile.needs).slice(0, 5);
  const extra = Math.max(0, profileNeedsToLabels(state.profile.needs).length + state.profile.needs.customNeeds.length - labels.length);
  els.activeNeeds.innerHTML = labels.map(label => `<span class="need-chip">${escapeHtml(label)}</span>`).join("")
    + (extra ? `<span class="need-chip">+${extra} more</span>` : "");
}

function scheduleWeatherRefresh() {
  clearTimeout(state.weatherTimer);
  state.weatherController?.abort();
  state.weatherTimer = setTimeout(() => {
    state.weatherController = new AbortController();
    fetchWeather({ signal: state.weatherController.signal });
  }, 450);
}

async function fetchWeather(options = {}) {
  const coordinates = state.startPlace?.coordinates;
  if (!coordinates) {
    state.weather = {
      temperatureF: null,
      precipitation: null,
      isRaining: null,
      source: "unavailable",
      updatedAt: null,
      freshness: "unknown"
    };
    return;
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coordinates[1]}&longitude=${coordinates[0]}&current=temperature_2m,precipitation&temperature_unit=fahrenheit&timezone=auto`;
  try {
    const response = await fetchWithPolicy(url, { signal: options.signal }, {
      timeoutMs: 9_000,
      retries: 1,
      source: "Open-Meteo weather"
    });
    if (!response.ok) throw new Error(`Weather ${response.status}`);
    const data = await response.json();
    const temperatureF = Number(data.current?.temperature_2m);
    const precipitation = Number(data.current?.precipitation);
    if (!Number.isFinite(temperatureF) || !Number.isFinite(precipitation)) throw new Error("Weather response is incomplete.");
    const updatedAt = Number.isFinite(Date.parse(data.current?.time))
      ? new Date(data.current.time).toISOString()
      : new Date().toISOString();
    state.weather = {
      temperatureF,
      precipitation,
      isRaining: precipitation > 0,
      source: "Open-Meteo",
      updatedAt,
      freshness: "current"
    };
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.warn(error);
    state.weather = {
      temperatureF: null,
      precipitation: null,
      isRaining: null,
      source: "unavailable",
      updatedAt: null,
      freshness: "unknown"
    };
  }
}

function setNetworkBadge(message, status) {
  els.networkBadge.textContent = message;
  els.networkBadge.dataset.status = status;
}

function setMapMessage(message, status) {
  els.mapMessage.textContent = message;
  els.mapMessage.dataset.status = status;
}

function setPlannerMessage(message, type) {
  els.plannerMessage.textContent = message;
  els.plannerMessage.dataset.status = type || "neutral";
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
