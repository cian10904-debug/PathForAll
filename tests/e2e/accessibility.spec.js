import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await installPublicServiceFixtures(page);
  await page.goto("/");
  await expect(page.locator("#map")).toBeVisible();
});

test("keyboard-only search, semantic route selection, and dialog focus", async ({ page }) => {
  const start = page.locator("#startSearch");
  await start.focus();
  await start.fill("Start path");
  await expect(page.locator("#startSuggestions [role=option]")).toHaveCount(1);
  await start.press("ArrowDown");
  await expect(start).toHaveAttribute("aria-activedescendant", "start-suggestion-0");
  await start.press("Enter");
  await expect(start).toHaveValue("Start path");

  const end = page.locator("#endSearch");
  await end.focus();
  await end.fill("End path");
  await expect(page.locator("#endSuggestions [role=option]")).toHaveCount(1);
  await end.press("ArrowDown");
  await end.press("Enter");
  await expect(end).toHaveValue("End path");

  await page.getByRole("button", { name: "Find routes" }).click();
  const routeCard = page.locator("article.route-card").first();
  await expect(routeCard).toBeVisible();
  await expect(routeCard.getByRole("radio")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#resultsPanel")).toHaveAttribute("aria-hidden", "false");

  const reviewButton = page.getByRole("button", { name: "Review route data" });
  await reviewButton.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#verificationTitle")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("[data-review-status]").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(reviewButton).toBeFocused();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("overlays isolate the map and responsive layouts do not overflow", async ({ page }) => {
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".planner-sheet")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${width}px layout has horizontal overflow`).toBeLessThanOrEqual(1);
  }

  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(zoomOverflow, "200% zoom layout has horizontal overflow").toBeLessThanOrEqual(1);
  await page.evaluate(() => { document.body.style.zoom = ""; });

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.locator("#profilePage")).toBeVisible();
  await expect(page.locator("#navigatePage")).toHaveAttribute("aria-hidden", "true");
  expect(await page.locator("#navigatePage").evaluate(element => element.inert)).toBe(true);
  await expect(page.locator("#profilePage h1")).toBeFocused();
});

test("unconfigured transit services are explicit and transit modes stay disabled", async ({ page }) => {
  await expect(page.locator("#plannerTransitStatus")).toHaveText("Transit information unavailable");
  await expect(page.locator("#navigatePage #transitConnectionList")).toHaveCount(0);
  for (const mode of ["Bus", "Subway", "Ferry", "Rail", "All Transit"]) {
    await expect(page.getByRole("radio", { name: mode, exact: true })).toBeDisabled();
  }
  await expect(page.getByRole("radio", { name: "Walk", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.locator("#transitDataSummary")).toHaveText("Transit services are not connected");
  await expect(page.locator("#transitDataDetail")).toContainText(
    "Walk remains available using OpenStreetMap pedestrian data"
  );
  await expect(page.locator("[data-transit-connection]")).toHaveCount(5);
  await expect(page.locator("[data-connection-status]")).toHaveText([
    "Not configured",
    "Not configured",
    "Not configured",
    "Not configured",
    "Not configured"
  ]);
  const checkButton = page.getByRole("button", { name: "Check connections", exact: true });
  await checkButton.click();
  await expect(page.locator("#transitDataSummary")).toHaveText("Transit services are not connected");
  await expect(page.locator("#transitDiagnostics")).toBeVisible();
  await expect(page.locator("#transitDiagnosticsJson")).not.toContainText("http://");
  await expect(page.locator("#transitDiagnosticsJson")).not.toContainText("https://");
});

test("mobile map-pick mode exposes the map and restores the planner", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const planner = page.locator(".planner-sheet");
  const bottomNav = page.locator(".bottom-nav");
  await expect(planner).toBeVisible();

  await page.getByRole("button", { name: "Choose starting point on map" }).click();
  await expect(page.locator("body")).toHaveClass(/map-pick-active/);
  await expect(page.locator("#mapPickBanner")).toBeVisible();
  await expect(planner).toHaveCSS("opacity", "0");
  expect(await planner.evaluate(element => element.inert)).toBe(true);
  const plannerBox = await planner.boundingBox();
  expect(plannerBox?.y, "the planner sheet moves below the viewport").toBeGreaterThanOrEqual(844);
  await expect(bottomNav).toBeVisible();
  await expect(bottomNav).toHaveCSS("position", "fixed");

  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/map-pick-active/);
  await expect(page.locator("#mapPickBanner")).toBeHidden();
  await expect(planner).toBeVisible();
  expect(await planner.evaluate(element => element.inert)).toBe(false);
  await expect(page.getByRole("button", { name: "Choose starting point on map" })).toBeFocused();

  await page.getByRole("button", { name: "Choose destination on map" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("body")).not.toHaveClass(/map-pick-active/);
  await expect(planner).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose destination on map" })).toBeFocused();
});

async function installPublicServiceFixtures(page) {
  await page.route("**/api/?**", async route => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    const start = /start/i.test(query);
    await route.fulfill({
      contentType: "application/geo+json",
      body: JSON.stringify({
        features: [{
          type: "Feature",
          geometry: { type: "Point", coordinates: start ? [-73.99, 40.73] : [-73.988, 40.73] },
          properties: {
            id: start ? "start" : "end",
            name: start ? "Start path" : "End path",
            city: "New York",
            importance: 1
          }
        }]
      })
    });
  });

  await page.route("**/api/interpreter", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(overpassFixture())
  }));

  await page.route("**/v1/forecast?**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      current: {
        time: Math.floor(Date.now() / 1000),
        temperature_2m: 68,
        precipitation: 0
      }
    })
  }));

  await page.route("https://tile.openstreetmap.org/**", route => route.fulfill({
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  }));
}

function overpassFixture() {
  const elements = [];
  const count = 22;
  for (let index = 0; index < count; index += 1) {
    elements.push({
      type: "node",
      id: index + 1,
      lon: -73.99 + .002 * index / (count - 1),
      lat: 40.73
    });
  }
  elements.push({
    type: "way",
    id: 100,
    nodes: Array.from({ length: count }, (_, index) => index + 1),
    tags: {
      highway: "footway",
      wheelchair: "yes",
      surface: "asphalt",
      incline: "0%",
      lit: "yes",
      name: "Accessible test path"
    }
  });
  return { elements };
}

test("missing slope evidence stays strict until the user explicitly allows unknowns", async ({ page }) => {
  const payload = overpassFixture();
  delete payload.elements.at(-1).tags.incline;
  await page.route("**/api/interpreter", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }));
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.locator("#limitSlope").check();
  await page.locator("#needsForm button[type=submit]").click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await selectJourney(page);
  await page.getByRole("button", { name: "Find routes" }).click();
  await expect(page.locator("article.route-card")).toHaveCount(0);
  await expect(page.locator("#plannerMessage")).toContainText(/evidence|mapped|unknown/i);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.locator("#unknownPolicy").selectOption("allow");
  await page.locator("#needsForm button[type=submit]").click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  const card = page.locator("article.route-card").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/unknown|missing/i);
  await expect(page.locator("#startNavigationButton")).toBeEnabled();
  await page.screenshot({ path: "test-results/unknown-conditions.png", fullPage: true });
});

test("navigation reports denied GPS and releases its watch on End", async ({ page }) => {
  await page.evaluate(() => {
    window.navigationTest = { cleared: 0 };
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      watchPosition(_success, error) { setTimeout(() => error({ code: 1, message: "Permission denied" }), 10); return 42; },
      clearWatch(id) { if (id === 42) window.navigationTest.cleared++; }
    }});
  });
  await selectJourney(page);
  await page.getByRole("button", { name: "Find routes" }).click();
  await expect(page.locator("article.route-card").first()).toBeVisible();
  await page.locator("#startNavigationButton").click();
  await expect(page.locator("#navigationOverlay")).toBeVisible();
  await expect(page.locator("#navigationInstruction")).toBeFocused();
  await expect(page.locator("#navigationMessage")).toContainText("Permission denied");
  await page.locator("#endNavigationButton").click();
  await expect(page.locator("#navigationOverlay")).toBeHidden();
  expect(await page.evaluate(() => window.navigationTest.cleared)).toBe(1);
});

test("corrupt saved settings recover without blocking planning", async ({ page }) => {
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) localStorage.setItem(key, "{invalid json");
    localStorage.setItem("pathforall-profile-v7", "{invalid json");
  });
  await page.reload();
  await selectJourney(page);
  await page.getByRole("button", { name: "Find routes" }).click();
  await expect(page.locator("article.route-card").first()).toBeVisible();
});

async function selectJourney(page) {
  for (const [id, text] of [["start", "Start path"], ["end", "End path"]]) {
    const input = page.locator(`#${id}Search`);
    await input.fill(text);
    await expect(page.locator(`#${id}Suggestions [role=option]`)).toHaveCount(1);
    await input.press("ArrowDown");
    await input.press("Enter");
  }
}

test("cancelling a pending plan restores the planning controls", async ({ page }) => {
  await selectJourney(page);
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const intercept = async route => {
    started();
    await delayed;
    await route.fulfill({ json: overpassFixture() }).catch(() => {});
  };
  await page.route("**/api/interpreter", intercept);
  const plan = page.getByRole("button", { name: "Find routes", exact: true });
  await plan.click();
  await pending;
  await expect(plan).toBeDisabled();
  await page.getByRole("radio", { name: "Walk", exact: true }).click();
  await expect(plan).toBeEnabled();
  await expect(plan).toHaveAttribute("aria-busy", "false");
  await page.unroute("**/api/interpreter", intercept);
  release();
  await plan.click();
  await expect(page.locator("article.route-card").first()).toBeVisible();
});
