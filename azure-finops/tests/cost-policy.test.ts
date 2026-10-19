import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BillingCooldownError,
  CostReadCoordinator,
  retryAfterMs,
} from "../providers/cost-policy.ts";
import { LiveProvider } from "../providers/live.ts";
import { createBackend } from "../backend.ts";
import { SUB, TENANT } from "../providers/demo.ts";
import type { Scope } from "../types.ts";
function fixture() {
  let now = Date.now();
  const sleeps: number[] = [];
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return {
    clock,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const throttle = (ms?: number) =>
  Object.assign(new Error("429"), {
    throttled: true,
    ...(ms == null ? {} : { retryAfterMs: ms }),
  });
test("retry hints accept only allowlisted header values and honor the longest server delay", () => {
  assert.equal(
    retryAfterMs(
      "Retry-After: 5\nx-ms-ratelimit-microsoft.costmanagement-qpu-retry-after: 17",
    ),
    17000,
  );
  assert.equal(
    retryAfterMs(
      "{'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after': '61'}",
    ),
    61000,
  );
  assert.equal(
    retryAfterMs(
      "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT",
      Date.parse("2026-10-21T07:27:00Z"),
    ),
    60000,
  );
  assert.equal(
    retryAfterMs("Authorization: Bearer PRIVATE\nretry-after: not-a-date"),
    undefined,
  );
});
test("billing reads are paced, retried within bounds, then deferred across refresh jobs", async () => {
  const f = fixture(),
    policy = new CostReadCoordinator({
      clock: f.clock,
      spacingMs: 20000,
      jitter: () => 0,
    });
  let calls = 0;
  const progress: string[] = [];
  assert.equal(
    await policy.request(
      "identity/tenant",
      async () => {
        calls++;
        if (calls === 1) throw throttle(30000);
        return "ok";
      },
      { progress: (s) => progress.push(s) },
    ),
    "ok",
  );
  assert.equal(calls, 2);
  assert.ok(f.sleeps.reduce((a, b) => a + b, 0) >= 30000);
  assert.ok(progress.some((s) => s.includes("retry 1/2")));
  const before = f.clock.now();
  await policy.request("identity/tenant", async () => "next");
  assert.equal(f.clock.now() - before, 20000);
  let denied = 0;
  await assert.rejects(
    () =>
      policy.request("identity/tenant", async () => {
        denied++;
        throw throttle(120000);
      }),
    BillingCooldownError,
  );
  await assert.rejects(
    () =>
      policy.request("identity/tenant", async () => {
        denied++;
        return "wrong";
      }),
    BillingCooldownError,
  );
  assert.equal(
    denied,
    1,
    "Another query or Refresh must not bypass an open cooldown",
  );
  f.advance(120001);
  assert.equal(
    await policy.request("identity/tenant", async () => "recovered"),
    "recovered",
  );
});
test("retry exhaustion and cancellation never send extra billing calls", async () => {
  const f = fixture(),
    policy = new CostReadCoordinator({
      clock: f.clock,
      spacingMs: 0,
      retries: 2,
      jitter: () => 0,
    });
  let calls = 0;
  await assert.rejects(
    () =>
      policy.request("tenant", async () => {
        calls++;
        throw throttle(1000);
      }),
    BillingCooldownError,
  );
  assert.equal(calls, 3);
  let active = true,
    cancelCalls = 0;
  const cancelled = new CostReadCoordinator({
    clock: {
      now: f.clock.now,
      sleep: async (ms) => {
        await f.clock.sleep(ms);
        active = false;
      },
    },
    spacingMs: 0,
    jitter: () => 0,
  });
  await assert.rejects(
    () =>
      cancelled.request(
        "tenant",
        async () => {
          cancelCalls++;
          throw throttle(2000);
        },
        { active: () => active },
      ),
    /stopped/,
  );
  assert.equal(cancelCalls, 1);
  let deniedCalls = 0;
  await assert.rejects(
    () =>
      policy.request("other", async () => {
        deniedCalls++;
        throw new Error("RBAC denied");
      }),
    /RBAC denied/,
  );
  assert.equal(deniedCalls, 1);
});
test("cache deduplicates complete queries, isolates keys, expires and never caches failures", async () => {
  const f = fixture(),
    policy = new CostReadCoordinator({
      clock: f.clock,
      spacingMs: 0,
      jitter: () => 0,
    });
  let calls = 0;
  const work = async () => {
    calls++;
    return [{ amount: 12 }];
  };
  const [a, b] = await Promise.all([
    policy.cached("tenant/sub/groups/Actual/USD", work),
    policy.cached("tenant/sub/groups/Actual/USD", work),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  b.value[0].amount = 99;
  assert.equal(
    (await policy.cached("tenant/sub/groups/Actual/USD", work)).value[0].amount,
    12,
  );
  await policy.cached("tenant/other/groups/Actual/USD", work);
  assert.equal(calls, 2);
  f.advance(600001);
  await policy.cached("tenant/sub/groups/Actual/USD", work);
  assert.equal(calls, 3);
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      () =>
        policy.cached("failure", async () => {
          calls++;
          throw new Error("Incomplete");
        }),
      /Incomplete/,
    );
  assert.equal(calls, 5);
});
test("a throttled snapshot preserves inventory, stops the billing cascade and consolidates warnings", async () => {
  const f = fixture(),
    policy = new CostReadCoordinator({
      clock: f.clock,
      spacingMs: 0,
      retries: 0,
      jitter: () => 0,
    });
  let billingCalls = 0;
  const p = new LiveProvider(async (args) => {
    if (args[0] === "account")
      return { id: SUB, tenantId: TENANT, user: { name: "engineer" } };
    if (args[0] === "group") return [];
    const url = args[args.indexOf("--url") + 1] ?? "";
    if (url.includes("ResourceGraph"))
      return {
        data: [
          {
            id: `/subscriptions/${SUB}/resourceGroups/app/providers/Microsoft.Compute/disks/d`,
            name: "d",
            type: "Microsoft.Compute/disks",
            resourceGroup: "app",
            properties: {},
          },
        ],
      };
    if (url.includes("/query?") || url.includes("/forecast?")) {
      billingCalls++;
      throw throttle(120000);
    }
    return { value: [] };
  }, policy);
  const scope: Scope = {
    tenantId: TENANT,
    subscriptionId: SUB,
    groupIds: [],
    basis: "ActualCost",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-19T23:59:59.999Z",
  };
  const s = await p.snapshot(scope);
  assert.equal(s.resources.length, 1);
  assert.equal(billingCalls, 1);
  assert.equal(s.costs.length, 0);
  assert.equal(s.forecast.length, 0);
  assert.equal(s.coverage.costs, "Throttled / deferred");
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /remaining|deferred/);
  await p.snapshot(scope);
  assert.equal(billingCalls, 1, "A second snapshot shares cooldown state");
});
test("backend preserves sanitized throttle metadata and mutation failures are never replayed", async () => {
  const b = createBackend(
    () => ({ get: () => undefined, set() {}, flush: async () => {} }) as any,
  );
  await b.bootstrap();
  const { jobId } = b.start({ kind: "accounts", mode: "live" });
  await new Promise((r) => setTimeout(r, 0));
  const poll = b.poll({ jobId }) as any;
  b.accept({
    jobId,
    nonce: poll.nonce,
    response: {
      ok: false,
      code: "PROCESS_EXIT_NON_ZERO",
      result: {
        stderr:
          "429 TooManyRequests\nRetry-After: 8\nAuthorization: Bearer PRIVATE",
      },
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const result = b.poll({ jobId });
  assert.equal(result.state, "error");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  let mutations = 0;
  const p = new LiveProvider(async (_args, _reason, mutating) => {
    assert.equal(mutating, true);
    mutations++;
    throw throttle(1);
  });
  await assert.rejects(() =>
    p.act({
      id: "action",
      mode: "live",
      kind: "start",
      createdAt: new Date().toISOString(),
      target: {
        tenantId: TENANT,
        subscriptionId: SUB,
        groupId: `/subscriptions/${SUB}/resourceGroups/app`,
        id: `/subscriptions/${SUB}/resourceGroups/app/providers/Microsoft.Compute/virtualMachines/vm`,
        type: "Microsoft.Compute/virtualMachines",
        name: "vm",
      },
    }),
  );
  assert.equal(mutations, 1);
});

test("live cache survives provider jobs but isolates identity, groups, basis and executable scope", async () => {
  const policy = new CostReadCoordinator({ spacingMs: 0 });
  const calls: string[][] = [];
  let identity = "engineer";
  const cli = async (args: string[]) => {
    if (args[0] === "account")
      return { id: SUB, tenantId: TENANT, user: { name: identity } };
    if (args[0] === "group") return [];
    const url = args[args.indexOf("--url") + 1] ?? "";
    if (url.includes("ResourceGraph")) return { data: [] };
    if (url.includes("/query?") || url.includes("/forecast?")) {
      calls.push(args);
      return {
        properties: {
          columns: [
            { name: "PreTaxCost" },
            { name: "Currency" },
            { name: "ServiceName" },
            { name: "UsageDate" },
          ],
          rows: [[12, "USD", "Compute", 20261010]],
        },
      };
    }
    return { value: [] };
  };
  const scope: Scope = {
    tenantId: TENANT,
    subscriptionId: SUB,
    groupIds: [],
    basis: "ActualCost",
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-15T23:59:59.999Z",
  };
  const load = (s = scope, namespace = "az/scope") =>
    new LiveProvider(cli, policy, { namespace }).snapshot(s);
  const first = await load(),
    count = calls.length;
  assert.ok(count > 0);
  assert.deepEqual(first.breakdowns?.service, [
    { name: "Compute", amount: 12, currency: "USD" },
  ]);
  const cached = await load();
  assert.equal(calls.length, count);
  assert.match(cached.coverage.billingFreshness, /reused/);
  for (const args of calls) {
    assert.equal(
      args[args.indexOf("--headers") + 1],
      "ClientType=FDOAzureFinOps",
    );
    const body = JSON.parse(args[args.indexOf("--body") + 1]);
    assert.notDeepEqual(body.dataset.grouping, [
      { type: "Dimension", name: "ServiceName" },
    ]);
  }
  await load({
    ...scope,
    groupIds: [`/subscriptions/${SUB}/resourcegroups/app`],
  });
  assert.ok(calls.length > count);
  let before = calls.length;
  await load({ ...scope, basis: "AmortizedCost" });
  assert.ok(calls.length > before);
  before = calls.length;
  identity = "another-engineer";
  await load();
  assert.ok(calls.length > before);
  before = calls.length;
  await load(scope, "other-cli/scope");
  assert.ok(calls.length > before);
});
test("host-relayed Retry-After opens shared billing cooldown without exposing diagnostics", async () => {
  const b = createBackend(
    () => ({ get: () => undefined, set() {}, flush: async () => {} }) as any,
  );
  await b.bootstrap();
  const { jobId } = b.start({
    kind: "snapshot",
    mode: "live",
    scope: {
      tenantId: TENANT,
      subscriptionId: SUB,
      groupIds: [],
      basis: "ActualCost",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-19T23:59:59.999Z",
    },
  });
  let billingCalls = 0,
    done: any;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const poll = b.poll({ jobId }) as any;
    if (poll.state !== "running") {
      done = poll;
      break;
    }
    if (!poll.request) continue;
    const args = poll.request.payload.args as string[];
    const url = args[args.indexOf("--url") + 1] ?? "";
    const throttled = url.includes("/query?") || url.includes("/forecast?");
    if (throttled) billingCalls++;
    const output =
      args[0] === "account"
        ? { id: SUB, tenantId: TENANT, user: { name: "engineer" } }
        : args[0] === "group"
          ? []
          : url.includes("ResourceGraph")
            ? { data: [] }
            : { value: [] };
    b.accept({
      jobId,
      nonce: poll.nonce,
      response: throttled
        ? {
            ok: false,
            code: "PROCESS_EXIT_NON_ZERO",
            result: {
              stderr:
                "429 TooManyRequests\nRetry-After: 120\nAuthorization: Bearer PRIVATE",
            },
          }
        : { ok: true, result: { stdout: JSON.stringify(output) } },
    });
  }
  assert.equal(done?.state, "done");
  assert.equal(billingCalls, 1);
  assert.equal(done.result.coverage.costs, "Throttled / deferred");
  assert.equal(done.result.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(done), /PRIVATE/);
});
