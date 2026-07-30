import { searchPlaces } from "./geocoding.js";

const SEARCH_DELAY_MS = 325;

/**
 * Owns the combobox request lifecycle, keyboard model, and suggestion DOM.
 * Place selection remains a product concern and is supplied by the caller.
 */
export function createSearchController({
  inputs,
  panels,
  statusElement,
  bounds,
  defaultCenter,
  getMapCenter,
  onSelect
}) {
  const timers = { start: null, end: null };
  const requests = { start: null, end: null };
  const states = {
    start: { phase: "idle", query: "", activeIndex: -1 },
    end: { phase: "idle", query: "", activeIndex: -1 }
  };

  function bind() {
    ["start", "end"].forEach(type => {
      const input = inputs[type];
      const panel = panels[type];

      input.addEventListener("focus", () => run(type, input.value || ""));
      input.addEventListener("input", () => {
        clearTimeout(timers[type]);
        timers[type] = setTimeout(() => run(type, input.value), SEARCH_DELAY_MS);
      });
      input.addEventListener("keydown", event => onKeydown(type, event));
      panel.addEventListener("click", event => {
        const retry = event.target.closest("[data-retry-search]");
        if (retry) {
          run(type, input.value, { force: true });
          return;
        }
        const button = event.target.closest("[data-place-index]");
        if (!button) return;
        const place = panel._places?.[Number(button.dataset.placeIndex)];
        if (place) onSelect(type, place);
      });
    });
  }

  async function run(type, query, options = {}) {
    requests[type]?.abort();
    const controller = new AbortController();
    requests[type] = controller;
    states[type] = { phase: "loading", query: String(query || ""), activeIndex: -1 };
    inputs[type].setAttribute("aria-busy", "true");
    render(type, []);
    const center = getMapCenter();

    try {
      const results = await searchPlaces(query, {
        bounds,
        center: center || defaultCenter,
        signal: controller.signal,
        force: options.force
      });
      if (controller.signal.aborted || requests[type] !== controller) return;
      states[type] = { phase: "ready", query: String(query || ""), activeIndex: -1 };
      inputs[type].setAttribute("aria-busy", "false");
      render(type, results);
    } catch (error) {
      if (controller.signal.aborted || requests[type] !== controller) return;
      console.warn("Place search unavailable:", error);
      states[type] = { phase: "error", query: String(query || ""), activeIndex: -1 };
      inputs[type].setAttribute("aria-busy", "false");
      render(type, []);
    }
  }

  function render(type, places) {
    const panel = panels[type];
    const input = inputs[type];
    const searchState = states[type];
    panel._places = places;

    if (searchState.phase === "loading") {
      panel.innerHTML =
        '<div class="suggestion-item suggestion-status"><span class="loading-dot" aria-hidden="true"></span><span><strong>Searching New York City</strong><small>Looking for addresses, landmarks, stations, and places.</small></span></div>';
    } else if (searchState.phase === "error") {
      panel.innerHTML =
        '<div class="suggestion-item suggestion-status"><span aria-hidden="true">!</span><span><strong>Search is temporarily unavailable</strong><small>Your query is still here. Check your connection and retry.</small><button type="button" class="retry-search-button" data-retry-search>Retry search</button></span></div>';
    } else if (!places.length) {
      panel.innerHTML =
        '<div class="suggestion-item"><span>?</span><span><strong>No nearby result</strong><small>Try a New York City address, landmark, or transit station.</small></span></div>';
    } else {
      panel.innerHTML = places
        .map(
          (place, index) => `
          <button id="${type}-suggestion-${index}" class="suggestion-item" type="button" role="option" aria-selected="false" data-place-index="${index}" tabindex="-1">
            <span>${place.id?.startsWith("local") ? "★" : "⌖"}</span>
            <span><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.subtitle || "OpenStreetMap place")}</small></span>
          </button>`
        )
        .join("");
    }

    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
    statusElement.textContent =
      searchState.phase === "loading"
        ? "Searching New York City."
        : searchState.phase === "error"
          ? "Search is temporarily unavailable."
          : `${places.length} suggestion${places.length === 1 ? "" : "s"} available.`;
  }

  function onKeydown(type, event) {
    const panel = panels[type];
    const input = inputs[type];
    const places = panel._places || [];

    if (event.key === "Escape") {
      close(type);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    if (event.key === "Enter") {
      const activeIndex = states[type].activeIndex;
      if (activeIndex >= 0 && places[activeIndex]) {
        event.preventDefault();
        onSelect(type, places[activeIndex]);
      }
      return;
    }
    if (!places.length) return;

    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const current = states[type].activeIndex;
    const activeIndex =
      current < 0
        ? direction > 0
          ? 0
          : places.length - 1
        : (current + direction + places.length) % places.length;
    states[type].activeIndex = activeIndex;
    panel.querySelectorAll('[role="option"]').forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === activeIndex));
    });
    const active = panel.querySelector(`#${type}-suggestion-${activeIndex}`);
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }

  function close(type) {
    panels[type].hidden = true;
    inputs[type].setAttribute("aria-expanded", "false");
    inputs[type].removeAttribute("aria-activedescendant");
    states[type].activeIndex = -1;
  }

  function hideAll() {
    close("start");
    close("end");
  }

  function dispose() {
    Object.values(requests).forEach(request => request?.abort());
    Object.values(timers).forEach(timer => clearTimeout(timer));
  }

  return { bind, hideAll, run, dispose };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
