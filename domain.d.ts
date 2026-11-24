export interface Needs {
  wheelchairMode?: boolean;
  avoidStairs?: boolean;
  requireCurb?: boolean;
  curbPolicy?: string;
  unknownPolicy?: "strict" | "allow";
  requireVerifiedCurbAccess?: boolean;
  maxSlope?: number | null;
  maxUphillSlope?: number;
  maxDownhillSlope?: number;
  requireElevator?: boolean;
  requireSmooth?: boolean;
  preferSmooth?: boolean;
  preferShade?: boolean;
  avoidRain?: boolean;
  preferWellLit?: boolean;
  minimizeTransfers?: boolean;
  maxWalkMinutes?: number;
  customNeeds?: string[];
  mobilityProfile?: string;
}
export interface Elevator {
  status: string;
  authoritative?: boolean;
  freshness?: string;
  updatedAt?: string | null;
  expiresAt?: string | null;
  source?: string;
}
export interface Edge {
  nodeRestrictions?: {
    nodeId: string;
    source: string;
    wheelchair: boolean;
    pedestrian: boolean;
  }[];
  crossingsUnknown?: boolean;
  id: string;
  from: string;
  to: string;
  minutes: number;
  distanceMeters: number;
  geometry?: number[][];
  slope?: number | null;
  surface?: string;
  stairs?: boolean;
  bidirectional?: boolean;
  blocked?: boolean;
  wheelchairStatus?: string | null;
  roadCenterline?: boolean;
  pedestrianEvidence?: string;
  requiresCurbRamp?: boolean;
  curbRamp?: boolean | null;
  curbEvidence?: import("./accessibility.js").CurbEvidence;
  requiresElevator?: boolean;
  elevator?: Elevator | null;
  elevatorStatus?: string | null;
  shade?: number | null;
  covered?: boolean;
  lit?: boolean | null;
  lightingSource?: string;
  crossing?: number;
  crossingEventId?: string;
  reports?: number;
  reportEventId?: string;
  confidence?: number;
  name?: string;
  osmWayId?: number;
  highway?: string;
  tags?: Record<string, string>;
  layer?: string;
  level?: string;
  bridge?: boolean;
  tunnel?: boolean;
}
export interface GraphNode {
  id: string;
  coordinates: number[];
  name?: string;
  tags?: Record<string, string>;
}
export type Nodes = Record<string, GraphNode>;
export interface Weather {
  temperatureF?: number;
  isRaining?: boolean;
}
export interface Weights {
  label: string;
  time: number;
  slope: number;
  unknownSlope: number;
  surface: number;
  shade: number;
  unknownShade: number;
  rain: number;
  crossing: number;
  uncertainty: number;
  report: number;
  limitedWheelchair: number;
  lighting: number;
}
