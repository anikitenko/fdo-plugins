// Verifies the built SDK entry and serialized iframe lifecycle with local,
// read-only example data. No provider credentials or cloud requests are used.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const root = path.resolve(__dirname, "..");
const host = path.resolve(
  process.env.FDO_SOURCE_ROOT || path.join(root, "../../fdo"),
);
process.env.NODE_PATH = path.join(host, "node_modules");
require("node:module").Module._initPaths();
const temp = fs.mkdtempSync(
  path.join(os.tmpdir(), "hyperstack-finops-browser-"),
);
process.env.FDO_SDK_LOG_ROOT = path.join(temp, "logs");
process.parentPort = new EventEmitter();
process.parentPort.postMessage = () => {};
const sdk = require(path.join(host, "node_modules/@anikitenko/fdo-sdk"));
(async () => {
  let browser;
  let fakeKey = null;
  let denyBillingRead = false;
  const originalFetch = global.fetch;
  const apiRequests = [];
  try {
    const Plugin = require(path.join(root, "dist/index.cjs")).default;
    const plugin = new Plugin();
    sdk.PluginRegistry.registerPlugin(plugin);
    sdk.PluginRegistry.configureCapabilities({
      granted: plugin.declareCapabilities(),
    });
    sdk.PluginRegistry.configureStorage({
      rootDir: path.join(temp, "storage"),
    });
    sdk.PluginRegistry.configureHostServices({
      request: async (request) => {
        if (request.action === "secrets.get") return { value: fakeKey };
        if (request.action === "secrets.set") {
          assert.equal(request.payload.value, "browser-fixture-key");
          fakeKey = request.payload.value;
          return { stored: true };
        }
        if (request.action === "secrets.delete") {
          fakeKey = null;
          return { deleted: true };
        }
        throw new Error("Unexpected test secret operation.");
      },
    });
    // All account reads below are local fixtures. Unexpected endpoints fail.
    global.fetch = async (url, init) => {
      const u = new URL(url);
      apiRequests.push(u);
      assert.equal(u.origin, "https://infrahub-api.nexgencloud.com");
      assert.equal(init.method, "GET");
      await new Promise((resolve) => setTimeout(resolve, 300));
      let body;
      if (u.pathname.endsWith("/core/virtual-machines"))
        body = {
          status: true,
          instances: [
            {
              id: 301,
              name: "range-training",
              status: "ACTIVE",
              environment: {
                org_id: 999,
                name: "range-test",
                region: "NORWAY-1",
              },
              flavor: {
                name: "n3-H100x1",
                gpu: "H100",
                gpu_count: 1,
                features: { no_hibernation: false },
              },
              volume_attachments: [],
              floating_ip: null,
              created_at: "2026-10-01T00:00:00Z",
            },
          ],
        };
      else if (u.pathname.endsWith("/core/volumes"))
        body = {
          status: true,
          volumes: [
            {
              id: 501,
              name: "debug-volume",
              status: "available",
              environment: { name: "range-test", region: "NORWAY-1" },
              volume_type: "Cloud-SSD",
              size: 100,
              attachments: [],
              created_at: "2026-10-01T00:00:00Z",
            },
          ],
        };
      else if (u.pathname.endsWith("/usage")) body = { status: true, data: [] };
      else if (u.pathname.endsWith("/pricebook")) body = [];
      else if (u.pathname.endsWith("/history/virtual-machine"))
        body = {
          success: true,
          billing_history_vm: {
            pagination: { pages: 1 },
            billing_history: [
              {
                attributes: {
                  infrahub_id: 301,
                  resource_name: "range-training",
                },
                metrics: { incurred_bill: 72, usage_time: 72 },
              },
            ],
          },
        };
      else if (u.pathname.endsWith("/core/volumes/501"))
        return {
          ok: false,
          status: 403,
          headers: { get: () => "req-volume-501" },
          json: async () => ({
            error_reason: "permission_denied",
            message: "Volume read access missing. api_key=browser-fixture-key",
          }),
        };
      else if (u.pathname.endsWith("/billing/billing/history/volume/501")) {
        if (denyBillingRead)
          return {
            ok: false,
            status: 403,
            headers: { get: () => "req-retry-denied" },
            json: async () => ({
              error_reason: "permission_denied",
              message: "Specific volume billing read denied",
            }),
          };
        body = {
          status: true,
          billing_history_volume_details: {
            total_count: 1,
            billing_history: [
              {
                attributes: { infrahub_id: 501 },
                metrics: { incurred_bill: 36, usage_time: 36 },
              },
            ],
          },
        };
      } else if (u.pathname.endsWith("/history/volume")) {
        if (u.searchParams.get("start_date").startsWith("2026-11"))
          return {
            ok: false,
            status: 403,
            headers: { get: () => "req-billing-501" },
            json: async () => ({
              error_reason: "permission_denied",
              message: "Volume billing list access missing.",
            }),
          };
        body = {
          success: true,
          billing_history_volume: {
            pagination: { pages: 1 },
            billing_history: [
              {
                attributes: { infrahub_id: 501, resource_name: "debug-volume" },
                metrics: { incurred_bill: 24, usage_time: 24 },
              },
            ],
          },
        };
      } else if (u.pathname.endsWith("/sub-resource"))
        body = {
          status: true,
          sub_resources_costs: {
            billing_history: [
              {
                metrics: {
                  publicip_incurred_bill: 0,
                  gpu_incurred_bill: 72,
                  cpu_incurred_bill: 0,
                  ram_incurred_bill: 0,
                  ephemeral_incurred_bill: 0,
                },
              },
            ],
          },
        };
      else if (u.pathname.endsWith("/history"))
        body = {
          status: true,
          billing_history: {
            org_id: 999,
            billing_history: [{ metrics: { incurred_bill: 72 } }],
          },
        };
      else throw new Error(`Unexpected test endpoint ${u.pathname}`);
      return { ok: true, status: 200, json: async () => body };
    };
    const chartPath = path.join(temp, "charts.js");
    await require(path.join(host, "node_modules/esbuild")).build({
      stdin: {
        contents: `import {installChartRenderer} from ${JSON.stringify(path.join(host, "src/components/plugin/utils/chartBridge.js"))};installChartRenderer();`,
        resolveDir: host,
      },
      outfile: chartPath,
      bundle: true,
      format: "iife",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    sdk.PluginRegistry.callInit();
    const { chromium } = require(path.join(host, "node_modules/playwright"));
    browser = await chromium.launch({
      executablePath:
        process.env.FDO_BROWSER ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1680, height: 1080 },
      locale: "en-GB",
      timezoneId: "Europe/Kyiv",
    });
    const page = await context.newPage();
    const errors = [],
      calls = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("__bridge", async (type, payload) => {
      assert.equal(type, "UI_MESSAGE");
      calls.push(payload.handler);
      assert.notEqual(payload.handler, "hyperstack-finops.execute");
      return {
        result: await sdk.PluginRegistry.callHandler(
          payload.handler,
          payload.content,
        ),
      };
    });
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">' +
        plugin.render() +
        "</body></html>",
    );
    await page.addScriptTag({ path: chartPath });
    await page.evaluate((source) => {
      window.createBackendReq = window.__bridge;
      window.eval(source);
    }, JSON.parse(plugin.serializeRenderOnLoad()));
    await page.getByText("Ready", { exact: true }).waitFor();
    await page.locator('#hf-content [data-action="demo"]').click();
    await page
      .getByText(
        "Example data is read-only. Connect and Sync for your account.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.locator("tbody tr.selected").count(), 0);
    await page.locator("#hf-chart-comparison svg").first().waitFor();
    await page.locator("#hf-chart-breakdown svg").first().waitFor();
    await page.locator("#hf-chart-budget svg").first().waitFor();
    assert.ok(
      (await page.locator(".nav-item").first().boundingBox()).height < 60,
    );
    await page.screenshot({
      path: path.join(temp, "overview.png"),
      fullPage: true,
    });
    await page.locator('[data-driver="vm"]').click();
    await page.locator('nav [data-page="resources"].active').waitFor();
    assert.equal(await page.locator(".resource-table tbody tr").count(), 3);
    assert.equal(await page.locator("tbody tr.selected").count(), 0);
    assert.equal(await page.locator(".inspector").count(), 0);
    await page.selectOption("#hf-kind", "");
    await page.waitForFunction(
      () => document.querySelectorAll(".resource-table tbody tr").length === 6,
    );
    await page.locator('.resource-table tbody [data-select="vm:102"]').click();
    await page
      .getByRole("heading", { name: "eval-h100-01", exact: true })
      .waitFor();
    await page.locator('[data-tab="origin"]').click();
    await page.locator('[data-tab="origin"][aria-selected="true"]').waitFor();
    const localDate = page.locator("#hf-tab-panel time").first();
    assert.match(
      await localDate.getAttribute("title"),
      /^Europe\/(Kiev|Kyiv)$/,
    );
    assert.ok(!(await localDate.innerText()).includes("T00:00:00"));
    await page.locator('[data-tab="billing"]').click();
    await page.locator('[data-tab="billing"][aria-selected="true"]').waitFor();
    assert.equal(await page.locator("[data-stage]").isDisabled(), true);
    await page.screenshot({
      path: path.join(temp, "resources.png"),
      fullPage: true,
    });
    await page.locator("[data-clear-selection]").click();
    await page
      .getByRole("heading", { name: "Select a resource", exact: true })
      .waitFor();
    assert.equal(await page.locator("tbody tr.selected").count(), 0);
    await page
      .locator('.resource-table tbody [data-select="public-ip:102"]')
      .click();
    await page.getByText("Public-IP cost", { exact: true }).waitFor();
    assert.match(
      await page.locator("#hf-tab-panel").innerText(),
      /does not report independent IP usage hours/,
    );
    assert.doesNotMatch(
      await page.locator(".inspector-metrics").innerText(),
      /Unknown|Not reported/,
    );
    await page
      .locator('.resource-table tbody [data-select="volume:202"]')
      .click();
    await page
      .getByText("Savings estimate window (hours after deletion)", {
        exact: true,
      })
      .waitFor();
    assert.match(
      await page.locator(".inspector-actions").innerText(),
      /not a delay, schedule, or refund/,
    );
    assert.equal(await page.locator("#hf-pause").inputValue(), "24");
    await page.locator("#hf-search").fill("completed");
    await page.waitForFunction(
      () => document.querySelectorAll(".resource-table tbody tr").length === 1,
    );
    assert.match(
      (await page.locator("tbody").allInnerTexts()).join(" "),
      /DELETED/,
    );
    await page.locator("#hf-search").fill("");
    await page.waitForFunction(
      () => document.querySelectorAll(".resource-table tbody tr").length === 6,
    );
    await page.locator('nav [data-page="optimization"]').click();
    await page.locator(".finding-card").first().waitFor();
    assert.equal(await page.locator(".finding-card").count(), 2);
    await page.locator('nav [data-page="changes"]').click();
    await page.locator('nav [data-page="changes"].active').waitFor();
    assert.match(
      (await page.locator("tbody").allInnerTexts()).join(" "),
      /More billed hours/,
    );
    await page.locator(".change-evidence summary").first().click();
    assert.match(
      await page.locator(".change-evidence details").first().innerText(),
      /Arithmetic attribution/,
    );
    await page.setViewportSize({ width: 1200, height: 350 });
    const navScroll = await page.locator(".sidebar nav").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return {
        top: el.scrollTop,
        overflow: getComputedStyle(el).overflowY,
        height: el.clientHeight,
        content: el.scrollHeight,
      };
    });
    assert.equal(navScroll.overflow, "auto");
    assert.ok(navScroll.top > 0, JSON.stringify(navScroll));
    await page.evaluate(() => window.scrollTo(0, 700));
    assert.equal(
      Math.round((await page.locator(".sidebar").boundingBox()).y),
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(temp, "mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1680, height: 1080 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#hf-connection summary").click();
    await page.locator("#hf-api-key").fill("browser-fixture-key");
    await page.locator('[data-action="configure"]').click();
    await page.getByText("Connected to Hyperstack", { exact: true }).waitFor();
    await page.selectOption("#hf-period", "custom");
    await page.locator("#hf-range-start").fill("2026-11-02");
    await page.locator("#hf-range-end").fill("2026-11-04");
    await page.locator('[data-action="apply-range"]').click();
    await page.locator("#hf-progress-panel").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#hf-progress").getAttribute("data-fdo-component"),
      "fdo.progress-bar",
    );
    await page.waitForFunction(() =>
      /Loading|reads finished|Saving/.test(
        document.getElementById("hf-progress-detail").textContent,
      ),
    );
    await page.screenshot({
      path: path.join(temp, "progress.png"),
      fullPage: true,
    });
    await page
      .getByText("Billing synchronized. Review coverage notes below.", {
        exact: true,
      })
      .waitFor();
    assert.match(
      await page.locator("#hf-loaded-range").innerText(),
      /2026-11-02 – 2026-11-04/,
    );
    assert.equal(await page.locator("#hf-period").inputValue(), "custom");
    assert.ok(
      apiRequests.some(
        (u) =>
          u.searchParams.get("start_date") === "2026-11-02T00:00:00" &&
          u.searchParams.get("end_date") === "2026-11-05T00:00:00",
      ),
    );
    assert.ok(
      apiRequests.some(
        (u) =>
          u.searchParams.get("start_date") === "2026-10-30T00:00:00" &&
          u.searchParams.get("end_date") === "2026-11-02T00:00:00",
      ),
    );
    await page.locator('nav [data-page="resources"]').click();
    await page.locator('nav [data-page="resources"].active').waitFor();
    assert.equal(await page.locator("tbody tr.selected").count(), 0);
    assert.match(
      (await page.locator("tbody").allInnerTexts()).join(" "),
      /72.00/,
    );
    await page.screenshot({
      path: path.join(temp, "custom-range.png"),
      fullPage: true,
    });
    await page.locator('.resource-table [data-select="volume:501"]').click();
    await page
      .getByRole("heading", { name: "debug-volume", exact: true })
      .waitFor();
    await page.locator('[data-stage="volume:501"]').click();
    await page
      .locator("#hf-error")
      .getByText(/HTTP 403/)
      .waitFor();
    await page.locator("#hf-error-details").waitFor({ state: "visible" });
    const diagnostics = await page.locator("#hf-error-diagnostics").innerText();
    assert.match(diagnostics, /GET \/core\/volumes\/501/);
    assert.match(diagnostics, /Volume read access missing/);
    assert.match(diagnostics, /req-volume-501/);
    assert.doesNotMatch(diagnostics, /browser-fixture-key/);
    assert.equal(await page.locator("#hf-progress-panel").isVisible(), false);
    denyBillingRead = true;
    await page
      .locator('[data-retry-bill="volume:501"][data-field="current"]')
      .click();
    await page
      .locator("#hf-billing-coverage")
      .getByText(/Still unavailable after 1 read attempt/)
      .waitFor();
    assert.equal(
      await page.locator('[data-retry-bill="volume:501"]').isDisabled(),
      true,
    );
    assert.match(
      await page.locator("#hf-status").innerText(),
      /Bill still unavailable/,
    );
    assert.match(
      await page.locator("#hf-billing-coverage").innerText(),
      /Specific volume billing read denied/,
    );
    denyBillingRead = false;
    await page.locator('#hf-billing-coverage [data-action="sync"]').click();
    await page
      .getByText("Billing synchronized. Review coverage notes below.", {
        exact: true,
      })
      .waitFor();
    await page
      .locator('[data-retry-bill="volume:501"][data-field="current"]')
      .click();
    await page.locator("#hf-billing-coverage").waitFor({ state: "detached" });
    assert.match(
      await page.locator("#hf-status").innerText(),
      /Billing data restored/,
    );
    assert.match(
      (await page.locator("tbody").allInnerTexts()).join(" "),
      /USD 36.00/,
    );
    assert.match(await page.locator(".metrics").innerText(), /Period change/i);
    assert.match(await page.locator(".metrics").innerText(), /USD 12.00/);
    await page.selectOption("#hf-period", "month");
    await page
      .getByText("Billing synchronized. Review coverage notes below.", {
        exact: true,
      })
      .waitFor();
    await page
      .getByText("Known-spend month-end run rate", { exact: true })
      .waitFor();
    assert.match(
      await page.locator("#hf-billing-coverage").innerText(),
      /debug-volume/,
    );
    await page.locator('nav [data-page="overview"]').click();
    await page.locator("#hf-chart-budget svg").first().waitFor();
    await page.screenshot({
      path: path.join(temp, "coverage-and-graphs.png"),
      fullPage: true,
    });
    const beforeInvalid = apiRequests.length;
    await page.locator("#hf-range-start").fill("2026-11-08");
    await page.locator("#hf-range-end").fill("2026-11-04");
    await page.locator('[data-action="apply-range"]').click();
    await page
      .locator("#hf-error")
      .getByText(/Invalid date range/)
      .waitFor();
    assert.equal(apiRequests.length, beforeInvalid);
    assert.match(
      await page.locator("#hf-loaded-range").innerText(),
      /This month/,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        screenshots: temp,
        bridgeRequests: calls.length,
      }),
    );
  } finally {
    global.fetch = originalFetch;
    if (browser) await browser.close();
    await sdk.PluginRegistry.clearPlugin();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
