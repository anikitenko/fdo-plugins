import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend, defaultSettings } from "../backend.ts";
import { normalizeExploration } from "../exploration.ts";
import { SUB, TENANT, OTHER_SUB } from "../providers/demo.ts";
const target = `/subscriptions/${SUB}/resourceGroups/app/providers/Microsoft.Databricks/workspaces/analytics`;
const preferences = () => ({
  version: 1,
  ...defaultSettings(),
  page: "databricks",
  scope: {
    tenantId: TENANT,
    subscriptionId: SUB,
    groupIds: [],
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-19T23:59:59.999Z",
    basis: "ActualCost",
  },
  serviceId: target,
  filters: { search: "app", token: "PRIVATE" },
  token: "PRIVATE",
  snapshot: { credentials: "PRIVATE" },
  serviceData: { secret: "PRIVATE" },
  confirmations: { target: "PRIVATE" },
  assetViews: {
    [target]: {
      query: "reporting",
      category: "warehouse",
      index: 2,
      candidatePage: 1,
      token: "PRIVATE",
    },
  },
});
function fixture() {
  const disk = new Map<string, any>();
  let flushes = 0,
    failing = false;
  const store = {
    get: (key: string) => disk.get(key),
    set: (key: string, value: unknown) => disk.set(key, structuredClone(value)),
    flush: async () => {
      flushes++;
      if (failing) throw new Error("flush failed");
    },
  };
  return {
    disk,
    store,
    flushes: () => flushes,
    fail: (value: boolean) => {
      failing = value;
    },
    backend: () => createBackend(() => store as any),
  };
}
test("exploration persists only projected preferences and skips unchanged writes across reloads", async () => {
  const f = fixture(),
    b = f.backend();
  await b.bootstrap();
  await b.saveExploration({ view: preferences() });
  const stored = f.disk.get("exploration");
  assert.equal(stored.serviceId, target);
  assert.equal(stored.assetViews[target].query, "reporting");
  assert.doesNotMatch(
    JSON.stringify(stored),
    /PRIVATE|snapshot|serviceData|confirmations|token/,
  );
  assert.equal(f.flushes(), 1);
  await b.saveExploration({ view: preferences() });
  assert.equal(
    f.flushes(),
    1,
    "An unchanged UI remount must not create a storage/refresh loop",
  );
  const reloaded = f.backend();
  assert.deepEqual((await reloaded.bootstrap()).exploration, stored);
  await reloaded.saveExploration({ view: preferences() });
  assert.equal(f.flushes(), 1);
  await reloaded.configure({ ...defaultSettings(), cli: "/usr/local/bin/az" });
  assert.equal((await reloaded.bootstrap()).exploration, undefined);
  await assert.rejects(
    () => reloaded.saveExploration({ view: preferences() }),
    /different provider configuration/,
  );
});
test("exploration validates scope and bounds nested metadata", () => {
  const input = preferences();
  assert.throws(
    () =>
      normalizeExploration(
        {
          ...input,
          scope: {
            ...input.scope,
            groupIds: [`/subscriptions/${OTHER_SUB}/resourcegroups/other`],
          },
        },
        defaultSettings(),
      ),
    /must belong/,
  );
  const view = normalizeExploration(
    {
      ...input,
      selectionId: `/subscriptions/${OTHER_SUB}/resourceGroups/app/providers/Microsoft.Compute/disks/d`,
      tablePage: Infinity,
      filters: { search: "x".repeat(10000) },
      columns: ["name", "token", "name"],
      assetViews: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          target + i,
          { query: "a".repeat(10000), index: -5 },
        ]),
      ),
    },
    defaultSettings(),
  );
  assert.equal(view.selectionId, undefined);
  assert.equal(view.tablePage, 0);
  assert.equal(view.filters.search.length, 512);
  assert.deepEqual(view.columns, ["name"]);
  assert.equal(Object.keys(view.assetViews).length, 20);
  assert.ok(
    Object.values(view.assetViews).every(
      (v: any) => v.query.length === 512 && v.index === 0,
    ),
  );
});
test("preference save acknowledgement awaits durable flush and a failed save can be retried", async () => {
  const f = fixture(),
    b = f.backend();
  await b.bootstrap();
  f.fail(true);
  await assert.rejects(
    () => b.saveExploration({ view: preferences() }),
    /flush failed/,
  );
  f.fail(false);
  await b.saveExploration({ view: preferences() });
  assert.equal(
    f.flushes(),
    2,
    "A failed flush cannot populate the unchanged-write cache",
  );
});
