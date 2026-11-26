import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../backend";
import { demoSnapshot } from "../demo";
import type { Operation, Saved } from "../types";
function harness(savedData?: Saved) {
  let stored: unknown = savedData,
    failSave = false,
    allowed = true,
    uncertain = false;
  const calls: string[] = [];
  const snapshot = demoSnapshot();
  const resources = snapshot.resources;
  const secrets = new Map<string, string>([
    ["hyperstack-finops.api-key", "backend-key"],
  ]);
  const options = {
    secrets: {
      get: async (key: string) => secrets.get(key) ?? null,
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => secrets.delete(key),
    },
    persistence: {
      load: async () => stored,
      save: async (v: Saved) => {
        if (failSave) throw new Error("storage denied");
        calls.push("checkpoint");
        stored = structuredClone(v);
      },
    },
    authorizeManagement: () => {
      if (!allowed) throw new Error("denied");
    },
    provider: {
      load: async () => snapshot,
      billing: async () => ({
        cost: 12,
        hours: 3,
        rate: 4,
        includesPublicIp: false,
      }),
      organization: async () => snapshot.organizationId!,
      inspect: async (_key: string, r: import("../types").Resource) =>
        resources.find((x) => x.key === r.key)!,
      capacity: async () =>
        "Currently unavailable; resume capacity is not guaranteed",
      execute: async () => {
        calls.push("execute");
        if (uncertain) throw new Error("timeout");
      },
    },
  };
  const backend = createBackend(options);
  return {
    backend,
    options,
    calls,
    resources,
    snapshot,
    secrets,
    stored: () => stored,
    fail: () => {
      failSave = true;
    },
    revoke: () => {
      allowed = false;
    },
    ambiguous: () => {
      uncertain = true;
    },
  };
}
async function staged(
  h: ReturnType<typeof harness>,
  key = "vm:101",
  kind = "hibernate",
) {
  await h.backend.sync({ period: "month" });
  return (
    await h.backend.stage({ resourceKey: key, kind, hours: 12, retainIp: true })
  ).plans[0];
}
test("staging previews retained dependencies and blocked stopped-VM hibernation without starting it", async () => {
  const h = harness();
  const p = await staged(h, "vm:102");
  assert.match(p.blocked!, /ACTIVE/);
  assert.deepEqual(p.dependencies, ["public-ip:102", "volume:201"]);
  await assert.rejects(
    h.backend.execute({ planId: p.id, confirm: true }),
    /ACTIVE/,
  );
  assert.ok(!h.calls.includes("execute"));
});
test("management requires FDO permission, confirmation and current dependencies", async () => {
  const h = harness();
  const p = await staged(h);
  await assert.rejects(
    h.backend.execute({ planId: p.id, confirm: false }),
    /acknowledge/,
  );
  h.resources[0].dependencies = ["volume:201"];
  await assert.rejects(
    h.backend.execute({ planId: p.id, confirm: true }),
    /Dependencies changed/,
  );
  h.revoke();
  await assert.rejects(
    h.backend.execute({ planId: p.id, confirm: true }),
    /denied/,
  );
  assert.ok(!h.calls.includes("execute"));
});
test("durable consumed marker precedes a single request and outcomes survive restart", async () => {
  const h = harness();
  const p = await staged(h);
  h.calls.length = 0;
  const [a, b] = await Promise.allSettled([
    h.backend.execute({ planId: p.id, confirm: true }),
    h.backend.execute({ planId: p.id, confirm: true }),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.deepEqual(h.calls, ["checkpoint", "execute", "checkpoint"]);
  const restored = createBackend(h.options);
  assert.equal((await restored.state()).operations[0].status, "submitted");
  assert.equal(h.calls.filter((c) => c === "execute").length, 1);
});
test("checkpoint failure prevents mutation and ambiguous submission blocks retries", async () => {
  const h = harness();
  const p = await staged(h);
  h.fail();
  await assert.rejects(
    h.backend.execute({ planId: p.id, confirm: true }),
    /No request was sent/,
  );
  assert.ok(!h.calls.includes("execute"));
  const h2 = harness();
  const p2 = await staged(h2);
  h2.ambiguous();
  const out = await h2.backend.execute({ planId: p2.id, confirm: true });
  assert.equal(out.operations[0].status, "uncertain");
  const p3 = (
    await h2.backend.stage({
      resourceKey: "vm:101",
      kind: "hibernate",
      hours: 12,
      retainIp: true,
    })
  ).plans[0];
  await assert.rejects(
    h2.backend.execute({ planId: p3.id, confirm: true }),
    /previous operation/,
  );
});
test("volume cleanup revalidates attachment evidence and exact resource-ID confirmation", async () => {
  const h = harness();
  const p = await staged(h, "volume:202", "delete-volume");
  await assert.rejects(
    h.backend.execute({
      planId: p.id,
      confirm: true,
      confirmResourceId: "201",
    }),
    /exact volume ID/,
  );
  const out = await h.backend.execute({
    planId: p.id,
    confirm: true,
    confirmResourceId: "202",
  });
  assert.equal(out.operations[0].status, "submitted");
});
test("demo is isolated and read-only, budgets persist, and credentials never enter view state", async () => {
  const h = harness();
  await h.backend.demo();
  await assert.rejects(
    h.backend.stage({
      resourceKey: "vm:101",
      kind: "hibernate",
      hours: 12,
      retainIp: true,
    }),
    /read-only/,
  );
  await h.backend.budget({ budget: 2500 });
  assert.equal((await createBackend(h.options).state()).budget, 2500);
  assert.ok(!JSON.stringify(await h.backend.state()).includes("backend-key"));
  await h.backend.configure({ remove: true });
  assert.equal((await h.backend.state()).snapshot, null);
});
test("interrupted operations become uncertain and are never replayed", async () => {
  const h = harness();
  const p = await staged(h);
  const operation: Operation = {
    id: "interrupted",
    plan: p,
    status: "running",
    at: new Date().toISOString(),
    message: "Running",
  };
  const prior = h.stored() as Saved;
  prior.operations.push(operation);
  const restored = harness(prior);
  assert.equal(
    (await restored.backend.state()).operations[0].status,
    "uncertain",
  );
  assert.ok(!restored.calls.includes("execute"));
});
test("Sync marks submitted operations complete only on positive provider state evidence", async () => {
  const h = harness();
  const p = await staged(h);
  await h.backend.execute({ planId: p.id, confirm: true });
  assert.equal(
    (await h.backend.sync({ period: "month" })).operations[0].status,
    "submitted",
  );
  h.resources[0].state = "HIBERNATED";
  assert.equal(
    (await h.backend.sync({ period: "month" })).operations[0].status,
    "completed",
  );
});

test("unverified organization identity blocks execution and capacity observations are timestamped", async () => {
  const h = harness();
  const p = await staged(h);
  const observed = await h.backend.capacity({ planId: p.id });
  assert.match(observed.plans[0].capacity, /Currently unavailable/);
  assert.ok(observed.plans[0].capacityAt);
  h.options.provider.organization = async () => 1000;
  await assert.rejects(
    h.backend.execute({ planId: p.id, confirm: true }),
    /organization changed/,
  );
  assert.ok(!h.calls.includes("execute"));
});

test("custom date range reaches provider billing windows and invalid ranges never dispatch reads", async () => {
  const h = harness();
  let received: import("../types").Windows | null = null;
  h.options.provider.load = async (...args: unknown[]) => {
    received = args[1] as import("../types").Windows;
    return h.snapshot;
  };
  await h.backend.sync({
    period: "custom",
    start: "2026-11-02",
    end: "2026-11-04",
  });
  assert.deepEqual(received!.current, {
    start: "2026-11-02T00:00:00.000Z",
    end: "2026-11-05T00:00:00.000Z",
  });
  received = null;
  await assert.rejects(
    h.backend.sync({
      period: "custom",
      start: "2026-02-30",
      end: "2026-03-01",
    }),
    /Invalid date range/,
  );
  assert.equal(received, null);
});

test("targeted billing retry restores a missing bill without modifying resources", async () => {
  const h = harness();
  await h.backend.sync({ period: "month" });
  h.resources[0].current = null;
  h.snapshot.billingIssues = [
    {
      resourceKey: "vm:101",
      field: "current",
      message: "Temporarily unavailable",
    },
  ];
  const out = await h.backend.retryBilling({
    resourceKey: "vm:101",
    field: "current",
  });
  assert.equal(out.snapshot!.resources[0].current!.cost, 12);
  assert.equal(out.snapshot!.resources[1].current!.cost, 240);
  assert.equal(out.snapshot!.billingIssues!.length, 0);
  assert.ok(!h.calls.includes("execute"));
});

test("progress stays observable during a pending provider read and finishes after work settles", async () => {
  const h = harness();
  let resolve!: (snapshot: typeof h.snapshot) => void;
  h.options.provider.load = () =>
    new Promise((r) => {
      resolve = r;
    });
  const updates: import("../types").ProgressUpdate[] = [];
  const backend = createBackend({
    ...h.options,
    report: (p) => updates.push(p),
  });
  const pending = backend.sync({ period: "month" });
  for (let n = 0; n < 15; n++) await Promise.resolve();
  assert.ok(updates.some((p) => p.active && /Loading selected/.test(p.label)));
  assert.equal(updates.at(-1)!.active, true);
  resolve(h.snapshot);
  await pending;
  assert.equal(updates.at(-1)!.active, false);
});

test("confirmed provider denial records a failed operation with safe diagnostics rather than an ambiguous submission", async () => {
  const { ProviderError } = await import("../diagnostics");
  const h = harness(),
    p = await staged(h);
  let dispatched = 0;
  h.options.provider.execute = async () => {
    dispatched++;
    throw new ProviderError("Hyperstack denied this action (HTTP 403).", {
      method: "GET",
      path: "/core/virtual-machines/101/hibernate",
      httpStatus: 403,
      providerCode: "permission_denied",
      providerMessage: "VM hibernate permission missing",
      requestId: "req-101",
      observedAt: new Date().toISOString(),
      guidance: "Check the VM hibernation permission.",
    });
  };
  const out = await h.backend.execute({ planId: p.id, confirm: true });
  assert.equal(dispatched, 1);
  assert.equal(out.operations[0].status, "failed");
  assert.equal(out.operations[0].diagnostics!.httpStatus, 403);
  assert.match(out.operations[0].message, /req-101/);
});

test("an unsuccessful retry returns refreshed inline failure evidence instead of leaving the same retry prompt unchanged", async () => {
  const { ProviderError } = await import("../diagnostics");
  const h = harness();
  await h.backend.sync({ period: "month" });
  h.resources[0].current = null;
  h.options.provider.billing = async () => {
    throw new ProviderError("Hyperstack denied a read (HTTP 403).", {
      method: "GET",
      path: "/billing/billing/history/virtual-machine/101",
      httpStatus: 403,
      providerCode: "permission_denied",
      providerMessage: "Billing read permission missing",
      requestId: "req-retry",
      observedAt: new Date().toISOString(),
      guidance: "Grant billing read access, then Sync.",
    });
  };
  const result = await h.backend.retryBilling({
    resourceKey: "vm:101",
    field: "current",
  });
  assert.equal(result.billingRetry!.outcome, "unavailable");
  assert.match(result.billingRetry!.message, /still unavailable/);
  const issue = result.snapshot!.billingIssues![0];
  assert.equal(issue.attempts, 1);
  assert.ok(issue.lastAttemptAt);
  assert.equal(issue.diagnostics!.httpStatus, 403);
  assert.equal(result.snapshot!.resources[0].current, null);
  assert.ok(!h.calls.includes("execute"));
});

test("retry cannot claim restoration when no numeric cost was returned", async () => {
  const h = harness();
  await h.backend.sync({ period: "month" });
  h.resources[0].current = null;
  h.options.provider.billing = async () => ({
    cost: null as unknown as number,
    hours: 0,
    rate: 0,
    includesPublicIp: false,
  });
  const result = await h.backend.retryBilling({
    resourceKey: "vm:101",
    field: "current",
  });
  assert.equal(result.billingRetry!.outcome, "unavailable");
  assert.equal(result.snapshot!.resources[0].current, null);
  assert.equal(
    result.snapshot!.billingIssues![0].retryBlocked,
    "provider-data",
  );
});
