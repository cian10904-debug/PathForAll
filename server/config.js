// @ts-check
import { resolve } from "node:path";

export function loadConfig(env = process.env) {
  const port = boundedInt(env.PORT, 8787, 1, 65_535, "PORT");
  const timeoutMs = boundedInt(
    env.OTP_TIMEOUT_MS,
    11_000,
    500,
    13_000,
    "OTP_TIMEOUT_MS",
  );
  const optionalUrl = (value, name) => {
    if (!value) return null;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(name + " must be an absolute URL.");
    }
    const internal = ["127.0.0.1", "localhost", "[::1]", "otp"].includes(
      url.hostname,
    );
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && internal))
    ) {
      throw new Error(
        name +
          " must use HTTPS or an internal OTP/loopback HTTP origin, with no credentials, query, or fragment.",
      );
    }
    return url.href;
  };
  const otpUrl = optionalUrl(env.OTP_URL, "OTP_URL");
  const fallbackUrl = optionalUrl(env.OTP_FALLBACK_URL, "OTP_FALLBACK_URL");
  if (fallbackUrl && !otpUrl)
    throw new Error("Set OTP_URL before configuring OTP_FALLBACK_URL.");
  if (otpUrl && !env.TRANSIT_MANIFEST)
    throw new Error("OTP_URL requires TRANSIT_MANIFEST from the graph build.");
  if (fallbackUrl && !env.TRANSIT_FALLBACK_MANIFEST)
    throw new Error("OTP_FALLBACK_URL requires TRANSIT_FALLBACK_MANIFEST.");
  const allowedOrigins = new Set(
    String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .filter(Boolean)
      .map((value) => {
        const url = new URL(value.trim());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.origin !== value.trim()
        )
          throw new Error("ALLOWED_ORIGINS contains an invalid origin.");
        return url.origin;
      }),
  );
  return {
    host: env.HOST || "127.0.0.1",
    port,
    timeoutMs,
    allowedOrigins,
    manifestPath: env.TRANSIT_MANIFEST ? resolve(env.TRANSIT_MANIFEST) : null,
    fallbackManifestPath: env.TRANSIT_FALLBACK_MANIFEST
      ? resolve(env.TRANSIT_FALLBACK_MANIFEST)
      : null,
    otpUrl,
    fallbackUrl,
    dist: resolve(env.PFA_DIST || "dist"),
    concurrency: boundedInt(env.PFA_CONCURRENCY, 4, 1, 32, "PFA_CONCURRENCY"),
    maxPerMinute: boundedInt(
      env.PFA_REQUESTS_PER_MINUTE,
      120,
      1,
      2_000,
      "PFA_REQUESTS_PER_MINUTE",
    ),
  };
}

function boundedInt(value, fallback, min, max, name) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(
      name + " must be an integer between " + min + " and " + max + ".",
    );
  return number;
}
