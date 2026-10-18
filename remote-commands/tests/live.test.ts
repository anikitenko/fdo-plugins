import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {SSHExecResult, SSHExecution, SSHOutputEvent, SSHConnectionStatus} from '@anikitenko/fdo-sdk';
import {createBackend} from '../backend.ts';
import {initialState, validateState} from '../model.ts';
import {describeStatus} from '../status.ts';
import {channel, deferred} from './fixtures.ts';

const tick = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
const result = (stdout = '', stderr = ''): SSHExecResult => ({stdout, stderr, exitCode: 0, signal: null, durationMs: 50, truncated: false});
function fixture() {
  const events = channel<SSHOutputEvent>(), status = channel<SSHConnectionStatus>(), terminal = deferred<SSHExecResult>();
  let cancels = 0;
  const starts: unknown[] = [];
  const ssh = {
    listProfiles: async () => [{id: 'vm', label: 'Fixture VM'}],
    watchStatus: () => status.iterator,
    start: async (options: unknown): Promise<SSHExecution> => {
      starts.push(options);
      return {events: events.iterator, result: terminal.promise, cancel: async () => {
        cancels++; await events.close(); terminal.reject({code: 'CANCELLED'}); return {remoteProcessStopped: null};
      }};
    },
  };
  let saved: unknown;
  const store = {get: <T>() => saved as T | undefined, set: (_: string, value: unknown) => {saved = value;}, remove() {}, clear() {}, has: () => !!saved, keys: () => [], flush: async () => {}};
  const backend = createBackend(ssh, () => store);
  return {backend, ssh, starts, events, status, terminal, store, cancels: () => cancels};
}
async function begin(f: ReturnType<typeof fixture>, maxOutputBytes = 1048576) {
  const review = await f.backend.prepare({profileId: 'vm', script: 'echo example', values: {}, stopOnError: true, timeout: 5, maxOutputBytes});
  const runId = crypto.randomUUID();
  const run = f.backend.run({token: review.token, viewId: 'view', runId});
  void run.catch(() => {}); await tick(); return {run, runId};
}

test('streams stdout and stderr before completion, applies the reviewed capture budget and never duplicates final output', async () => {
  const f = fixture(), {run, runId} = await begin(f, 262144);
  let done = false; void run.then(() => {done = true;});
  f.events.push({sequence: 0, stream: 'stdout', data: 'hello 🌍'}); f.events.push({sequence: 1, stream: 'stderr', data: '<warning>'}); await tick();
  const live = await f.backend.sync({viewId: 'view', runId});
  assert.equal(done, false); assert.equal(live.output?.stdout, 'hello 🌍'); assert.equal(live.output?.stderr, '<warning>');
  assert.deepEqual(f.starts, [{profileId: 'vm', command: 'set -e; echo example', timeoutMs: 5000, maxOutputBytes: 262144}]);
  f.terminal.resolve({...result('hello 🌍', '<warning>'), truncated: true}); await f.events.close();
  assert.equal((await run).result.truncated, true);
  const drained = await f.backend.sync({viewId: 'view', runId, stdoutOffset: live.output!.stdoutOffset, stderrOffset: live.output!.stderrOffset});
  assert.equal(drained.output?.stdout, ''); assert.equal(drained.output?.stderr, '');
  await f.backend.release({viewId: 'view'});
});

test('polling returns bounded output pages and isolates execution IDs between views', async () => {
  const f = fixture(), {run, runId} = await begin(f, 262144);
  f.events.push({sequence: 0, stream: 'stdout', data: 'x'.repeat(100000)}); await tick();
  const page = await f.backend.sync({viewId: 'view', runId}); assert.equal(page.output!.stdout.length, 32768);
  const next = await f.backend.sync({viewId: 'view', runId, stdoutOffset: page.output!.stdoutOffset}); assert.equal(next.output!.stdout.length, 32768);
  await assert.rejects(f.backend.sync({viewId: 'other', runId}), /another view/);
  await assert.rejects(f.backend.cancel({viewId: 'other', runId}), /this view/);
  f.terminal.resolve(result('x'.repeat(100000))); await f.events.close(); await run;
  await f.backend.release({viewId: 'view'}); await f.backend.release({viewId: 'other'});
});

test('cancel while start acknowledgement is pending cancels once and retains partial output without claiming remote termination', async () => {
  const f = fixture(), gate = deferred<SSHExecution>(), original = f.ssh.start;
  f.ssh.start = async options => {const handle = await original(options); await gate.promise; return handle;};
  const {run, runId} = await begin(f);
  assert.equal((await f.backend.cancel({viewId: 'view', runId})).cancellation, null);
  gate.resolve({events: f.events.iterator, result: f.terminal.promise, cancel: async () => ({remoteProcessStopped: null})});
  await assert.rejects(run, {code: 'CANCELLED'});
  await f.backend.cancel({viewId: 'view', runId});
  assert.equal(f.cancels(), 1);
  const ended = await f.backend.sync({viewId: 'view', runId});
  assert.deepEqual(ended.output!.cancellation, {remoteProcessStopped: null}); assert.equal(ended.output!.done, true);
  await f.backend.release({viewId: 'view'});
});

test('view teardown requests cancellation, ends status monitoring and never retries a started command', async () => {
  const f = fixture();
  await f.backend.sync({viewId: 'view', profileId: 'vm'}); await tick();
  f.status.push({profileId: 'vm', state: 'connected', checkedAt: new Date().toISOString(), staleAfterMs: 10000}); await tick();
  assert.equal((await f.backend.sync({viewId: 'view', profileId: 'vm'})).monitor!.observation!.state, 'connected');
  const {run} = await begin(f); await f.backend.release({viewId: 'view'});
  await assert.rejects(run, {code: 'CANCELLED'});
  assert.equal(f.cancels(), 1); assert.equal(f.starts.length, 1);
});

test('timeout preserves streamed output; unavailable live adapters fail without buffered fallback', async () => {
  const f = fixture(), {run, runId} = await begin(f);
  f.events.push({sequence: 0, stream: 'stdout', data: 'before timeout'}); await tick();
  f.terminal.reject({code: 'TIMEOUT'}); await f.events.close();
  await assert.rejects(run, (error: {code?: string; output?: {stdout: string}}) => error.code === 'TIMEOUT' && error.output?.stdout === 'before timeout');
  assert.equal((await f.backend.sync({viewId: 'view', runId})).output!.stdout, 'before timeout');
  f.ssh.start = async () => {throw {code: 'UNAVAILABLE'};};
  const second = await begin(f); await assert.rejects(second.run, {code: 'UNAVAILABLE'});
  assert.equal(f.starts.length, 1); await f.backend.release({viewId: 'view'});
});

test('status requires fresh authenticated observations and never stays connected after heartbeat loss or feed end', () => {
  const now = Date.now(), observation = {profileId: 'vm', state: 'connected' as const, checkedAt: new Date(now).toISOString(), staleAfterMs: 1000};
  const feed = {active: true, observation, error: ''};
  assert.equal(describeStatus(feed, now).label, 'SSH connected');
  assert.match(describeStatus(feed, now).detail, /Observed.*fresh/);
  assert.equal(describeStatus(feed, now + 1000).label, 'SSH status stale');
  assert.equal(describeStatus({...feed, active: false}, now).label, 'SSH status unknown');
  assert.equal(describeStatus(feed, now - 5000).label, 'SSH status unknown');
  assert.equal(describeStatus(null, now).label, 'SSH status unknown');
});

test('denied monitoring is explicit and does not execute a shell health probe', async () => {
  const f = fixture(); f.ssh.watchStatus = () => {throw {code: 'ACCESS_DENIED'};};
  await f.backend.sync({viewId: 'view', profileId: 'vm'}); await tick();
  const status = (await f.backend.sync({viewId: 'view', profileId: 'vm'})).monitor!;
  assert.equal(status.active, false); assert.match(status.error, /ssh.status.watch/); assert.equal(f.starts.length, 0);
  await f.backend.release({viewId: 'view'});
});

test('JSON saves require a flush acknowledgement, propagate failures and recover with the draft intact', async () => {
  const f = fixture(), state = initialState(); state.batches[0].draft = 'echo retained';
  f.store.flush = async () => {throw new Error('write failed');};
  await assert.rejects(f.backend.save({profileId: 'vm', state}), /write failed/);
  assert.equal((f.store.get() as typeof state).batches[0].draft, 'echo retained');
  f.store.flush = async () => {}; assert.deepEqual(await f.backend.save({profileId: 'vm', state}), {saved: true});
  const legacy = {...state}; delete (legacy as Partial<typeof state>).captureBytes;
  assert.equal(validateState(legacy).captureBytes, 1048576);
  assert.throws(() => validateState({...state, captureBytes: 0}), /Capture/);
  const {flush: _, ...withoutFlush} = f.store;
  await assert.rejects(createBackend(f.ssh, () => withoutFlush).save({profileId: 'vm', state}), /acknowledgement is unsupported/);
});

test('cancellation preserves affirmative, negative and unknown host termination evidence', async () => {
  for (const remoteProcessStopped of [true, false, null]) {
    const f = fixture(), original = f.ssh.start;
    f.ssh.start = async options => {const handle = await original(options); return {...handle, cancel: async () => {await handle.cancel(); return {remoteProcessStopped};}};};
    const {run, runId} = await begin(f);
    const ack = await f.backend.cancel({viewId: 'view', runId});
    assert.deepEqual(ack.cancellation, {remoteProcessStopped});
    await assert.rejects(run, {code: 'CANCELLED'});
    await f.backend.release({viewId: 'view'});
  }
});

test('cancellation after successful completion does not replace the completed execution result', async () => {
  const f = fixture(), original = f.ssh.start;
  f.ssh.start = async options => {const handle = await original(options); return {...handle, cancel: async () => ({remoteProcessStopped: null})};};
  const {run, runId} = await begin(f); f.terminal.resolve(result('finished')); await f.events.close();
  const completed = await run;
  await f.backend.cancel({viewId: 'view', runId});
  assert.equal(completed.result.exitCode, 0); assert.equal(completed.result.stdout, 'finished');
  assert.equal((await f.backend.sync({viewId: 'view', runId})).output!.done, true);
  await f.backend.release({viewId: 'view'});
});

test('start and cancel requests acknowledge immediately while execution and cancellation are pending', async () => {
  const f = fixture(), acknowledgement = deferred<{remoteProcessStopped: boolean | null}>();
  f.ssh.start = async options => {f.starts.push(options); return {events: f.events.iterator, result: f.terminal.promise, cancel: () => acknowledgement.promise};};
  const review = await f.backend.prepare({profileId: 'vm', script: 'echo live', values: {}, stopOnError: true, timeout: 5});
  const runId = crypto.randomUUID();
  assert.deepEqual(f.backend.start({token: review.token, viewId: 'view', runId}), {started: true});
  await tick(); f.events.push({sequence: 0, stream: 'stdout', data: 'partial'}); await tick();
  assert.equal(f.backend.requestCancel({viewId: 'view', runId}).requested, true);
  const progress = await f.backend.sync({viewId: 'view', runId});
  assert.equal(progress.output!.stdout, 'partial'); assert.equal(progress.output!.done, false);
  acknowledgement.resolve({remoteProcessStopped: true}); await tick();
  f.terminal.reject({code: 'CANCELLED'}); await f.events.close(); await tick();
  const ended = await f.backend.sync({viewId: 'view', runId, stdoutOffset: 7});
  assert.equal(ended.output!.stdout, ''); assert.equal(ended.output!.stdoutLength, 7);
  assert.equal(ended.output!.error!.code, 'CANCELLED'); assert.equal(ended.output!.done, true);
  assert.deepEqual(ended.output!.cancellation, {remoteProcessStopped: true});
  assert.equal(f.starts.length, 1); await f.backend.release({viewId: 'view'});
});
