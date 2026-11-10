// Build each plugin first. To test an unreleased SDK checkout:
// FDO_SDK_ROOT=../fdo-sdk node scripts/verify-plugin-cleanup.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const {EventEmitter} = require('node:events');
const root = path.resolve(__dirname, '..');
const sdkRoot = path.resolve(process.env.FDO_SDK_ROOT || path.join(root, '../fdo/node_modules/@anikitenko/fdo-sdk'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fdo-plugin-cleanup-'));
process.env.FDO_SDK_LOG_ROOT = path.join(temporary, 'logs');
const sdk = require(sdkRoot);
assert.equal(typeof sdk.FDO_SDK.prototype.onDispose, 'function', 'Build/select the SDK with PluginScope support using FDO_SDK_ROOT.');
const {PluginRegistry} = sdk;
const load = Module._load;
Module._load = function(request, ...args) {
  return request === '@anikitenko/fdo-sdk' ? sdk : load.call(this, request, ...args);
};
const native = {setTimeout, clearTimeout, setInterval, clearInterval};
const timers = new Map();
global.setTimeout = (callback, ms, ...args) => {
  const timer = native.setTimeout(() => {timers.delete(timer); callback(...args);}, ms);
  timers.set(timer, ms); return timer;
};
global.setInterval = (callback, ms, ...args) => {
  const timer = native.setInterval(callback, ms, ...args);
  timers.set(timer, ms); return timer;
};
global.clearTimeout = timer => {timers.delete(timer); native.clearTimeout(timer);};
global.clearInterval = timer => {timers.delete(timer); native.clearInterval(timer);};
const settle = async () => {for (let i = 0; i < 50; i++) await Promise.resolve();};

(async () => {
  try {
    for (const name of ['hyperstack-availability', 'azure-finops', 'remote-commands']) {
      process.parentPort = Object.assign(new EventEmitter(), {postMessage() {}});
      let instance, disposed = 0;
      const register = sdk.FDO_SDK.prototype.onDispose;
      sdk.FDO_SDK.prototype.onDispose = function(cleanup) {
        instance = this;
        return register.call(this, () => {disposed++; return cleanup();});
      };
      try {
        const Plugin = require(path.join(root, name, 'dist/index.cjs')).default;
        PluginRegistry.configureCapabilities({granted: Plugin.prototype.declareCapabilities()});
        PluginRegistry.configureStorage({rootDir: path.join(temporary, name)});
        PluginRegistry.configureHostServices({request: async request => {
          if (request.action === 'secrets.get') return {value: null};
          throw new Error('Unexpected host request: ' + request.action);
        }});
        PluginRegistry.callInit();
        await settle();
        assert.ok(instance, name + ' must register its backend with the SDK scope');
        PluginRegistry.callInit();
        await settle();
        assert.equal(disposed, 0, name + ' must unregister a replaced backend after releasing it');
        if (name === 'hyperstack-availability') {
          const response = await PluginRegistry.callHandler('hyperstack.availability.setPolling', {seconds: 60});
          assert.ok(response.ok);
        } else if (name === 'azure-finops') {
          const response = await PluginRegistry.callHandler('azure-finops.start', {kind: 'accounts', mode: 'live'});
          assert.ok(response.ok);
        }
        await settle();
        assert.equal(timers.size, name === 'remote-commands' || name === 'azure-finops' ? 2 : 1,
          name + ' must retain only the current backend timers');
        await PluginRegistry.shutdown();
        await settle();
        assert.equal(instance.signal.aborted, true);
        assert.equal(disposed, 1, name + ' cleanup must run once');
        assert.equal(timers.size, 0, name + ' leaked timers: ' + [...timers.values()]);
        assert.equal(process.parentPort.listenerCount('message'), 0);
        await instance.dispose();
        assert.equal(disposed, 1);
        console.log(name + ': SDK shutdown released owned resources.');
      } finally {
        sdk.FDO_SDK.prototype.onDispose = register;
        await PluginRegistry.clearPlugin();
      }
    }
  } finally {
    Module._load = load;
    Object.assign(global, native);
    delete process.parentPort;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
