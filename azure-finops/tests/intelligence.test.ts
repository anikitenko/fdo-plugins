import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveProvider, resourceFromAzure } from "../providers/live.ts";
import {
  detectAnomalies,
  utilization,
  discover,
  origin,
  resizeOptions,
} from "../providers/intelligence.ts";
import { actionArgs } from "../actions.ts";
import { reviewAction } from "../domain.ts";
import { defaultSettings, createBackend } from "../backend.ts";
import { DemoProvider, SUB, TENANT } from "../providers/demo.ts";
import type { Scope, Snapshot, Operation, PlanAction } from "../types.ts";
const scope: Scope = {
  tenantId: TENANT,
  subscriptionId: SUB,
  groupIds: [],
  from: "2026-09-01T00:00:00Z",
  to: "2026-10-18T23:59:59Z",
  basis: "AmortizedCost",
};
const rid = `/subscriptions/${SUB}/resourceGroups/rg-dev/providers/Microsoft.Compute/virtualMachines/vm`;
const raw = {
  id: rid,
  name: "vm",
  type: "Microsoft.Compute/virtualMachines",
  location: "westeurope",
  properties: {
    hardwareProfile: { vmSize: "Standard_D2s_v5" },
    storageProfile: { osDisk: { deleteOption: "Detach" } },
    networkProfile: { networkInterfaces: [] },
  },
  systemData: {
    createdAt: "2025-01-01",
    createdBy: "person@example.com",
    createdByType: "User",
  },
};
const wait = async (b: any, id: string) => {
  for (let i = 0; i < 200; i++) {
    const r = b.poll({ jobId: id });
    if (r.state === "done") return r.result;
    if (r.state === "error") throw new Error(r.error);
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("Timeout");
};
test("forecasts preserve exact group scopes, cost basis, currency and reject partial group totals", async () => {
  const calls: string[][] = [];
  const provider = new LiveProvider(async (args) => {
    calls.push(args);
    if (args[0] === "account") return { id: SUB, tenantId: TENANT };
    if (args[0] === "group") return [];
    const url = args[args.indexOf("--url") + 1] ?? "";
    if (url.includes("/forecast?"))
      return {
        properties: {
          columns: [
            { name: "PreTaxCost" },
            { name: "Currency" },
            { name: "CostStatus" },
          ],
          rows: [
            [12, "USD", "Forecast"],
            [9, "EUR", "Forecast"],
            [1000, "USD", "Actual"],
          ],
        },
      };
    if (url.includes("ResourceGraph")) return { data: [] };
    if (url.includes("/query?")) throw new Error("No costs fixture");
    return { value: [] };
  });
  const groups = [
    `/subscriptions/${SUB}/resourcegroups/a`,
    `/subscriptions/${SUB}/resourcegroups/b`,
  ];
  const s = await provider.snapshot({ ...scope, groupIds: groups });
  assert.deepEqual(
    s.forecast.map((f) => [f.currency, f.amount]),
    [
      ["USD", 24],
      ["EUR", 18],
    ],
  );
  for (const call of calls.filter((c) =>
    c.some((v) => v.includes("/forecast?")),
  )) {
    const body = JSON.parse(call[call.indexOf("--body") + 1]);
    assert.equal(body.type, "AmortizedCost");
    assert.equal(body.includeActualCost, false);
    assert.ok(
      groups.some((id) =>
        call.some((v) =>
          v.includes(id + "/providers/Microsoft.CostManagement/forecast"),
        ),
      ),
    );
  }
  const denied = new LiveProvider(async (args) => {
    if (args[0] === "account") return { id: SUB, tenantId: TENANT };
    if (args[0] === "group") return [];
    const url = args[args.indexOf("--url") + 1] ?? "";
    if (url.includes("/resourcegroups/a/") && url.includes("/forecast?"))
      return {
        properties: {
          columns: [{ name: "Cost" }, { name: "Currency" }],
          rows: [[12, "USD"]],
        },
      };
    throw new Error("Permission denied");
  });
  const partial = await denied.snapshot({ ...scope, groupIds: groups });
  assert.equal(partial.forecast.length, 0);
  assert.match(partial.coverage.forecast, /Unavailable/);
});
test("statistical anomalies use prior history, currency isolation and never substitute for Azure anomalies", () => {
  const s = {
    scope: { ...scope, from: "2026-09-01" },
    now: "2026-10-19T12:00:00Z",
    coverage: { costs: "Available", comparison: "Available" },
    previous: [],
    costs: Array.from({ length: 30 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10),
      amount: i === 25 ? 100 : 10,
      currency: "USD",
    })),
  } as unknown as Snapshot;
  const rows = detectAnomalies(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, "2026-09-26");
  assert.equal(rows[0].source, "Plugin statistical check");
  assert.equal(
    detectAnomalies({
      ...s,
      coverage: { costs: "Available", comparison: "Unavailable" },
    }).length,
    0,
  );
});
test("fleet metric signals preserve independent memory denial and hourly network coverage", async () => {
  const r = resourceFromAzure(raw, scope, new Date().toISOString());
  await utilization(r, scope, async (args) => {
    const name = args[args.indexOf("--metric") + 1];
    if (name === "Available Memory Bytes") throw new Error("Denied");
    const key = name === "Percentage CPU" ? "average" : "total";
    return {
      value: [{ timeseries: [{ data: [{ [key]: 4 }, { [key]: 8 }] }] }],
    };
  });
  assert.equal(r.metrics?.cpu, 6);
  assert.equal(
    r.signals?.find((s) => s.name === "Available Memory Bytes")?.value,
    null,
  );
  assert.equal(
    r.signals?.find((s) => s.name === "Network In Total")?.value,
    12,
  );
  assert.equal(r.signals?.length, 4);
});
test("dependency discovery finds inbound, outbound NIC and backup references, excluding substring matches", async () => {
  const nic = `/subscriptions/${SUB}/resourceGroups/rg-dev/providers/Microsoft.Network/networkInterfaces/nic`;
  const pip = `/subscriptions/${SUB}/resourceGroups/rg-dev/providers/Microsoft.Network/publicIPAddresses/ip`;
  const r = resourceFromAzure(
    {
      ...raw,
      properties: { networkProfile: { networkInterfaces: [{ id: nic }] } },
    },
    scope,
    new Date().toISOString(),
  );
  await discover(
    r,
    { properties: { nic: { id: nic } } },
    async (_url, _method, body: any) => ({
      data: body.query.startsWith("Recovery")
        ? [{ id: rid + "/backup", properties: { sourceResourceId: rid } }]
        : [
            { id: rid + "/consumer", properties: { vmId: rid } },
            { id: rid + "/false", properties: { text: rid + "-other" } },
          ],
    }),
    async () => ({
      properties: {
        ipConfigurations: [{ properties: { publicIPAddress: { id: pip } } }],
      },
    }),
  );
  assert.ok(r.dependencies.some((d) => d.id === pip));
  assert.ok(r.dependencies.some((d) => d.relation.includes("Backup")));
  assert.ok(r.dependencies.some((d) => d.relation.includes("Inbound")));
  assert.ok(!r.dependencies.some((d) => d.id.endsWith("/false")));
  assert.ok(r.dependencyCoverage!.length >= 3);
});
test("deployment target evidence and Bicep compiler metadata do not fabricate original creator or creation", async () => {
  const r = resourceFromAzure(
    { ...raw, systemData: undefined },
    scope,
    new Date().toISOString(),
  );
  const deployment = `/subscriptions/${SUB}/resourceGroups/rg-dev/providers/Microsoft.Resources/deployments/build`;
  await origin(
    r,
    async (args) => {
      assert.equal(args[0], "deployment");
      assert.equal(args.at(-1), "metadata._generator");
      return { name: "bicep" };
    },
    async (url) =>
      url.includes("/operations?")
        ? [
            {
              properties: {
                targetResource: { id: rid },
                timestamp: "2026-09-02",
                provisioningOperation: "Create",
              },
            },
          ]
        : [
            {
              id: deployment,
              name: "build",
              properties: { timestamp: "2026-09-02" },
            },
          ],
  );
  assert.equal(r.provisioning.value, "Bicep");
  assert.equal(r.provisioning.confidence, "Inferred");
  assert.equal(r.created.value, null);
  assert.equal(r.creator.value, null);
  assert.ok(r.events.some((e) => e.title.includes("not creation proof")));
});
test("resize blocks active VMs and permits only compatible Azure options with quota", async () => {
  const r = resourceFromAzure(raw, scope, new Date().toISOString());
  r.state = "Running";
  await resizeOptions(r, raw, async () => {
    throw new Error("must not query");
  });
  assert.equal(r.resize?.options.length, 0);
  r.state = "VM deallocated";
  const cap = (cpu: string) =>
    Object.entries({
      CpuArchitectureType: "x64",
      HyperVGenerations: "V2",
      DiskControllerTypes: "SCSI",
      PremiumIO: "True",
      MaxResourceVolumeMB: "0",
      MaxDataDiskCount: "8",
      MaxNetworkInterfaces: "4",
      vCPUs: cpu,
      MemoryGB: "16",
    }).map(([name, value]) => ({ name, value }));
  await resizeOptions(r, raw, async (args) =>
    args[1] === "list-vm-resize-options"
      ? [{ name: "Standard_D4s_v5" }, { name: "Standard_D8s_v5" }]
      : args[1] === "list-skus"
        ? [
            {
              name: "Standard_D2s_v5",
              family: "family",
              capabilities: cap("2"),
              restrictions: [],
            },
            {
              name: "Standard_D4s_v5",
              family: "family",
              capabilities: cap("4"),
              restrictions: [],
            },
            {
              name: "Standard_D8s_v5",
              family: "family",
              capabilities: cap("8"),
              restrictions: [{ type: "Location" }],
            },
          ]
        : [
            { name: { value: "cores" }, limit: 100, currentValue: 2 },
            { name: { value: "family" }, limit: 100, currentValue: 2 },
          ],
  );
  assert.deepEqual(
    r.resize?.options.map((o) => o.name),
    ["Standard_D4s_v5"],
  );
  r.lockCoverage = true;
  const action: PlanAction = {
    id: "a",
    kind: "resize",
    size: "Standard_D4s_v5",
    mode: "live",
    target: r,
    createdAt: new Date().toISOString(),
  };
  assert.equal(reviewAction(action, r).errors.length, 0);
  assert.ok(
    reviewAction({ ...action, size: "Standard_D8s_v5" }, r).errors.length > 0,
  );
  assert.deepEqual(actionArgs(action).slice(0, 6), [
    "vm",
    "resize",
    "--ids",
    rid,
    "--size",
    "Standard_D4s_v5",
  ]);
});
test("every mutation requires typed target confirmation, including start and tags", async () => {
  for (const kind of [
    "start",
    "tags",
    "deallocate",
    "restart",
    "stop",
  ] as const) {
    const storage = new Map();
    const b = createBackend(
      () =>
        ({
          get: (k: string) => storage.get(k),
          set: (k: string, v: any) => storage.set(k, structuredClone(v)),
          flush: async () => {},
        }) as any,
    );
    await b.bootstrap();
    const r = (
      await new DemoProvider(defaultSettings()).snapshot(scope)
    ).resources.find(
      (r) => r.type.toLowerCase() === "microsoft.compute/virtualmachines",
    )!;
    await b.addAction({
      mode: "demo",
      kind,
      target: r,
      tags: { owner: "team" },
    });
    const review = await wait(
      b,
      b.start({ mode: "demo", kind: "review", scope }).jobId,
    );
    assert.throws(
      () =>
        b.execute({ token: review.token, scope, confirmBulk: true, names: {} }),
      /Type the exact/,
    );
    assert.equal(b.state().operations.length, 0);
  }
});
test("observed changes enforce lag and compare same exact target/basis without combining currencies", async () => {
  let costCall = 0;
  const calls: string[][] = [];
  const p = new LiveProvider(async (args) => {
    calls.push(args);
    if (args[0] === "account") return { id: SUB, tenantId: TENANT };
    costCall++;
    return {
      properties: {
        columns: [
          { name: "ResourceId" },
          { name: "PreTaxCost" },
          { name: "Currency" },
          { name: "UsageDate" },
        ],
        rows: [
          [rid, costCall === 1 ? 28 : 14, "USD", 20250101],
          [rid + "-unrelated", 900, "USD", 20250101],
          [rid, costCall === 1 ? 7 : 9, "EUR", 20250101],
        ],
      },
    };
  });
  const op = {
    id: "op",
    startedAt: "2025-01-08T12:00:00Z",
    identity: "user",
    correlationIds: [],
    message: "Verified",
    state: "succeeded",
    endedAt: "2025-01-08T12:00:00Z",
    action: {
      id: "action",
      createdAt: "2025-01-08T12:00:00Z",
      kind: "deallocate",
      mode: "live",
      target: resourceFromAzure(raw, scope, "2025-01-01"),
    },
  } as Operation;
  const m = await p.measure(op);
  assert.deepEqual(
    m.rows.map((r) => [r.currency, r.change]),
    [
      ["USD", 14],
      ["EUR", -2],
    ],
  );
  assert.match(m.explanation, /not proven causal/);
  assert.ok(
    calls
      .filter((a) => a.includes("--body"))
      .every(
        (a) => JSON.parse(a[a.indexOf("--body") + 1]).type === "ActualCost",
      ),
  );
  await assert.rejects(
    () => p.measure({ ...op, endedAt: new Date().toISOString() }),
    /Measurement pending/,
  );
});
