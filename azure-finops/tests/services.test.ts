import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectService,
  databricksRead,
  serviceList,
  serviceKind,
} from "../providers/services.ts";
import { resourceFromAzure } from "../providers/live.ts";
import { validateTarget, DAY } from "../domain.ts";
import { TENANT, SUB } from "../providers/demo.ts";
import type { Scope } from "../types.ts";
const now = new Date().toISOString();
const scope: Scope = {
  tenantId: TENANT,
  subscriptionId: SUB,
  groupIds: [`/subscriptions/${SUB}/resourcegroups/app`],
  basis: "AmortizedCost",
  from: new Date(Date.parse(now) - 30 * DAY).toISOString(),
  to: now,
};
const root = `/subscriptions/${SUB}/resourceGroups/app/providers/`;
const rawDB = {
  id: root + "Microsoft.Databricks/workspaces/analytics",
  name: "analytics",
  type: "Microsoft.Databricks/workspaces",
  properties: {
    workspaceUrl: "adb-123456789.12.azuredatabricks.net",
    managedResourceGroupId: `/subscriptions/${SUB}/resourceGroups/managed-db`,
  },
};
test("Databricks inspection is CLI-only, paginated, separates managed costs and flags configuration rather than safe deletion", async () => {
  const r = resourceFromAzure(rawDB, scope, now),
    calls: string[][] = [];
  let clusterPages = 0,
    relatedScope: Scope | undefined;
  const s = (await inspectService(
    r,
    rawDB,
    scope,
    async () => ({
      value: [
        {
          id: `/subscriptions/${SUB}/resourceGroups/managed-db/providers/Microsoft.Compute/disks/data`,
          name: "data",
          properties: {},
        },
      ],
    }),
    async (args) => {
      calls.push(args);
      const url = new URL(args[args.indexOf("--url") + 1]);
      if (url.pathname.endsWith("clusters/list")) {
        clusterPages++;
        if (clusterPages === 2)
          assert.equal(url.searchParams.get("page_token"), "cursor /?&");
        return {
          items: [
            {
              id: "cluster" + clusterPages,
              name: "interactive",
              state: "RUNNING",
              auto: clusterPages === 1 ? 0 : 30,
            },
          ],
          ...(clusterPages === 1 ? { next: "cursor /?&" } : {}),
        };
      }
      if (url.pathname.endsWith("warehouses"))
        return {
          items: [{ id: "sql", name: "sql", state: "RUNNING", auto: 15 }],
        };
      if (url.pathname.includes("instance-pools"))
        return {
          items: [{ id: "pool", name: "warm", min: 2, idle: 2, used: 0 }],
        };
      return { items: [] };
    },
    async (selected) => {
      relatedScope = selected;
      return [
        {
          resourceId: null,
          groupId: selected.groupIds[0],
          service: "VMs",
          region: "x",
          day: now.slice(0, 10),
          currency: "USD",
          amount: 80,
          tags: {},
        },
      ];
    },
  ))!;
  assert.equal(clusterPages, 2);
  assert.equal(s.candidates.length, 2);
  assert.ok(
    s.candidates.every(
      (c) => c.suggested.includes("review") || c.suggested.includes("Review"),
    ),
  );
  assert.ok(
    s.assets.some((a) => a.category.includes("do not delete directly")),
  );
  assert.equal(relatedScope!.basis, scope.basis);
  assert.deepEqual(relatedScope!.groupIds, [
    `/subscriptions/${SUB}/resourcegroups/managed-db`,
  ]);
  assert.equal(s.relatedCosts[0].costs[0].amount, 80);
  assert.ok(s.relatedCosts[0].explanation.includes("overlap"));
  for (const args of calls) {
    assert.equal(args[0], "rest");
    assert.equal(args[args.indexOf("--method") + 1], "get");
    assert.equal(
      args[args.indexOf("--resource") + 1],
      "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d",
    );
    assert.equal(args[args.indexOf("--subscription") + 1], SUB);
    assert.ok(args.includes("--query"));
    assert.ok(!args.includes("--headers"));
    assert.ok(!args.includes("get-access-token"));
    assert.doesNotMatch(
      args.at(-1)!,
      /spark_conf|parameters|secret|access_token|api_key|authorization|environment/i,
    );
  }
});
test("workspace host, pagination and denied data-plane coverage cannot produce a clean empty workspace", async () => {
  const r = resourceFromAzure(rawDB, scope, now);
  let calls = 0;
  await assert.rejects(
    () =>
      databricksRead(
        async () => {
          calls++;
          return {};
        },
        {
          ...rawDB,
          properties: {
            workspaceUrl: "adb-123.12.azuredatabricks.net.evil.test",
          },
        },
        r,
        "clusters",
        scope,
      ),
    /Workspace URL/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () =>
      databricksRead(
        async () => ({ items: [], more: true }),
        rawDB,
        r,
        "clusters",
        scope,
      ),
    /cursor/,
  );
  const s = (await inspectService(
    r,
    rawDB,
    scope,
    async () => {
      throw new Error("Denied");
    },
    async () => {
      throw new Error("Databricks membership denied");
    },
    async () => {
      throw new Error("Denied");
    },
  ))!;
  assert.equal(s.candidates.length, 0);
  assert.equal(
    s.coverage.filter(
      (c) => c.name.startsWith("Databricks ") && c.state === "Unavailable",
    ).length,
    5,
  );
  assert.ok(s.limitations.some((l) => l.includes("Reader alone")));
});
test("Foundry inspection distinguishes provisioned allocation, usage evidence, missing projects and currencies", async () => {
  const raw = {
    id: root + "Microsoft.CognitiveServices/accounts/ai",
    name: "ai",
    kind: "AIServices",
    type: "Microsoft.CognitiveServices/accounts",
    properties: {},
  };
  const r = resourceFromAzure(raw, scope, now);
  const s = (await inspectService(
    r,
    raw,
    scope,
    async (url) => {
      if (url.includes("/projects?")) throw new Error("Denied");
      return {
        value: [
          {
            id: raw.id + "/deployments/chat",
            name: "chat",
            sku: { name: "ProvisionedManaged", capacity: 100 },
            properties: {
              model: { name: "model", version: "1" },
              provisioningState: "Succeeded",
            },
          },
        ],
      };
    },
    async (args) => {
      if (args.includes("list-definitions"))
        return [
          {
            name: "AzureOpenAIRequests",
            unit: "Count",
            dimensions: ["ModelDeploymentName"],
          },
          {
            name: "AzureOpenAIProvisionedManagedUtilizationV2",
            unit: "Percent",
            dimensions: ["ModelDeploymentName"],
          },
        ];
      const start = Date.parse(args[args.indexOf("--start-time") + 1]);
      return {
        value: [
          {
            timeseries: [
              {
                metadatavalues: [
                  { name: { value: "ModelDeploymentName" }, value: "chat" },
                ],
                data: Array.from({ length: 168 }, (_, i) => ({
                  timeStamp: new Date(start + i * 3600000).toISOString(),
                  total: 0,
                  average: 3,
                })),
              },
            ],
          },
        ],
      };
    },
    async () => [],
  ))!;
  assert.equal(s.kind, "foundry");
  assert.equal(s.assets[0].configuration.includes("capacity 100"), true);
  assert.ok(
    s.coverage.some(
      (c) => c.name.includes("projects") && c.state === "Unavailable",
    ),
  );
  assert.equal(s.signals.length, 2);
  assert.ok(s.signals.every((m) => m.assetId === raw.id + "/deployments/chat"));
  assert.ok(s.candidates.some((c) => c.title.includes("no observed requests")));
  assert.ok(s.candidates.every((c) => !c.suggested.includes("safe to delete")));
});
test("account-level and missing Foundry metrics are never assigned as zero deployment usage", async () => {
  const raw = {
    id: root + "Microsoft.CognitiveServices/accounts/ai",
    name: "ai",
    type: "Microsoft.CognitiveServices/accounts",
    properties: {},
  };
  const s = (await inspectService(
    resourceFromAzure(raw, scope, now),
    raw,
    scope,
    async () => ({ value: [] }),
    async (args) =>
      args.includes("list-definitions")
        ? [{ name: "AzureOpenAIRequests", unit: "Count", dimensions: [] }]
        : { value: [{ timeseries: [] }] },
    async () => [],
  ))!;
  assert.ok(s.signals.some((m) => m.assetId === null && m.value === null));
  assert.equal(s.candidates.length, 0);
});
test("classic Foundry compute minimums and online deployments stay exact and provider pagination cannot escape a collection", async () => {
  const raw = {
    id: root + "Microsoft.MachineLearningServices/workspaces/hub",
    name: "hub",
    kind: "Hub",
    type: "Microsoft.MachineLearningServices/workspaces",
    properties: {},
  };
  const s = (await inspectService(
    resourceFromAzure(raw, scope, now),
    raw,
    scope,
    async (url) => {
      if (url.includes("ResourceGraph")) return { data: [] };
      if (url.includes("/computes?"))
        return {
          value: [
            {
              id: raw.id + "/computes/train",
              name: "train",
              type: "Microsoft.MachineLearningServices/workspaces/computes",
              properties: {
                createdOn: "2025-01-01T00:00:00Z",
                modifiedOn: "2025-02-01T00:00:00Z",
                compute: {
                  vmSize: "Standard_D2s_v5",
                  minNodeCount: 2,
                  currentNodeCount: 2,
                  maxNodeCount: 8,
                },
              },
            },
          ],
        };
      if (url.includes("/onlineEndpoints?"))
        return {
          value: [{ id: raw.id + "/onlineEndpoints/api", name: "api" }],
        };
      if (url.includes("/onlineEndpoints/api/deployments?"))
        return {
          value: [
            {
              id: raw.id + "/onlineEndpoints/api/deployments/blue",
              name: "blue",
              properties: {
                instanceType: "Standard_DS3_v2",
                scaleSettings: { instanceCount: 2 },
              },
            },
          ],
        };
      return { value: [] };
    },
    async () => {
      throw new Error("Must not run inference/compute commands");
    },
    async () => [],
  ))!;
  assert.ok(s.candidates.some((c) => c.title.includes("minimum compute")));
  assert.ok(s.assets.some((a) => a.id.endsWith("/deployments/blue")));
  assert.equal(
    s.assets.find((a) => a.name === "train")?.created?.value,
    "2025-01-01T00:00:00Z",
  );
  assert.match(
    s.assets.find((a) => a.name === "train")?.modified?.source ?? "",
    /properties.modifiedOn/,
  );
  await assert.rejects(
    () =>
      serviceList(
        async () => ({
          value: [],
          nextLink:
            "https://management.azure.com" +
            raw.id +
            "/projects?api-version=2025-06-01",
        }),
        "https://management.azure.com" +
          raw.id +
          "/computes?api-version=2024-10-01",
      ),
    /escaped exact/,
  );
});
test("child service identities are inspectable without expanding mutation authorization", () => {
  const id = root + "Microsoft.CognitiveServices/accounts/ai/deployments/chat";
  const r = {
    tenantId: TENANT,
    subscriptionId: SUB,
    id,
    groupId: `/subscriptions/${SUB}/resourceGroups/app`,
    name: "ai/chat",
    type: "Microsoft.CognitiveServices/accounts/deployments",
  };
  assert.equal(validateTarget(r, true).id, id);
  assert.throws(() => validateTarget(r), /identity|identities/);
  assert.equal(serviceKind(r), "foundry");
  assert.throws(
    () => validateTarget({ ...r, name: "wrong" }, true),
    /identities/,
  );
});
test("last modification stays independent from creation, runtime use and incomplete history", () => {
  const r = resourceFromAzure(
    { ...rawDB, systemData: { lastModifiedAt: "2025-02-01T00:00:00Z" } },
    scope,
    now,
  );
  assert.equal(r.created.value, null);
  assert.equal(r.modified!.value, "2025-02-01T00:00:00Z");
  assert.equal(r.modified!.confidence, "Verified");
  assert.equal(r.activityCoverage, undefined);
  assert.equal(r.attached, null);
  const compute = resourceFromAzure(
    {
      id:
        root +
        "Microsoft.MachineLearningServices/workspaces/hub/computes/train",
      name: "train",
      type: "Microsoft.MachineLearningServices/workspaces/computes",
      properties: {
        createdOn: "2024-01-01T00:00:00Z",
        modifiedOn: "2025-01-01T00:00:00Z",
      },
    },
    scope,
    now,
  );
  assert.equal(compute.created.value, "2024-01-01T00:00:00Z");
  assert.match(compute.modified!.source, /properties.modifiedOn/);
});
