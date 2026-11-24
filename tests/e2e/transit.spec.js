import { test, expect } from "@playwright/test";
import { createServer as createVite } from "vite";
import { createAppServer } from "../../server/index.js";
import { createOtpProvider } from "../../server/otp-provider.js";
import { CLOCK, start, end, exampleItinerary, manifest, mockOtp } from "../fixtures/otp.js";

test.use({ timezoneId: "Pacific/Honolulu", viewport: { width: 390, height: 844 } });

test("All Transit uses New York time, shows the actual bus itinerary, saves it and opens navigation", async ({ page }) => {
  test.setTimeout(60_000);
  const workerErrors = [];
  page.on("console", (message) => {
    if (message.text().includes("Worker failed to load")) workerErrors.push(message.text());
  });
  const provider = createOtpProvider({ url: "https://otp.example.test/otp/gtfs/v1", manifest,
    clock: () => CLOCK, fetchImpl: mockOtp([exampleItinerary()]) });
  const server = createAppServer({ primary: provider, clock: () => CLOCK });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  let vite;
  try {
    vite = await createVite({
      configFile: false,
      define: {
        "import.meta.env.VITE_ACCESSIBLE_ROUTING_URL": JSON.stringify("/api/routes"),
        "import.meta.env.VITE_ACCESSIBLE_ROUTING_CAPABILITIES_URL": JSON.stringify("/api/capabilities"),
      },
      server: { port: 0, host:"127.0.0.1", proxy: { "/api": { target: "http://127.0.0.1:" + server.address().port } } }
    });
    await vite.listen();
    const url = "http://127.0.0.1:" + vite.httpServer.address().port;
    await page.clock.setFixedTime(CLOCK);
    await page.route("**/api/?**", route => {
      const origin = new URL(route.request().url()).searchParams.get("q") === "Example start";
      return route.fulfill({ json:{ features:[{ type:"Feature",
        geometry:{ type:"Point", coordinates:origin ? start : end },
        properties:{ id: origin ? "start" : "end", name:origin ? "Example start" : "Example end", city:"New York" }
      }] } });
    });
    await page.route("**/v1/forecast?**", route => route.abort());
    await page.route("https://tile.openstreetmap.org/**", route => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
    }));
    const mapWorker = page.waitForResponse(response => response.url().includes("/maplibre-gl-worker.mjs") && response.ok());
    await page.goto(url);
    await mapWorker;
    await page.getByRole("radio",{name:"All Transit",exact:true}).click();
    for (const [prefix, label] of [["start","Example start"], ["end","Example end"]]) {
      const search = page.locator("#" + prefix + "Search");
      await search.fill(label);
      await expect(page.locator("#" + prefix + "Suggestions [role=option]")).toHaveCount(1);
      await search.press("ArrowDown");
      await search.press("Enter");
    }
    await page.getByText("Leave now by default").click();
    await page.locator("#departureTime").fill("2026-11-24T10:00");
    const received = page.waitForResponse(response => response.url().endsWith("/api/routes") && response.request().method() === "POST");
    await page.getByRole("button",{name:"Find routes",exact:true}).click();
    const response = await received;
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(response.request().postDataJSON().departureTime).toBe(CLOCK.toISOString());
    expect(body.routes[0].requestedMode).toBe("mixed");
    expect(body.routes[0].actualModes).toEqual(["bus"]);
    expect(body.routes[0].legs[1].departureTime).toBe("2026-11-24T15:09:00.000Z");
    const card = page.locator(".route-card").first();
    await expect(card).toContainText("Bus M8");
    await expect(card).toContainText("New York time");
    await expect(card).toContainText("1 min waiting");
    await expect(card).toContainText("0 transfers");
    await page.screenshot({ path:"test-results/transit-mobile.png", fullPage:true });
    await page.setViewportSize({width:1280,height:900});
    await page.screenshot({ path:"test-results/transit-desktop.png", fullPage:true });
    await page.getByRole("button",{name:"Save route",exact:true}).click();
    await page.getByRole("button",{name:"Start navigation",exact:true}).click();
    await expect(page.locator("#navigationOverlay")).toBeVisible();
    await page.getByRole("button",{name:"End",exact:true}).click();
    await expect(page.locator("#navigationOverlay")).toBeHidden();
    await page.getByRole("button",{name:"Saved",exact:true}).click();
    await expect(page.locator("#savedPlacesList")).toContainText("Example start");
    expect(workerErrors).toEqual([]);
  } finally {
    await page.goto("about:blank").catch(()=>{});
    await vite?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
