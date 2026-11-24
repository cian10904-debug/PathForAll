// @ts-check
import { fetchWithPolicy } from "./fetch-client.js";
export function unavailableWeather() {
  return {
    temperatureF: null,
    precipitation: null,
    isRaining: null,
    source: "unavailable",
    updatedAt: null,
    retrievedAt: null,
    freshness: "unknown",
  };
}
/** @param {number[]} coordinates @param {{signal?: AbortSignal}} options */
export async function loadWeather(coordinates, options = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coordinates[1]}&longitude=${coordinates[0]}&current=temperature_2m,precipitation&temperature_unit=fahrenheit&timeformat=unixtime&timezone=UTC`;
  try {
    const response = await fetchWithPolicy(
      url,
      { signal: options.signal },
      { timeoutMs: 9000, retries: 1, source: "Open-Meteo weather" },
    );
    if (!response.ok) return unavailableWeather();
    const data = await response.json();
    const {
      temperature_2m: temperatureF,
      precipitation,
      time,
    } = data.current || {};
    if (
      ![temperatureF, precipitation, time].every(Number.isFinite) ||
      precipitation < 0
    )
      return unavailableWeather();
    const age = Date.now() - time * 1000;
    if (age < -60_000 || age > 7200_000) return unavailableWeather();
    return {
      temperatureF,
      precipitation,
      isRaining: precipitation > 0,
      source: "Open-Meteo",
      updatedAt: new Date(time * 1000).toISOString(),
      retrievedAt: new Date().toISOString(),
      freshness: "current",
    };
  } catch {
    return unavailableWeather();
  }
}
