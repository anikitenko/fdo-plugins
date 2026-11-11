import {test} from "node:test";
import assert from "node:assert/strict";
import {createRestorationCatalogService, matchingVmStock, readHibernatedVm, restoreHibernatedVm} from "./restoration";
import {createAvailabilityBackend} from "./backend";
import {createDeploymentService} from "./deployment";
import type {MonitoringRecord, RestorationPlan} from "./deployment";
import type {AvailabilitySnapshot} from "./logic";

const wireVm = {id: 42, name: "existing", status: "HIBERNATED", environment: {region: "CANADA-1"}, flavor: {name: "n3-H100x1", gpu: "H100", gpu_count: 1}, private_data: "secret"};
const vm = readHibernatedVm(wireVm);
const item = {id: "exact", region: vm.region, flavor: vm.flavor, gpu: vm.gpu, availableCount: 1, isAvailable: true, status: "available" as const};
const plan: RestorationPlan = {restoreVmId: vm.id, itemId: item.id, name: vm.name, region: vm.region, flavor: vm.flavor};
const ok = (body: unknown) => ({ok: true, status: 200, json: async () => body});

test("hibernated catalog paginates, skips active and CPU VMs, and returns only public metadata", async () => {
  let calls = 0;
  const result = await createRestorationCatalogService({fetch: async (_url, init) => {
    assert.equal((init.headers as Record<string, string>).api_key, "credential");
    assert.equal(init.cache, "no-store");
    calls++;
    return ok({status: true, count: 3, instances: calls === 1 ? [wireVm] : [{...wireVm, id: 43, status: "ACTIVE"}, {...wireVm, id: 44, flavor: {gpu: ""}}]});
  }}).load("credential");
  assert.deepEqual(result, {ok: true, vms: [vm]});
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret|credential|private_data/);
});

test("restore requires exact region, GPU and flavor and never substitutes allocation-only stock", () => {
  assert.equal(matchingVmStock(vm, [item]), item);
  for (const other of [{...item, region: "NORWAY-1"}, {...item, gpu: "A100"}, {...item, flavor: "1x"}, {...item, flavor: `${item.flavor}-spot`}, {...item, flavor: `${item.flavor}-bigroot`}]) {
    assert.equal(matchingVmStock(vm, [other]), undefined);
  }
  assert.equal(matchingVmStock(vm, [item, {...item, id: "duplicate"}]), undefined);
});

test("restore revalidates hibernation and configuration before the documented mutation", async () => {
  const calls: string[] = [];
  const result = await restoreHibernatedVm(async (url, init) => {
    calls.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    return ok(calls.length === 1 ? {status: true, instance: wireVm} : {status: true});
  }, "credential", plan);
  assert.equal(result.status, "submitted");
  assert.equal(result.vmId, 42);
  assert.equal(calls[1], "https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/42/hibernate-restore");
  for (const changed of [{...wireVm, status: "ACTIVE"}, {...wireVm, status: "HIBERNATING"}, {...wireVm, environment: {region: "NORWAY-1"}}, {...wireVm, flavor: {...wireVm.flavor, name: "other"}}, {...wireVm, id: 43}]) {
    let count = 0;
    const rejected = await restoreHibernatedVm(async () => {count++; return ok({status: true, instance: changed});}, "credential", plan);
    assert.equal(rejected.status, "failed");
    assert.equal(count, 1);
  }
});

test("restore deadlines and ambiguous mutation outcomes never retry or expose provider errors", async () => {
  for (const outcome of [async () => {throw new Error("credential");}, async () => ok({status: false, message: "credential"}), async () => ({...ok({}), ok: false, status: 500}), async () => new Promise<never>(() => {})]) {
    let calls = 0;
    const result = await restoreHibernatedVm(async () => ++calls === 1 ? ok({status: true, instance: wireVm}) : outcome(), "credential", plan, undefined, 5);
    assert.equal(result.status, "uncertain");
    assert.equal(calls, 2);
    assert.doesNotMatch(JSON.stringify(result), /credential/);
  }
  let calls = 0;
  const result = await restoreHibernatedVm(async () => {calls++; return new Promise<never>(() => {});}, "credential", plan, undefined, 5);
  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
});

test("restoration resolves configuration server-side, persists across restart and consumes one request", async () => {
  let saved: MonitoringRecord | undefined;
  let available = false;
  let restores = 0;
  const monitoring = {load: async () => saved && structuredClone(saved), save: async (record: MonitoringRecord) => {saved = structuredClone(record);}};
  const options = {
    monitoring,
    secrets: {get: async () => "credential", set: async () => {}, delete: async () => true},
    restorationCatalogService: {load: async () => ({ok: true as const, vms: [vm]})},
    service: {check: async () => ({ok: true as const, snapshot: {checkedAt: new Date().toISOString(), items: [{...item, status: available ? "available" : "unavailable"}]} as AvailabilitySnapshot})},
    deploymentService: createDeploymentService({fetch: async url => {
      if (!url.endsWith("/hibernate-restore")) return ok({status: true, instance: wireVm});
      assert.equal(saved?.state.status, "creating", "checkpoint precedes restore");
      restores++;
      return ok({status: true});
    }}),
  };
  const first = createAvailabilityBackend(options);
  await first.refresh();
  const invalid = await first.armDeployment({restoreVmId: 42});
  assert.equal(invalid.deployment?.status, "failed");
  const armed = await first.armDeployment({restoreVmId: 42, confirmCharges: true, region: "fake", flavor: "fake", itemId: "fake"});
  assert.deepEqual(saved?.plan, plan);
  await first.refresh({launchId: armed.deployment?.launchId});
  assert.equal(restores, 0);
  const restarted = createAvailabilityBackend(options);
  const state = await restarted.getConfiguration();
  assert.equal(state.monitoring?.state.status, "waiting");
  available = true;
  await restarted.refresh({launchId: state.monitoring?.state.launchId});
  await restarted.refresh({launchId: state.monitoring?.state.launchId});
  assert.equal(restores, 1);
  assert.equal(saved?.state.status, "submitted");
  const third = createAvailabilityBackend(options);
  await third.refresh({launchId: state.monitoring?.state.launchId});
  assert.equal(restores, 1);
});

test("cancellation persists for restore plans and interrupted restore checkpoints become uncertain", async () => {
  const {createDeploymentController} = await import("./deployment");
  let calls = 0;
  const controller = createDeploymentController({create: async () => {calls++; return {status: "submitted", vmId: 42, message: "Scheduled"};}});
  const snapshot: AvailabilitySnapshot = {checkedAt: new Date().toISOString(), items: [item]};
  controller.arm({...plan, confirmCharges: true}, snapshot);
  controller.cancel();
  const restarted = createDeploymentController({create: async () => {throw new Error("must not restore");}});
  restarted.restore(controller.record());
  await restarted.onSnapshot("credential", snapshot, undefined);
  assert.equal(restarted.state().status, "cancelled");
  const armed = controller.arm({...plan, confirmCharges: true}, snapshot);
  await controller.onSnapshot("credential", snapshot, armed.launchId, async () => {
    restarted.restore(controller.record());
    assert.equal(restarted.state().status, "uncertain");
    throw new Error("disk failure");
  });
  assert.equal(calls, 0);
  await restarted.onSnapshot("credential", snapshot, armed.launchId);
  assert.equal(restarted.state().status, "uncertain");
});

test("aborted restoration reads and late details never dispatch a restore", async () => {
  const controller = new AbortController();
  let calls = 0;
  let release!: (value: ReturnType<typeof ok>) => void;
  const pending = restoreHibernatedVm(async () => {calls++; return new Promise(resolve => {release = resolve;});}, "credential", plan, controller.signal);
  controller.abort();
  assert.equal((await pending).status, "failed");
  release(ok({status: true, instance: wireVm}));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
});
