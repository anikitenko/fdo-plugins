import {test} from "node:test";
import assert from "node:assert/strict";
import {createRestorationQueue} from "./restoration-queue";
import {createAvailabilityRuntime} from "./runtime";
import type {AvailabilityItem, AvailabilitySnapshot} from "./logic";
import type {MonitoringRecord, RestorationPlan, DeploymentService} from "./deployment";

const plans: RestorationPlan[] = [1, 2, 3].map(id => ({restoreVmId: id, name: `VM ${id}`, region: "A", flavor: `flavor-${id}`, itemId: `item-${id}`}));
const stock = (available: number[], same = false): AvailabilitySnapshot => ({checkedAt: new Date().toISOString(), items: plans.map((p, i): AvailabilityItem => ({id: same ? plans[0].itemId : p.itemId, region: p.region, flavor: same ? plans[0].flavor : p.flavor, gpu: "GPU", availableCount: null, isAvailable: available.includes(i + 1), status: available.includes(i + 1) ? "available" : "unavailable"}))});

test("restore queue skips unavailable entries, restores any ready configuration, and retains the rest", async () => {
  const calls: number[] = [];
  const queue = createRestorationQueue({create: async (_key, plan) => {
    assert.ok("restoreVmId" in plan);
    calls.push(plan.restoreVmId);
    return {status: "submitted", vmId: plan.restoreVmId, message: "Scheduled"};
  }});
  queue.add(plans);
  queue.add(plans);
  await queue.onSnapshot("secret", stock([2]), async () => {});
  assert.deepEqual(calls, [2]);
  assert.deepEqual(queue.entries().map(e => e.state.status), ["waiting", "submitted", "waiting"]);
  await queue.onSnapshot("secret", stock([1, 3]), async () => {});
  await queue.onSnapshot("secret", stock([1, 2, 3]), async () => {});
  assert.deepEqual(calls, [2, 1, 3]);
});

test("VMs sharing a configuration require separate fresh snapshots", async () => {
  let calls = 0;
  const queue = createRestorationQueue({create: async () => {calls++; return {status: "submitted", vmId: calls, message: "Scheduled"};}});
  queue.add(plans.map(p => ({...p, flavor: plans[0].flavor, itemId: plans[0].itemId})));
  const snapshot = stock([1]);
  await queue.onSnapshot("secret", snapshot, async () => {});
  assert.equal(calls, 1);
  assert.equal(queue.entries().filter(e => e.state.status === "waiting").length, 2);
  await queue.onSnapshot("secret", snapshot, async () => {});
  assert.equal(calls, 2);
});

test("one uncertain or rejected VM does not block other queued configurations", async () => {
  const queue = createRestorationQueue({create: async (_key, p) => {
    if (p.name === plans[0].name) throw new Error("private-provider-details");
    return {status: p.name === plans[1].name ? "failed" : "submitted", vmId: 3, message: "Result"};
  }});
  queue.add(plans);
  await queue.onSnapshot("secret", stock([1, 2, 3]), async () => {});
  assert.deepEqual(queue.entries().map(e => e.state.status), ["uncertain", "failed", "submitted"]);
  assert.doesNotMatch(JSON.stringify(queue.entries()), /private-provider-details/);
  queue.add([plans[0], plans[2]]);
  assert.deepEqual(queue.entries().map(e => e.state.status), ["uncertain", "failed", "submitted"]);
});

test("queue checkpoints precede each mutation and interrupted entries restore uncertain while others keep waiting", async () => {
  let saved: unknown;
  let calls = 0;
  const service: DeploymentService = {create: async (_key, p) => {
    assert.ok("restoreVmId" in p);
    const restart = createRestorationQueue(service);
    restart.restore(saved);
    assert.deepEqual(restart.entries().map(e => e.state.status), ["uncertain", "waiting", "waiting"]);
    calls++;
    return {status: "submitted", vmId: p.restoreVmId, message: "Scheduled"};
  }};
  const queue = createRestorationQueue(service);
  queue.add(plans);
  let saves = 0;
  await queue.onSnapshot("secret", stock([1, 2, 3]), async () => {
    if (++saves === 2) throw new Error("terminal storage failure");
    saved = structuredClone(queue.entries());
  });
  assert.equal(calls, 1);
  const restarted = createRestorationQueue({create: async () => {throw new Error("not expected");}});
  restarted.restore(saved);
  assert.deepEqual(restarted.entries().map(e => e.state.status), ["uncertain", "waiting", "waiting"]);
  let dispatched = false;
  const blocked = createRestorationQueue({create: async () => {dispatched = true; throw new Error("not expected");}});
  blocked.add(plans);
  await blocked.onSnapshot("secret", stock([1, 2, 3]), async () => {throw new Error("checkpoint failure");});
  assert.equal(dispatched, false);
  assert.deepEqual(blocked.entries().map(e => e.state.status), ["failed", "waiting", "waiting"]);
});

test("queue cancellation and validation survive restart without replaying stored messages", async () => {
  const service: DeploymentService = {create: async () => {throw new Error("not expected");}};
  const queue = createRestorationQueue(service);
  queue.add(plans);
  queue.cancel([2]);
  const restart = createRestorationQueue(service);
  restart.restore(queue.entries().map(e => ({...e, state: {...e.state, message: "untrusted-stored-message"}})));
  assert.deepEqual(restart.entries().map(e => e.state.status), ["waiting", "cancelled", "waiting"]);
  assert.doesNotMatch(JSON.stringify(restart.entries()), /untrusted-stored-message/);
  restart.cancel();
  await restart.onSnapshot("secret", stock([1, 2, 3]), async () => {});
  assert.ok(restart.entries().every(e => e.state.status === "cancelled"));
  for (const invalid of [{}, [queue.entries()[0], queue.entries()[0]], [{...queue.entries()[0], plan: {restoreVmId: -1}}]]) assert.throws(() => restart.restore(invalid));
});

function runtimeFixture() {
  let saved: MonitoringRecord | undefined;
  let available: number[] = [];
  const calls: number[] = [];
  const timers = new Map<number, {callback: () => void; ms: number}>();
  let timerId = 0;
  const options = {
    secrets: {get: async () => "key", set: async () => {}, delete: async () => true},
    preferences: {load: async () => 0, save: async () => {}},
    monitoring: {load: async () => saved && structuredClone(saved), save: async (v: MonitoringRecord) => {saved = structuredClone(v);}},
    restorationCatalogService: {load: async () => ({ok: true as const, vms: plans.map(p => ({id: p.restoreVmId, name: p.name, region: p.region, flavor: p.flavor, gpu: "GPU", gpuCount: 1}))})},
    service: {check: async () => ({ok: true as const, snapshot: stock(available)})},
    deploymentService: {create: async (_key: string, p: Parameters<DeploymentService["create"]>[1]) => {
      assert.ok("restoreVmId" in p);
      assert.equal(saved?.restorations?.find(e => e.plan.restoreVmId === p.restoreVmId)?.state.status, "creating");
      calls.push(p.restoreVmId);
      return {status: "submitted" as const, vmId: p.restoreVmId, message: "Scheduled"};
    }},
    clock: {now: () => Date.now(), setTimeout: (callback: () => void, ms: number) => {timers.set(++timerId, {callback, ms}); return timerId;}, clearTimeout: (id: unknown) => {timers.delete(id as number);}},
  };
  return {options, calls, timers, available: (ids: number[]) => {available = ids;}, saved: () => saved};
}
const settle = async () => {for (let i = 0; i < 100; i++) await Promise.resolve();};

test("backend queue persists, schedules every minute with manual refresh, accepts additions and resumes without a view", async () => {
  const f = runtimeFixture();
  const first = createAvailabilityRuntime(f.options);
  await first.start();
  assert.equal((await first.enqueueRestorations({vmIds: [1, 2], confirmCharges: true})).ok, true);
  await settle();
  assert.equal(f.timers.values().next().value?.ms, 60000);
  const duplicate = await first.enqueueRestorations({vmIds: [1], confirmCharges: true});
  assert.equal(duplicate.ok, true);
  await settle();
  assert.equal(f.saved()?.restorations?.length, 2);
  f.available([2]);
  await first.refresh();
  assert.deepEqual(f.calls, [2]);
  await first.enqueueRestorations({vmIds: [3], confirmCharges: true});
  await settle();
  first.dispose();
  const second = createAvailabilityRuntime(f.options);
  await second.start();
  assert.deepEqual(f.calls, [2]);
  assert.equal(second.getState().monitoring?.restorations?.filter(e => e.state.status === "waiting").length, 2);
  f.available([1, 3]);
  await second.refresh();
  assert.deepEqual(f.calls, [2, 1, 3]);
  assert.equal(f.timers.size, 0);
  assert.equal((await second.enqueueRestorations({vmIds: [2], confirmCharges: true})).ok, false);
  second.dispose();
});

test("backend validates multi-selection atomically and persists selected cancellation and connection disarming", async () => {
  const f = runtimeFixture();
  const runtime = createAvailabilityRuntime(f.options);
  await runtime.start();
  for (const input of [{vmIds: [1]}, {vmIds: [1, 999], confirmCharges: true}, {vmIds: [-1], confirmCharges: true}, {vmIds: "1", confirmCharges: true}]) {
    assert.equal((await runtime.enqueueRestorations(input)).ok, false);
    assert.equal(f.saved()?.restorations?.length ?? 0, 0);
  }
  await runtime.enqueueRestorations({vmIds: [1, 2, 3], confirmCharges: true});
  await settle();
  await runtime.cancelRestorations({vmIds: [2]});
  assert.deepEqual(f.saved()?.restorations?.map(e => e.state.status), ["waiting", "cancelled", "waiting"]);
  await runtime.saveConnection({apiKey: "new-key"});
  await settle();
  assert.ok(f.saved()?.restorations?.every(e => e.state.status === "cancelled"));
  f.available([1, 2, 3]);
  await runtime.refresh();
  assert.deepEqual(f.calls, []);
  runtime.dispose();
});
