import {test} from "node:test";
import assert from "node:assert/strict";
import {createDeploymentController, createDeploymentService} from "./deployment";
import {createAvailabilityBackend} from "./backend";
import type {AvailabilityItem, AvailabilitySnapshot} from "./logic";

const item: AvailabilityItem = {id: "vm-type", region: "CANADA-1", gpu: "L40", flavor: "n3-L40x1", availableCount: 1, isAvailable: true, status: "available"};
const snapshot = (status: AvailabilityItem["status"] = "available"): AvailabilitySnapshot => ({
  checkedAt: new Date().toISOString(), items: [{...item, status, availableCount: status === "unknown" ? null : status === "available" ? 1 : 0, isAvailable: status === "unknown" ? null : status === "available"}],
});
const input = {itemId: item.id, name: "my-vm", environment: "gpu-env", image: "Ubuntu Server 24.04 LTS", keypair: "my-key", publicIp: true, confirmCharges: true};
const plan = {...input};
const response = (body: unknown, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const environments = {status: true, environments: [{name: "gpu-env", region: "CANADA-1"}]};

test("one-shot deployment waits for the exact available type and consumes the plan once", async () => {
  let calls = 0;
  const controller = createDeploymentController({async create(_key, selected, target) {
    calls++;
    assert.equal(selected.name, "my-vm");
    assert.equal(target.id, item.id);
    return {status: "submitted", message: "Created", vmId: 42};
  }});
  assert.equal(controller.arm({...input, confirmCharges: false}, snapshot()).status, "failed");
  assert.equal(controller.arm({...input, itemId: "forged"}, snapshot()).status, "failed");
  const armed = controller.arm(input, snapshot("unavailable"));
  assert.equal(armed.status, "waiting");
  assert.equal(controller.arm({...input, name: "different"}, snapshot()).status, "failed");
  await controller.onSnapshot("secret", snapshot(), undefined); // A reloaded view cannot resume it.
  await controller.onSnapshot("secret", snapshot(), "wrong-id");
  await controller.onSnapshot("secret", snapshot("unknown"), armed.launchId);
  await controller.onSnapshot("secret", snapshot("unavailable"), armed.launchId);
  await controller.onSnapshot("secret", {...snapshot(), items: [{...item, id: "other", region: "US-1"}]}, armed.launchId);
  assert.equal(calls, 0);
  assert.equal((await controller.onSnapshot("secret", snapshot(), armed.launchId)).vmId, 42);
  await controller.onSnapshot("secret", snapshot(), armed.launchId);
  assert.equal(calls, 1);
});

test("cancelled and uncertain deployments never automatically create again", async () => {
  let calls = 0;
  const controller = createDeploymentController({async create() {calls++; throw new Error("secret");}});
  const first = controller.arm(input, snapshot());
  assert.equal(controller.cancel().status, "cancelled");
  await controller.onSnapshot("secret", snapshot(), first.launchId);
  assert.equal(calls, 0);
  const second = controller.arm(input, snapshot());
  const result = await controller.onSnapshot("secret", snapshot(), second.launchId);
  assert.equal(result.status, "uncertain");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  await controller.onSnapshot("secret", snapshot(), second.launchId);
  assert.equal(calls, 1);
});

test("deployment uses documented fields, validates region and returns only a VM ID", async () => {
  const calls: Array<{url: string; init: RequestInit}> = [];
  const service = createDeploymentService({fetch: async (url, init) => {
    calls.push({url, init});
    return url.endsWith("/environments") ? response(environments) : response({status: true, instances: [{id: 42, sensitive: "do-not-expose"}]});
  }});
  const result = await service.create("test-secret", plan, item);
  assert.equal(result.status, "submitted");
  assert.equal(result.vmId, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://infrahub-api.nexgencloud.com/v1/core/environments");
  assert.equal(calls[1].url, "https://infrahub-api.nexgencloud.com/v1/core/virtual-machines");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal((calls[1].init.headers as Record<string, string>).api_key, "test-secret");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    name: "my-vm", environment_name: "gpu-env", image_name: input.image,
    flavor_name: item.flavor, key_name: "my-key", count: 1, assign_floating_ip: true, security_rules: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /test-secret|do-not-expose/);

  let posts = 0;
  const mismatch = createDeploymentService({fetch: async (_url, init) => {
    if (init.method === "POST") posts++;
    return response({status: true, environments: [{name: "gpu-env", region: "US-1"}]});
  }});
  assert.equal((await mismatch.create("secret", plan, item)).status, "failed");
  assert.equal(posts, 0);
});

test("creation errors and malformed successes stop without exposing provider text or retrying", async () => {
  for (const status of [400, 401, 403, 409, 429, 500, 408, 200]) {
    let posts = 0;
    const service = createDeploymentService({fetch: async (_url, init) => {
      if (init.method === "GET") return response(environments);
      posts++;
      return response({status: false, message: "secret-provider-body"}, status);
    }});
    const result = await service.create("secret-key", plan, item);
    assert.equal(result.status, [500, 408, 200].includes(status) ? "uncertain" : "failed");
    assert.doesNotMatch(JSON.stringify(result), /secret-provider-body|secret-key/);
    assert.equal(posts, 1);
  }
});

test("deadlines cover body parsing and late environment responses cannot launch a VM", async () => {
  let finish: (value: unknown) => void = () => {};
  let posts = 0;
  const service = createDeploymentService({timeoutMs: 5, fetch: async (_url, init) => {
    if (init.method === "POST") posts++;
    return {ok: true, status: 200, json: () => new Promise(resolve => {finish = resolve;})};
  }});
  assert.equal((await service.create("secret", plan, item)).status, "failed");
  finish(environments);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posts, 0);

  const slowPost = createDeploymentService({timeoutMs: 5, fetch: async (_url, init) => {
    if (init.method === "GET") return response(environments);
    return {ok: true, status: 200, json: () => new Promise(() => {})};
  }});
  assert.equal((await slowPost.create("secret", plan, item)).status, "uncertain");
});

test("backend requires a checked type, fresh stock and an armed view; concurrent refreshes create once", async () => {
  let count = 0;
  let current = snapshot("unavailable");
  const backend = createAvailabilityBackend({
    secrets: {get: async () => "test-key", set: async () => {}, delete: async () => true},
    service: {check: async () => ({ok: true, snapshot: current})},
    deploymentService: {create: async () => {count++; return {status: "submitted", message: "Scheduled", vmId: 42};}},
  });
  assert.equal((await backend.armDeployment(input)).deployment?.status, "failed");
  await backend.refresh();
  const armed = (await backend.armDeployment(input)).deployment;
  assert.equal(armed?.status, "waiting");
  await backend.refresh({launchId: armed?.launchId});
  assert.equal(count, 0);
  current = snapshot();
  await backend.refresh();
  assert.equal(count, 0);
  const results = await Promise.all([backend.refresh({launchId: armed?.launchId}), backend.refresh({launchId: armed?.launchId})]);
  assert.equal(count, 1);
  assert.equal(results[0].ok && results[0].deployment?.vmId, 42);
  assert.doesNotMatch(JSON.stringify(results), /test-key/);
});

test("connection replacement cancels waiting and requires a new stock check", async () => {
  let calls = 0;
  const backend = createAvailabilityBackend({
    secrets: {get: async () => "test-key", set: async () => {}, delete: async () => true},
    service: {check: async () => ({ok: true, snapshot: snapshot()})},
    deploymentService: {create: async () => {calls++; return {status: "submitted", message: "Scheduled"};}},
  });
  await backend.refresh();
  const armed = (await backend.armDeployment(input)).deployment;
  await backend.saveConnection({apiKey: "new-key"});
  assert.equal((await backend.armDeployment(input)).deployment?.status, "failed");
  await backend.refresh({launchId: armed?.launchId});
  assert.equal(calls, 0);
});
