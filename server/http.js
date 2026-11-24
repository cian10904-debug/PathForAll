// @ts-check
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  transitError,
  TransitProviderError,
  TRANSIT_ERROR_MESSAGES,
} from "../transit-errors.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function sendJson(response, status, data) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

export function sendError(response, error) {
  const code =
    error instanceof TransitProviderError ? error.code : "PROVIDER_UNAVAILABLE";
  const status = ERROR_STATUS[code] || 422;
  const details = error instanceof TransitProviderError ? error.details : {};
  if (error?.httpStatus) response.statusCode = error.httpStatus;
  if (code === "RATE_LIMITED") response.setHeader("Retry-After", "5");
  sendJson(response, error?.httpStatus || status, {
    code,
    message: TRANSIT_ERROR_MESSAGES[code] || "Route planning is unavailable.",
    details,
  });
}

export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_MODE: 400,
  TRANSIT_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_CONTRACT_ERROR: 502,
  RATE_LIMITED: 429,
  TRANSIT_DATA_STALE: 409,
  REQUEST_CANCELLED: 499,
};

export function readJson(request, signal) {
  const limit = 16_384;
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      String(request.headers["content-type"] || ""),
    )
  ) {
    request.resume();
    throw Object.assign(transitError("INVALID_REQUEST"), { httpStatus: 415 });
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw Object.assign(transitError("INVALID_REQUEST"), { httpStatus: 413 });
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const detach = () => {
      request.off("data", data).off("end", end).off("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const fail = () => {
      detach();
      reject(transitError("INVALID_REQUEST"));
    };
    const abort = () => {
      detach();
      request.resume();
      reject(signal.reason);
    };
    const end = () => {
      detach();
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
      } catch {
        reject(transitError("INVALID_REQUEST"));
      }
    };
    const data = (chunk) => {
      size += chunk.byteLength;
      if (size > limit) {
        detach();
        request.resume();
        reject(
          Object.assign(transitError("INVALID_REQUEST"), { httpStatus: 413 }),
        );
      } else chunks.push(chunk);
    };
    if (signal.aborted) return abort();
    request.on("data", data).once("end", end).once("error", fail);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function allowOrigin(request, response, allowedOrigins) {
  const origin = request.headers.origin;
  if (!origin) return true;
  let valid = allowedOrigins.has(origin);
  try {
    const parsed = new URL(origin);
    valid ||=
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host === request.headers.host;
  } catch {
    return false;
  }
  if (!valid) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

export async function serveStatic(path, request, response, dist) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (
    path !== "/" &&
    path !== "/index.html" &&
    !/^\/assets\/[A-Za-z0-9._-]+$/.test(path)
  )
    return false;
  const name = path === "/" ? "index.html" : path.slice(1);
  const file = resolve(dist, name);
  const type = MIME[extname(file)];
  if (!type) return false;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control":
      name === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  if (request.method === "HEAD") response.end();
  else
    createReadStream(file)
      .on("error", (error) => response.destroy(error))
      .pipe(response);
  return true;
}
