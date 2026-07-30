"use strict";

// Test-only teaching graph. Attributes are not field-verified and this module must
// never be imported by production search, map, or routing code.
export const fallbackNodes = {
  cooper: { id: "cooper", name: "Cooper Union", coordinates: [-73.9905, 40.7292] },
  astor: { id: "astor", name: "Astor Place", coordinates: [-73.9915, 40.7302] },
  laf8: { id: "laf8", name: "Lafayette St & E 8th St", coordinates: [-73.9928, 40.7309] },
  broadway8: { id: "broadway8", name: "Broadway & E 8th St", coordinates: [-73.9949, 40.7318] },
  university8: { id: "university8", name: "University Pl & E 8th St", coordinates: [-73.9972, 40.7326] },
  washNE: { id: "washNE", name: "Washington Square Northeast", coordinates: [-73.9986, 40.7319] },
  cooperSouth: { id: "cooperSouth", name: "Cooper Square South", coordinates: [-73.9900, 40.7279] },
  bowery4: { id: "bowery4", name: "Bowery & E 4th St", coordinates: [-73.9915, 40.7269] },
  laf4: { id: "laf4", name: "Lafayette St & E 4th St", coordinates: [-73.9941, 40.7278] },
  mercer4: { id: "mercer4", name: "Mercer St & W 4th St", coordinates: [-73.9967, 40.7289] },
  washEast: { id: "washEast", name: "Washington Square East", coordinates: [-73.9987, 40.7303] },
  broadwayWaverly: { id: "broadwayWaverly", name: "Broadway & Waverly Pl", coordinates: [-73.9960, 40.7298] },
  washNorth: { id: "washNorth", name: "Washington Square North", coordinates: [-73.9997, 40.7328] }
};

const edgeDefinitions = [
  { id: "e1", from: "cooper", to: "astor", name: "Cooper Sq to Astor Pl", minutes: 2.1, distanceMeters: 155, slope: 2, surface: "smooth", stairs: false, curbRamp: true, shade: 0.35, covered: false, crossing: 2, confidence: 0.92 },
  { id: "e2", from: "astor", to: "laf8", name: "Astor Pl east passage", minutes: 1.5, distanceMeters: 105, slope: 1, surface: "smooth", stairs: false, curbRamp: true, shade: 0.25, covered: true, crossing: 1, confidence: 0.82, requiresElevator: true, elevatorStatus: "working" },
  { id: "e3", from: "laf8", to: "broadway8", name: "E 8th St: Lafayette to Broadway", minutes: 3.1, distanceMeters: 225, slope: 5, surface: "uneven", stairs: false, curbRamp: true, shade: 0.25, covered: false, crossing: 3, confidence: 0.88 },
  { id: "e4", from: "broadway8", to: "university8", name: "E 8th St: Broadway to University", minutes: 2.9, distanceMeters: 210, slope: 3, surface: "smooth", stairs: false, curbRamp: true, shade: 0.55, covered: false, crossing: 2, confidence: 0.91 },
  { id: "e5", from: "university8", to: "washNE", name: "University Pl to Washington Sq NE", minutes: 1.8, distanceMeters: 128, slope: 2, surface: "smooth", stairs: false, curbRamp: true, shade: 0.7, covered: false, crossing: 1, confidence: 0.94 },
  { id: "e6", from: "washNE", to: "washNorth", name: "Washington Square north path", minutes: 1.4, distanceMeters: 95, slope: 1, surface: "smooth", stairs: false, curbRamp: true, shade: 0.8, covered: false, crossing: 0, confidence: 0.95 },

  { id: "e7", from: "cooper", to: "cooperSouth", name: "Cooper Square south sidewalk", minutes: 1.8, distanceMeters: 130, slope: 2, surface: "smooth", stairs: false, curbRamp: true, shade: 0.45, covered: false, crossing: 1, confidence: 0.90 },
  { id: "e8", from: "cooperSouth", to: "bowery4", name: "E 4th St approach", minutes: 2.0, distanceMeters: 145, slope: 1, surface: "smooth", stairs: false, curbRamp: true, shade: 0.5, covered: false, crossing: 2, confidence: 0.91 },
  { id: "e9", from: "bowery4", to: "laf4", name: "E 4th St: Bowery to Lafayette", minutes: 3.5, distanceMeters: 205, slope: 2, surface: "smooth", stairs: false, curbRamp: true, shade: 0.62, covered: false, crossing: 2, confidence: 0.89 },
  { id: "e10", from: "laf4", to: "mercer4", name: "W 4th St: Lafayette to Mercer", minutes: 4.2, distanceMeters: 220, slope: 2, surface: "smooth", stairs: false, curbRamp: true, shade: 0.65, covered: true, crossing: 2, confidence: 0.90 },
  { id: "e11", from: "mercer4", to: "washEast", name: "W 4th St: Mercer to Washington Sq", minutes: 3.0, distanceMeters: 180, slope: 1, surface: "smooth", stairs: false, curbRamp: true, shade: 0.68, covered: false, crossing: 1, confidence: 0.93 },
  { id: "e12", from: "washEast", to: "washNE", name: "Washington Square east path", minutes: 1.7, distanceMeters: 120, slope: 1, surface: "smooth", stairs: false, curbRamp: true, shade: 0.78, covered: false, crossing: 0, confidence: 0.96 },

  { id: "e13", from: "laf4", to: "broadwayWaverly", name: "Lafayette to Broadway shortcut", minutes: 2.2, distanceMeters: 155, slope: 4, surface: "rough", stairs: true, curbRamp: false, shade: 0.18, covered: true, crossing: 1, confidence: 0.86 },
  { id: "e14", from: "broadwayWaverly", to: "broadway8", name: "Broadway north segment", minutes: 2.4, distanceMeters: 170, slope: 4, surface: "uneven", stairs: false, curbRamp: true, shade: 0.18, covered: false, crossing: 3, confidence: 0.82 },
  { id: "e15", from: "broadwayWaverly", to: "washEast", name: "Waverly Place connection", minutes: 2.5, distanceMeters: 185, slope: 4, surface: "smooth", stairs: false, curbRamp: true, shade: 0.60, covered: false, crossing: 1, confidence: 0.90 },
  { id: "e16", from: "astor", to: "cooperSouth", name: "Astor to Cooper Square south", minutes: 2.3, distanceMeters: 165, slope: 6, surface: "rough", stairs: false, curbRamp: true, shade: 0.15, covered: false, crossing: 3, confidence: 0.78 },
  { id: "e17", from: "university8", to: "washNorth", name: "University Place north connection", minutes: 1.9, distanceMeters: 140, slope: 2, surface: "smooth", stairs: false, curbRamp: true, shade: 0.75, covered: false, crossing: 1, confidence: 0.91 },
  { id: "e18", from: "mercer4", to: "broadwayWaverly", name: "Mercer-Waverly connector", minutes: 1.7, distanceMeters: 118, slope: 4, surface: "smooth", stairs: false, curbRamp: true, shade: 0.55, covered: false, crossing: 1, confidence: 0.90 },
  { id: "e19", from: "laf4", to: "broadwayWaverly", name: "W 3rd Street connector", minutes: 1.3, distanceMeters: 132, slope: 2, surface: "smooth", stairs: false, curbRamp: true, shade: 0.50, covered: false, crossing: 1, confidence: 0.90 }
];

// Export a mutable copy because the demo changes blockages, elevator state, and reports at runtime.
export const fallbackEdges = edgeDefinitions.map(edge => ({
  ...edge,
  pedestrianEvidence: "dedicated",
  roadCenterline: false,
  // Representative lighting attributes for the offline network; live routes use OSM lit tags.
  lit: ["e1", "e2", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12", "e15", "e17"].includes(edge.id)
    ? true
    : ["e3", "e14", "e16"].includes(edge.id) ? false : null,
  lightingSource: "estimated",
  blocked: false,
  reports: 0
}));

export const fallbackDefaultStart = "cooper";
export const fallbackDefaultEnd = "washNE";
export const fallbackCenter = [-73.9952, 40.7298];
