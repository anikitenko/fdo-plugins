import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {SSHTerminalOutput, SSHTerminalResult, SSHTerminalSession, SSHTerminalOptions} from '@anikitenko/fdo-sdk';
import {createTerminalController} from '../terminal.ts';
import {channel, deferred} from './fixtures.ts';

const tick = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
function fixture() {
  const output = channel<SSHTerminalOutput>(), terminal = deferred<SSHTerminalResult>(), cancellation = deferred<{remoteProcessStopped: boolean | null}>();
  const writes: string[] = [], resizes: number[][] = [], opens: SSHTerminalOptions[] = [];
  let closes = 0, cancels = 0;
  const session: SSHTerminalSession = {output: output.iterator, result: terminal.promise,
    write: async text => {writes.push(text as string);}, resize: async (rows, columns) => {resizes.push([rows, columns]);},
    endInput: async () => {}, close: async () => {closes++; await output.close(); terminal.resolve({reason: 'closed', exitCode: null, signal: null, remoteProcessStopped: null});},
    cancel: async () => {cancels++; return cancellation.promise;}};
  const ssh = {openTerminal: async (options: SSHTerminalOptions, _signal?: AbortSignal) => {opens.push(options); return session;}};
  const profile = {id: 'vm', host: 'vm.example', port: 22, username: 'user', authenticationType: 'privateKey', trustedHostKey: 'SHA256:fixture'};
  const controller = createTerminalController(ssh, async () => ({...profile}));
  const open = (mode = 'off') => controller.terminalOpen({viewId: 'view', profileId: 'vm', mode, rows: 24, columns: 80});
  return {controller, profile, session, ssh, output, terminal, cancellation, writes, resizes, opens, open, closes: () => closes, cancels: () => cancels};
}

test('terminal output holds a single raw packet until emulator acknowledgement, including split UTF-8 and ANSI', async () => {
  const f = fixture(), {id} = f.open(); await tick();
  const first = Uint8Array.from([27, 91, 50, 74, 0xf0, 0x9f]), second = Uint8Array.from([0x8c, 0x8d]);
  f.output.push({sequence: 0, data: first}); f.output.push({sequence: 1, data: second}); await tick();
  const request = {viewId: 'view', id, ack: -1};
  assert.deepEqual(f.controller.terminalPoll(request).packet, {sequence: 0, bytes: [...first]});
  assert.deepEqual(f.controller.terminalPoll(request).packet, {sequence: 0, bytes: [...first]});
  assert.throws(() => f.controller.terminalPoll({...request, ack: 1}), /ahead/);
  f.controller.terminalPoll({...request, ack: 0}); await tick();
  assert.deepEqual(f.controller.terminalPoll({...request, ack: 0}).packet, {sequence: 1, bytes: [...second]});
  f.terminal.resolve({reason: 'exited', exitCode: 3, signal: null, remoteProcessStopped: true}); await f.output.close(); await tick();
  assert.equal(f.controller.terminalPoll({...request, ack: 0}).done, false);
  f.controller.terminalPoll({...request, ack: 1}); await tick();
  const done = f.controller.terminalPoll({...request, ack: 1});
  assert.equal(done.done, true); assert.equal(done.result!.exitCode, 3); assert.equal(done.packet, null);
  f.controller.terminalClose(request);
});

test('terminal input uses stdin once with no local echo or persistence, resize is separate, and view ownership is enforced', async () => {
  const f = fixture(), {id} = f.open(); await tick(); const request = {viewId: 'view', id};
  await f.controller.terminalInput({...request, text: 'sudo command\r'});
  await f.controller.terminalInput({...request, text: 'test-password\r'});
  await f.controller.terminalInput({...request, text: '\x03'});
  await f.controller.terminalResize({...request, rows: 40, columns: 100});
  assert.deepEqual(f.writes, ['sudo command\r', 'test-password\r', '\x03']); assert.deepEqual(f.resizes, [[40, 100]]);
  assert.equal(JSON.stringify(f.controller.terminalPoll({...request, ack: -1})).includes('test-password'), false);
  await assert.rejects(f.controller.terminalInput({...request, text: '🌍'.repeat(9000)}), /too large/);
  await assert.rejects(f.controller.terminalResize({...request, rows: 0, columns: 80}), /dimensions/);
  assert.throws(() => f.controller.terminalPoll({...request, viewId: 'other', ack: -1}), /this view/);
  assert.throws(() => f.open(), /Close the current/); f.controller.terminalClose(request); await tick();
});

test('terminal cancellation returns promptly, preserves host evidence and close releases without claiming termination', async () => {
  const f = fixture(), {id} = f.open(); await tick(); const request = {viewId: 'view', id};
  assert.deepEqual(f.controller.terminalCancel(request), {requested: true}); f.controller.terminalCancel(request);
  assert.equal(f.cancels(), 1); assert.equal(f.controller.terminalPoll({...request, ack: -1}).cancellation, undefined);
  f.cancellation.resolve({remoteProcessStopped: false}); await tick();
  assert.deepEqual(f.controller.terminalPoll({...request, ack: -1}).cancellation, {remoteProcessStopped: false});
  f.controller.terminalClose(request); await tick(); assert.ok(f.closes() >= 1);
});

test('X11 modes pass through exactly, denied untrusted mode never opens a trusted fallback and errors are safe', async () => {
  for (const mode of ['off', 'trusted', 'untrusted']) {
    const f = fixture(); f.ssh.openTerminal = async options => {f.opens.push(options); throw {code: 'X11_UNSUPPORTED', message: '/private/xauth-cookie-secret'};};
    const {id} = f.open(mode); await tick();
    const state = f.controller.terminalPoll({viewId: 'view', id, ack: -1});
    assert.equal(f.opens.length, 1); assert.deepEqual(f.opens[0].x11, mode === 'off' ? undefined : {mode});
    assert.equal(state.error!.code, 'X11_UNSUPPORTED'); assert.doesNotMatch(state.error!.message, /private|secret/);
    assert.equal(state.done, true); f.controller.terminalClose({viewId: 'view', id});
  }
});

test('X11 negotiation denial identifies server checks without blaming consent or leaking provider details', async () => {
  for (const mode of ['trusted', 'untrusted']) {
    const f = fixture();
    f.ssh.openTerminal = async options => {f.opens.push(options); throw {code: 'X11_FORWARDING_DENIED', message: '/private/xauth-cookie-secret'};};
    const {id} = f.open(mode); await tick();
    const state = f.controller.terminalPoll({viewId: 'view', id, ack: -1});
    assert.equal(state.error!.code, 'X11_FORWARDING_DENIED');
    const message = state.error!.message;
    assert.match(message, /after host consent and local X11 preflight checks/);
    assert.match(message, /PTY allocation or shell startup/);
    assert.match(message, /remote SSH server logs/);
    assert.ok(message.includes(`Requested X11 mode: ${mode}`));
    assert.doesNotMatch(message, /profile consent|private|secret/);
    assert.equal(f.opens.length, 1);
    assert.deepEqual(f.opens[0].x11, {mode});
    assert.equal(state.done, true);
    f.controller.terminalClose({viewId: 'view', id});
  }
});

test('recent terminal-only success narrows X11 denial for the same view and unchanged profile', async () => {
  for (const mode of ['trusted', 'untrusted']) {
    const f = fixture(), opened = f.open('off'); await tick();
    assert.equal(f.controller.terminalPoll({viewId: 'view', id: opened.id, ack: -1}).ready, true);
    f.controller.terminalClose({viewId: 'view', id: opened.id}); await tick();
    f.ssh.openTerminal = async options => {f.opens.push(options); throw {code: 'X11_FORWARDING_DENIED', message: '/private/cookie-secret'};};
    const {id} = f.open(mode); await tick();
    const message = f.controller.terminalPoll({viewId: 'view', id, ack: -1}).error!.message;
    assert.match(message, /^The remote server rejected X11 forwarding\./);
    assert.match(message, /This profile works with X11 off, and local X11 checks passed/);
    assert.match(message, /xauth.*no-X11-forwarding or restrict/);
    assert.ok(message.includes(`Requested X11 mode: ${mode}`));
    assert.doesNotMatch(message, /PTY allocation|private|secret/);
    assert.equal(f.opens.length, 2, 'only the two explicitly requested sessions were opened');
    assert.deepEqual(f.opens[1].x11, {mode});
    f.controller.terminalClose({viewId: 'view', id});
  }
});

test('terminal-only diagnostic evidence expires and cannot cross profiles, endpoints or views', async () => {
  const originalNow = Date.now;
  try {
    for (const scenario of ['host', 'port', 'username', 'authenticationType', 'trustedHostKey', 'profileId', 'viewId', 'release', 'expiry', 'failed-off']) {
      const f = fixture(), opened = f.open('off'); await tick();
      f.controller.terminalClose({viewId: 'view', id: opened.id}); await tick();
      if (scenario === 'host') f.profile.host = 'other.example';
      if (scenario === 'port') f.profile.port = 2222;
      if (scenario === 'username') f.profile.username = 'other';
      if (scenario === 'authenticationType') f.profile.authenticationType = 'password';
      if (scenario === 'trustedHostKey') f.profile.trustedHostKey = 'SHA256:other';
      if (scenario === 'release') f.controller.terminalRelease({viewId: 'view'});
      if (scenario === 'expiry') Date.now = () => originalNow() + 300001;
      f.ssh.openTerminal = async () => {throw {code: 'X11_FORWARDING_DENIED'};};
      if (scenario === 'failed-off') {
        const failed = f.open('off'); await tick(); f.controller.terminalClose({viewId: 'view', id: failed.id});
      }
      const viewId = scenario === 'viewId' ? 'other' : 'view';
      const {id} = f.controller.terminalOpen({viewId, profileId: scenario === 'profileId' ? 'other' : 'vm', mode: 'untrusted', rows: 24, columns: 80}); await tick();
      const message = f.controller.terminalPoll({viewId, id, ack: -1}).error!.message;
      assert.doesNotMatch(message, /This profile works with X11 off/, scenario);
      assert.match(message, /PTY allocation or shell startup/, scenario);
      f.controller.terminalClose({viewId, id}); f.controller.terminalRelease({viewId: 'view'});
      Date.now = originalNow;
    }
  } finally {Date.now = originalNow;}
});

test('released pending opens close late sessions and changed destination details prevent SSH opening', async () => {
  const f = fixture(), opening = deferred<SSHTerminalSession>(); let signal: AbortSignal | undefined;
  f.ssh.openTerminal = async (_options, abort) => {signal = abort; return opening.promise;};
  f.open(); await tick(); f.controller.terminalRelease({viewId: 'view'}); assert.equal(signal!.aborted, true);
  opening.resolve(f.session); await tick(); assert.ok(f.closes() >= 1);
  const other = fixture();
  const {id} = other.controller.terminalOpen({viewId: 'view', profileId: 'vm', expectedProfile: {host: 'stale'}, mode: 'off', rows: 24, columns: 80});
  await tick(); assert.equal(other.opens.length, 0);
  assert.equal(other.controller.terminalPoll({viewId: 'view', id, ack: -1}).error!.code, 'INVALID_REQUEST');
  other.controller.terminalClose({viewId: 'view', id});
});

test('terminal access denials include the requested X11 mode without pretending to know the host failed check', async () => {
  for (const mode of ['off', 'trusted', 'untrusted']) {
    const f = fixture(); f.ssh.openTerminal = async () => {throw {code: 'ACCESS_DENIED'};};
    const {id} = f.open(mode); await tick();
    const message = f.controller.terminalPoll({viewId: 'view', id, ack: -1}).error!.message;
    assert.ok(message.includes(`Requested X11 mode: ${mode}`)); assert.match(message, /secrets.consume/);
    if (mode !== 'off') assert.match(message, /consents are distinct/);
    f.controller.terminalClose({viewId: 'view', id});
  }
});
