import type {
  Account,
  Scope,
  Resource,
  Group,
  Provider,
  Snapshot,
  Settings,
  PlanAction,
  Operation,
  Target,
  Charge,
} from "../types.ts";
import { DAY, normalizeId, previousPeriod } from "../domain.ts";
import { demoService } from "./service-demo.ts";
import { findingRules } from "../rules.ts";
export const DEMO_NOW = "2026-10-19T12:00:00.000Z";
export const TENANT = "11111111-1111-1111-1111-111111111111";
export const SUB = "22222222-2222-2222-2222-222222222222";
export const OTHER_SUB = "33333333-3333-3333-3333-333333333333";
const unknown = (source: string) => ({
  value: null,
  confidence: "Unknown" as const,
  source,
});
export function demoResources(subscriptionId = SUB): Resource[] {
  const rows = [
    [
      "vm-dev-runner",
      "Microsoft.Compute/virtualMachines",
      "rg-dev",
      184,
      "Running",
      75,
      "Platform team",
    ],
    [
      "disk-build-old",
      "Microsoft.Compute/disks",
      "rg-dev",
      42,
      "Unattached",
      122,
      "",
    ],
    [
      "pip-sandbox",
      "Microsoft.Network/publicIPAddresses",
      "rg-sandbox",
      4,
      "Unassociated",
      0,
      "",
    ],
    [
      "vm-api-test",
      "Microsoft.Compute/virtualMachines",
      "rg-sandbox",
      96,
      "Deallocated",
      32,
      "",
    ],
    [
      "stdevlogs",
      "Microsoft.OperationalInsights/workspaces",
      "rg-dev",
      68,
      "Succeeded",
      181,
      "Observability",
    ],
    [
      "disk-cache",
      "Microsoft.Compute/disks",
      "rg-sandbox",
      38,
      "Attached",
      46,
      "",
    ],
    [
      "vm-platform",
      "Microsoft.Compute/virtualMachines",
      "rg-platform",
      290,
      "Running",
      240,
      "Platform team",
    ],
    [
      "vm-metrics-gap",
      "Microsoft.Compute/virtualMachines",
      "rg-observability",
      35,
      "Running",
      8,
      "SRE",
    ],
    [
      "dbx-analytics",
      "Microsoft.Databricks/workspaces",
      "rg-dev",
      700,
      "Succeeded",
      365,
      "Data platform",
    ],
    [
      "ai-foundry",
      "Microsoft.CognitiveServices/accounts",
      "rg-dev",
      460,
      "Succeeded",
      120,
      "AI platform",
    ],
    [
      "ai-hub",
      "Microsoft.MachineLearningServices/workspaces",
      "rg-sandbox",
      175,
      "Succeeded",
      210,
      "ML platform",
    ],
  ];
  return rows.map(([name, type, group, _cost, state, age, owner], i) => {
    const groupId = `/subscriptions/${subscriptionId}/resourceGroups/${group}`,
      id = `${groupId}/providers/${type}/${name}`;
    const created = new Date(
      Date.parse(DEMO_NOW) - Number(age) * DAY,
    ).toISOString();
    const vm = String(type).endsWith("virtualMachines");
    return {
      tenantId: TENANT,
      subscriptionId,
      id,
      name: String(name),
      type: String(type),
      kind: i === 9 ? "AIServices" : i === 10 ? "Hub" : undefined,
      groupId,
      location: "westeurope",
      sku: vm ? "Standard_D2s_v5" : null,
      state: String(state),
      tags: {
        ...(owner ? { owner: String(owner) } : {}),
        ...(i === 1 ? {} : { environment: "development" }),
        ...(i === 0 ? { "managed-by": "terraform" } : {}),
      },
      etag: `demo-${i}`,
      created: age
        ? {
            value: created,
            confidence: "Verified",
            source: "systemData.createdAt",
          }
        : unknown("Provider does not expose creation metadata"),
      modified: {
        value: new Date(Date.parse(created) + 120000).toISOString(),
        confidence: "Verified",
        source: "Demo systemData.lastModifiedAt (control plane only)",
      },
      creator: age
        ? {
            value: "sp-platform-deploy",
            confidence: "Verified",
            source: "systemData.createdBy",
          }
        : unknown("No retained creation evidence"),
      provisioning:
        i === 0
          ? {
              value: "Terraform",
              confidence: "Inferred",
              source: "managed-by tag",
              explanation:
                "A tag is a hint and can be edited; no deployment state was inspected.",
            }
          : unknown("No provisioning provenance returned"),
      firstObserved: DEMO_NOW,
      events: age
        ? [
            {
              at: created,
              title: "Resource created",
              source: "systemData.createdAt",
            },
            {
              at: new Date(Date.parse(created) + 120000).toISOString(),
              title: "Deployment completed",
              source: "Demo deployment record",
            },
          ]
        : [],
      dependencies: vm
        ? [
            {
              id: `${groupId}/providers/Microsoft.Network/networkInterfaces/${name}-nic`,
              relation: "Network interface",
            },
            {
              id: `${groupId}/providers/Microsoft.Compute/disks/${name}-os`,
              relation: "OS disk",
            },
          ]
        : [],
      gaps: [
        "External consumers and IaC state are not exhaustively discovered.",
      ],
      locks: i === 6 ? ["CanNotDelete at resource group"] : [],
      lockCoverage: true,
      metrics: vm
        ? {
            cpu: i === 0 ? 1.8 : 7.2,
            samples: i === 7 ? 12 : 168,
            expected: 168,
            from: new Date(Date.parse(DEMO_NOW) - 7 * DAY).toISOString(),
            to: DEMO_NOW,
          }
        : undefined,
      attached:
        String(state) === "Unattached" || String(state) === "Unassociated"
          ? false
          : String(type).endsWith("/disks")
            ? true
            : null,
      deleteOptions: vm ? ["Detach", "Detach"] : undefined,
      historyCoverage:
        "Demo fixture. Activity history shown is illustrative; real Azure Activity Log normally retains 90 days.",
    };
  });
}
function demoSignals(r: Resource): Resource["signals"] {
  if (!r.metrics) return undefined;
  return [
    {
      name: "Percentage CPU",
      value: r.metrics!.cpu,
      unit: "%",
      samples: r.metrics!.samples,
      expected: r.metrics!.expected,
      from: r.metrics!.from,
      to: r.metrics!.to,
      explanation: "Isolated demo fixture",
    },
    {
      name: "Available Memory Bytes",
      value: 6 * 1024 ** 3,
      unit: "bytes available",
      samples: 168,
      expected: 168,
      from: r.metrics!.from,
      to: r.metrics!.to,
      explanation: "Simulated free memory, not utilization percent",
    },
    {
      name: "Network In Total",
      value: 1024 ** 3,
      unit: "bytes received",
      samples: 168,
      expected: 168,
      from: r.metrics!.from,
      to: r.metrics!.to,
      explanation: "Simulated network volume",
    },
  ];
}
export class DemoProvider implements Provider {
  constructor(private settings: Settings) {}
  async accounts(): Promise<Account[]> {
    return [
      {
        tenantId: TENANT,
        id: SUB,
        name: "Engineering",
        user: "engineering@contoso.example",
      },
      {
        tenantId: TENANT,
        id: OTHER_SUB,
        name: "Sandbox",
        user: "engineering@contoso.example",
      },
    ];
  }
  async groups(scope: Scope): Promise<Group[]> {
    return ["rg-dev", "rg-sandbox", "rg-platform", "rg-observability"].map(
      (name, i) => ({
        id: `/subscriptions/${scope.subscriptionId}/resourceGroups/${name}`,
        name,
        subscriptionId: scope.subscriptionId,
        location: "westeurope",
        tags: { owner: "Platform team" },
        created: {
          value: "2025-04-01T00:00:00Z",
          confidence: "Verified",
          source: "Resource group systemData (group only)",
        },
        locks: i === 2 ? ["CanNotDelete"] : [],
      }),
    );
  }
  private resources(sub: string) {
    return demoResources(sub)
      .filter((r) => !this.settings.demoOverrides[normalizeId(r.id)]?.deleted)
      .map((r) => ({
        ...r,
        ...this.settings.demoOverrides[normalizeId(r.id)],
      }));
  }
  async snapshot(scope: Scope): Promise<Snapshot> {
    const all = demoResources(scope.subscriptionId),
      groups = await this.groups(scope);
    const within = (groupId: string) =>
      !scope.groupIds.length || scope.groupIds.includes(normalizeId(groupId));
    const makeCosts = (period: Scope, comparison = false): Charge[] => {
      const result: Charge[] = [],
        days = Math.max(
          1,
          Math.round(
            (Date.parse(period.to) - Date.parse(period.from) + 1) / DAY,
          ),
        );
      for (const [i, r] of all.entries())
        if (within(r.groupId) && i !== 7) {
          const base =
            ([184, 42, 4, 96, 68, 38, 290, 0, 700, 460, 175][i] *
              (scope.basis === "AmortizedCost" ? 0.91 : 1) *
              (comparison ? (i === 0 ? 0.65 : 0.94) : 1) *
              days) /
            30;
          for (let d = 0; d < days; d++)
            result.push({
              resourceId: r.id,
              groupId: r.groupId,
              service: r.type.split("/")[0],
              region: r.location,
              day: new Date(Date.parse(period.from) + d * DAY)
                .toISOString()
                .slice(0, 10),
              currency: "USD",
              amount: base / days,
              tags: r.tags,
            });
        }
      if (within(groups[0].id))
        result.push({
          resourceId: `${groups[0].id}/providers/Microsoft.Compute/disks/deleted-historical-disk`,
          groupId: groups[0].id,
          service: "Historical disk charges",
          region: "westeurope",
          day: period.from.slice(0, 10),
          currency: "USD",
          amount: comparison ? 8 : 11,
          tags: { environment: "development" },
        });
      return result;
    };
    const month = {
      ...scope,
      from: DEMO_NOW.slice(0, 7) + "-01T00:00:00.000Z",
      to: DEMO_NOW,
    };
    const snapshot: Snapshot = {
      scope,
      now: DEMO_NOW,
      fetchedAt: new Date().toISOString(),
      groups,
      resources: this.resources(scope.subscriptionId).filter((r) =>
        within(r.groupId),
      ),
      costs: makeCosts(scope),
      previous: makeCosts(previousPeriod(scope), true),
      mtd: makeCosts(month),
      findings: [],
      forecast: [],
      budgets: [
        {
          name: "Engineering monthly budget",
          scopeId: `/subscriptions/${scope.subscriptionId}`,
          amount: 1200,
          currency: "USD",
          spent: 480,
          period: "Monthly · subscription scope",
        },
      ],
      warnings: [
        "Demo mode: consistent fixture clock 19 Oct 2026, 12:00 UTC. Actions only change simulated state.",
        "Costs include historical charges unmatched to current inventory.",
      ],
      coverage: {
        comparison: "Available",
        inventory: "Complete demo fixture",
        costs: "Simulated; excludes vm-metrics-gap",
        metrics: "7-day hourly fixture; one VM has insufficient coverage",
        history: "Fixture evidence; not a live activity history",
        budgets: "Subscription-wide; not filtered to resource groups",
        forecast:
          "Simple projection from scoped month-to-date; not an Azure forecast",
      },
    };
    snapshot.findings = findingRules(snapshot);
    const mtd = snapshot.mtd.reduce((s, c) => s + c.amount, 0);
    snapshot.forecast = [
      {
        amount: (mtd / 19) * 31,
        currency: "USD",
        basis: "Demo: scoped MTD / 19 elapsed days × 31; not Azure-provided.",
      },
    ];
    return snapshot;
  }
  async service(target: Target, scope: Scope) {
    if (
      target.tenantId !== scope.tenantId ||
      target.subscriptionId !== scope.subscriptionId
    )
      throw new Error(
        "Service target differs from current tenant/subscription",
      );
    const r = await this.inspect(target, scope);
    if (!r) throw new Error("Demo service target absent");
    return demoService(r, scope, DEMO_NOW);
  }
  async inspect(target: Target, _scope: Scope) {
    const resource =
      this.resources(target.subscriptionId).find(
        (r) => normalizeId(r.id) === normalizeId(target.id),
      ) ?? null;
    if (
      resource &&
      resource.type.toLowerCase() === "microsoft.compute/virtualmachines"
    )
      resource.resize = {
        checkedAt: DEMO_NOW,
        options: /deallocated/i.test(resource.state)
          ? [
              { name: "Standard_D2s_v5", cores: 2, memoryGB: 8 },
              { name: "Standard_D4s_v5", cores: 4, memoryGB: 16 },
            ].filter((o) => o.name !== resource.sku)
          : [],
        errors: /deallocated/i.test(resource.state)
          ? []
          : [
              "Resize requires a deallocated VM; complete deallocation separately.",
            ],
      };
    if (resource) {
      resource.signals = demoSignals(resource);
      resource.dependencyCoverage = [
        "Demo provider fixture: known references only; no Azure discovery performed",
      ];
    }
    return resource;
  }
  async scan(scope: Scope) {
    const snapshot = await this.snapshot(scope);
    for (const r of snapshot.resources) r.signals = demoSignals(r);
    snapshot.coverage.metrics =
      "Demo fleet utilization fixture; no Azure commands";
    return snapshot;
  }
  async measure(
    operation: Operation,
  ): Promise<NonNullable<Operation["measurement"]>> {
    if (operation.state !== "succeeded")
      throw new Error("Only completed operations can be measured");
    return {
      basis: "ActualCost",
      baselineFrom: "2026-10-01T00:00:00Z",
      baselineTo: "2026-10-07T23:59:59Z",
      postFrom: "2026-10-09T00:00:00Z",
      postTo: "2026-10-15T23:59:59Z",
      measuredAt: DEMO_NOW,
      rows: [{ currency: "USD", baseline: 28, post: 12, change: 16 }],
      explanation:
        "DEMO illustrative seven-day pre/post comparison. Fixture costs do not respond to simulated actions. This is not measured Azure savings or a causal claim.",
    };
  }
  async act(action: PlanAction) {
    const key = normalizeId(action.target.id),
      current = this.settings.demoOverrides[key] ?? {};
    this.settings.demoOverrides[key] = {
      ...current,
      ...(action.kind === "delete"
        ? { deleted: true }
        : action.kind === "resize"
          ? { sku: action.size }
          : action.kind === "tags"
            ? {
                tags: {
                  ...(await this.inspect(action.target, {} as Scope))?.tags,
                  ...action.tags,
                },
              }
            : {
                state:
                  action.kind === "deallocate"
                    ? "Deallocated"
                    : action.kind === "stop"
                      ? "Stopped (allocated)"
                      : "Running",
              }),
    };
  }
  async verify(action: PlanAction, scope: Scope) {
    const r = await this.inspect(action.target, scope);
    return action.kind === "delete" ? !r : !!r;
  }
}
