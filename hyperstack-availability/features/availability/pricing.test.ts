import {test} from "node:test";
import assert from "node:assert/strict";
import {withHyperstackPricing, stockConfigurationGpuCount} from "./pricing";
import {createAvailabilityService} from "./service";
import type {AvailabilityItem} from "./logic";
import type {AvailabilityService} from "./service";
const item: AvailabilityItem = {id: "a", region: "CANADA-1", gpu: "H100", flavor: "n3-H100x8", gpuCount: 8, availableCount: 2, isAvailable: true, status: "available"};
const stock = (items = [item]): AvailabilityService => ({check: async () => ({ok: true, snapshot: {checkedAt: "2026-11-03T10:00:00Z", items}})});
const response = (body: unknown) => ({ok: true, json: async () => body});

test("account pricebook values scale by GPU count, separate spot rates and preserve zero prices", async () => {
  const service = withHyperstackPricing(stock([item, {...item, id: "spot", flavor: "n3-H100x8-spot"}, {...item, id: "zero", gpu: "L40", gpuCount: 1}]), {fetch: async (url, init) => {
    assert.equal(url, "https://infrahub-api.nexgencloud.com/v1/pricebook");
    assert.equal((init.headers as Record<string, string>).api_key, "secret");
    assert.equal(init.redirect, "error");
    return response([{name: "H100", value: "1.500000000", original_value: "2.0"}, {name: "H100-spot", value: "0.75"}, {name: "L40", value: "0E-9"}]);
  }});
  const result = await service.check("secret");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.items.map(i => i.hourlyPrice), [12, 6, 0]);
  assert.equal(result.snapshot.items[0].availableCount, 2);
  assert.equal(result.snapshot.items[0].status, "available");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("missing counts/rates, malformed numbers, and duplicate resources never fabricate a price", async () => {
  for (const entries of [[], [{name: "H100", value: "bad"}], [{name: "H100", value: -1}], [{name: "H100", value: "Infinity"}], [{name: "H100", value: ""}], [{name: "H100", value: 1}, {name: "H100", value: 2}]]) {
    const result = await withHyperstackPricing(stock(), {fetch: async () => response(entries)}).check("key");
    assert.equal(result.ok && result.snapshot.items[0].hourlyPrice, null);
  }
  const result = await withHyperstackPricing(stock([{...item, gpuCount: undefined}, {...item, id: "spot", flavor: "n3-H100x8-spot"}, {...item, id: "fractional", gpuCount: 1.5}]), {fetch: async () => response([{name: "H100", value: 1}])}).check("key");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.snapshot.items.map(i => i.hourlyPrice), [null, null, null]);
});

test("prices cache per account, expire after five minutes, and apply promotion dates at display time", async () => {
  let time = Date.parse("2026-11-03T10:00:00Z");
  let calls = 0;
  const service = withHyperstackPricing(stock(), {now: () => time, fetch: async () => {
    calls++;
    return response([{name: "H100", value: "1", original_value: "2", start_time: "2026-11-03T09:00:00Z", end_time: "2026-11-03T10:01:00Z"}]);
  }});
  const first = await service.check("first-key");
  assert.equal(first.ok && first.snapshot.items[0].hourlyPrice, 8);
  time += 60_000;
  const expiredPromo = await service.check("first-key");
  assert.equal(expiredPromo.ok && expiredPromo.snapshot.items[0].hourlyPrice, 16);
  assert.equal(calls, 1);
  await service.check("second-key");
  assert.equal(calls, 2);
  time += 300_001;
  await service.check("second-key");
  assert.equal(calls, 3);
});

test("pricebook timeouts, HTTP failures and unreadable bodies preserve stock without leaking provider details", async () => {
  for (const fetch of [async () => ({ok: false, json: async () => ({secret: "private-body"})}), async () => {throw new Error("private-body");}, async () => response({status: true, pricebook: []}), async () => ({ok: true, json: () => new Promise<never>(() => {})})]) {
    const result = await withHyperstackPricing(stock(), {fetch, timeoutMs: 5}).check("secret-key");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.snapshot.items[0].hourlyPrice, null);
      assert.equal(result.snapshot.items[0].status, "available");
    }
    assert.doesNotMatch(JSON.stringify(result), /secret-key|private-body/);
  }
});

test("GPU allocation survives flavor/stock merging before pricing", async () => {
  const service = createAvailabilityService({provider: {
    endpoint: "https://infrahub-api.nexgencloud.com/v1/core/stocks", authenticationHeader: "api_key", formatCredential: key => key, normalizeResponse: body => body,
    catalog: {endpoint: "https://infrahub-api.nexgencloud.com/v1/core/flavors", normalizeResponse: body => body},
  }, fetch: async url => ({ok: true, status: 200, json: async () => ({items: [{...item, gpuCount: url.endsWith("/flavors") ? 8 : undefined}]})})});
  const priced = withHyperstackPricing(service, {fetch: async () => response([{name: "H100", value: "1.5"}])});
  const result = await priced.check("key");
  assert.equal(result.ok && result.snapshot.items[0].gpuCount, 8);
  assert.equal(result.ok && result.snapshot.items[0].hourlyPrice, 12);
});


test("stock configurations map to the same per-GPU price as flavors, using allocation rather than available VM count", async () => {
  const service = withHyperstackPricing(stock([
    {...item, id: "flavor", gpuCount: 8},
    {...item, id: "stock-1", flavor: "1x", gpuCount: undefined, availableCount: 36},
    {...item, id: "stock-2", flavor: "2x", gpuCount: undefined, availableCount: 12},
    {...item, id: "stock-8", flavor: "8x", gpuCount: undefined, availableCount: 0, status: "unavailable", isAvailable: false},
    {...item, id: "stock-10", flavor: "10x", gpuCount: undefined, availableCount: 2},
    {...item, id: "stock-spot", gpu: "H100-spot", flavor: "2x", gpuCount: undefined, availableCount: 12},
  ]), {fetch: async () => response([{name: "H100", value: "1.5"}, {name: "H100-spot", value: "0.75"}])});
  const result = await service.check("key");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.items.map(i => i.hourlyPrice), [12, 1.5, 3, 12, 15, 1.5]);
  assert.equal(result.snapshot.items[3].status, "unavailable");
  assert.equal(result.snapshot.items[1].availableCount, 36);
});

test("stock GPU count parsing accepts documented configurations without guessing from arbitrary flavor names", () => {
  for (const [label, count] of [["1x", 1], ["2x", 2], ["4x", 4], ["8x", 8], ["10x", 10]] as const) assert.equal(stockConfigurationGpuCount(label), count);
  for (const label of ["0x", "-2x", "1.5x", "8x-large", "n3-H100x8", "unknown", "9007199254740992x"]) assert.equal(stockConfigurationGpuCount(label), undefined);
});
