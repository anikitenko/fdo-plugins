// Local verification only: actual SDK persistence + host chart renderer; no Azure access.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  host = path.resolve(
    process.env.FDO_SOURCE_ROOT || path.join(root, "../../fdo"),
  );
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "azure-finops-browser-"));
process.env.FDO_SDK_LOG_ROOT = path.join(temp, "logs");
process.parentPort = new (require("node:events").EventEmitter)();
process.parentPort.postMessage = () => {};
(async () => {
  let browser;
  const sdk = require(path.join(root, "node_modules/@anikitenko/fdo-sdk"));
  try {
    const Plugin = require(path.join(root, "dist/index.cjs")).default;
    sdk.PluginRegistry.configureCapabilities({
      granted: new Plugin().declareCapabilities(),
    });
    sdk.PluginRegistry.configureStorage({
      rootDir: path.join(temp, "storage"),
    });
    sdk.PluginRegistry.callInit();
    const plugin = new Plugin();
    const render = plugin.render(),
      onLoad = plugin.renderOnLoad();
    const { build } = require(path.join(root, "node_modules/esbuild"));
    const chartPath = path.join(temp, "charts.js");
    await build({
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
    const { chromium } = require(path.join(host, "node_modules/playwright"));
    browser = await chromium.launch({
      executablePath:
        process.env.FDO_BROWSER ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1680, height: 1100 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    let privileged = 0;
    page.on("pageerror", (e) => errors.push(e.message));
    await page.exposeFunction("__bridge", async (type, payload) => {
      if (type !== "UI_MESSAGE") {
        privileged++;
        throw new Error("Demo requested a privileged action");
      }
      return {
        result: await sdk.PluginRegistry.callHandler(
          payload.handler,
          payload.content,
        ),
      };
    });
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
        render +
        "</body></html>",
    );
    await page.addScriptTag({ path: chartPath });
    await page.evaluate((source) => {
      window.createBackendReq = window.__bridge;
      window.eval(source);
    }, onLoad);
    await page.locator("#af-resource-table tbody tr").first().waitFor();
    await page.getByRole("row").filter({ hasText: "vm-dev-runner" }).click();
    await page.getByRole("heading", { name: "Origin & ownership" }).waitFor();
    await page.locator("#af-groups-button").click();
    await page.screenshot({
      path: "/private/tmp/azure-finops-resources.png",
      fullPage: true,
    });
    await page.locator("#af-groups-cancel").click();
    await page.locator('[data-page="overview"]').click();
    await page.locator(".recharts-wrapper").first().waitFor();
    await page.screenshot({
      path: "/private/tmp/azure-finops-overview.png",
      fullPage: true,
    });
    await page.locator('[data-page="settings"]').click();
    await page
      .getByRole("heading", { name: "Custom capability setup" })
      .waitFor();
    assert.equal(
      (await page
        .getByText("system.process.scope.azure-finops", { exact: false })
        .count()) > 0,
      true,
    );
    await page.setViewportSize({ width: 740, height: 1000 });
    await page.locator('[data-page="resources"]').click();
    await page.screenshot({
      path: "/private/tmp/azure-finops-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      "mobile page overflow",
    );
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole("row").filter({ hasText: "disk-build-old" }).click();
    await page
      .getByRole("button", { name: "Propose deletion…", exact: true })
      .click();
    await page.locator("#af-review").click();
    await page.locator("#af-review-dialog").waitFor({ state: "visible" });
    const execute = page.getByRole("button", {
      name: "Simulate reviewed actions",
      exact: true,
    });
    assert.equal(await execute.isDisabled(), true);
    await page
      .getByRole("checkbox", {
        name: "I reviewed every exact target and operational impact",
      })
      .check();
    assert.equal(await execute.isDisabled(), true);
    await page
      .getByRole("textbox", { name: "Confirm deletion disk-build-old" })
      .fill("disk-build-old");
    assert.equal(await execute.isEnabled(), true);
    await page
      .locator("#af-review-dialog")
      .screenshot({ path: "/private/tmp/azure-finops-review.png" });
    await page.locator("#af-review-close").click();
    await page.locator('[data-page="databricks"]').click();
    await page
      .getByRole("button", { name: "Inspect service", exact: true })
      .click();
    await page.getByText("analytics-interactive", { exact: true }).waitFor();
    await page.screenshot({
      path: "/private/tmp/azure-finops-databricks.png",
      fullPage: true,
    });
    await page.locator('[data-page="foundry"]').click();
    await page
      .getByRole("row")
      .filter({ hasText: "ai-foundry" })
      .getByRole("button", { name: "Inspect service", exact: true })
      .click();
    await page.getByText("chat-prod", { exact: true }).waitFor();
    await page.screenshot({
      path: "/private/tmp/azure-finops-foundry.png",
      fullPage: true,
    });
    assert.equal(
      await page
        .getByRole("heading", {
          name: "Cleanup review candidates",
          exact: true,
        })
        .count(),
      1,
    );

    assert.equal(privileged, 0);
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      "mobile page should contain horizontal table overflow",
    );
    console.log(
      "Browser smoke passed: real SDK storage, all-demo request isolation, real host FDOCharts, responsive layout, no browser errors. Screenshots in /private/tmp/azure-finops-*.png",
    );
  } finally {
    await browser?.close();
    sdk.PluginRegistry.clearPlugin();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
