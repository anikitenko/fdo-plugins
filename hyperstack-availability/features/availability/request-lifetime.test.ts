import {test} from "node:test";
import assert from "node:assert/strict";
import {createDeploymentCatalogService} from "./catalog";
import {createDeploymentService} from "./deployment";
import {withHyperstackPricing} from "./pricing";
import type {AvailabilityItem} from "./logic";

const tick = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
const plan = {itemId: "type", name: "vm", environment: "env", image: "Ubuntu", keypair: "key", publicIp: false};
const item: AvailabilityItem = {id: "type", region: "A", gpu: "GPU", flavor: "flavor", availableCount: 1, isAvailable: true, status: "available"};

test("shutdown aborts catalog and pricebook requests even when fetch never settles", async () => {
  const owner = new AbortController();
  const signals: AbortSignal[] = [];
  const request = async (_url: string, init: RequestInit): Promise<never> => {
    signals.push(init.signal as AbortSignal);
    return new Promise(() => {});
  };
  const catalog = createDeploymentCatalogService({fetch: request}).load("key", {signal: owner.signal});
  const pricing = withHyperstackPricing({check: async () => ({ok: false, error: {code: "cancelled", message: "stopped", retryable: false}})}, {fetch: request}).check("key", {signal: owner.signal});
  assert.equal(signals.length, 4);
  owner.abort();
  assert.equal((await catalog).ok, false);
  assert.equal((await pricing).ok, false);
  assert.ok(signals.every(signal => signal.aborted));
});

test("shutdown during environment lookup prevents a late POST; shutdown after dispatch stays uncertain", async () => {
  for (const dispatched of [false, true]) {
    const owner = new AbortController();
    let finishEnvironment!: (value: {ok: boolean; status: number; json(): Promise<unknown>}) => void;
    const methods: string[] = [];
    const signals: AbortSignal[] = [];
    const service = createDeploymentService({fetch: async (_url, init) => {
      methods.push(init.method!); signals.push(init.signal as AbortSignal);
      if (init.method === "POST") return new Promise(() => {});
      return new Promise(resolve => {finishEnvironment = resolve;});
    }});
    const pending = service.create("key", plan, item, {signal: owner.signal});
    const environment = {ok: true, status: 200, json: async () => ({status: true, environments: [{name: "env", region: "A"}]})};
    if (dispatched) {finishEnvironment(environment); await tick();}
    owner.abort();
    assert.equal((await pending).status, dispatched ? "uncertain" : "failed");
    finishEnvironment(environment); await tick();
    assert.deepEqual(methods, dispatched ? ["GET", "POST"] : ["GET"]);
    assert.ok(signals.every(signal => signal.aborted));
  }
});

test("already stopped request owners never dispatch catalog, pricing or creation requests", async () => {
  const owner = new AbortController(); owner.abort();
  let calls = 0;
  const request = async (): Promise<never> => {calls++; throw new Error("unexpected dispatch");};
  await createDeploymentCatalogService({fetch: request}).load("key", {signal: owner.signal});
  await createDeploymentService({fetch: request}).create("key", plan, item, {signal: owner.signal});
  await withHyperstackPricing({check: async () => ({ok: false, error: {code: "cancelled", message: "stopped", retryable: false}})}, {fetch: request}).check("key", {signal: owner.signal});
  assert.equal(calls, 0);
});
