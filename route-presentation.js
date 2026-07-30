"use strict";

import { transitLegs } from "./route-model.js";

/** Pure card data for the UI and Node integration tests. */
export function routeCardViewModel(route) {
  const transit = transitLegs(route);
  const firstTransit = transit[0] || null;
  const lastTransit = transit.at(-1) || null;
  const isTransit = ["bus", "subway", "ferry", "mixed"].includes(route?.mode);
  const elevatorAccessibility = transit.find(leg => leg.mode === "subway")?.accessibility || {};
  const elevator = elevatorAccessibility.elevator?.status || elevatorAccessibility.elevatorStatus || "unknown";
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
  return {
    type: isTransit ? "transit" : route?.mode === "walk" ? "walk" : "invalid",
    icon: route?.mode === "bus" ? "🚌" : route?.mode === "subway" ? "🚇" : route?.mode === "ferry" ? "⛴" : route?.mode === "mixed" ? "↔" : "🚶",
    durationMinutes: Math.max(0, Math.round(Number(route?.totalDurationSeconds || 0) / 60)),
    durationLabel: scheduleUnknown ? "Schedule required" : `${Math.max(0, Math.round(Number(route?.totalDurationSeconds || 0) / 60))} min`,
    walkingMinutes: Math.max(0, Math.round((route?.legs || []).filter(leg => leg.mode === "walk" || leg.mode === "transfer").reduce((sum, leg) => sum + Number(leg.durationSeconds || 0), 0) / 60)),
    transitMinutes: Math.max(0, Math.round(transit.reduce((sum, leg) => sum + Number(leg.durationSeconds || 0) + Number(leg.waitSeconds || 0), 0) / 60)),
    transitSummary: transit.map(leg => `${leg.mode === "bus" ? "Bus" : leg.mode === "subway" ? "Subway" : "Ferry"} ${leg.routeName || leg.routeId || leg.operator || "service"}${leg.headsign ? ` toward ${leg.headsign}` : ""}`).filter((value, index, all) => all.indexOf(value) === index),
    boardingName: firstTransit?.from?.name || null,
    exitName: lastTransit?.to?.name || null,
    elevatorStatus: elevator,
    dataCoverage: dataCoverageLabel(route),
    lighting: lightingLabel(route?.accessibility),
    surfaceSlope: surfaceSlopeLabel(route?.accessibility),
    arrivalText: availableBoardings.length
      ? `${availableBoardings.length} of ${arrivalBoardings.length} boarding arrival${availableBoardings.length === 1 ? "" : "s"} available`
      : arrival?.status === "stale" ? "Arrival data may be stale" : "Arrival information unavailable",
    boardingArrivals: arrivalBoardings.map(boarding => ({
      label: `${boarding.mode === "bus" ? "Bus" : boarding.mode === "subway" ? "Subway" : "Ferry"} ${boarding.routeId || "service"}`,
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
    warnings: route?.warnings || [],
    hasTransitGeometryGap: transit.some(leg => !leg.geometry)
  };
}

export function routeCardMarkup(route, index, escape = value => String(value ?? ""), selected = false) {
  const view = routeCardViewModel(route);
  if (view.type === "invalid") return `<div class="empty-card"><strong>Route details unavailable</strong><span>This route could not be safely displayed.</span></div>`;
  const selectedClass = selected ? " selected" : "";
  const selectButton = (label, icon, duration) => `<button class="route-select-button" type="button" role="radio" aria-checked="${selected}" data-route-index="${index}" aria-label="Select ${escape(label)}, ${escape(duration)}"><span><span class="route-label">${escape(label)}</span><span class="route-time">${escape(duration)}</span></span><span aria-hidden="true">${icon}</span></button>`;
  if (view.type === "walk") {
    return `<article class="route-card${selectedClass}">${selectButton(route.label, view.icon, view.durationLabel)}<p class="route-summary">${escape(route.warnings?.join("; ") || "Personalized accessible walking route.")}</p><div class="route-metrics"><div class="route-metric"><span>Distance</span><strong>${Math.round(route.distanceMeters || 0)} m</strong></div><div class="route-metric"><span>Data coverage</span><strong>${escape(view.dataCoverage)}</strong></div><div class="route-metric"><span>Lighting</span><strong>${escape(view.lighting)}</strong></div><div class="route-metric"><span>Surface & slope</span><strong>${escape(view.surfaceSlope)}</strong></div></div></article>`;
  }
  const transitItems = view.transitSummary.map(item => `<li>${escape(item)}</li>`).join("");
  const boardingItems = view.boardingArrivals.map(item => `<li><strong>${escape(item.label)}</strong> · ${escape(item.text)}</li>`).join("");
  const ferryDetails = view.operator
    ? `<p class="ferry-detail"><strong>${escape(view.operator)}</strong>${view.ticketRequired ? " · Ticket required" : ""}${view.securityScreeningRequired ? " · Security screening required" : ""}${view.ferryScheduleUnavailable ? " · Check current schedule and ticket availability" : ""}</p>`
    : "";
  const warning = view.hasTransitGeometryGap ? "Detailed transit map geometry is unavailable for part of this route." : "";
  return `<article class="route-card${selectedClass}">${selectButton(route.label, view.icon, view.durationLabel)}<p class="route-summary">${view.boardingName ? `Board at ${escape(view.boardingName)}${view.exitName ? ` and exit at ${escape(view.exitName)}.` : "."}` : "Transit stop details are unavailable."}</p><p class="transit-arrival-line"><strong>${escape(view.transitSummary[0] || "Transit")}</strong> · ${escape(view.arrivalText)}</p>${ferryDetails}<div class="route-metrics"><div class="route-metric"><span>Distance</span><strong>${Math.round(route.distanceMeters || 0)} m</strong></div><div class="route-metric"><span>Data coverage</span><strong>${escape(view.dataCoverage)}</strong></div><div class="route-metric"><span>Lighting</span><strong>${escape(view.lighting)}</strong></div><div class="route-metric"><span>Surface & slope</span><strong>${escape(view.surfaceSlope)}</strong></div><div class="route-metric"><span>Elevator / transit</span><strong>${escape(view.elevatorStatus)}</strong></div></div>${warning ? `<p class="trust-line">${escape(warning)}</p>` : ""}<ol class="segment-list">${transitItems}${boardingItems}</ol></article>`;
}

function dataCoverageLabel(route) {
  const trust = route?.trust || {};
  if (Number(trust.barrierSegments || 0) > 0) return "Known barrier";
  if (Number(trust.criticalUnknowns ?? trust.unknownSegments ?? 0) > 0) return "Critical gaps";
  if (trust.coverageLevel) return String(trust.coverageLevel);
  if (route?.dataFreshness === "stale") return "Stale";
  if (route?.dataFreshness === "current") return "Current provider";
  return "Limited";
}

function lightingLabel(metrics = {}) {
  if (!Number.isFinite(metrics.litCoverage)) return "Unknown";
  return metrics.litCoverage >= .7 ? "Higher coverage" : metrics.litCoverage > 0 ? "Partial coverage" : "Data missing";
}

function surfaceSlopeLabel(metrics = {}) {
  const surface = metrics.roughSegments ? "Rough sections" : metrics.unevenSegments ? "Mixed surface" : "Surface unknown";
  const slope = metrics.maxSlope == null ? "slope unknown" : `${Number(metrics.maxSlope).toFixed(1)}% max`;
  return `${surface} · ${slope}`;
}
