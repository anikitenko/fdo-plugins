const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (!process.env.FDO_REMOTE_SMOKE_DIR) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fdo-remote-commands-'));
  try {
    require('node:child_process').execFileSync(process.execPath, [__filename], {stdio: 'inherit', env: {...process.env, FDO_REMOTE_SMOKE_DIR: temp}});
  } catch {process.exitCode = 1;}
  finally {fs.rmSync(temp, {recursive: true, force: true});}
  return;
}
const temp = process.env.FDO_REMOTE_SMOKE_DIR;
process.env.FDO_SDK_LOG_ROOT = path.join(temp, 'logs');
// Test-only stand-in for FDO's worker bootstrap; no real host IPC is used.
process.parentPort = new (require('node:events').EventEmitter)();
process.parentPort.postMessage = () => {};
const sdk = require('@anikitenko/fdo-sdk');
const {PluginRegistry} = sdk;
let executions = 0;
function configure() {
  PluginRegistry.configureCapabilities({granted: [...sdk.createSSHCapabilityBundle({monitorStatus: true}), 'storage', 'storage.json', 'system.clipboard.write']});
  PluginRegistry.configureStorage({rootDir: path.join(temp, 'storage')});
  PluginRegistry.configureHostServices({watchSSHStatus: async ({profileId}) => ({async *[Symbol.asyncIterator]() {yield {profileId, state: 'connected', checkedAt: new Date().toISOString(), staleAfterMs: 5000};}}),
    startSSHExecution: async () => {executions++; return {events: {async *[Symbol.asyncIterator]() {yield {sequence: 0, stream: 'stdout', data: 'fixture output'};}}, result: Promise.resolve({stdout: 'fixture output', stderr: '', exitCode: 0, signal: null, durationMs: 5, truncated: false}), cancel: async () => ({remoteProcessStopped: null})};},
    request: async request => {
    if (request.action === 'ssh.profiles.list') return {profiles: [{id: 'fixture', label: 'Fixture VM', host: 'vm.example.test', port: 2222, username: 'ubuntu', authenticationType: 'privateKey', trustedHostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}]};
    if (request.action === 'ssh.exec') {executions++; return {stdout: 'fixture output', stderr: '', exitCode: 0, signal: null, durationMs: 5, truncated: false};}
    throw new Error('Unexpected service request');
  }});
}
(async () => {
  try {
    configure();
    const Plugin = require(process.env.FDO_REMOTE_SMOKE_BUNDLE || '../dist/index.cjs').default;
    PluginRegistry.callInit();
    let response = await PluginRegistry.callHandler('remote-commands.bootstrap', {});
    assert.equal(response.ok, true); assert.equal(response.data.profiles[0].id, 'fixture'); assert.deepEqual(response.data.warnings, []);
    assert.equal(response.data.profiles[0].host, 'vm.example.test');
    assert.equal(response.data.profiles[0].username, 'ubuntu');
    const state = response.data.states.fixture;
    state.batches[0].draft = 'cd /tmp\nexport TEST=preserved\nprintf "$TEST"';
    state.selectedBatch = 'logs';
    response = await PluginRegistry.callHandler('remote-commands.save', {profileId: 'fixture', state});
    assert.equal(response.ok, true);
    assert.equal(executions, 0);
    // Tear down the actual SDK scope and create a new plugin over the disk store.
    PluginRegistry.clearPlugin(); configure(); PluginRegistry.registerPlugin(new Plugin()); PluginRegistry.callInit();
    response = await PluginRegistry.callHandler('remote-commands.bootstrap', {});
    assert.equal(response.data.states.fixture.selectedBatch, 'logs');
    assert.equal(response.data.states.fixture.batches[0].draft, state.batches[0].draft);
    const review = await PluginRegistry.callHandler('remote-commands.prepare', {profileId: 'fixture', script: 'uptime', values: {}, timeout: 10, stopOnError: true});
    assert.equal(executions, 0); assert.equal(review.data.command, 'set -e; uptime');
    assert.ok(new Plugin().declareCapabilities().includes('ssh.status.watch'));
    const started = await PluginRegistry.callHandler('remote-commands.start', {token: review.data.token, viewId: 'bundle-view', runId: 'bundle-run'});
    assert.equal(started.data.started, true);
    let snapshot;
    for (let i = 0; i < 50; i++) {
      snapshot = await PluginRegistry.callHandler('remote-commands.sync', {viewId: 'bundle-view', profileId: 'fixture', runId: 'bundle-run'});
      if (snapshot.data.output?.done) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(snapshot.data.output.result.exitCode, 0); assert.equal(snapshot.data.output.stdout, 'fixture output'); assert.equal(executions, 1);
    const rendered = PluginRegistry.callRenderer();
    const html = JSON.parse(rendered.render);
    const messages = [];
    process.parentPort.postMessage = message => messages.push(message);
    process.parentPort.emit('message', {data: {message: 'PLUGIN_RENDER', content: {}}});
    const transportRender = messages.find(message => message.type === 'PLUGIN_RENDER')?.response;
    assert.ok(transportRender, 'the SDK communicator must return the render response');
    assert.equal(transportRender.error, undefined, 'the render transport must not fall back to Invalid render payload');
    const transportHtml = JSON.parse(transportRender.render);
    assert.match(transportHtml, /<main id="remote-commands"/);
    assert.match(transportHtml, /grid-template-columns:230px minmax\(380px,1fr\) 300px/);
    assert.equal(typeof JSON.parse(transportRender.onLoad), 'string');
    assert.match(html, /grid-template-columns:230px minmax\(380px,1fr\) 300px/, 'deployed render must contain the workspace CSS');
    const {JSDOM} = require('jsdom');
    const dom = new JSDOM(transportHtml);
    try {
      const document = dom.window.document;
      const computed = element => dom.window.getComputedStyle(element);
      assert.equal(computed(document.querySelector('#remote-commands')).padding, '14px');
      assert.equal(computed(document.querySelector('.rc-layout')).display, 'grid');
      assert.equal(computed(document.querySelector('.rc-layout')).gridTemplateColumns, '230px minmax(380px,1fr) 300px');
      assert.equal(computed(document.querySelector('.rc-panel')).padding, '16px');
      assert.equal(computed(document.querySelector('h1')).fontSize, '30px');
      assert.equal(document.querySelector('#rc-workspace').hasAttribute('hidden'), true);
      // jsdom's cascade does not reliably honor !important over later rules.
      // Verify the browser's hidden-state contract through the actual CSSOM.
      const hiddenRule = [...document.styleSheets[0].cssRules].find(rule => rule.selectorText?.includes('[hidden]'));
      assert.equal(hiddenRule.style.getPropertyValue('display'), 'none');
      assert.equal(hiddenRule.style.getPropertyPriority('display'), 'important');
    } finally {dom.window.close();}
    console.log('Bundle smoke passed: deployed computed styles, registration, handlers, real SDK JSON disk persistence across reload, and mocked host SSH transport.');
  } finally {PluginRegistry.clearPlugin();}
})().catch(error => {console.error(error); process.exitCode = 1;});
