import {test} from "node:test";
import assert from "node:assert/strict";
import {createMonitoringPersistence, MONITORING_STORAGE_KEY} from "./monitoring";
import {createAvailabilityBackend} from "./backend";
import type {MonitoringRecord, DeploymentResult} from "./deployment";
import type {MonitoringPersistence} from "./monitoring";
import type {AvailabilitySnapshot} from "./logic";

const input = {itemId: "type", name: "gpu-vm", environment: "env", image: "Ubuntu", keypair: "key", publicIp: true, confirmCharges: true};
const snapshot = (available = false): AvailabilitySnapshot => ({checkedAt: "2026-11-02T10:00:00Z", items: [{id: "type", region: "A", flavor: "gpu-flavor", gpu: "GPU", availableCount: available ? 1 : 0, isAvailable: available, status: available ? "available" : "unavailable"}]});
const clone = <T,>(v: T): T => v === undefined ? v : JSON.parse(JSON.stringify(v));
function disk() {
  let value: unknown;
  const persistence: MonitoringPersistence = {load: async () => clone(value), save: async next => {value = clone(next);}};
  return {persistence, read: () => clone(value) as MonitoringRecord, write: (v: unknown) => {value = clone(v);}};
}
function backend(monitoring: MonitoringPersistence, create: () => Promise<DeploymentResult>, available = false) {
  return createAvailabilityBackend({monitoring,
    secrets: {get: async () => "backend-secret", set: async () => {}, delete: async () => true},
    service: {check: async () => ({ok: true, snapshot: snapshot(available)})},
    deploymentService: {create},
  });
}

test("waiting survives backend recreation, restores its configuration, and executes exactly once from fresh stock", async () => {
  const store = disk();
  let posts = 0;
  const create = async (): Promise<DeploymentResult> => {posts++; return {status: "submitted", vmId: 42, message: "Scheduled"};};
  const first = backend(store.persistence, create);
  await first.refresh();
  const armed = await first.armDeployment(input);
  assert.equal(store.read().state.status, "waiting");
  assert.equal(store.read().plan?.name, input.name);
  assert.doesNotMatch(JSON.stringify(store.read()), /backend-secret|confirmCharges/);
  const second = backend(store.persistence, create, true);
  const restored = await second.getConfiguration();
  assert.equal(restored.monitoring?.state.status, "waiting");
  assert.equal(restored.monitoring?.lastCheckedAt, snapshot().checkedAt);
  await second.refresh(); // A read without the restored monitoring ID cannot launch.
  assert.equal(posts, 0);
  await Promise.all([second.refresh({launchId: armed.deployment?.launchId}), second.refresh({launchId: armed.deployment?.launchId})]);
  assert.equal(posts, 1);
  assert.equal(store.read().state.status, "submitted");
  const third = backend(store.persistence, create, true);
  const completed = await third.getConfiguration();
  assert.equal(completed.monitoring?.state.vmId, 42);
  await third.refresh({launchId: armed.deployment?.launchId});
  assert.equal(posts, 1);
});

test("creation waits for a durable consumed marker, and interrupted creation is never retried", async () => {
  const store = disk();
  let release = () => {};
  let started = false;
  const service = backend(store.persistence, async () => {started = true; return new Promise(resolve => {release = () => resolve({status: "submitted", vmId: 42, message: "Created"});});}, true);
  await service.refresh();
  const armed = await service.armDeployment(input);
  const pending = service.refresh({launchId: armed.deployment?.launchId});
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(started, true);
  assert.equal(store.read().state.status, "creating");
  let duplicate = 0;
  const restarted = backend(store.persistence, async () => {duplicate++; return {status: "submitted", vmId: 43, message: "Created"};}, true);
  assert.equal((await restarted.getConfiguration()).monitoring?.state.status, "uncertain");
  await restarted.refresh({launchId: armed.deployment?.launchId});
  assert.equal(duplicate, 0);
  release();
  await pending;
});

test("failed checkpoint blocks VM requests and unknown/invalid stored records block arming", async () => {
  const store = disk();
  let fail = false;
  let posts = 0;
  const persistence: MonitoringPersistence = {load: store.persistence.load, save: async v => {
    if (fail) throw new Error("private-storage-error");
    await store.persistence.save(v);
  }};
  const instance = backend(persistence, async () => {posts++; return {status: "submitted", vmId: 42, message: "Created"};}, true);
  await instance.refresh();
  const armed = await instance.armDeployment(input);
  fail = true;
  await instance.refresh({launchId: armed.deployment?.launchId});
  assert.equal(posts, 0);
  for (const invalid of [{version: 99}, {version: 1, plan: {}, state: {status: "waiting", launchId: "x"}}]) {
    store.write(invalid);
    const broken = backend(store.persistence, async () => {posts++; return {status: "submitted", vmId: 42, message: "Created"};}, true);
    const result = await broken.getConfiguration();
    assert.equal(result.monitoring?.state.status, "failed");
    await broken.refresh();
    assert.equal((await broken.armDeployment(input)).deployment?.status, "failed");
  }
  assert.equal(posts, 0);
});

test("cancel and connection replacement persist disarming across restart", async () => {
  for (const action of ["cancel", "replace", "remove"]) {
    const store = disk();
    let posts = 0;
    const create = async (): Promise<DeploymentResult> => {posts++; return {status: "submitted", vmId: 42, message: "Created"};};
    const instance = backend(store.persistence, create);
    await instance.refresh();
    const armed = await instance.armDeployment(input);
    if (action === "cancel") await instance.cancelDeployment();
    if (action === "replace") await instance.saveConnection({apiKey: "replacement"});
    if (action === "remove") await instance.removeConnection();
    assert.equal(store.read().state.status, "cancelled");
    const restarted = backend(store.persistence, create, true);
    await restarted.refresh({launchId: armed.deployment?.launchId});
    assert.equal(posts, 0);
  }
});

test("SDK persistence adapter requires real persistence and waits for flush", async () => {
  let saved: unknown;
  let flushed = false;
  const value: MonitoringRecord = {version: 1, plan: null, state: {status: "idle", message: "Idle"}};
  const store = {
    get: <T,>() => saved as T, set: (_key: string, v: unknown) => {saved = v;},
    flush: async () => {flushed = true;}, capabilities: {persistent: true},
    remove: () => {}, clear: () => {}, has: () => false, keys: () => [],
  };
  const persistence = createMonitoringPersistence(() => store);
  await persistence.save(value);
  assert.equal(flushed, true);
  assert.deepEqual(await persistence.load(), value);
  assert.equal(MONITORING_STORAGE_KEY, "hyperstack.monitoring.v1");
  const memory = createMonitoringPersistence(() => ({...store, capabilities: {persistent: false}}));
  await assert.rejects(memory.load());
  await assert.rejects(memory.save(value));
});


test("VM submission waits for the checkpoint flush barrier", async () => {
  const store = disk();
  let release = () => {};
  let checkpointStarted = false;
  let posts = 0;
  const persistence: MonitoringPersistence = {load: store.persistence.load, save: async record => {
    if (record.state.status === "creating") {
      checkpointStarted = true;
      await new Promise<void>(resolve => {release = resolve;});
    }
    await store.persistence.save(record);
  }};
  const instance = backend(persistence, async () => {posts++; return {status: "submitted", vmId: 42, message: "Created"};}, true);
  await instance.refresh();
  const armed = await instance.armDeployment(input);
  const pending = instance.refresh({launchId: armed.deployment?.launchId});
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(checkpointStarted, true);
  assert.equal(posts, 0);
  release();
  await pending;
  assert.equal(posts, 1);
});

test("a failed terminal save retains the durable creating marker and restores as uncertain", async () => {
  const store = disk();
  const persistence: MonitoringPersistence = {load: store.persistence.load, save: async record => {
    if (record.state.status === "submitted") throw new Error("disk unavailable");
    await store.persistence.save(record);
  }};
  let posts = 0;
  const create = async (): Promise<DeploymentResult> => {posts++; return {status: "submitted", vmId: 42, message: "VM #42 submitted"};};
  const instance = backend(persistence, create, true);
  await instance.refresh();
  const armed = await instance.armDeployment(input);
  const result = await instance.refresh({launchId: armed.deployment?.launchId});
  assert.equal(result.monitoring?.state.vmId, 42);
  assert.equal(store.read().state.status, "creating");
  const restarted = backend(store.persistence, create, true);
  assert.equal((await restarted.getConfiguration()).monitoring?.state.status, "uncertain");
  await restarted.refresh({launchId: armed.deployment?.launchId});
  assert.equal(posts, 1);
});

test("explicit cancellation can clear invalid saved state after storage access recovers", async () => {
  const store = disk();
  store.write({version: 99});
  const instance = backend(store.persistence, async () => ({status: "submitted", vmId: 42, message: "Created"}));
  assert.equal((await instance.getConfiguration()).monitoring?.state.status, "failed");
  assert.equal((await instance.cancelDeployment()).deployment?.status, "cancelled");
  assert.equal(store.read().state.status, "cancelled");
  const restarted = backend(store.persistence, async () => ({status: "submitted", vmId: 42, message: "Created"}));
  assert.equal((await restarted.getConfiguration()).monitoring?.state.status, "cancelled");
});
