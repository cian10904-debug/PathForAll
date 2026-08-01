"use strict";

import { haversineMeters } from "./osm-network.js";
import { isRenderableLegGeometry, lineGeometry, routeGeometrySegments } from "./route-model.js";

export function buildWalkingNavigationSteps(routeResult, edges, nodes, destinationName = "destination") {
  if (!routeResult?.traversals?.length) return [];
  const edgeMap = new Map(edges.map(edge => [edge.id, edge]));
  const steps = [];
  let previousBearing = null;

  routeResult.traversals.forEach((traversal, index) => {
    const edge = edgeMap.get(traversal.edgeId);
    if (!edge) return;
    const coordinates = orientedGeometry(edge, traversal.reverse, nodes);
    const targetCoordinate = coordinates.at(-1) || nodes[traversal.reverse ? edge.from : edge.to]?.coordinates;
    if (!targetCoordinate) return;
    const hasGeometry = coordinates.length >= 2;
    const bearing = hasGeometry ? bearingDegrees(coordinates[0], targetCoordinate) : previousBearing;
    const street = friendlyStreetName(edge.name);
    const instruction = !hasGeometry
      ? `Continue on ${street}`
      : index === 0
      ? `Head ${cardinalDirection(bearing)} on ${street}`
      : `${turnInstruction(previousBearing, bearing)} onto ${street}`;
    steps.push({
      id: `walk-${index}-${edge.id}`,
      type: "walk",
      icon: index === 0 ? "↑" : turnIcon(previousBearing, bearing),
      instruction,
      detail: accessibilityDetail(edge),
      distanceMeters: Number(edge.distanceMeters || segmentDistance(coordinates)),
      minutes: Number(edge.minutes || 0),
      coordinates: hasGeometry ? coordinates : [],
      targetCoordinate
    });
    previousBearing = bearing;
  });

  const last = steps.at(-1);
  if (last) {
    steps.push({
      id: "arrive",
      type: "arrive",
      icon: "●",
      instruction: `Arrive at ${destinationName}`,
      detail: "Destination is ahead.",
      distanceMeters: 0,
      minutes: 0,
      coordinates: [last.targetCoordinate],
      targetCoordinate: last.targetCoordinate
    });
  }
  return compressWalkingSteps(steps);
}

export function routeCoordinates(routeOption) {
  if (Array.isArray(routeOption?.legs)) {
    const coordinates = [];
    for (const segment of routeGeometrySegments(routeOption)) {
      const previous = coordinates.at(-1);
      if (validCoordinate(previous) && sameCoordinate(previous, segment.coordinates[0])) {
        appendCoordinates(coordinates, segment.coordinates.slice(1));
      } else {
        if (coordinates.length) coordinates.push(null);
        appendCoordinates(coordinates, segment.coordinates);
      }
    }
    return coordinates;
  }
  const coordinates = [];
  for (const segment of routeOption?.geometrySegments || []) appendCoordinates(coordinates, segment.coordinates || []);
  return coordinates;
}

export function splitRouteGeometrySegments(routePoints) {
  const segments = [];
  let current = [];
  for (const point of routePoints || []) {
    if (!validCoordinate(point)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

export function isPedestrianOffRouteEligible(step, accuracy) {
  if (!step || step.type !== "walk") return false;
  if (step.indoor === true || step.geometryVerified === false) return false;
  if (Number.isFinite(accuracy) && accuracy > 35) return false;
  return Array.isArray(step.coordinates)
    && step.coordinates.length >= 2
    && step.coordinates.every(validCoordinate);
}

export function recordNavigationCompletionOnce(navigation, callback, details) {
  if (!navigation || navigation.completedRecorded) return false;
  navigation.completedRecorded = true;
  callback(details);
  return true;
}

/** Build turn-by-turn instructions from the normalized RouteOption contract. */
export function buildRouteNavigationSteps(route, destinationName = "destination") {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const steps = [];
  for (let index = 0; index < legs.length;) {
    const leg = legs[index];
    const targetCoordinate = leg?.to?.coordinates;
    if (!targetCoordinate) {
      index += 1;
      continue;
    }
    if (leg.mode === "walk") {
      steps.push({ id: `walk-${leg.id}`, type: "walk", icon: "↑", instruction: `Walk${leg.streetName ? ` on ${leg.streetName}` : " to the next point"}`, detail: accessibilityDetail(leg.accessibility || {}), distanceMeters: Number(leg.distanceMeters || 0), minutes: Number(leg.durationSeconds || 0) / 60, coordinates: navigationGeometry(leg), targetCoordinate });
      index += 1;
      continue;
    }
    if (leg.mode === "transfer") {
      steps.push({ id: `transfer-${leg.id}`, type: "transfer", icon: "↔", instruction: "Make the accessible transfer", detail: leg.accessibility?.elevatorStatus ? `Elevator status: ${leg.accessibility.elevatorStatus}` : "Check transfer accessibility", distanceMeters: Number(leg.distanceMeters || 0), minutes: Number(leg.durationSeconds || 0) / 60, coordinates: navigationGeometry(leg), targetCoordinate });
      index += 1;
      continue;
    }
    if (leg.mode === "bus" || leg.mode === "subway" || leg.mode === "ferry") {
      const group = collectTransitLegGroup(legs, index);
      const first = group.legs[0];
      const last = group.legs.at(-1);
      if (first.mode === "ferry" && first.securityScreeningRequired) {
        steps.push({
          id: `security-${first.id}`,
          type: "security",
          icon: "⌁",
          instruction: "Complete security screening",
          detail: `${first.from.name} · allow additional time before boarding`,
          distanceMeters: 0,
          minutes: 0,
          coordinates: [first.from.coordinates],
          targetCoordinate: first.from.coordinates
        });
      }
      if (Number(first.waitSeconds || 0) > 0) {
        steps.push({ id: `wait-${first.id}`, type: "wait", icon: "◷", instruction: `Wait for ${first.operator || first.routeName || first.routeId || "transit"}`, detail: `${Math.ceil(Number(first.waitSeconds) / 60)} min ${first.waitSource === "scheduled" ? "scheduled" : "provider"} wait at ${first.from.name}`, distanceMeters: 0, minutes: Number(first.waitSeconds) / 60, coordinates: [first.from.coordinates], targetCoordinate: first.from.coordinates });
      }
      const serviceName = first.mode === "ferry" ? first.operator || "Statue City Cruises" : `${first.mode} ${first.routeName || first.routeId || "service"}`;
      steps.push({ id: `board-${first.id}`, type: "board", icon: transitIcon(first.mode), instruction: `Board ${serviceName}`, detail: `${first.headsign ? `Toward ${first.headsign} · ` : ""}${first.from.name}${first.ticketRequired ? " · ticket required" : ""}`, distanceMeters: 0, minutes: 0, coordinates: [first.from.coordinates], targetCoordinate: first.from.coordinates });
      steps.push({ id: `ride-${first.id}-${last.id}`, type: first.mode, icon: transitIcon(first.mode), route: first.routeName || first.routeId, instruction: `Ride to ${last.to.name}`, detail: first.mode === "ferry" ? `${first.operator || "Statue City Cruises"}${first.scheduleSource ? "" : " · check current schedule"}` : `${group.stopCount} stop${group.stopCount === 1 ? "" : "s"}${last.accessibility?.elevatorStatus ? ` · elevator ${last.accessibility.elevatorStatus}` : ""}`, distanceMeters: group.distanceMeters, minutes: group.durationSeconds / 60, coordinates: group.geometry, targetCoordinate: last.to.coordinates });
      steps.push({ id: `exit-${last.id}`, type: "exit", icon: "↓", instruction: `Exit at ${last.to.name}`, detail: first.mode === "ferry" ? "Continue on the accessible island path shown by the route provider." : last.accessibility?.elevatorStatus ? `Elevator status: ${last.accessibility.elevatorStatus}` : "Continue using the accessible exit.", distanceMeters: 0, minutes: 0, coordinates: [last.to.coordinates], targetCoordinate: last.to.coordinates });
      index = group.nextIndex;
      continue;
    }
    index += 1;
  }
  if (steps.length) steps.push({ id: "arrive", type: "arrive", icon: "●", instruction: `Arrive at ${destinationName}`, detail: "Trip complete.", distanceMeters: 0, minutes: 0, coordinates: [steps.at(-1).targetCoordinate], targetCoordinate: steps.at(-1).targetCoordinate });
  return steps;
}

function collectTransitLegGroup(legs, startIndex) {
  const first = legs[startIndex];
  const key = transitVehicleKey(first);
  const group = [];
  let index = startIndex;
  while (index < legs.length) {
    const leg = legs[index];
    if (!leg || !["bus", "subway", "ferry"].includes(leg.mode) || transitVehicleKey(leg) !== key) break;
    group.push(leg);
    index += 1;
  }
  return {
    legs: group,
    nextIndex: index,
    durationSeconds: group.reduce((sum, leg) => sum + Number(leg.durationSeconds || 0), 0),
    distanceMeters: group.reduce((sum, leg) => sum + Number(leg.distanceMeters || 0), 0),
    stopCount: Math.max(1, group.reduce((sum, leg) => sum + Math.max(1, Number(leg.stopCount || 1)), 0)),
    // If any portion lacks verified geometry, do not connect the visible
    // portions with an invented straight line in navigation.
    geometry: continuousGroupGeometry(group)
  };
}

function transitVehicleKey(leg) {
  return `${leg.mode}:${leg.routeId || leg.routeName || leg.operator || leg.id}:${leg.tripId || leg.directionId || leg.headsign || ""}`;
}

function navigationGeometry(leg) {
  if (!isRenderableLegGeometry(leg)) return [];
  return lineGeometry(leg.geometry)?.coordinates || [];
}

function continuousGroupGeometry(legs) {
  const output = [];
  for (const leg of legs) {
    const coordinates = navigationGeometry(leg);
    if (coordinates.length < 2) return [];
    if (!output.length) {
      output.push(...coordinates);
      continue;
    }
    if (!sameCoordinate(output.at(-1), coordinates[0])) return [];
    output.push(...coordinates.slice(1));
  }
  return output;
}

function sameCoordinate(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

export function findNavigationProgress(position, steps, currentIndex = 0) {
  if (!position || !steps?.length) return { stepIndex: currentIndex, distanceMeters: Infinity };
  let bestIndex = Math.min(currentIndex, steps.length - 1);
  let bestDistance = Infinity;
  const end = Math.min(steps.length - 1, currentIndex + 4);
  for (let index = Math.max(0, currentIndex - 1); index <= end; index += 1) {
    const target = steps[index]?.targetCoordinate;
    if (!target) continue;
    const distance = haversineMeters(position, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  if (bestDistance < 28 && bestIndex < steps.length - 1) bestIndex += 1;
  return { stepIndex: bestIndex, distanceMeters: bestDistance };
}

export function remainingMinutes(steps, stepIndex) {
  return (steps || []).slice(stepIndex).reduce((sum, step) => sum + Number(step.minutes || 0), 0);
}

function transitIcon(mode) {
  return mode === "bus" ? "🚌" : mode === "subway" ? "🚇" : "⛴";
}

function compressWalkingSteps(steps) {
  const output = [];
  for (const step of steps) {
    const previous = output.at(-1);
    if (step.type === "walk" && previous?.type === "walk" && previous.instruction === step.instruction) {
      previous.distanceMeters += step.distanceMeters;
      previous.minutes += step.minutes;
      appendCoordinates(previous.coordinates, step.coordinates);
      previous.targetCoordinate = step.targetCoordinate;
    } else {
      output.push({ ...step, coordinates: [...(step.coordinates || [])] });
    }
  }
  return output;
}

function orientedGeometry(edge, reverse, _nodes) {
  // Do not manufacture a direct node-to-node line when source geometry is
  // absent. A text instruction can be omitted more safely than a non-walkable
  // navigation path can be invented.
  const geometry = lineGeometry(edge?.geometry)?.coordinates || [];
  return reverse ? [...geometry].reverse() : geometry;
}

function friendlyStreetName(name) {
  if (!name || /^OSM way/i.test(name)) return "the pedestrian path";
  return name.replace(/\s*\(OSM.*$/i, "");
}

function accessibilityDetail(edge) {
  const details = [];
  if (edge.surface && edge.surface !== "unknown") details.push(`${edge.surface} surface`);
  if (Number.isFinite(edge.slope)) details.push(`${edge.slope.toFixed(1)}% slope`);
  if (edge.covered) details.push("covered");
  return details.join(" · ") || "Accessibility data is incomplete";
}

function bearingDegrees(a, b) {
  const toRadians = value => value * Math.PI / 180;
  const toDegrees = value => value * 180 / Math.PI;
  const [lon1, lat1] = a.map(toRadians);
  const [lon2, lat2] = b.map(toRadians);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function turnInstruction(previous, current) {
  if (!Number.isFinite(previous)) return `Head ${cardinalDirection(current)}`;
  const delta = ((current - previous + 540) % 360) - 180;
  if (Math.abs(delta) < 18) return "Continue";
  if (delta >= 18 && delta < 55) return "Bear right";
  if (delta >= 55 && delta < 135) return "Turn right";
  if (delta >= 135) return "Make a sharp right";
  if (delta <= -18 && delta > -55) return "Bear left";
  if (delta <= -55 && delta > -135) return "Turn left";
  return "Make a sharp left";
}

function turnIcon(previous, current) {
  if (!Number.isFinite(previous)) return "↑";
  const delta = ((current - previous + 540) % 360) - 180;
  if (Math.abs(delta) < 18) return "↑";
  return delta > 0 ? "↱" : "↰";
}

function cardinalDirection(bearing) {
  const directions = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return directions[Math.round(bearing / 45) % 8];
}

function appendCoordinates(target, source) {
  for (const coordinate of source || []) {
    const previous = target.at(-1);
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) target.push(coordinate);
  }
}

function segmentDistance(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) total += haversineMeters(coordinates[index - 1], coordinates[index]);
  return total;
}

export function distanceToRouteMeters(position, routePoints) {
  if (!position || !Array.isArray(routePoints) || !routePoints.length) return Infinity;
  const validPoints = routePoints.filter(validCoordinate);
  if (validPoints.length === 1) return haversineMeters(position, validPoints[0]);
  let best = Infinity;
  for (let index = 1; index < routePoints.length; index += 1) {
    if (!validCoordinate(routePoints[index - 1]) || !validCoordinate(routePoints[index])) continue;
    best = Math.min(best, distanceToSegmentMeters(position, routePoints[index - 1], routePoints[index]));
  }
  return best;
}

export function nearestRoutePoint(position, routePoints) {
  if (!position || !Array.isArray(routePoints) || !routePoints.length) return null;
  let best = null;
  let bestDistance = Infinity;
  for (let index = 1; index < routePoints.length; index += 1) {
    if (!validCoordinate(routePoints[index - 1]) || !validCoordinate(routePoints[index])) continue;
    const projected = projectToSegment(position, routePoints[index - 1], routePoints[index]);
    const distance = haversineMeters(position, projected);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = projected;
    }
  }
  return best ? { coordinate: best, distanceMeters: bestDistance } : null;
}

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function distanceToSegmentMeters(point, start, end) {
  return haversineMeters(point, projectToSegment(point, start, end));
}

function projectToSegment(point, start, end) {
  const referenceLat = ((point[1] + start[1] + end[1]) / 3) * Math.PI / 180;
  const scaleX = Math.cos(referenceLat);
  const px = point[0] * scaleX;
  const py = point[1];
  const ax = start[0] * scaleX;
  const ay = start[1];
  const bx = end[0] * scaleX;
  const by = end[1];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return [(ax + t * dx) / scaleX, ay + t * dy];
}
