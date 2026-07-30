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

  await page.getByRole("button", { name: "Find accessible routes" }).click();
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
    .exclude("#map")
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
  for (const mode of ["Bus", "Subway", "Ferry", "Mixed"]) {
    await expect(page.getByRole("radio", { name: mode, exact: true })).toBeDisabled();
  }
  await expect(page.getByRole("radio", { name: "Walk", exact: true })).toBeEnabled();

  const checkButton = page.getByRole("button", { name: "Check connections", exact: true });
  await checkButton.click();
  await expect(page.locator("#transitDataSummary")).toHaveText("Transit services are not connected");
  await expect(page.locator("#transitDiagnostics")).toBeVisible();
  await expect(page.locator("#transitDiagnosticsJson")).not.toContainText("http://");
  await expect(page.locator("#transitDiagnosticsJson")).not.toContainText("https://");
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
        time: "2099-01-01T12:00:00Z",
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
      lit: "yes",
      name: "Accessible test path"
    }
  });
  return { elements };
}
