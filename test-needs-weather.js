import assert from 'node:assert/strict';
import { effectiveNeeds, emptyTripNeeds } from './needs.js';
import { loadWeather } from './weather-service.js';

const saved = { unknownPolicy: 'strict', maxSlope: null, avoidStairs: true, customNeeds: [] };
const trip = { ...emptyTripNeeds(), maxSlope: 4, preferShade: true };
const savedBefore = JSON.stringify(saved), tripBefore = JSON.stringify(trip);
const merged = effectiveNeeds(saved, trip);
assert.equal(merged.maxSlope, 4);
assert.equal(merged.avoidStairs, true);
assert.equal(merged.unknownPolicy, 'strict');
assert.equal(JSON.stringify(saved), savedBefore);
assert.equal(JSON.stringify(trip), tripBefore);
assert.equal(effectiveNeeds({ ...saved, maxSlope: 3 }, trip).maxSlope, 3);

const originalFetch = globalThis.fetch;
try {
  const now = Math.floor(Date.now() / 1000);
  for (const current of [
    { temperature_2m: 70, precipitation: 0, time: now },
    { temperature_2m: null, precipitation: 0, time: now },
    { temperature_2m: 70, precipitation: 0, time: now + 3600 },
    { temperature_2m: 70, precipitation: 0 },
    { temperature_2m: 70, precipitation: -1, time: now }
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ current }));
    const weather = await loadWeather([-73.99, 40.73]);
    const expected = current.temperature_2m === 70 && current.precipitation === 0 && current.time === now;
    assert.equal(weather.freshness === 'current', expected);
    if (!expected) assert.equal(weather.updatedAt, null, 'missing or invalid observations never receive an invented observation time');
  }
} finally { globalThis.fetch = originalFetch; }
console.log('Needs immutability, optional constraints, and weather evidence validation passed.');
