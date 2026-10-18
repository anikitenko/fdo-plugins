import {completedExecution, statusFeed, channel, deferred} from './fixtures.ts';
import type {SSHTerminalSession, SSHTerminalOptions, SSHExecResult, SSHOutputEvent} from '@anikitenko/fdo-sdk';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {renderRemoteCommands, renderRemoteCommandsOnLoad} from '../render.ts';
import {createBackend} from '../backend.ts';
import {serviceMessage} from '../model.ts';
const {JSDOM} = createRequire(import.meta.url)('jsdom');

async function fixture() {
  const persisted = new Map<string, any>(), calls: any[] = [];
  const store = {get: (k: string) => persisted.get(k), set: (k: string, v: unknown) => {persisted.set(k, structuredClone(v));}, remove() {}, clear() {}, has: (k: string) => persisted.has(k), keys: () => [...persisted.keys()], flush: async () => {}};
  const profiles = [{id: 'dev', label: 'dev-api-01', host: '2001:db8::12', port: 2222, username: 'ubuntu', authenticationType: 'privateKey' as const, trustedHostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}, {id: 'stage', label: 'staging-01'}];
  const ssh = {openTerminal: async (_options: SSHTerminalOptions): Promise<SSHTerminalSession> => {throw {code: 'UNAVAILABLE'};}, start: async (options: any) => completedExecution(ssh.exec(options)), watchStatus: statusFeed, listProfiles: async () => profiles, exec: async (options: any) => {calls.push(options); return {stdout: '<output>\n', stderr: 'diagnostic\n', exitCode: 3, signal: null, durationMs: 27, truncated: true};}};
  const backend = createBackend(ssh, () => store);
  const dom = new JSDOM(`<!doctype html><html><body>${renderRemoteCommands()}</body></html>`, {runScripts: 'outside-only', url: 'http://localhost/'});
  const win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function() {this.open = true;};
  win.HTMLDialogElement.prototype.close = function() {this.open = false;};
  let bridgeTail = Promise.resolve();
  win.createBackendReq = (type: string, payload: any) => {
    const response = bridgeTail.then(async () => {
    if (type === 'requestPrivilegedAction') return {ok: true};
    const name = payload.handler.replace('remote-commands.', '');
    if (name === 'copy') return {action: 'system.clipboard.write', payload: {text: payload.content.text}};
    try {return structuredClone({ok: true, data: await (backend as any)[name === 'cancel' ? 'requestCancel' : name](payload.content)});} catch (e) {return {ok: false, error: name === 'save' ? 'Could not persist changes. Your draft is retained. Check FDO diagnostics and retry saving.' : serviceMessage(e), code: (e as {code?: string}).code, output: (e as {output?: unknown}).output};}
    });
    bridgeTail = response.then(() => {}, () => {});
    return response;
  };
  win.eval(renderRemoteCommandsOnLoad());
  const $ = (selector: string) => win.document.querySelector(selector);
  const settle = async () => {for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));};
  const click = async (selector: string) => {$(selector).click(); await settle();};
  const type = async (selector: string, value: string) => {$(selector).value = value; $(selector).dispatchEvent(new win.Event('input', {bubbles: true})); await settle();};
  const action = async (label: string) => {
    const buttons = [...win.document.querySelectorAll('dialog[open] button')];
    const b = buttons.find((b: any) => b.textContent === label) as any; assert.ok(b, label); b.click(); await settle();
  };
  await settle();
  return {dom, win, $, settle, click, type, action, calls, persisted, backend, profiles, ssh, store};
}

test('UI streams output before completion, cancels honestly, retains partial output and keeps SSH status independent', async () => {
  const f = await fixture(), events = channel<SSHOutputEvent>(), terminal = deferred<SSHExecResult>();
  f.ssh.start = async options => {f.calls.push(options); return {events: events.iterator, result: terminal.promise,
    cancel: async () => {await events.close(); terminal.reject({code: 'CANCELLED'}); return {remoteProcessStopped: null};}};};
  try {
    await f.type('#rc-capture', '4096'); f.$('#rc-capture').dispatchEvent(new f.win.Event('change')); await f.settle();
    await f.type('#rc-editor', 'echo live'); await f.click('#rc-run');
    assert.match(f.$('dialog').textContent, /capture 4096 KiB/); await f.action('Execute on VM');
    events.push({sequence: 0, stream: 'stdout', data: 'hello 🌍'}); events.push({sequence: 1, stream: 'stderr', data: '<warning>'});
    await new Promise(resolve => setTimeout(resolve, 300)); await f.settle();
    assert.match(f.$('#rc-output').textContent, /Running/); assert.match(f.$('#rc-output').textContent, /hello 🌍/);
    assert.match(f.$('#rc-output').textContent, /<warning>/); assert.equal(f.$('#rc-output warning'), null);
    assert.equal(f.$('#rc-connection').textContent, 'SSH connected'); assert.match(f.$('#rc-status-time').textContent, /Observed.*fresh/);
    assert.equal(f.calls[0].maxOutputBytes, 4194304); assert.equal(f.$('#rc-cancel').disabled, false);
    await f.click('#rc-cancel'); await new Promise(resolve => setTimeout(resolve, 300)); await f.settle();
    assert.match(f.$('#rc-output').textContent, /Cancelled/); assert.match(f.$('#rc-output').textContent, /termination is unconfirmed/);
    assert.equal(f.$('#rc-output').textContent.split('hello 🌍').length - 1, 1);
    assert.equal(f.$('#rc-connection').textContent, 'SSH connected'); assert.equal(f.calls.length, 1);
  } finally {f.win.dispatchEvent(new f.win.Event('pagehide')); f.dom.window.close();}
});

test('UI retains unsaved drafts and retries persistence after the flush barrier fails', async () => {
  const f = await fixture();
  try {
    f.store.flush = async () => {throw new Error('/private/sensitive-disk-path');};
    await f.type('#rc-editor', 'echo keep-my-draft');
    assert.match(f.$('#rc-persistence').textContent, /not persisted/);
    assert.equal(f.$('#rc-editor').value, 'echo keep-my-draft');
    assert.doesNotMatch(f.$('#rc-message').textContent, /sensitive-disk-path/);
    assert.equal(f.$('#rc-retry-save').hidden, false);
    f.store.flush = async () => {}; await f.click('#rc-retry-save');
    assert.match(f.$('#rc-persistence').textContent, /persisted by FDO/);
    assert.equal(f.$('#rc-retry-save').hidden, true);
    assert.equal(f.persisted.get('vm:dev').batches[0].draft, 'echo keep-my-draft');
  } finally {f.win.dispatchEvent(new f.win.Event('pagehide')); f.dom.window.close();}
});

test('shows and searches public SSH metadata, reviews the resolved destination and resets missing fields between VMs', async () => {
  const f = await fixture();
  try {
    assert.equal(f.$('#rc-vm-address').textContent, '[2001:db8::12]:2222');
    assert.equal(f.$('#rc-vm-user').textContent, 'ubuntu');
    assert.equal(f.$('#rc-vm-auth').textContent, 'Private key');
    assert.equal(f.$('#rc-vm-fingerprint').textContent, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    for (const query of ['2001:db8', 'ubuntu', '2222']) {
      await f.type('#rc-vm-search', query); assert.equal(f.win.document.querySelectorAll('#rc-vms button').length, 1);
    }
    await f.type('#rc-editor', 'uptime'); await f.click('#rc-run');
    assert.match(f.$('dialog .rc-review-target').textContent, /ubuntu@\[2001:db8::12\]:2222/);
    assert.match(f.$('dialog .rc-profile-trust').textContent, /Private key.*SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
    assert.equal(f.calls.length, 0); await f.action('Cancel');
    await f.type('#rc-vm-search', ''); await f.click('#rc-vms button:nth-child(2)');
    for (const id of ['rc-vm-address', 'rc-vm-user', 'rc-vm-auth', 'rc-vm-fingerprint']) assert.equal(f.$(`#${id}`).textContent, 'Not supplied by host');
    await f.click('#rc-vms button:first-child');
    f.profiles[0].username = 'deploy'; await f.click('#rc-refresh');
    assert.equal(f.$('#rc-vm-user').textContent, 'deploy'); assert.equal(f.calls.length, 0);
    assert.equal(JSON.stringify([...f.persisted.values()]).includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  } finally {f.dom.window.close();}
});

test('serialized iframe UI switches per-VM batch drafts instantly and restores them after reload', async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls.length, 0);
    await f.type('#rc-editor', 'cd /tmp\nexport TEST=kept\necho "$TEST"');
    f.$('#rc-batches').value = 'docker'; f.$('#rc-batches').dispatchEvent(new f.win.Event('change')); await f.settle();
    assert.match(f.$('#rc-editor').value, /docker inspect/);
    f.$('#rc-batches').value = 'health'; f.$('#rc-batches').dispatchEvent(new f.win.Event('change')); await f.settle();
    assert.match(f.$('#rc-editor').value, /export TEST=kept/);
    await f.click('#rc-vms button:nth-child(2)'); assert.match(f.$('#rc-editor').value, /uptime/);
    await f.type('#rc-editor', 'echo staging'); await f.click('#rc-vms button:first-child'); assert.match(f.$('#rc-editor').value, /export TEST=kept/);
    f.win.eval(renderRemoteCommandsOnLoad()); await f.settle();
    assert.match(f.$('#rc-editor').value, /export TEST=kept/); assert.equal(f.calls.length, 0);
    assert.equal(f.persisted.get('vm:stage').batches[0].draft, 'echo staging');
  } finally {f.dom.window.close();}
});

test('batch CRUD, literal replacement and cross-VM copies retain drafts', async () => {
  const f = await fixture();
  try {
    await f.click('#rc-new'); await f.type('dialog input[aria-label="Batch name"]', 'Custom'); await f.action('Save');
    await f.type('#rc-editor', 'echo apple\necho apple'); await f.type('#rc-find', 'apple'); await f.type('#rc-replace', 'pear'); await f.click('#rc-replace-all');
    assert.equal(f.$('#rc-editor').value, 'echo pear\necho pear');
    await f.click('#rc-save'); await f.click('#rc-rename'); await f.type('dialog input', 'Renamed'); await f.action('Save');
    await f.click('#rc-duplicate'); await f.action('Save'); assert.match(f.$('#rc-batches option:checked').textContent, /Renamed copy/);
    await f.click('#rc-copy-batch'); await f.action('Copy');
    assert.equal(f.persisted.get('vm:stage').batches.at(-1).draft, 'echo pear\necho pear');
    await f.click('#rc-delete-batch'); await f.action('Delete');
    assert.equal(f.persisted.get('vm:dev').batches.length, 4); assert.equal(f.calls.length, 0);
  } finally {f.dom.window.close();}
});

test('saved scripts support metadata, search, favorites, edit, reorder, insert, copy and deletion', async () => {
  const f = await fixture();
  const savedAction = async (label: string, index = 0) => {const b = [...f.win.document.querySelectorAll('#rc-saved article')][index]!.querySelectorAll('button'); [...b].find((n: any) => n.textContent === label)!.click(); await f.settle();};
  try {
    for (const [name, script] of [['Disk', 'df -h'], ['Memory', 'free -m']]) {
      await f.click('#rc-add-saved'); await f.type('dialog [aria-label="Name"]', name); await f.type('dialog [aria-label="Description (optional)"]', 'Important check'); await f.type('dialog [aria-label="Tags (comma separated)"]', 'linux, health'); await f.type('dialog textarea', script); await f.action('Save command');
    }
    await savedAction('Move down'); assert.equal(f.persisted.get('vm:dev').saved[0].name, 'Memory');
    await f.click('#rc-saved article button'); await f.click('#rc-favorites'); assert.equal(f.win.document.querySelectorAll('#rc-saved article').length, 1);
    await f.type('#rc-saved-search', 'linux'); assert.equal(f.win.document.querySelectorAll('#rc-saved article').length, 1);
    await savedAction('Edit'); await f.type('dialog [aria-label="Name"]', 'RAM'); await f.action('Save command');
    await savedAction('Copy to VM'); await f.action('Copy'); assert.equal(f.persisted.get('vm:stage').saved[0].name, 'RAM');
    await savedAction('Insert into editor'); assert.match(f.$('#rc-editor').value, /free -m/); assert.equal(f.calls.length, 0);
    await savedAction('Delete'); await f.action('Delete'); assert.equal(f.persisted.get('vm:dev').saved.length, 1);
  } finally {f.dom.window.close();}
});

test('selected text and saved Run require review; template edits invalidate approval and results are safe text', async () => {
  const f = await fixture();
  try {
    await f.type('#rc-editor', 'echo not-selected\necho {{service}}');
    const editor = f.$('#rc-editor'); editor.selectionStart = 'echo not-selected\n'.length; editor.selectionEnd = editor.value.length;
    await f.click('#rc-run-selected'); assert.equal(f.calls.length, 0);
    assert.ok(f.$('dialog button.rc-primary').disabled);
    await f.type('dialog [aria-label="Template service"]', 'nginx'); await f.action('Resolve commands');
    assert.equal(f.$('dialog pre').textContent, 'set -e; echo nginx');
    await f.type('dialog [aria-label="Template service"]', 'redis'); assert.ok(f.$('dialog button.rc-primary').disabled);
    await f.action('Resolve commands'); await f.action('Execute on VM');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].command, 'set -e; echo redis');
    await new Promise(resolve => setTimeout(resolve, 300)); await f.settle();
    assert.match(f.$('#rc-output').textContent, /Failed · exit 3/); assert.match(f.$('#rc-output').textContent, /TRUNCATED/);
    assert.match(f.$('#rc-output').textContent, /<output>/); assert.equal(f.$('#rc-output output'), null);
    await f.click('#rc-add-saved'); await f.type('dialog [aria-label="Name"]', 'Service'); await f.type('dialog textarea', 'echo saved'); await f.action('Save command');
    const before = editor.value;
    const run = [...f.win.document.querySelectorAll('#rc-saved button')].find((b: any) => b.textContent === '▶ Run') as any;
    run.click(); await f.settle(); assert.equal(f.calls.length, 1); assert.equal(editor.value, before);
    assert.equal(f.$('dialog pre').textContent, 'set -e; echo saved'); await f.action('Cancel');
    assert.equal(f.calls.length, 1);
  } finally {f.dom.window.close();}
});

test('terminal UI requires explicit connect, acknowledges only consumed bytes and routes password input to its fixed VM', async () => {
  const f = await fixture();
  const events = channel<any>(), result = deferred<any>(), opened: SSHTerminalOptions[] = [], writes: string[] = [], rendered: number[][] = [];
  let consume: (() => void) | undefined, keyboard: ((text: string) => void) | undefined, disposed = false, closes = 0;
  f.win.FDOTerminal = {create: () => ({write: (data: Uint8Array, done: () => void) => {rendered.push([...data]); consume = done;},
    onData: (fn: (text: string) => void) => {keyboard = fn; return {dispose() {}};}, onResize: () => ({dispose() {}}),
    getSize: () => ({rows: 30, columns: 90}), focus() {}, reset() {}, dispose() {disposed = true;}})};
  f.ssh.openTerminal = async options => {opened.push(options); return {output: events.iterator, result: result.promise,
    write: async text => {writes.push(text as string);}, resize: async () => {}, endInput: async () => {}, cancel: async () => ({remoteProcessStopped: null}),
    close: async () => {closes++; await events.close(); result.resolve({reason: 'closed', exitCode: null, signal: null, remoteProcessStopped: null});}};};
  const wait = async () => {await new Promise(resolve => setTimeout(resolve, 120)); await f.settle();};
  try {
    assert.equal(f.win.document.querySelectorAll('#rc-console').length, 1);
    assert.equal(f.$('#rc-batch-panel').hidden, false); assert.equal(f.$('#rc-terminal-panel').hidden, true);
    assert.equal(f.$('#rc-console').contains(f.$('#rc-output')), true);
    assert.equal(f.$('#rc-console').contains(f.$('#rc-terminal-screen')), true);
    await f.click('#rc-console-terminal'); assert.equal(opened.length, 0);
    f.$('#rc-terminal-x11').value = 'untrusted'; await f.click('#rc-terminal-open');
    assert.equal(opened.length, 0); assert.match(f.$('#rc-terminal-review-mode').textContent, /will not fall back/);
    await f.click('#rc-terminal-review-connect'); await wait();
    assert.equal(opened.length, 1); assert.deepEqual(opened[0].x11, {mode: 'untrusted'});
    assert.equal(f.$('#rc-batch-panel').hidden, true); assert.equal(f.$('#rc-terminal-panel').hidden, false);
    assert.equal(f.$('#rc-console-terminal').getAttribute('aria-pressed'), 'true');
    events.push({sequence: 0, data: Uint8Array.from([27, 91, 50, 74, 0xf0, 0x9f])});
    events.push({sequence: 1, data: Uint8Array.from([0x8c, 0x8d])}); await wait();
    assert.equal(rendered.length, 1); await wait(); assert.equal(rendered.length, 1, 'no next packet until consumed');
    consume!(); await wait(); assert.equal(rendered.length, 2); assert.deepEqual(rendered[1], [0x8c, 0x8d]); consume!();
    await f.click('#rc-vms button:nth-child(2)');
    assert.match(f.$('#rc-terminal-target').textContent, /dev-api-01/); assert.doesNotMatch(f.$('#rc-terminal-target').textContent, /staging/);
    keyboard!('sudo vim notes.txt\r'); keyboard!('test-secret-password\r'); await wait();
    assert.deepEqual(writes, ['sudo vim notes.txt\r', 'test-secret-password\r']);
    assert.equal(JSON.stringify([...f.persisted.values()]).includes('test-secret-password'), false);
    assert.doesNotMatch(f.$('#rc-terminal-screen').textContent, /test-secret-password/);
    await f.click('#rc-console-batch'); assert.equal(f.$('#rc-terminal-panel').hidden, true);
    keyboard!('ignored while hidden'); await wait(); assert.equal(writes.length, 2);
    assert.match(f.$('#rc-console-terminal').textContent, /active/);
    await f.type('#rc-editor', 'echo batch output'); await f.click('#rc-run'); await f.action('Execute on VM');
    await new Promise(resolve => setTimeout(resolve, 300)); await f.settle();
    assert.equal(f.$('#rc-batch-panel').hidden, false); assert.match(f.$('#rc-output').textContent, /Failed · exit 3/);
    assert.equal(opened.length, 1); assert.equal(disposed, false); assert.equal(closes, 0);
    await f.click('#rc-console-terminal'); assert.equal(f.$('#rc-batch-panel').hidden, true);
    assert.equal(rendered.length, 2, 'switching views preserves the same emulator output');
    await f.click('#rc-terminal-interrupt'); await wait(); assert.equal(writes.at(-1), '\x03');
    await f.click('#rc-terminal-cancel'); await wait(); assert.match(f.$('#rc-terminal-status').textContent, /unconfirmed/);
    await events.close(); result.reject({code: 'X11_AUTH_UNAVAILABLE'}); await wait();
    assert.match(f.$('#rc-terminal-status').textContent, /expired or revoked/);
    assert.equal(f.$('#rc-terminal-panel').hidden, false); assert.equal(f.$('#rc-batch-panel').hidden, true);
    assert.equal(f.$('#rc-terminal-open').disabled, false); assert.equal(rendered.length, 2);
    f.win.dispatchEvent(new f.win.Event('pagehide')); await f.settle(); assert.equal(disposed, true); assert.ok(closes >= 1);
  } finally {f.dom.window.close();}
});

test('terminal does not open without a renderer and shows unsupported X11 without silently downgrading', async () => {
  const f = await fixture(); let opens = 0;
  try {
    f.ssh.openTerminal = async () => {opens++; throw {code: 'X11_UNSUPPORTED'};};
    await f.click('#rc-terminal-open'); assert.equal(opens, 0); assert.match(f.$('#rc-terminal-status').textContent, /renderer/);
    f.win.FDOTerminal = {create: () => ({write() {}, onData: () => ({dispose() {}}), onResize: () => ({dispose() {}}), getSize: () => ({rows: 24, columns: 80}), focus() {}, reset() {}, dispose() {}})};
    f.$('#rc-terminal-x11').value = 'untrusted'; await f.click('#rc-terminal-open'); await f.click('#rc-terminal-review-connect');
    await new Promise(resolve => setTimeout(resolve, 200)); await f.settle();
    assert.equal(opens, 1); assert.match(f.$('#rc-terminal-status').textContent, /Untrusted forwarding requires/);
    assert.equal(f.$('#rc-terminal-x11').value, 'untrusted'); assert.equal(f.$('#rc-terminal-open').disabled, false);
  } finally {f.win.dispatchEvent(new f.win.Event('pagehide')); f.dom.window.close();}
});

test('interactive batch review routes the entire script to a fresh PTY, while output-only runs remain separate', async () => {
  const f = await fixture(), output = channel<any>(), result = deferred<any>(), writes: string[] = [];
  let opens = 0, key: ((text: string) => void) | undefined;
  const wait = async () => {await new Promise(resolve => setTimeout(resolve, 150)); await f.settle();};
  f.win.FDOTerminal = {create: () => ({write: (_: Uint8Array, consume: () => void) => consume(),
    onData: (fn: (text: string) => void) => {key = fn; return {dispose() {}};}, onResize: () => ({dispose() {}}), getSize: () => ({rows: 24, columns: 80}), focus() {}, reset() {}, dispose() {}})};
  f.ssh.openTerminal = async options => {assert.deepEqual(options.x11, {mode: 'untrusted'}); opens++; return {output: output.iterator, result: result.promise,
    write: async text => {writes.push(text as string);}, resize: async () => {}, endInput: async () => {}, cancel: async () => ({remoteProcessStopped: null}),
    close: async () => {await output.close(); result.resolve({reason: 'closed', exitCode: null, signal: null, remoteProcessStopped: null});}};};
  try {
    f.$('#rc-run-mode').value = 'terminal'; f.$('#rc-terminal-x11').value = 'untrusted';
    await f.type('#rc-editor', "cd /tmp\nexport TEST=ok\nnano notes.txt\nprintf '%s' \"$TEST\"");
    await f.click('#rc-run'); assert.equal(opens, 0); assert.equal(f.calls.length, 0);
    assert.match(f.$('#rc-dialog').textContent, /Interactive PTY/); assert.match(f.$('#rc-dialog').textContent, /up to 5 minutes/); assert.match(f.$('#rc-dialog').textContent, /output-only timeout and capture settings do not apply/);
    await f.action('Execute on VM'); await wait();
    assert.equal(opens, 1); assert.equal(f.calls.length, 0); assert.equal(writes.length, 1);
    assert.equal(f.$('#rc-terminal-panel').hidden, false); assert.equal(f.$('#rc-batch-panel').hidden, true);
    assert.match(writes[0], /^exec sh -c '/); assert.match(writes[0], /nano notes.txt\nprintf/);
    key!('\x18'); await wait(); assert.equal(writes.at(-1), '\x18');
    assert.match(f.$('#rc-terminal-target').textContent, /dev-api-01/);
    await f.click('#rc-terminal-close');
    f.$('#rc-run-mode').value = 'batch'; await f.click('#rc-run'); assert.match(f.$('#rc-dialog').textContent, /no keyboard input/);
    await f.action('Cancel');
  } finally {f.win.dispatchEvent(new f.win.Event('pagehide')); f.dom.window.close();}
});
