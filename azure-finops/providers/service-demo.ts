import type { Resource, Scope, ServiceInspection } from "../types.ts";
import { serviceKind } from "./services.ts";
export function demoService(
  r: Resource,
  scope: Scope,
  DEMO_NOW: string,
): ServiceInspection {
  const kind = serviceKind(r);
  if (!kind) throw new Error("Demo service adapter unavailable");
  const s: ServiceInspection = {
    kind,
    target: {
      tenantId: r.tenantId,
      subscriptionId: r.subscriptionId,
      id: r.id,
      name: r.name,
      type: r.type,
      groupId: r.groupId,
    },
    observedAt: DEMO_NOW,
    from: scope.from,
    to: scope.to,
    basis: scope.basis,
    facts: [
      {
        name: "Mode",
        value: "DEMO — isolated illustrative metadata",
        source: "Fixed demo clock",
      },
      {
        name: "Created at",
        value: r.created.value ?? "Unknown",
        source: r.created.source,
      },
      {
        name: "Last control-plane modification",
        value: r.modified?.value ?? "Unknown",
        source: r.modified?.source ?? "Unknown",
      },
    ],
    coverage: [
      {
        name: "Service metadata",
        state: "Available",
        explanation: "Demo fixtures only; no Azure or Databricks calls.",
      },
      {
        name: "Runtime consumers",
        state: "Unavailable",
        explanation:
          "Interactive users, notebooks, external traffic, owners and retention intent are not proven absent.",
      },
    ],
    assets: [],
    signals: [],
    candidates: [],
    relatedCosts: [],
    limitations: [
      "DEMO fixture. No cleanup action, query, model inference or paid compute is executed.",
      "Age and lack of ARM changes do not establish inactivity or deletion safety. Usage, ownership and dependency review remain required.",
    ],
  };
  if (kind === "databricks") {
    s.facts.push({
      name: "Managed group",
      value: `/subscriptions/${r.subscriptionId}/resourceGroups/databricks-managed-demo`,
      source: "Illustrative separate billing scope",
    });
    s.assets = [
      {
        id: "cluster-demo",
        name: "analytics-interactive",
        category: "Cluster",
        state: "RUNNING",
        configuration:
          "Standard_DS3_v2 · 2–8 workers · automatic termination disabled",
        source: "Demo Databricks metadata",
      },
      {
        id: "warehouse-demo",
        name: "reporting-sql",
        category: "SQL warehouse",
        state: "RUNNING",
        configuration: "Small · 1–2 clusters · auto-stop 20 min",
        source: "Demo Databricks metadata",
      },
      {
        id: "pool-demo",
        name: "etl-warm-pool",
        category: "Instance pool",
        state: "Unknown",
        configuration: "Minimum idle 2 · currently idle 2 / used 0",
        source: "Demo Databricks metadata",
      },
      {
        id: "job-demo",
        name: "nightly-etl",
        category: "Job",
        state: "Unknown",
        configuration: "Schedule UNPAUSED · existing cluster cluster-demo",
        source:
          "Demo job configuration; absence of runs is not evidence of no usage",
      },
    ];
    s.candidates = [
      {
        assetId: "cluster-demo",
        title: "Cluster: automatic shutdown disabled",
        evidence:
          "Explicit auto-termination=0. It can continue consuming compute while running.",
        missing: ["Active notebooks, streaming and scheduled workloads."],
        suggested:
          "Review enabling automatic termination with the owner in Databricks. Do not directly delete managed Azure resources.",
        confidence: "Configuration verified in demo; inactivity unknown",
      },
      {
        assetId: "pool-demo",
        title: "Review warm idle pool minimum",
        evidence: "Minimum idle 2; idle 2, used 0 in this fixture snapshot.",
        missing: [
          "Scheduled runs, cold-start requirements and other pool consumers.",
        ],
        suggested:
          "Review minimum idle allocation through Databricks after workload approval.",
        confidence: "Snapshot only; not historical idle proof",
      },
    ];
    s.relatedCosts = [
      {
        scopeId: `/subscriptions/${r.subscriptionId}/resourceGroups/databricks-managed-demo`,
        explanation:
          "Demo managed-group infrastructure charges; outside selected groups. Separate from workspace/DBU charges; do not double-count overlap.",
        costs: [
          {
            resourceId: `/subscriptions/${r.subscriptionId}/resourceGroups/databricks-managed-demo/providers/Microsoft.Compute/virtualMachines/worker-demo`,
            groupId: `/subscriptions/${r.subscriptionId}/resourceGroups/databricks-managed-demo`,
            service: "Virtual Machines",
            region: r.location,
            day: scope.to.slice(0, 10),
            currency: "USD",
            amount: 156,
            tags: {},
          },
        ],
      },
    ];
    s.limitations.push(
      "Per-cluster DBUs, full SQL/query history and system.billing tables are not read. Querying billing tables may start paid compute.",
    );
  } else {
    const isML = r.type.toLowerCase().includes("machinelearning");
    s.assets = isML
      ? [
          {
            id: r.id + "/computes/training",
            armId: r.id + "/computes/training",
            name: "training",
            category: "Azure ML compute",
            state: "Running",
            configuration: "Standard_DS3_v2 · minimum nodes 2, maximum 8",
            source: "Demo ARM compute allocation",
          },
        ]
      : [
          {
            id: r.id + "/deployments/chat-prod",
            armId: r.id + "/deployments/chat-prod",
            name: "chat-prod",
            category: "Model deployment",
            state: "Succeeded",
            configuration: "gpt-4.1 · ProvisionedManaged · capacity 100",
            source: "Demo ARM allocation",
          },
          {
            id: r.id + "/projects/support",
            armId: r.id + "/projects/support",
            name: "support",
            category: "Foundry project",
            state: "Succeeded",
            configuration:
              "Shared account billing; no fabricated per-project split",
            source: "Demo ARM project",
          },
        ];
    s.candidates = [
      {
        assetId: s.assets[0].id,
        title: isML
          ? "Review minimum compute nodes"
          : "Review provisioned model capacity",
        evidence: isML
          ? "Configured minimum 2 nodes; workload demand not established."
          : "Provisioned capacity 100; observed utilization 4.2% over a seven-day fixture.",
        missing: [
          "Peak workload, failover, consumers, commitment terms and ownership confirmation.",
        ],
        suggested:
          "Review capacity with the workload owner; deleting a deployment may leave commitments and related storage charges.",
        confidence: "Review candidate; cleanup eligibility unknown",
      },
    ];
    if (!isML)
      s.signals = [
        {
          assetId: s.assets[0].id,
          metric: "AzureOpenAIProvisionedManagedUtilizationV2",
          value: 4.2,
          unit: "Percent",
          samples: 168,
          expected: 168,
          from: "2026-10-12T12:00:00.000Z",
          to: DEMO_NOW,
          source: "DEMO hourly utilization fixture; not Azure data",
        },
      ];
    s.limitations.push(
      "Account costs are not assigned to every project/model. Storage, Search, monitoring and commitment charges may be billed independently.",
    );
  }
  return s;
}
