import {test} from "node:test";
import assert from "node:assert/strict";
import {createAvailabilityRuntime} from "./runtime";
import type {RuntimeClock} from "./runtime";
import {createRefreshPreferences} from "./monitoring";
import type {MonitoringRecord} from "./deployment";
import type {AvailabilityServiceResult} from "./service";

const clone = <T,>(v: T): T => v === undefined ? v : JSON.parse(JSON.stringify(v));
async function settle() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function clock() {
  const timers = new Map<number, {callback: () => void; ms: number}>();
  let id = 0;
  let now = 0;
  const api: RuntimeClock = {now: () => now, setTimeout(callback, ms) {timers.set(++id, {callback, ms}); return id;}, clearTimeout: timer => {timers.delete(timer as number);}};
  return {api, timers, fire() {
    assert.equal(timers.size, 1);
    const [key, entry] = [...timers][0];
    timers.delete(key); now += entry.ms; entry.callback();
  }, advance(ms: number) {now += ms;}};
}
const input = {itemId: "type", name: "gpu-vm", environment: "env", image: "Ubuntu", keypair: "key", publicIp: false, confirmCharges: true};
function storage() {
  let monitoring: unknown;
  let seconds: unknown = 0;
  return {
    monitoring: {load: async () => clone(monitoring), save: async (v: MonitoringRecord) => {monitoring = clone(v);}},
    preferences: {load: async () => seconds, save: async (v: number) => {seconds = v;}},
    read: () => monitoring as MonitoringRecord,
    seconds: () => seconds,
    interval: (v: unknown) => {seconds = v;},
  };
}
function fixture(disk = storage()) {
  const time = clock();
  let checks = 0;
  let posts = 0;
  let catalogs = 0;
  let available = false;
  let credential = "secret";
  let checkOverride: (() => Promise<AvailabilityServiceResult>) | undefined;
  const runtime = createAvailabilityRuntime({clock: time.api, preferences: disk.preferences, monitoring: disk.monitoring,
    secrets: {get: async () => credential, set: async (_key, value) => {credential = value;}, delete: async () => {credential = ""; return true;}},
    service: {check: async () => {
      checks++;
      if (checkOverride) return checkOverride();
      return {ok: true, snapshot: {checkedAt: new Date(checks * 1000).toISOString(), items: [{id: "type", region: "A", gpu: "GPU", flavor: "flavor", availableCount: available ? 1 : 0, isAvailable: available, status: available ? "available" : "unavailable"}]}};
    }},
    catalogService: {load: async () => {catalogs++; return {ok: true, catalog: {environments: [{name: "env", region: "A"}], images: [{name: "Ubuntu", region: "A"}], keypairs: [{name: "key", environment: "env"}]}};}},
    deploymentService: {create: async () => {assert.equal(disk.read().state.status, "creating"); posts++; return {status: "submitted", vmId: 42, message: "VM #42 scheduled"};}},
  });
  return {runtime, time, disk, checks: () => checks, posts: () => posts, catalogs: () => catalogs,
    available: (v: boolean) => {available = v;}, check: (v: () => Promise<AvailabilityServiceResult>) => {checkOverride = v;}};
}

test("one backend scheduler restores and persists automatic refresh independently of page reads", async t => {
  const f = fixture();
  f.disk.interval(300);
  t.after(() => f.runtime.dispose());
  await f.runtime.start();
  assert.equal(f.checks(), 1);
  for (let i = 0; i < 20; i++) {f.runtime.getState(); await f.runtime.getConfiguration();}
  assert.equal(f.checks(), 1);
  assert.equal([...f.time.timers.values()][0].ms, 300_000);
  await f.runtime.setPolling({seconds: 600});
  assert.equal(f.disk.seconds(), 600);
  assert.equal([...f.time.timers.values()][0].ms, 600_000);
  f.time.fire(); await settle();
  assert.equal(f.checks(), 2);
  f.runtime.dispose();
  const next = fixture(f.disk);
  t.after(() => next.runtime.dispose());
  await next.runtime.start();
  assert.equal(next.runtime.getState().pollingSeconds, 600);
  assert.equal([...next.time.timers.values()][0].ms, 600_000);
  await next.runtime.setPolling({seconds: 0});
  assert.equal(next.time.timers.size, 0);
  next.runtime.dispose();
  const manual = fixture(f.disk);
  t.after(() => manual.runtime.dispose());
  await manual.runtime.start();
  assert.equal(manual.runtime.getState().pollingSeconds, 0);
  assert.equal(manual.time.timers.size, 0);
});

test("armed monitoring checks every minute without browser clients, then stops after one creation", async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.start();
  await f.runtime.deploymentOptions();
  assert.equal((await f.runtime.armDeployment(input)).deployment?.status, "waiting");
  await settle();
  assert.equal(f.posts(), 0);
  assert.equal([...f.time.timers.values()][0].ms, 60_000);
  // No frontend timer or launch ID participates in this check.
  f.available(true);
  f.time.fire(); await settle();
  assert.equal(f.posts(), 1);
  assert.equal(f.runtime.getState().deployment?.status, "submitted");
  assert.equal(f.time.timers.size, 0);
  await f.runtime.refresh();
  assert.equal(f.posts(), 1);
});

test("saved waiting resumes on backend startup without opening a page", async t => {
  const first = fixture();
  await first.runtime.start(); await first.runtime.deploymentOptions();
  await first.runtime.armDeployment(input); await settle();
  first.runtime.dispose();
  const next = fixture(first.disk);
  next.available(true);
  t.after(() => next.runtime.dispose());
  await next.runtime.start();
  assert.equal(next.posts(), 1);
  assert.equal(next.runtime.getState().monitoring?.state.status, "submitted");
});

test("concurrent refreshes coalesce while state reads immediately retain cached results", async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.start();
  const old = f.runtime.getState().snapshot;
  let finish: (v: AvailabilityServiceResult) => void = () => {};
  f.check(() => new Promise(resolve => {finish = resolve;}));
  const first = f.runtime.refresh();
  const second = f.runtime.refresh();
  await settle();
  assert.equal(f.checks(), 2);
  assert.equal(f.runtime.getState().snapshot, old);
  assert.equal(f.runtime.getState().refreshing, true);
  finish({ok: false, error: {code: "network_error", message: "private-provider-detail", retryable: true}});
  await Promise.all([first, second]);
  assert.equal(f.runtime.getState().snapshot, old);
  assert.equal(f.runtime.getState().error?.code, "network_error");
  assert.doesNotMatch(JSON.stringify(f.runtime.getState()), /private-provider-detail|secret/);
  assert.equal(f.runtime.getState().refreshing, false);
});

test("catalog reads share a cache across pages and explicit reload bypasses it", async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.start();
  await Promise.all([f.runtime.deploymentOptions(), f.runtime.deploymentOptions()]);
  await f.runtime.deploymentOptions();
  assert.equal(f.catalogs(), 1);
  await f.runtime.deploymentOptions({force: true});
  assert.equal(f.catalogs(), 2);
  f.time.advance(300_001);
  await f.runtime.deploymentOptions();
  assert.equal(f.catalogs(), 3);
  await f.runtime.removeConnection();
  assert.equal(f.runtime.getState().snapshot, null);
  assert.equal(f.runtime.getState().configuration.configured, false);
});

test("unsupported or unwritable refresh preferences do not replace the saved interval", async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  f.disk.interval(300);
  await f.runtime.start();
  assert.equal((await f.runtime.setPolling({seconds: 10})).ok, false);
  assert.equal(f.disk.seconds(), 300);
  f.disk.preferences.save = async () => {throw new Error("private-storage-error");};
  const result = await f.runtime.setPolling({seconds: 600});
  assert.equal(result.ok, false);
  assert.equal(f.runtime.getState().pollingSeconds, 300);
  assert.doesNotMatch(JSON.stringify(result), /private-storage/);
});

test("disposal stops even an already queued scheduler callback", async () => {
  const f = fixture();
  f.disk.interval(60);
  await f.runtime.start();
  const callback = [...f.time.timers.values()][0].callback;
  f.runtime.dispose();
  callback(); await settle();
  assert.equal(f.checks(), 1);
  assert.equal(f.time.timers.size, 0);
});

test("SDK refresh preference uses a separate persistent key and flushes before acknowledgement", async () => {
  const data = new Map<string, unknown>();
  let flushed = 0;
  const store = {get: <T,>(key: string) => data.get(key) as T | undefined, set: (key: string, value: unknown) => {data.set(key, value);}, flush: async () => {flushed++;}, capabilities: {persistent: true}, remove: () => {}, clear: () => {}, has: () => false, keys: () => []};
  const prefs = createRefreshPreferences(() => store);
  await prefs.save(600);
  assert.equal(flushed, 1);
  assert.equal(await createRefreshPreferences(() => store).load(), 600);
  assert.equal(data.has("hyperstack.monitoring.v1"), false);
  await prefs.save(0);
  assert.equal(await prefs.load(), 0);
  await assert.rejects(createRefreshPreferences(() => ({...store, capabilities: {persistent: false}})).save(60));
});


test("a refresh preference read failure remains visible after a successful stock check and can be repaired", async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  f.disk.preferences.load = async () => {throw new Error("private-storage-detail");};
  await f.runtime.start();
  assert.equal(f.runtime.getState().snapshot?.items.length, 1);
  assert.equal(f.runtime.getState().error?.code, "refresh_settings_unavailable");
  assert.doesNotMatch(JSON.stringify(f.runtime.getState()), /private-storage/);
  assert.equal((await f.runtime.setPolling({seconds: 300})).ok, true);
  assert.equal(f.runtime.getState().error, null);
  assert.equal([...f.time.timers.values()][0].ms, 300_000);
});
