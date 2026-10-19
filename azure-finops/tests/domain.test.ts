import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateScope,
  validateTarget,
  previousPeriod,
  totals,
  changes,
  reviewAction,
  csv,
  savings,
  normalizeId,
} from "../domain.ts";
import {
  DemoProvider,
  DEMO_NOW,
  TENANT,
  SUB,
  OTHER_SUB,
} from "../providers/demo.ts";
import { defaultSettings, createBackend } from "../backend.ts";
import type { Scope, PlanAction } from "../types.ts";
const scope: Scope = {
  tenantId: TENANT,
  subscriptionId: SUB,
  groupIds: [],
  basis: "ActualCost",
  from: "2026-09-20T00:00:00.000Z",
  to: "2026-10-19T23:59:59.999Z",
};
test("scope identities, dates and equivalent periods cannot cross subscriptions", () => {
  assert.throws(
    () =>
      validateScope({
        ...scope,
        groupIds: [`/subscriptions/${OTHER_SUB}/resourceGroups/rg-dev`],
      }),
    /belong/,
  );
  assert.throws(
    () => validateScope({ ...scope, to: "2024-01-01" }),
    /date range/,
  );
  const before = previousPeriod(scope);
  assert.equal(
    Date.parse(scope.to) - Date.parse(scope.from),
    Date.parse(before.to) - Date.parse(before.from),
  );
  assert.equal(Date.parse(before.to) + 1, Date.parse(scope.from));
});
test("currency totals and newly billed changes retain unmatched historical charges", async () => {
  const snapshot = await new DemoProvider(defaultSettings()).snapshot(scope),
    charge = snapshot.costs[0];
  assert.equal(
    totals([
      { ...charge, amount: 10, currency: "USD" },
      { ...charge, amount: 20, currency: "EUR" },
    ]).length,
    2,
  );
  const change = changes([{ ...charge, amount: 4 }], [])[0];
  assert.equal(change.category, "Newly billed");
  assert.equal(change.percent, null);
  assert.ok(
    snapshot.costs.some((c) => c.resourceId?.includes("deleted-historical")),
  );
  assert.equal(
    snapshot.resources.find((r) => r.name === "pip-sandbox")!.created
      .confidence,
    "Unknown",
  );
  assert.equal(
    snapshot.resources.find((r) => r.name === "disk-build-old")!.tags.owner,
    undefined,
  );
  assert.ok(snapshot.findings.some((f) => f.title === "Low VM CPU"));
  assert.equal(
    snapshot.findings.some(
      (f) => f.target.name === "vm-metrics-gap" && f.title === "Low VM CPU",
    ),
    false,
  );
  assert.ok(savings(snapshot).every((s) => s.amount > 0));
  assert.equal(snapshot.now, DEMO_NOW);
});
test("deletion adapters block locks, unknown attachments, related-delete options and mismatched IDs", async () => {
  const provider = new DemoProvider(defaultSettings()),
    snapshot = await provider.snapshot(scope);
  const disk = snapshot.resources.find((r) => r.name === "disk-build-old")!,
    vm = snapshot.resources.find((r) => r.name === "vm-dev-runner")!;
  const action: PlanAction = {
    id: "a",
    mode: "demo",
    kind: "delete",
    target: disk,
    createdAt: DEMO_NOW,
  };
  assert.equal(reviewAction(action, disk).errors.length, 0);
  assert.match(
    reviewAction(action, { ...disk, attached: null }).errors.join(" "),
    /Attachment/,
  );
  assert.match(
    reviewAction(action, { ...disk, lockCoverage: false }).errors.join(" "),
    /lock discovery/,
  );
  assert.match(
    reviewAction(
      { ...action, target: vm },
      { ...vm, deleteOptions: ["Delete"] },
    ).errors.join(" "),
    /Detach/,
  );
  assert.throws(
    () => validateTarget({ ...disk, subscriptionId: OTHER_SUB }),
    /identity/,
  );
  assert.equal(
    csv(
      [{ name: '=HYPERLINK("x")', value: "a,b" }],
      ["name", "value"],
    ).includes("'=HYPERLINK"),
    true,
  );
});
function backendFixture() {
  const persisted = new Map<string, any>();
  const store = {
    get: (key: string) => persisted.get(key),
    set: (key: string, value: any) =>
      persisted.set(key, structuredClone(value)),
    flush: async () => {},
    has: () => false,
    keys: () => [],
    remove() {},
    clear() {},
  };
  return { backend: createBackend(() => store as any), store, persisted };
}
async function done(backend: ReturnType<typeof createBackend>, jobId: string) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const result = backend.poll({ jobId });
    if (result.state === "error" && "error" in result)
      throw new Error(result.error);
    if (result.state === "done" && "result" in result)
      return result.result as any;
    assert.equal(
      "request" in result,
      false,
      "Demo must never emit host requests",
    );
  }
  throw new Error("Job did not settle.");
}
test("demo actions persist without executing, require one-time deletion review, and record verified outcomes", async () => {
  const f = backendFixture();
  await f.backend.bootstrap();
  const resource = (
    await new DemoProvider(defaultSettings()).snapshot(scope)
  ).resources.find((r) => r.name === "disk-build-old")!;
  const action = await f.backend.addAction({
    mode: "demo",
    kind: "delete",
    target: resource,
  });
  assert.equal(f.backend.state().operations.length, 0);
  assert.equal(f.persisted.get("settings").plan.length, 1);
  const review = await done(
    f.backend,
    f.backend.start({ kind: "review", mode: "demo", scope }).jobId,
  );
  assert.throws(
    () =>
      f.backend.execute({
        token: review.token,
        scope,
        confirmBulk: true,
        names: {},
      }),
    /Type the exact/,
  );
  const execution = f.backend.execute({
    token: review.token,
    scope,
    confirmBulk: true,
    names: { [action.id]: resource.name },
  });
  assert.throws(
    () =>
      f.backend.execute({
        token: review.token,
        scope,
        confirmBulk: true,
        names: { [action.id]: resource.name },
      }),
    /already|expired|used/,
  );
  const result = await done(f.backend, execution.jobId);
  assert.equal(result.operations[0].state, "succeeded");
  assert.equal(result.plan.length, 0);
  const reloaded = createBackend(() => f.store as any);
  await reloaded.bootstrap();
  assert.equal(reloaded.state().operations[0].action.target.id, resource.id);
  const inventory = await done(
    reloaded,
    reloaded.start({ kind: "snapshot", mode: "demo", scope }).jobId,
  );
  assert.equal(
    inventory.resources.some(
      (r: any) => normalizeId(r.id) === normalizeId(resource.id),
    ),
    false,
  );
});
test("conflicting actions, changed resources, and failed durable saves cannot bypass review", async () => {
  const f = backendFixture();
  await f.backend.bootstrap();
  const resource = (await new DemoProvider(defaultSettings()).snapshot(scope))
    .resources[0];
  await f.backend.addAction({ mode: "demo", kind: "start", target: resource });
  await f.backend.addAction({ mode: "demo", kind: "delete", target: resource });
  const review = await done(
    f.backend,
    f.backend.start({ kind: "review", mode: "demo", scope }).jobId,
  );
  assert.ok(
    review.items.every((i: any) =>
      i.errors.some((e: string) => e.includes("Conflicting")),
    ),
  );
  assert.throws(
    () =>
      f.backend.execute({
        token: review.token,
        scope,
        confirmBulk: true,
        names: {},
      }),
    /resolve validation/,
  );
  const failed = createBackend(
    () =>
      ({
        ...f.store,
        flush: async () => {
          throw new Error("fixture write failure");
        },
      }) as any,
  );
  await failed.bootstrap();
  await assert.rejects(
    failed.addAction({ mode: "demo", kind: "deallocate", target: resource }),
    /write failure/,
  );
  assert.equal(failed.state().plan.length, 2);
});

test("execution revalidates drift and preserves per-resource partial failures without retrying", async () => {
  const f = backendFixture(),
    boot = await f.backend.bootstrap(),
    resources = (await new DemoProvider(defaultSettings()).snapshot(scope))
      .resources;
  const disk = resources.find((r) => r.name === "disk-build-old")!,
    ip = resources.find((r) => r.name === "pip-sandbox")!;
  const actions = [];
  for (const r of [disk, ip])
    actions.push(
      await f.backend.addAction({ mode: "demo", kind: "delete", target: r }),
    );
  const review = await done(
    f.backend,
    f.backend.start({ kind: "review", mode: "demo", scope }).jobId,
  );
  boot.settings.demoOverrides[normalizeId(disk.id)] = { attached: true };
  const result = await done(
    f.backend,
    f.backend.execute({
      token: review.token,
      scope,
      confirmBulk: true,
      names: Object.fromEntries(actions.map((a) => [a.id, a.target.name])),
    }).jobId,
  );
  assert.equal(
    result.operations.find((o: any) => o.action.target.name === disk.name)
      .state,
    "failed",
  );
  assert.equal(
    result.operations.find((o: any) => o.action.target.name === ip.name).state,
    "succeeded",
  );
  assert.equal(result.plan.length, 1);
  assert.equal(result.plan[0].target.id, disk.id);
});
