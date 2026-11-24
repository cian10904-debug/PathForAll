"use strict";

import { modeLabel } from "./transit-modes.js";
import { transitLegs } from "./route-model.js";

/** Pure card data for the UI and Node integration tests. */
export function routeCardViewModel(route) {
  const transit = transitLegs(route);
  const firstTransit = transit[0] || null;
  const lastTransit = transit.at(-1) || null;
  const isTransit = transit.length > 0;
  const stationLeg = transit.find(leg => ["subway", "rail"].includes(leg.mode));
  const elevatorAccessibility = stationLeg?.accessibility || {};
  const elevator = stationLeg ? elevatorAccessibility.elevator?.status || elevatorAccessibility.elevatorStatus || "Status unknown" : "Not required for this ride";
  const arrival = route?.arrivals;
  const ferry = transit.find(leg => leg.mode === "ferry");
  const arrivalBoardings = route?.boardings || arrival?.boardings || [];
  const availableBoardings = arrivalBoardings.filter(boarding => boarding.status === "available");
  const scheduleUnknown = Boolean(ferry && (
    ferry.scheduleStatus !== "verified"
    || ferry.scheduleFreshness !== "current"
    || !ferry.scheduleSource
    || !ferry.departureTime
  ));
  const scheduled = transit.filter(leg => (leg.scheduledDepartureTime || leg.departureTime) && leg.scheduleStatus === "verified" && leg.scheduleSource);
  return {
    type: isTransit ? "transit" : route?.mode === "walk" ? "walk" : "invalid",
    icon: route?.mode === "bus" ? "🚌" : route?.mode === "subway" ? "🚇" : route?.mode === "ferry" ? "⛴" : route?.mode === "rail" ? "🚆" : route?.mode === "mixed" ? "↔" : "🚶",
    durationMinutes: Math.max(0, Math.round(Number(route?.totalDurationSeconds || 0) / 60)),
    durationLabel: scheduleUnknown ? "Schedule required" : `${Math.max(0, Math.round(Number(route?.totalDurationSeconds || 0) / 60))} min`,
    waitMinutes: Math.ceil(Number(route?.totalWaitSeconds || 0) / 60),
    transfers: Math.max(0, Number(route?.transfers) || 0),
    walkingMinutes: Math.max(0, Math.round((route?.legs || []).filter(leg => leg.mode === "walk" || leg.mode === "transfer").reduce((sum, leg) => sum + Number(leg.durationSeconds || 0), 0) / 60)),
    transitMinutes: Math.max(0, Math.round(transit.reduce((sum, leg) => sum + Number(leg.durationSeconds || 0) + Number(leg.waitSeconds || 0), 0) / 60)),
    transitSummary: transit.map(leg => `${modeLabel(leg.mode)} ${leg.routeName || leg.routeId || leg.operator || "service"}${leg.headsign ? ` toward ${leg.headsign}` : ""}`).filter((value, index, all) => all.indexOf(value) === index),
    boardingName: firstTransit?.from?.name || null,
    exitName: lastTransit?.to?.name || null,
    elevatorStatus: elevator,
    dataCoverage: dataCoverageLabel(route),
    hasFrequencyEstimate: transit.some(leg => leg.waitSource === "frequency"),
    hasEstimatedTime: transit.some(leg => leg.waitSource === "realtime"),
    scheduleText: transit.some(leg => leg.waitSource === "frequency") ? "Frequency-based waiting estimates are shown where exact departures are unavailable." : scheduled.length ? `Uses scheduled times: ${scheduled.map(leg => `${leg.routeName || leg.routeId} departs ${new Date(leg.scheduledDepartureTime || leg.departureTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} New York time`).join("; ")}. Schedules are not live predictions.` : "Schedule evidence is not available for every boarding.",
    lighting: lightingLabel(route?.accessibility),
    surfaceSlope: surfaceSlopeLabel(route?.accessibility),
    arrivalText: availableBoardings.length
      ? `${availableBoardings.length} of ${arrivalBoardings.length} boarding arrival${availableBoardings.length === 1 ? "" : "s"} available`
      : arrival?.status === "stale" ? "Arrival data may be stale" : "Arrival information unavailable",
    boardingArrivals: arrivalBoardings.map(boarding => ({
      label: `${modeLabel(boarding.mode)} ${boarding.routeId || "service"}`,
      text: boarding.status === "available" && boarding.selectedPrediction
        ? `${boarding.selectedPrediction.kind === "scheduled" ? "Scheduled" : boarding.sourceLabel || "Provider"} in ${boarding.selectedPrediction.minutes} min`
        : boarding.status === "stale" ? "Data may be stale" : "Arrival information unavailable"
    })),
    operator: ferry?.operator || null,
    ticketRequired: ferry?.ticketRequired === true,
    securityScreeningRequired: ferry?.securityScreeningRequired === true,
    ferryScheduleUnavailable: scheduleUnknown,
    dataFreshness: route?.dataFreshness || "unknown",
    dataUpdatedAt: route?.updatedAt || route?.providerUpdatedAt || null,
    evidenceStatus: route?.evidence?.status || "unknown",
    warnings: route?.warnings || [],
    hasTransitGeometryGap: transit.some(leg => !leg.geometry)
  };
}

const escapeText = value => String(value ?? "").replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
export function routeCardMarkup(route, index, escape = escapeText, selected = false) {
  const view = routeCardViewModel(route);
  if (view.type === "invalid") return `<div class="empty-card"><strong>Route details unavailable</strong><span>This route could not be safely displayed.</span></div>`;
  const selectedClass = selected ? " selected" : "";
  const selectButton = (label, icon, duration) => `<button class="route-select-button" type="button" role="radio" aria-checked="${selected}" data-route-index="${index}" aria-label="Select ${escape(label)}, ${escape(duration)}"><span><span class="route-label">${escape(label)}</span><span class="route-time">${escape(duration)}</span></span><span aria-hidden="true">${icon}</span></button>`;
  if (view.type === "walk") {
    return `<article class="route-card${selectedClass}">${selectButton(route.label, view.icon, view.durationLabel)}${evidenceMarkup(route, escape)}<p class="route-summary">${escape(route.warnings?.join("; ") || "Walking route based on available map evidence.")}</p><div class="route-metrics"><div class="route-metric"><span>Distance</span><strong>${Math.round(route.distanceMeters || 0)} m</strong></div><div class="route-metric"><span>Data coverage</span><strong>${escape(view.dataCoverage)}</strong></div><div class="route-metric"><span>Estimated lighting coverage</span><strong>${escape(view.lighting)}</strong></div><div class="route-metric"><span>Surface & slope</span><strong>${escape(view.surfaceSlope)}</strong></div></div></article>`;
  }
  const transitItems = view.transitSummary.map(item => `<li>${escape(item)}</li>`).join("");
  const boardingItems = view.boardingArrivals.map(item => `<li><strong>${escape(item.label)}</strong> · ${escape(item.text)}</li>`).join("");
  const ferryDetails = view.operator
    ? `<p class="ferry-detail"><strong>${escape(view.operator)}</strong>${view.ticketRequired ? " · Ticket required" : ""}${view.securityScreeningRequired ? " · Security screening required" : ""}${view.ferryScheduleUnavailable ? " · Check current schedule and ticket availability" : ""}</p>`
    : "";
  const warning = view.hasTransitGeometryGap ? "Detailed transit map geometry is unavailable for part of this route." : "";
  const sourceDetails = `<p class="trust-line">${escape(view.scheduleText)}${view.hasEstimatedTime ? " OTP estimates are separate from scheduled times." : ""}</p><details><summary>Sources and limitations</summary><p>${escape(route.dataSource)}. Retrieved ${escape(route.retrievedAt || route.updatedAt || "at an unknown time")}.</p><ul>${(route.warnings || []).map(text => `<li>${escape(text)}</li>`).join("")}</ul></details>`;
  return `<article class="route-card${selectedClass}">${selectButton(route.label, view.icon, view.durationLabel)}<p class="route-summary">${view.boardingName ? `Board at ${escape(view.boardingName)}${view.exitName ? ` and exit at ${escape(view.exitName)}.` : "."}` : "Transit stop details are unavailable."}</p><p class="transit-arrival-line"><strong>${escape(view.transitSummary[0] || "Transit")}</strong> · ${escape(view.arrivalText)}</p><p class="route-summary">${view.transfers} transfer${view.transfers === 1 ? "" : "s"} · ${view.walkingMinutes} min walking · ${view.waitMinutes} min waiting</p>${ferryDetails}${sourceDetails}${evidenceMarkup(route, escape)}<div class="route-metrics"><div class="route-metric"><span>Distance</span><strong>${Math.round(route.distanceMeters || 0)} m</strong></div><div class="route-metric"><span>Data coverage</span><strong>${escape(view.dataCoverage)}</strong></div><div class="route-metric"><span>Estimated lighting coverage</span><strong>${escape(view.lighting)}</strong></div><div class="route-metric"><span>Surface & slope</span><strong>${escape(view.surfaceSlope)}</strong></div><div class="route-metric"><span>Station access</span><strong>${escape(view.elevatorStatus)}</strong></div></div>${warning ? `<p class="trust-line">${escape(warning)}</p>` : ""}<ol class="segment-list">${transitItems}${boardingItems}</ol></article>`;
}

function dataCoverageLabel(route) {
  if (route?.evidence?.status === "unknown") return "Required evidence missing";
  if (route?.evidence?.status === "violated") return "Known requirement violation";
  const trust = route?.trust || {};
  if (Number(trust.barrierSegments || 0) > 0) return "Known barrier";
  if (Number(trust.criticalUnknowns ?? trust.unknownSegments ?? 0) > 0) return "Critical gaps";
  if (trust.coverageLevel) return String(trust.coverageLevel);
  if (route?.dataFreshness === "stale") return "Stale";
  if (route?.dataFreshness === "current") return "Current provider";
  return "Limited";
}

function lightingLabel(metrics = {}) {
  if (!Number.isFinite(metrics.litCoverage)) return "Lighting data unavailable";
  const percent = Math.round(metrics.litCoverage * 100);
  if (Number(metrics.unknownLightingCoverage || 0) > 0) return `${percent}% · some segments unavailable`;
  return `${percent}% mapped as lit`;
}

function surfaceSlopeLabel(metrics = {}) {
  const surface = metrics.roughSegments ? "Rough sections" : metrics.unevenSegments ? "Mixed surface" : "Surface unknown";
  const slope = metrics.maxSlope == null ? "slope unknown" : `${Number(metrics.maxSlope).toFixed(1)}% mapped max${metrics.unknownSlopeSegments ? " · gaps" : ""}`;
  return `${surface} · ${slope}`;
}

function evidenceMarkup(route, escape) {
  const data = route.evidence;
  if (!data) return '<p class="trust-line">Accessibility evidence is incomplete.</p>';
  const label = data.status === "satisfied" ? data.requirements?.length ? "Selected requirements supported by mapped evidence" : "No mandatory accessibility requirements applied" : data.status === "violated" ? "Known requirement violation" : "Selected requirements not fully confirmed";
  const reasons = (data.segments || []).flatMap(segment => [...segment.unknowns, ...segment.violations].map(([name, value]) => `<li>${escape(name)} · ${Math.round(segment.distanceMeters)} m: ${escape(value.reason)}</li>`));
  return `<p class="trust-line">${escape(label)}. Map tags are not field verification.</p>${reasons.length ? `<details class="evidence-details"><summary>Inspect unknown conditions (${Math.round(data.unknownDistanceMeters)} m; ${data.unknownEvents || 0} boarding checks)</summary><ul>${reasons.join("")}</ul></details>` : ""}`;
}
