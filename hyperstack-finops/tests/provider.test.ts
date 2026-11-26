import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../provider";
import { totals, windows } from "../domain";
const now = new Date("2026-11-16T00:00:00Z");
const vm = {
  id: 1,
  name: "training",
  status: "SHUTOFF",
  environment: { org_id: 999, name: "train", region: "NORWAY-1" },
  flavor: {
    name: "n3-H100x1",
    gpu: "H100",
    gpu_count: 1,
    features: { no_hibernation: false },
  },
  volume_attachments: [{ volume: { id: 11 }, status: "ATTACHED" }],
  floating_ip: "192.0.2.1",
  created_at: "2026-11-01T00:00:00Z",
};
const bill = (id: number, cost: number) => ({
  attributes: { infrahub_id: id, resource_name: `vm-${id}`, status: "ACTIVE" },
  metrics: { incurred_bill: cost, usage_time: 10 },
});
function fixture(
  failPrevious = false,
  breakdown:
    | "complete"
    | "ip-only"
    | "unavailable"
    | "previous-unavailable" = "complete",
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const provider = createProvider(async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    let body: unknown;
    const previous = u.searchParams.get("start_date")?.startsWith("2026-10");
    if (u.pathname.endsWith("/core/virtual-machines"))
      body = { status: true, instances: [vm] };
    else if (u.pathname.endsWith("/core/volumes"))
      body = { status: true, volumes: [] };
    else if (u.pathname.endsWith("/usage"))
      body = {
        status: true,
        data:
          u.searchParams.get("deleted") === "true"
            ? [
                {
                  resource_id: 2,
                  resource_type: "virtual-machine",
                  name: "finished-run",
                  create_time: "2026-10-01T00:00:00Z",
                  terminate_time: "2026-11-02T00:00:00Z",
                  active: false,
                  exclude_billing: false,
                  bill_per_minute: 0,
                },
              ]
            : [
                {
                  resource_id: 1,
                  resource_type: "virtual-machine",
                  name: "training",
                  active: true,
                  exclude_billing: false,
                  bill_per_minute: 0.05,
                },
              ],
      };
    else if (u.pathname.endsWith("/pricebook"))
      body = [
        {
          name: "H100",
          value: "3",
          original_value: "3",
          start_time: null,
          end_time: null,
        },
      ];
    else if (u.pathname.endsWith("/history/virtual-machine")) {
      if (previous && failPrevious)
        return {
          ok: false,
          status: 403,
          json: async () => ({ secret: "must not leak" }),
        };
      body = {
        success: true,
        billing_history_vm: {
          billing_history: [bill(1, previous ? 20 : 30), bill(2, 10)],
          pagination: { pages: 1 },
        },
      };
    } else if (u.pathname.endsWith("/history/volume"))
      body = {
        success: true,
        billing_history_volume: {
          billing_history: [],
          pagination: { pages: 1 },
        },
      };
    else if (u.pathname.endsWith("/sub-resource")) {
      if (
        breakdown === "unavailable" ||
        (breakdown === "previous-unavailable" && previous)
      )
        return { ok: false, status: 403, json: async () => ({}) };
      body = {
        status: true,
        sub_resources_costs: {
          billing_history: [
            {
              metrics:
                breakdown === "ip-only"
                  ? { publicip_incurred_bill: 2 }
                  : {
                      publicip_incurred_bill: 2,
                      gpu_incurred_bill: 8,
                      cpu_incurred_bill: 0,
                      ram_incurred_bill: 0,
                      ephemeral_incurred_bill: 0,
                    },
            },
          ],
        },
      };
    } else if (u.pathname.endsWith("/history"))
      body = {
        status: true,
        billing_history: {
          billing_history: [{ metrics: { incurred_bill: 40 } }],
        },
      };
    else throw new Error("private request details");
    return { ok: true, status: 200, json: async () => body };
  });
  return { provider, calls };
}
test("reported spend joins deleted usage and separates public IP costs without double counting", async () => {
  const { provider, calls } = fixture();
  const s = await provider.load("secret-key", windows("month", now));
  assert.deepEqual(s.resources.find((r) => r.key === "vm:1")!.dependencies, [
    "volume:11",
    "public-ip:1",
  ]);
  assert.equal(totals(s.resources).current, 40);
  assert.equal(s.resources.find((r) => r.key === "vm:1")!.current!.cost, 28);
  assert.equal(
    s.resources.find((r) => r.key === "public-ip:1")!.current!.cost,
    2,
  );
  assert.equal(s.resources.find((r) => r.key === "vm:2")!.state, "DELETED");
  assert.equal(
    s.resources.find((r) => r.key === "vm:1")!.current!.hours,
    10,
    "usage_time is documented in hours",
  );
  assert.equal(s.resources.find((r) => r.key === "vm:2")!.origin, "Unknown");
  assert.ok(calls.some((c) => c.url.searchParams.get("deleted") === "true"));
  assert.ok(
    calls.every(
      (c) =>
        c.url.origin === "https://infrahub-api.nexgencloud.com" &&
        c.init.redirect === "error",
    ),
  );
  assert.ok(!JSON.stringify(s).includes("secret-key"));
});
test("previous-period failure is unknown instead of zero and produces a coverage warning", async () => {
  const { provider } = fixture(true);
  const s = await provider.load("key", windows("month", now));
  assert.equal(s.resources.find((r) => r.key === "vm:1")!.previous, null);
  assert.equal(totals(s.resources).delta, null);
  assert.match(s.warnings.join(" "), /Previous VM billing unavailable/);
});
test("pagination never silently truncates repeated pages and provider errors redact bodies", async () => {
  const provider = createProvider(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: "credential-secret" }),
  }));
  await assert.rejects(
    provider.capacity("credential-secret", { id: 1 } as any),
    (e) => e instanceof Error && !e.message.includes("credential-secret"),
  );
  const repeat = createProvider(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      billing_history_vm: {
        billing_history: [bill(1, 3)],
        pagination: { pages: 2 },
      },
    }),
  }));
  await assert.rejects(
    repeat.load("key", windows("month", now)),
    /Billing could not be loaded/,
  );
});

test("VM inspection rejects configuration drift and execution uses documented lifecycle methods", async () => {
  const calls: { url: URL; method: string | undefined }[] = [];
  const provider = createProvider(async (url, init) => {
    calls.push({ url: new URL(url), method: init.method });
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.includes("hibernate") || init.method === "DELETE"
          ? { status: true }
          : {
              status: true,
              instance: { ...vm, flavor: { ...vm.flavor, name: "different" } },
            },
    };
  });
  const { provider: loader } = fixture();
  const s = await loader.load("key", windows("month", now));
  await assert.rejects(
    provider.inspect(
      "key",
      s.resources.find((r) => r.key === "vm:1")!,
    ),
    /configuration changed/,
  );
  await provider.execute("key", "hibernate", 1, true);
  await provider.execute("key", "delete-volume", 2, false);
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].url.searchParams.get("retain_ip"), "true");
  assert.equal(calls[2].method, "DELETE");
  assert.match(calls[2].url.pathname, /core\/volumes\/2$/);
});

test("body parsing is bounded by backend cancellation even if transport ignores the signal", async () => {
  const controller = new AbortController();
  const provider = createProvider(
    async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    controller.signal,
  );
  const pending = provider.capacity("key", { id: 1 } as any);
  controller.abort();
  await assert.rejects(pending, /canceled/);
});

test("core inventory pagination follows the provider's page size rather than assuming 100", async () => {
  const pages: number[] = [];
  const provider = createProvider(async (url) => {
    const u = new URL(url);
    let body: unknown = {};
    if (u.pathname.endsWith("/core/virtual-machines")) {
      const page = Number(u.searchParams.get("page"));
      pages.push(page);
      body = {
        status: true,
        page_size: 1,
        instances: page <= 2 ? [{ ...vm, id: page }] : [],
      };
    } else if (u.pathname.endsWith("/core/volumes"))
      body = { status: true, volumes: [] };
    else if (u.pathname.endsWith("/history/virtual-machine"))
      body = {
        success: true,
        billing_history_vm: { billing_history: [], pagination: { pages: 1 } },
      };
    else if (u.pathname.endsWith("/history/volume"))
      body = {
        success: true,
        billing_history_volume: {
          billing_history: [],
          pagination: { pages: 1 },
        },
      };
    else if (u.pathname.endsWith("/usage")) body = { status: true, data: [] };
    else if (u.pathname.endsWith("/pricebook")) body = [];
    else if (u.pathname.endsWith("/history"))
      body = {
        status: true,
        billing_history: { org_id: 999, billing_history: [] },
      };
    return { ok: true, status: 200, json: async () => body };
  });
  const s = await provider.load("key", windows("month", now));
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(s.resources.filter((r) => r.kind === "vm").length, 2);
});

test("valid IP billing survives omitted compute fields and missing splits leave full VM totals usable", async () => {
  const ipOnly = await fixture(false, "ip-only").provider.load(
    "key",
    windows("month", now),
  );
  assert.equal(
    ipOnly.resources.find((r) => r.key === "public-ip:1")!.current!.cost,
    2,
  );
  assert.equal(totals(ipOnly.resources).current, 40);
  const unsplit = await fixture(false, "unavailable").provider.load(
    "key",
    windows("month", now),
  );
  assert.equal(
    unsplit.resources.find((r) => r.key === "vm:1")!.current!.includesPublicIp,
    true,
  );
  assert.equal(
    unsplit.resources.find((r) => r.key === "vm:1")!.current!.cost,
    30,
  );
  assert.equal(totals(unsplit.resources).current, 40);
  assert.equal(totals(unsplit.resources).delta, 10);
  assert.equal(totals(unsplit.resources).currentMissing, 0);
});

test("one missing IP split uses the full VM bill in both periods without double-counting known IP components", async () => {
  const s = await fixture(false, "previous-unavailable").provider.load(
    "key",
    windows("month", now),
  );
  const vm = s.resources.find((r) => r.key === "vm:1")!,
    ip = s.resources.find((r) => r.key === "public-ip:1")!;
  assert.equal(vm.current!.cost, 30);
  assert.equal(vm.previous!.cost, 20);
  assert.equal(vm.current!.includesPublicIp, true);
  assert.equal(vm.previous!.includesPublicIp, true);
  assert.equal(
    ip.current!.cost,
    2,
    "Known component still available in the IP inspector",
  );
  assert.equal(totals(s.resources).current, 40);
  assert.equal(totals(s.resources).delta, 10);
  assert.equal(
    totals(s.resources.filter((r) => r.kind === "vm")).delta,
    10,
    "VM-only comparisons keep the same cost basis",
  );
});

test("historical IP discovered in the previous period preserves an earlier selected-period zero across Sync and reload", async () => {
  const provider = createProvider(async (url) => {
    const u = new URL(url),
      previous = u.searchParams.get("start_date")?.startsWith("2026-10");
    let body: unknown;
    if (u.pathname.endsWith("/core/virtual-machines"))
      body = {
        status: true,
        instances: [{ ...vm, status: "HIBERNATED", floating_ip: null }],
      };
    else if (u.pathname.endsWith("/core/volumes"))
      body = { status: true, volumes: [] };
    else if (u.pathname.endsWith("/usage")) body = { status: true, data: [] };
    else if (u.pathname.endsWith("/pricebook")) body = [];
    else if (u.pathname.endsWith("/history/virtual-machine"))
      body = {
        success: true,
        billing_history_vm: {
          billing_history: [bill(1, previous ? 30 : 10)],
          pagination: { pages: 1 },
        },
      };
    else if (u.pathname.endsWith("/history/volume"))
      body = {
        success: true,
        billing_history_volume: {
          billing_history: [],
          pagination: { pages: 1 },
        },
      };
    else if (u.pathname.endsWith("/sub-resource"))
      body = {
        status: true,
        sub_resources_costs: {
          billing_history: [
            {
              attributes: { infrahub_id: 1 },
              metrics: { publicip_incurred_bill: previous ? 2 : 0 },
            },
          ],
        },
      };
    else
      body = {
        status: true,
        billing_history: {
          org_id: 999,
          billing_history: [{ metrics: { incurred_bill: 10 } }],
        },
      };
    return { ok: true, status: 200, json: async () => body };
  });
  for (
    let repeat = 0, metadata: import("../types").Resource[] = [];
    repeat < 3;
    repeat++
  ) {
    const s = await provider.load(
      "fixture-credential",
      windows("month", now),
      metadata,
    );
    const ip = s.resources.find((r) => r.key === "public-ip:1")!;
    assert.equal(ip.current!.cost, 0);
    assert.equal(ip.previous!.cost, 2);
    assert.equal(s.resources.find((r) => r.key === "vm:1")!.current!.cost, 10);
    assert.equal(totals(s.resources).delta, -20);
    assert.equal(s.billingIssues!.length, 0);
    metadata = structuredClone(s.resources);
  }
});

test("zero-cost deleted VM stays discoverable as the parent of a billed historical IP", async () => {
  const provider = createProvider(async (url) => {
    const u = new URL(url),
      previous = u.searchParams.get("start_date")?.startsWith("2026-10");
    let body: unknown;
    if (u.pathname.endsWith("/core/virtual-machines"))
      body = { status: true, instances: [] };
    else if (u.pathname.endsWith("/core/volumes"))
      body = { status: true, volumes: [] };
    else if (u.pathname.endsWith("/usage")) body = { status: true, data: [] };
    else if (u.pathname.endsWith("/pricebook")) body = [];
    else if (u.pathname.endsWith("/history/virtual-machine"))
      body = {
        success: true,
        billing_history_vm: {
          billing_history: previous ? [bill(1, 2)] : [],
          pagination: { pages: 1 },
        },
      };
    else if (u.pathname.endsWith("/history/volume"))
      body = {
        success: true,
        billing_history_volume: {
          billing_history: [],
          pagination: { pages: 1 },
        },
      };
    else if (u.pathname.endsWith("/sub-resource"))
      body = {
        status: true,
        sub_resources_costs: {
          billing_history: [{ metrics: { publicip_incurred_bill: 2 } }],
        },
      };
    else
      body = {
        status: true,
        billing_history: { org_id: 999, billing_history: [] },
      };
    return { ok: true, status: 200, json: async () => body };
  });
  const s = await provider.load("fixture-credential", windows("month", now));
  assert.ok(s.resources.some((r) => r.key === "vm:1"));
  assert.equal(
    s.resources.find((r) => r.key === "public-ip:1")!.current!.cost,
    0,
  );
  assert.equal(totals(s.resources).currentMissing, 0);
});

test("IP zero-cost retry accepts a valid subresource amount without redundant attributes and rejects mismatched IDs", async () => {
  const resource = {
    key: "public-ip:1",
    id: 1,
    kind: "public-ip",
  } as import("../types").Resource;
  const provider = createProvider(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      sub_resources_costs: {
        billing_history: [{ metrics: { publicip_incurred_bill: 0 } }],
      },
    }),
  }));
  const result = await provider.billing(
    "fixture-credential",
    resource,
    windows("month", now).current,
  );
  assert.equal(result.cost, 0);
  assert.equal(result.hours, null);
  const other = createProvider(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      sub_resources_costs: {
        billing_history: [
          {
            attributes: { infrahub_id: 2 },
            metrics: { publicip_incurred_bill: 0 },
          },
        ],
      },
    }),
  }));
  await assert.rejects(
    other.billing(
      "fixture-credential",
      resource,
      windows("month", now).current,
    ),
    /billing identity/,
  );
});
