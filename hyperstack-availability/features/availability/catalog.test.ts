import {test} from "node:test";
import assert from "node:assert/strict";
import {createDeploymentCatalogService} from "./catalog";
import {createAvailabilityBackend} from "./backend";

const ok = (body: unknown) => ({ok: true, json: async () => body});
test("loads grouped images and paginated keys without returning public keys or provider bodies", async () => {
  const calls: string[] = [];
  const service = createDeploymentCatalogService({fetch: async (url, init) => {
    calls.push(url);
    assert.equal((init.headers as Record<string, string>).api_key, "secret");
    assert.equal(init.redirect, "error");
    if (url.includes("/environments")) return ok({status: true, environments: [{name: "env", region: "CANADA-1", unrelated: "private"}]});
    if (url.includes("/images")) return ok({status: true, images: [{region_name: "CANADA-1", type: "Ubuntu", images: [{name: "Ubuntu CUDA", id: 1}]}]});
    return ok({status: true, count: 2, keypairs: [{name: url.includes("page=1&") ? "key-a" : "key-b", environment: {name: "env"}, public_key: "private-material"}]});
  }});
  const result = await service.load("secret");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.catalog.images, [{name: "Ubuntu CUDA", region: "CANADA-1"}]);
  assert.equal(result.catalog.keypairs.length, 2);
  assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
});

test("catalog deadlines and malformed responses fail without exposing errors", async () => {
  for (const fetch of [async () => ok({status: true, images: [{name: "missing-region"}]}), async () => {throw new Error("secret");}, async () => new Promise<never>(() => {})]) {
    const result = await createDeploymentCatalogService({fetch, timeoutMs: 5}).load("secret");
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test("backend rejects mismatched regional selections before arming and clears catalog on key replacement", async () => {
  const backend = createAvailabilityBackend({
    secrets: {get: async () => "key", set: async () => {}, delete: async () => true},
    service: {check: async () => ({ok: true, snapshot: {checkedAt: new Date().toISOString(), items: [{id: "vm", region: "A", gpu: "GPU", flavor: "flavor", availableCount: 0, isAvailable: false, status: "unavailable"}]}})},
    deploymentService: {create: async () => {throw new Error("Should not create");}},
    catalogService: {load: async () => ({ok: true, catalog: {environments: [{name: "env", region: "A"}], images: [{name: "Ubuntu", region: "B"}], keypairs: [{name: "key", environment: "env"}]}})},
  });
  await backend.refresh();
  await backend.deploymentOptions();
  const result = await backend.armDeployment({itemId: "vm", name: "vm", environment: "env", image: "Ubuntu", keypair: "key", publicIp: false, confirmCharges: true});
  assert.equal(result.deployment?.status, "failed");
});
