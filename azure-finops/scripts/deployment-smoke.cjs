const assert = require("node:assert/strict"),
  path = require("node:path");
process.env.FDO_SDK_LOG_ROOT = path.join(process.argv[3], "logs");
process.parentPort = new (require("node:events").EventEmitter)();
const messages = [];
process.parentPort.postMessage = (message) => messages.push(message);
const sdk = require("@anikitenko/fdo-sdk"),
  { PluginRegistry } = sdk;
(async () => {
  try {
    const Plugin = require(process.argv[2]).default,
      plugin = new Plugin();
    const configure = () => {
      PluginRegistry.configureCapabilities({
        granted: plugin.declareCapabilities(),
      });
      PluginRegistry.configureStorage({
        rootDir: path.join(process.argv[3], "storage"),
      });
    };
    assert.ok(plugin.declareCapabilities().includes("storage"));
    assert.ok(plugin.declareCapabilities().includes("storage.json"));
    configure();
    PluginRegistry.configureCapabilities({
      granted: plugin
        .declareCapabilities()
        .filter((capability) => capability !== "storage.json"),
    });
    PluginRegistry.callInit();
    const denied = await PluginRegistry.callHandler(
      "azure-finops.bootstrap",
      {},
    );
    assert.equal(
      denied.ok,
      false,
      "Base storage alone must not authorize the JSON backend",
    );
    assert.match(denied.error, /storage\.json/);
    configure();
    let response = await PluginRegistry.callHandler(
      "azure-finops.bootstrap",
      {},
    );
    assert.equal(response.ok, true);
    assert.equal(response.data.settings.mode, "demo");
    process.parentPort.emit("message", {
      data: { message: "PLUGIN_RENDER", content: {} },
    });
    const transport = messages.find(
      (message) => message.type === "PLUGIN_RENDER",
    )?.response;
    assert.ok(transport);
    assert.equal(transport.error, undefined);
    const html = JSON.parse(transport.render);
    assert.match(html, /id="azure-finops"/);
    assert.match(html, /grid-template-columns:228px/);
    assert.equal(typeof JSON.parse(transport.onLoad), "string");
    const { normalizePluginRenderPayload } = require(process.argv[4]);
    const checked = normalizePluginRenderPayload(transport);
    assert.equal(checked.onLoad, JSON.parse(transport.onLoad));
    assert.throws(
      () =>
        normalizePluginRenderPayload({
          ...transport,
          onLoad: JSON.stringify(
            "(()=>window.sessionStorage.getItem('blocked'))()",
          ),
        }),
      /blocked sessionStorage/,
    );
    response = await PluginRegistry.callHandler("azure-finops.configure", {
      mode: "demo",
      cli: "/usr/local/bin/az",
      processScope: "azure-finops",
    });
    assert.equal(response.ok, true);
    PluginRegistry.clearPlugin();
    configure();
    PluginRegistry.registerPlugin(new Plugin());
    PluginRegistry.callInit();
    response = await PluginRegistry.callHandler("azure-finops.bootstrap", {});
    assert.equal(response.data.settings.cli, "/usr/local/bin/az");
    console.log(
      "Deployment smoke passed: compiled storage/storage.json manifest, missing JSON-grant rejection, real host startup/render-source guard, SDK transport and durable settings across reload.",
    );
  } finally {
    PluginRegistry.clearPlugin();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
