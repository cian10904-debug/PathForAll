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

export async function fetchWithPolicy(input, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function")
    throw new FetchServiceError(
      "FETCH_UNAVAILABLE",
      "Network access is unavailable.",
    );
  const timeoutMs = Math.max(250, Number(options.timeoutMs || 10_000));
  const retries = Math.max(0, Math.min(2, Number(options.retries || 0)));
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
      if (
        response.ok ||
        !shouldRetryStatus(response.status) ||
        attempt === retries
      )
        return response;
      lastError = new FetchServiceError(
        "HTTP_RETRYABLE",
        `Service returned ${response.status}.`,
        {
          status: response.status,
          source: options.source,
          retriable: true,
        },
      );
    } catch (cause) {
      if (init.signal?.aborted)
        throw new DOMException("Request cancelled.", "AbortError");
      const timedOut = controller.signal.aborted;
      lastError = new FetchServiceError(
        timedOut ? "FETCH_TIMEOUT" : "FETCH_FAILED",
        timedOut
          ? "The service request timed out."
          : "The service request failed.",
        { source: options.source, retriable: true, cause },
      );
      if (attempt === retries) throw lastError;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
    await retryDelay(180 * (attempt + 1), init.signal);
  }
  throw lastError;
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Request cancelled.", "AbortError"));
      },
      { once: true },
    );
  });
}
