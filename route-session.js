"use strict";

/** Coordinates cancellable planning requests without allowing stale commits. */
export function createRouteSession() {
  let version = 0;
  let controller = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const requestVersion = ++version;
      return { signal: controller.signal, isCurrent: () => requestVersion === version && !controller.signal.aborted, cancel: () => controller.abort(), version: requestVersion };
    },
    cancel() {
      version += 1;
      controller?.abort();
    },
    get version() { return version; }
  };
}
