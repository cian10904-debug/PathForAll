// @ts-check
"use strict";

export class FetchServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FetchServiceError";
    this.code = code;
    this.status = details.status ?? null;
    this.source = details.source || "network";
    this.retriable = details.retriable === true;
    this.cause = details.cause;
  }
}

const cancelled = () => new DOMException("Request cancelled.", "AbortError");

export async function fetchWithPolicy(input, init = {}, options = {}) {
  if (init.signal?.aborted) throw cancelled();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function")
    throw new FetchServiceError(
      "FETCH_UNAVAILABLE",
      "Network access is unavailable.",
    );
  const timeoutMs = Math.max(20, Number(options.timeoutMs) || 10_000);
  const maxBytes = Math.max(
    1024,
    Math.min(
      64 * 1024 * 1024,
      Number(options.maxResponseBytes) || 64 * 1024 * 1024,
    ),
  );
  const retries =
    /^(GET|HEAD)$/i.test(init.method || "GET") || options.retryReadOnlyPost
      ? Math.max(0, Math.min(2, Math.floor(Number(options.retries) || 0)))
      : 0;
  const deadline =
    performance.now() +
    (Number(options.totalTimeoutMs) || timeoutMs * (retries + 1) + 3_000);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init.signal?.aborted) throw cancelled();
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new FetchServiceError(
        "FETCH_TIMEOUT",
        "The service request timed out.",
        { source: options.source },
      );
    const controller = new AbortController();
    const abort = () => controller.abort(cancelled());
    init.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException("Deadline exceeded.", "TimeoutError"),
        ),
      Math.min(timeoutMs, remaining),
    );
    let delay = 180 * 2 ** attempt;
    try {
      const response = await awaitWithSignal(
        fetchImpl(input, { ...init, signal: controller.signal }),
        controller.signal,
      );
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const after = retryAfter(response.headers?.get?.("Retry-After"));
      if (
        retryable &&
        attempt < retries &&
        after <= 3_000 &&
        Math.max(after, delay) < deadline - performance.now()
      ) {
        delay = Math.max(after, delay);
        if (response instanceof Response)
          void response.body?.cancel().catch(() => {});
        lastError = new FetchServiceError(
          "HTTP_RETRYABLE",
          "The service asked us to retry.",
          { source: options.source, status: response.status, retriable: true },
        );
      } else {
        return await boundedBody(
          response,
          maxBytes,
          controller.signal,
          options.source,
        );
      }
    } catch (cause) {
      if (init.signal?.aborted) throw cancelled();
      if (cause instanceof FetchServiceError) throw cause;
      const timedOut = controller.signal.reason?.name === "TimeoutError";
      lastError = new FetchServiceError(
        timedOut ? "FETCH_TIMEOUT" : "FETCH_FAILED",
        timedOut
          ? "The service request timed out."
          : "The service request failed.",
        { source: options.source, cause, retriable: true },
      );
      if (attempt === retries) throw lastError;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
    await retryDelay(delay, init.signal);
  }
  throw lastError;
}

async function boundedBody(response, maxBytes, signal, source) {
  if (!(response instanceof Response) || !response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get("Content-Length")) > maxBytes)
      throw oversized();
    while (true) {
      const item = await awaitWithSignal(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) throw oversized();
      chunks.push(item.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  function oversized() {
    return new FetchServiceError(
      "RESPONSE_TOO_LARGE",
      "Provider response exceeds its size budget.",
      { source },
    );
  }
}

/** This also bounds injected fetch implementations and synthetic streams that do not honor AbortSignal. */
function awaitWithSignal(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function retryAfter(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  return Math.max(0, Date.parse(value) - Date.now()) || 0;
}

function retryDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
