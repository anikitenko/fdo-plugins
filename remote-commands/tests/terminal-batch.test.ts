import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import type {SSHTerminalOptions, SSHTerminalOutput, SSHTerminalResult} from '@anikitenko/fdo-sdk';
import {terminalLaunch} from '../terminal-launch.ts';
import {createBackend} from '../backend.ts';
import {serviceMessage} from '../model.ts';
import {channel, deferred} from './fixtures.ts';

const tick = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
function fixture() {
  const output = channel<SSHTerminalOutput>(), result = deferred<SSHTerminalResult>(), writes: string[] = [];
  let starts = 0, terminals = 0;
  const opened: SSHTerminalOptions[] = [];
  const ssh = {listProfiles: async () => [{id: 'vm', label: 'VM', host: 'vm.example', username: 'user'}], watchStatus: () => channel<any>().iterator,
    start: async () => {starts++; throw {code: 'ACCESS_DENIED'};}, openTerminal: async (options: SSHTerminalOptions) => {opened.push(options); terminals++; return {
      output: output.iterator, result: result.promise, write: async (text: string | Uint8Array) => {writes.push(text as string);}, resize: async () => {}, endInput: async () => {},
      cancel: async () => ({remoteProcessStopped: null}), close: async () => {await output.close(); result.resolve({reason: 'closed', exitCode: null, signal: null, remoteProcessStopped: null});},
    };}};
  const backend = createBackend(ssh, () => {throw new Error('No storage needed.');});
  const prepare = (executionMode = 'terminal', x11Mode = 'off') => backend.prepare({profileId: 'vm', script: 'nano notes.txt\nprintf done', stopOnError: true, timeout: 5, values: {}, executionMode, x11Mode});
  return {backend, ssh, writes, opened, prepare, terminals: () => terminals, starts: () => starts};
}

test('terminal launch preserves quotes, multiline shell state and independent stdin for interactive commands', () => {
  const script = "cd /\nexport CHECK=kept\nprintf '%s\\n' \"quote's $CHECK\"\nread answer\nprintf 'after:%s:%s' \"$PWD\" \"$answer\"";
  const output = execFileSync('/bin/sh', ['-c', terminalLaunch(script)], {input: 'keyboard input\n', encoding: 'utf8'});
  assert.equal(output, "quote's kept\nafter:/:keyboard input");
  assert.throws(() => terminalLaunch('x'.repeat(3000)), /3000-byte/);
  assert.throws(() => terminalLaunch('echo ok\x03echo bad'), /control characters/);
});

test('interactive review opens a fresh PTY, launches exactly the reviewed script once and cannot use output-only execution', async () => {
  const f = fixture(), review = await f.prepare('terminal', 'untrusted');
  assert.equal(f.terminals(), 0); await assert.rejects(f.backend.run({token: review.token, viewId: 'view', runId: 'run'}), /interactive terminal/);
  const {id} = f.backend.terminalStart({token: review.token, viewId: 'view', rows: 24, columns: 80, command: 'ignored', profileId: 'ignored', mode: 'trusted'});
  await tick(); assert.equal(f.terminals(), 1); assert.equal(f.starts(), 0);
  assert.deepEqual(f.opened[0].x11, {mode: 'untrusted'}, 'execution cannot replace the reviewed X11 mode');
  assert.deepEqual(f.writes, [terminalLaunch('set -e; nano notes.txt\nprintf done')]);
  await f.backend.terminalInput({viewId: 'view', id, text: '\x18'}); assert.equal(f.writes.at(-1), '\x18');
  assert.throws(() => f.backend.terminalStart({token: review.token, viewId: 'view', rows: 24, columns: 80}), /Review/);
  f.backend.terminalClose({viewId: 'view', id}); await tick();
});

test('output-only tokens cannot open PTYs and failed batch authorization never retries as an interactive shell', async () => {
  const f = fixture(), review = await f.prepare('batch');
  assert.throws(() => f.backend.terminalStart({token: review.token, viewId: 'view', rows: 24, columns: 80}), /Review/);
  await assert.rejects(f.backend.run({token: review.token, viewId: 'view', runId: 'run'}), /entire resolved script/);
  assert.equal(f.starts(), 1); assert.equal(f.terminals(), 0); await f.backend.release({viewId: 'view'});
});

test('denied permissions identify profile command policy, interactive consent, monitoring and X11 independently', () => {
  assert.match(serviceMessage({code: 'ACCESS_DENIED'}, 'batch'), /including set -e/);
  assert.match(serviceMessage({code: 'ACCESS_DENIED'}, 'terminal'), /Interactive terminal access/);
  assert.match(serviceMessage({code: 'ACCESS_DENIED'}, 'terminal'), /exact-mode profile consent/);
  assert.match(serviceMessage({code: 'ACCESS_DENIED'}, 'status'), /terminal-only profile/);
});
