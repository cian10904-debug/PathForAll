"use strict";

import { appStorage } from "./storage-adapter.js";

const PROFILE_KEY = "pathforall-profile-v7";
const PROFILE_SCHEMA_VERSION = 2;

export const MOBILITY_PRESETS = Object.freeze({
  wheelchair: Object.freeze({
    wheelchairMode: true,
    avoidStairs: true,
    requireCurb: true,
    curbPolicy: "preferred",
    preferSmooth: true,
    requireElevator: true,
    preferShade: false,
    avoidRain: false,
    minimizeTransfers: true,
    maxSlope: 6,
    maxWalkMinutes: 12
  }),
  limited: Object.freeze({
    wheelchairMode: false,
    avoidStairs: true,
    requireCurb: false,
    curbPolicy: "preferred",
    preferSmooth: true,
    requireElevator: true,
    preferShade: false,
    avoidRain: false,
    minimizeTransfers: true,
    maxSlope: 8,
    maxWalkMinutes: 10
  }),
  senior: Object.freeze({
    wheelchairMode: false,
    avoidStairs: true,
    requireCurb: false,
    curbPolicy: "preferred",
    preferSmooth: true,
    requireElevator: false,
    preferShade: true,
    avoidRain: false,
    minimizeTransfers: true,
    maxSlope: 8,
    maxWalkMinutes: 12
  }),
  custom: Object.freeze({
    wheelchairMode: false,
    avoidStairs: false,
    requireCurb: false,
    curbPolicy: "allowUnknown",
    preferSmooth: false,
    requireElevator: false,
    preferShade: false,
    avoidRain: false,
    minimizeTransfers: false,
    maxSlope: 10,
    maxWalkMinutes: 15
  })
});

export const DEFAULT_PROFILE = Object.freeze({
  signedIn: false,
  name: "Guest",
  email: "",
  avatar: "",
  needs: {
    mobilityProfile: "wheelchair",
    wheelchairMode: true,
    avoidStairs: true,
    requireCurb: true,
    curbPolicy: "preferred",
    preferSmooth: true,
    requireElevator: true,
    preferShade: false,
    avoidRain: false,
    minimizeTransfers: true,
    maxSlope: 6,
    maxWalkMinutes: 12,
    customNeeds: []
  }
});

export function loadProfile() {
  const saved = appStorage.readJson(PROFILE_KEY, null, {
    version: PROFILE_SCHEMA_VERSION,
    migrate: value => value
  });
  return normalizeProfile(saved);
}

export function saveProfile(profile) {
  const normalized = normalizeProfile(profile);
  appStorage.writeJson(PROFILE_KEY, normalized, { version: PROFILE_SCHEMA_VERSION });
  return normalized;
}

export function signOutProfile(profile) {
  return saveProfile({
    ...profile,
    signedIn: false,
    name: "Guest",
    email: "",
    avatar: ""
  });
}

export function normalizeProfile(value) {
  const source = value && typeof value === "object" ? value : {};
  const needs = source.needs && typeof source.needs === "object" ? source.needs : {};
  const mobilityProfile = ["wheelchair", "limited", "senior", "custom"].includes(needs.mobilityProfile)
    ? needs.mobilityProfile
    : (needs.wheelchairMode === false ? "custom" : "wheelchair");
  const preset = MOBILITY_PRESETS[mobilityProfile];
  return {
    signedIn: Boolean(source.signedIn),
    name: cleanText(source.name, 40) || "Guest",
    email: cleanText(source.email, 120),
    avatar: typeof source.avatar === "string" ? source.avatar : "",
    needs: {
      mobilityProfile,
      wheelchairMode: mobilityProfile === "custom" ? Boolean(needs.wheelchairMode) : preset.wheelchairMode,
      avoidStairs: booleanOr(needs.avoidStairs, preset.avoidStairs),
      requireCurb: booleanOr(needs.requireCurb, preset.requireCurb),
      curbPolicy: validCurbPolicy(needs.curbPolicy, preset.curbPolicy),
      preferSmooth: booleanOr(needs.preferSmooth, preset.preferSmooth),
      requireElevator: booleanOr(needs.requireElevator, preset.requireElevator),
      preferShade: booleanOr(needs.preferShade, preset.preferShade),
      avoidRain: booleanOr(needs.avoidRain, preset.avoidRain),
      minimizeTransfers: booleanOr(needs.minimizeTransfers, preset.minimizeTransfers),
      maxSlope: clampNumber(needs.maxSlope, 2, 12, preset.maxSlope),
      maxWalkMinutes: clampNumber(needs.maxWalkMinutes, 4, 25, preset.maxWalkMinutes),
      customNeeds: Array.isArray(needs.customNeeds)
        ? needs.customNeeds.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 12)
        : []
    }
  };
}

export function applyMobilityPreset(mobilityProfile, currentNeeds = {}) {
  const profile = MOBILITY_PRESETS[mobilityProfile] ? mobilityProfile : "custom";
  return {
    ...currentNeeds,
    ...MOBILITY_PRESETS[profile],
    mobilityProfile: profile,
    customNeeds: Array.isArray(currentNeeds.customNeeds) ? [...currentNeeds.customNeeds] : []
  };
}

export function clearProfile() {
  appStorage.remove(PROFILE_KEY);
}

export function profileNeedsToLabels(needs) {
  const labels = [];
  if (needs.avoidStairs) labels.push("No stairs");
  if (needs.requireCurb) labels.push("Curb ramps");
  if (needs.preferSmooth) labels.push("Smooth surfaces");
  if (needs.requireElevator) labels.push("Working elevators");
  if (needs.preferShade) labels.push("Shade");
  if (needs.avoidRain) labels.push("Rain cover");
  if (needs.minimizeTransfers) labels.push("Fewer transfers");
  labels.push(`Slope ≤ ${needs.maxSlope}%`);
  return labels;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function booleanOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function validCurbPolicy(value, fallback) {
  return ["required", "preferred", "allowUnknown"].includes(value) ? value : fallback;
}
