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
  const profiles = [{id: 'dev', label: 'dev-api-01'}, {id: 'stage', label: 'staging-01'}];
  const ssh = {listProfiles: async () => profiles, exec: async (options: any) => {calls.push(options); return {stdout: '<output>\n', stderr: 'diagnostic\n', exitCode: 3, signal: null, durationMs: 27, truncated: true};}};
  const backend = createBackend(ssh, () => store);
  const dom = new JSDOM(`<!doctype html><html><body>${renderRemoteCommands()}</body></html>`, {runScripts: 'outside-only', url: 'http://localhost/'});
  const win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function() {this.open = true;};
  win.HTMLDialogElement.prototype.close = function() {this.open = false;};
  win.createBackendReq = async (type: string, payload: any) => {
    if (type === 'requestPrivilegedAction') return {ok: true};
    const name = payload.handler.replace('remote-commands.', '');
    if (name === 'copy') return {action: 'system.clipboard.write', payload: {text: payload.content.text}};
    try {return structuredClone({ok: true, data: await (backend as any)[name](payload.content)});} catch (e) {return {ok: false, error: serviceMessage(e)};}
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
  return {dom, win, $, settle, click, type, action, calls, persisted, backend};
}

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

