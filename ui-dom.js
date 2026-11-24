// @ts-check
/** Elements in this app's control collections are HTML elements. Filter runtime
 * types so keyboard and focus operations never rely on an SVG or text node. */
export function elements(selector) {
  return [...document.querySelectorAll(selector)].filter(
    (element) => element instanceof HTMLElement,
  );
}

export function buttons(selector) {
  return [...document.querySelectorAll(selector)].filter(
    (element) => element instanceof HTMLButtonElement,
  );
}
