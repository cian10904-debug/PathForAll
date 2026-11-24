// @ts-check
"use strict";

/** Owns the lifetime of a route calculation and its loading controls.
 * @param {(busy: boolean) => void} [onBusy]
 */
export function createRouteSession(onBusy = () => {}) {
  let version = 0;
  /** @type {AbortController | null} */
  let controller = null;
  const cancel = () => {
    version += 1;
    const previous = controller;
    controller = null;
    previous?.abort();
    onBusy(false);
  };

  return {
    begin() {
      const previous = controller;
      const requestController = new AbortController();
      controller = requestController;
      const requestVersion = ++version;
      const isCurrent = () =>
        requestVersion === version && !requestController.signal.aborted;
      previous?.abort();
      onBusy(true);
      return {
        signal: requestController.signal,
        isCurrent,
        cancel: () => {
          if (isCurrent()) cancel();
        },
        finish: () => {
          if (!isCurrent() || controller !== requestController) return;
          controller = null;
          onBusy(false);
        },
        version: requestVersion,
      };
    },
    cancel,
    get version() {
      return version;
    },
  };
}
