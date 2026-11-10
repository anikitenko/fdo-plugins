import {test} from "node:test";
import assert from "node:assert/strict";
import {createBackend} from "../backend.ts";
import {CostReadCoordinator} from "../providers/cost-policy.ts";

const tick = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};

test("backend cleanup rejects pending host work and queued persistence without touching the closing store", async () => {
  let writes = 0;
  const backend = createBackend(() => ({get: () => undefined, set: () => {writes++;}, flush: async () => {}} as any));
  await backend.bootstrap();
  const {jobId} = backend.start({kind: "accounts", mode: "live"});
  await tick();
  assert.ok("request" in backend.poll({jobId}));
  const saved = backend.removeAction({id: "unused"});
  const failed = assert.rejects(saved, /stopped/);
  backend.dispose(); backend.dispose();
  await failed; await tick();
  assert.equal(writes, 0);
  assert.throws(() => backend.poll({jobId}), /stopped/);
  assert.throws(() => backend.start({kind: "accounts", mode: "live"}), /stopped/);
  await assert.rejects(backend.bootstrap(), /stopped/);
});

test("billing cleanup wakes pending pacing delays and never starts another Azure read", async () => {
  const billing = new CostReadCoordinator({spacingMs: 60000});
  let reads = 0;
  await billing.request("tenant", async () => {reads++;});
  const pending = billing.request("tenant", async () => {reads++;});
  const stopped = assert.rejects(pending, /stopped/);
  await tick();
  billing.dispose(); billing.dispose();
  await stopped;
  assert.equal(reads, 1);
  await assert.rejects(billing.request("tenant", async () => {reads++;}), /stopped/);
  assert.equal(reads, 1);
});
