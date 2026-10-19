import type {
  Account,
  Scope,
  Group,
  Resource,
  Provider,
  Snapshot,
  PlanAction,
  Target,
  Charge,
  Finding,
  ServiceInspection,
  Operation,
} from "../types.ts";
import { inspectService } from "./services.ts";
import { actionArgs } from "../actions.ts";
import { DAY, normalizeId, previousPeriod } from "../domain.ts";
import {
  utilization,
  discover,
  origin,
  resizeOptions,
  detectAnomalies,
} from "./intelligence.ts";
import { findingRules } from "../rules.ts";
export type Cli = (
  args: string[],
  reason: string,
  mutating?: boolean,
) => Promise<any>;
const unknown = (source: string) => ({
  value: null,
  confidence: "Unknown" as const,
  source,
});
export function resourceFromAzure(
  raw: any,
  scope: Scope,
  now: string,
): Resource {
  const id = String(raw.id),
    match = /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)/i.exec(id),
    p = raw.properties ?? {};
  const mlCompute =
    String(raw.type).toLowerCase() ===
    "microsoft.machinelearningservices/workspaces/computes";
  const modified =
    raw.systemData?.lastModifiedAt ?? (mlCompute ? p.modifiedOn : null);
  const created =
    raw.systemData?.createdAt ??
    (mlCompute ? p.createdOn : null) ??
    (["microsoft.compute/disks", "microsoft.compute/virtualmachines"].includes(
      String(raw.type).toLowerCase(),
    )
      ? p.timeCreated
      : null);
  const tags = Object.fromEntries(
    Object.entries(raw.tags ?? {}).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
  const refs: { id: string; relation: string }[] = [];
  for (const d of [
    p.storageProfile?.osDisk,
    ...(p.storageProfile?.dataDisks ?? []),
  ])
    if (d?.managedDisk?.id)
      refs.push({ id: d.managedDisk.id, relation: "Managed disk" });
  for (const nic of p.networkProfile?.networkInterfaces ?? [])
    if (nic.id) refs.push({ id: nic.id, relation: "Network interface" });
  if (raw.managedBy) refs.push({ id: raw.managedBy, relation: "Attached to" });
  const type = String(raw.type).toLowerCase(),
    vm = type === "microsoft.compute/virtualmachines";
  const options = vm
    ? [
        p.storageProfile?.osDisk?.deleteOption,
        ...(p.storageProfile?.dataDisks ?? []).map((d: any) => d.deleteOption),
        ...(p.networkProfile?.networkInterfaces ?? []).map(
          (n: any) => n.properties?.deleteOption ?? n.deleteOption,
        ),
      ].map((v) => v ?? "Unknown")
    : undefined;
  return {
    id,
    name: String(raw.name),
    type: String(raw.type),
    tenantId: scope.tenantId,
    subscriptionId: scope.subscriptionId,
    groupId: match?.[1] ?? "",
    kind: raw.kind,
    location: raw.location ?? "Unknown",
    sku: raw.sku?.name ?? p.hardwareProfile?.vmSize ?? null,
    state:
      p.extended?.instanceView?.powerState?.displayStatus ??
      p.extended?.instanceView?.powerState?.code ??
      p.provisioningState ??
      "Unknown",
    tags,
    etag: raw.etag,
    created: created
      ? {
          value: created,
          confidence: "Verified",
          source: raw.systemData?.createdAt
            ? "systemData.createdAt"
            : mlCompute
              ? "Azure ML compute properties.createdOn"
              : "Provider properties.timeCreated",
        }
      : unknown("Creation metadata not exposed"),
    modified: modified
      ? {
          value: modified,
          confidence: "Verified",
          source: raw.systemData?.lastModifiedAt
            ? "systemData.lastModifiedAt (control plane, not workload interactions)"
            : "Azure ML compute properties.modifiedOn (control plane, not workload interactions)",
        }
      : unknown(
          "Last control-plane modification metadata not exposed; retained history is not lifetime coverage",
        ),
    creator: raw.systemData?.createdBy
      ? {
          value: raw.systemData.createdBy,
          confidence: "Verified",
          source: `systemData.createdBy (${raw.systemData.createdByType ?? "unknown type"})`,
        }
      : unknown("Creator not exposed; owner tags are not creator evidence"),
    provisioning: tags["managed-by"]
      ? {
          value: tags["managed-by"],
          confidence: "Inferred",
          source: "managed-by tag",
          explanation:
            "Tag evidence only; no IaC state or authoritative tool signature verified.",
        }
      : unknown("No tool attribution evidence"),
    firstObserved: now,
    events: created
      ? [
          {
            at: created,
            title: "Resource created",
            source: raw.systemData?.createdAt
              ? "systemData"
              : "Provider creation metadata",
          },
        ]
      : [],
    dependencies: refs,
    gaps: [
      "References are provider-reported, not a complete dependency graph.",
      "External DNS, backups, cross-subscription consumers and IaC state are not proven absent.",
    ],
    locks: [],
    lockCoverage: false,
    attached:
      type === "microsoft.compute/disks"
        ? !!(
            raw.managedBy ||
            p.managedBy ||
            (raw.managedByExtended ?? p.managedByExtended ?? []).length
          )
          ? true
          : p.diskState === "Unattached"
            ? false
            : null
        : type === "microsoft.network/publicipaddresses"
          ? !!(p.ipConfiguration || p.natGateway)
          : null,
    deleteOptions: options,
    historyCoverage:
      "Activity Log normally retains 90 days; Resource Graph changes normally retain 14 days. Missing history does not prove absence.",
  };
}
export class LiveProvider implements Provider {
  private subscriptionId = "";
  constructor(private cli: Cli) {}
  async accounts(): Promise<Account[]> {
    // account show detects missing CLI or missing manual sign-in; never run login or token commands.
    await this.cli(
      ["account", "show"],
      "Check Azure CLI availability and manual sign-in",
    );
    const rows = await this.cli(
      ["account", "list", "--all"],
      "List subscriptions visible to the signed-in CLI identity",
    );
    return rows
      .filter((a: any) => a.state === "Enabled")
      .map((a: any) => ({
        tenantId: a.tenantId,
        id: a.id,
        name: a.name,
        user: a.user?.name ?? "Unknown identity",
      }));
  }
  private async account(scope: Scope) {
    const a = await this.cli(
      ["account", "show", "--subscription", scope.subscriptionId],
      "Verify exact subscription and tenant context",
    );
    if (
      normalizeId(a.id) !== normalizeId(scope.subscriptionId) ||
      normalizeId(a.tenantId) !== normalizeId(scope.tenantId)
    )
      throw new Error(
        "CLI tenant/subscription context changed. Sign in manually and review the scope again.",
      );
    this.subscriptionId = scope.subscriptionId;
  }
  async groups(scope: Scope): Promise<Group[]> {
    await this.account(scope);
    const rows = await this.cli(
      ["group", "list", "--subscription", scope.subscriptionId],
      "List resource groups for the selected subscription",
    );
    return rows.map((g: any) => ({
      id: g.id,
      name: g.name,
      subscriptionId: scope.subscriptionId,
      location: g.location,
      tags: g.tags ?? {},
      created: g.systemData?.createdAt
        ? {
            value: g.systemData.createdAt,
            confidence: "Verified",
            source: "Resource group systemData; not resource age",
          }
        : unknown("Group creation metadata not exposed"),
      locks: [],
    }));
  }
  private async rest(
    url: string,
    method = "get",
    body?: unknown,
    query?: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.origin !== "https://management.azure.com" ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Rejected a non-Azure-management pagination URL.");
    if (!this.subscriptionId)
      throw new Error("Verify subscription context before Azure REST calls.");
    const requestedSubscription = /^\/subscriptions\/([^/]+)/i.exec(
      parsed.pathname,
    )?.[1];
    if (
      requestedSubscription &&
      normalizeId(requestedSubscription) !== normalizeId(this.subscriptionId)
    )
      throw new Error("Rejected a cross-subscription pagination URL.");
    return this.cli(
      [
        "rest",
        "--method",
        method,
        "--url",
        url,
        "--subscription",
        this.subscriptionId,
        ...(body ? ["--body", JSON.stringify(body)] : []),
        ...(query ? ["--query", query] : []),
      ],
      `Azure ${method.toUpperCase()} ${parsed.pathname}`,
    );
  }
  private async list(url: string, query?: string) {
    const values: any[] = [];
    const seen = new Set<string>();
    for (let page = 0; url; page++) {
      if (page >= 100 || seen.has(url))
        throw new Error(
          "Pagination limit reached; data is incomplete. Narrow the scope.",
        );
      seen.add(url);
      const response = await this.rest(url, "get", undefined, query);
      values.push(...(response.value ?? []));
      url = response.nextLink ?? "";
    }
    return values;
  }
  private async inventory(scope: Scope) {
    const rows: any[] = [];
    let skip: string | undefined;
    const seen = new Set<string>();
    do {
      const body: any = {
        subscriptions: [scope.subscriptionId],
        query:
          "Resources | project id, name, type, kind, location, resourceGroup, tags, properties, sku, managedBy",
        options: {
          $top: 1000,
          resultFormat: "objectArray",
          ...(skip ? { $skipToken: skip } : {}),
        },
      };
      const response = await this.rest(
        "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
        "post",
        body,
      );
      rows.push(...response.data);
      skip = response.$skipToken;
      if (skip && (seen.has(skip) || seen.size >= 100))
        throw new Error(
          "Resource Graph pagination is incomplete. Narrow the scope.",
        );
      if (skip) seen.add(skip);
    } while (skip);
    return rows
      .filter(
        (r) =>
          !scope.groupIds.length ||
          scope.groupIds.includes(
            normalizeId(
              `/subscriptions/${scope.subscriptionId}/resourceGroups/${r.resourceGroup}`,
            ),
          ),
      )
      .map((r) => resourceFromAzure(r, scope, new Date().toISOString()));
  }
  private async costRows(
    scope: Scope,
    groupings = ["ResourceId", "ServiceName"],
  ) {
    const dataset: any = {
      granularity: "Daily",
      aggregation: { cost: { name: "PreTaxCost", function: "Sum" } },
      grouping: groupings.map((name) => ({
        type: name === "owner" ? "TagKey" : "Dimension",
        name,
      })),
    };
    if (scope.groupIds.length)
      dataset.filter = {
        dimensions: {
          name: "ResourceGroupName",
          operator: "In",
          values: scope.groupIds.map((id) => id.split("/").at(-1)),
        },
      };
    const body = {
      type: scope.basis,
      timeframe: "Custom",
      timePeriod: { from: scope.from, to: scope.to },
      dataset,
    };
    let url = `https://management.azure.com/subscriptions/${scope.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`;
    const rows: any[] = [];
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url) || seen.size >= 100)
        throw new Error(
          "Cost pagination is incomplete. Narrow the date range.",
        );
      seen.add(url);
      const response = await this.rest(url, "post", body),
        p = response.properties;
      if (!p?.columns || !Array.isArray(p.rows))
        throw new Error("Cost Management returned an unsupported schema.");
      rows.push(
        ...p.rows.map((row: any[]) =>
          Object.fromEntries(
            p.columns.map((c: any, i: number) => [c.name, row[i]]),
          ),
        ),
      );
      url = p.nextLink ?? "";
    }
    return rows;
  }
  private async costs(scope: Scope): Promise<Charge[]> {
    return (await this.costRows(scope)).map((row) => {
      const resourceId = row.ResourceId || null,
        id = resourceId ? String(resourceId) : null;
      const group = id
        ? (/^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)/i.exec(id)?.[1] ??
          null)
        : null;
      const date = String(row.UsageDate ?? "");
      const amount = Number(row.PreTaxCost ?? row.Cost ?? row.cost);
      if (!Number.isFinite(amount) || !row.Currency)
        throw new Error(
          "Cost or currency is missing; no zero total was fabricated.",
        );
      return {
        resourceId: id,
        groupId: group,
        service: row.ServiceName ?? "Unspecified service",
        region: "Not returned",
        day: /^\d{8}$/.test(date)
          ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
          : date,
        currency: String(row.Currency),
        amount,
        tags: {},
      };
    });
  }
  async snapshot(scope: Scope): Promise<Snapshot> {
    await this.account(scope);
    const now = new Date().toISOString();
    const snapshot: Snapshot = {
      scope,
      now,
      fetchedAt: now,
      groups: [],
      resources: [],
      costs: [],
      previous: [],
      mtd: [],
      budgets: [],
      forecast: [],
      findings: [],
      warnings: [],
      coverage: {},
      breakdowns: {},
    };
    const attempt = async (key: string, work: () => Promise<void>) => {
      try {
        await work();
        snapshot.coverage[key] = "Available";
      } catch (e) {
        snapshot.coverage[key] = "Unavailable / partial";
        snapshot.warnings.push(
          `${key}: ${e instanceof Error ? e.message : "Unavailable"}`,
        );
      }
    };
    await attempt("groups", async () => {
      snapshot.groups = await this.groups(scope);
    });
    await attempt("inventory", async () => {
      snapshot.resources = await this.inventory(scope);
    });
    await attempt("costs", async () => {
      snapshot.costs = await this.costs(scope);
    });
    await attempt("comparison", async () => {
      snapshot.previous = await this.costs(previousPeriod(scope));
    });
    await attempt("monthToDate", async () => {
      snapshot.mtd = await this.costs({
        ...scope,
        from: now.slice(0, 7) + "-01T00:00:00.000Z",
        to: now,
      });
    });
    for (const [key, dimension] of [
      ["service", "ServiceName"],
      ["region", "ResourceLocation"],
      ["owner", "owner"],
    ])
      await attempt(`${key}Breakdown`, async () => {
        const rows = await this.costRows(scope, [dimension]);
        const totals = new Map<
          string,
          { name: string; amount: number; currency: string }
        >();
        for (const row of rows) {
          const name = String(row[dimension] ?? row.TagValue ?? "Unassigned"),
            currency = String(row.Currency ?? "Unknown"),
            amount = Number(row.PreTaxCost ?? row.Cost ?? row.cost);
          if (!Number.isFinite(amount) || currency === "Unknown")
            throw new Error("Missing amount or currency.");
          const key = currency + "|" + name;
          const existing = totals.get(key) ?? { name, amount: 0, currency };
          existing.amount += amount;
          totals.set(key, existing);
        }
        snapshot.breakdowns![key] = [...totals.values()];
      });
    await attempt("budgets", async () => {
      const scopes = [
        `/subscriptions/${scope.subscriptionId}`,
        ...scope.groupIds,
      ];
      for (const scopeId of scopes)
        for (const b of await this.list(
          `https://management.azure.com${scopeId}/providers/Microsoft.Consumption/budgets?api-version=2024-08-01`,
        )) {
          const p = b.properties;
          snapshot.budgets.push({
            name: b.name,
            scopeId,
            amount: p.amount,
            currency: p.currentSpend?.unit ?? null,
            spent: p.currentSpend?.amount ?? null,
            period: p.timeGrain,
          });
        }
    });
    await attempt("forecast", async () => {
      snapshot.forecast = await this.forecast(scope, now);
    });
    await attempt("anomalyAlerts", async () => {
      const scopeId = `/subscriptions/${scope.subscriptionId}`;
      snapshot.anomalyAlerts = (
        await this.list(
          `https://management.azure.com${scopeId}/providers/Microsoft.CostManagement/scheduledActions?api-version=2025-03-01`,
        )
      )
        .filter(
          (a) =>
            a.kind === "InsightAlert" || a.properties?.kind === "InsightAlert",
        )
        .map((a) => ({
          name: String(a.properties?.displayName ?? a.name),
          status: String(a.properties?.status ?? "Unknown"),
          scopeId,
        }));
    });
    snapshot.coverage.anomalies =
      "Azure anomaly insight records are available in subscription Cost Analysis; the public Scheduled Actions API exposes alert configuration, not detected records. Plugin statistical checks are separate.";
    snapshot.anomalies = detectAnomalies(snapshot);
    snapshot.coverage.metrics =
      "Use Scan VM utilization in Optimization for all VMs in this scope; individual details also collect CPU, available memory and network volume. Missing signals stay unknown.";
    snapshot.coverage.history =
      "Load resource details for retained activity and Resource Graph changes.";
    snapshot.coverage.budgets +=
      " · actual Azure scope retained; subscription budgets are broader than selected groups.";
    snapshot.findings = findingRules(snapshot);
    await attempt("advisor", async () => {
      const recommendations = await this.list(
        `https://management.azure.com/subscriptions/${scope.subscriptionId}/providers/Microsoft.Advisor/recommendations?api-version=2023-01-01`,
      );
      for (const a of recommendations) {
        const p = a.properties,
          id = p.resourceMetadata?.resourceId,
          r = snapshot.resources.find(
            (r) => id && normalizeId(r.id) === normalizeId(id),
          );
        if (!r || p.category !== "Cost") continue;
        snapshot.findings.push({
          id: a.id,
          target: r,
          title:
            p.shortDescription?.problem ?? "Azure Advisor cost recommendation",
          source: "Azure Advisor",
          evidence:
            p.shortDescription?.solution ?? "See recommendation in Azure.",
          confidence: "Azure recommendation",
          window: `Last updated ${p.lastUpdated ?? "unknown"}`,
          missing: [
            "Savings currency/period not normalized; review Advisor for the authoritative estimate.",
          ],
          savings: null,
          currency: null,
          basis: "Azure Advisor; no fabricated monthly estimate.",
          overlapKey: normalizeId(r.id),
          suggested:
            "Review resource metrics, compatibility and business requirements.",
        } as Finding);
      }
    });
    return snapshot;
  }
  private async forecast(
    scope: Scope,
    now: string,
  ): Promise<Snapshot["forecast"]> {
    const date = new Date(now),
      from = new Date(
        Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate() + 1,
        ),
      ).toISOString(),
      to = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1,
      ).toISOString();
    if (Date.parse(from) > Date.parse(to))
      throw new Error("No remaining complete days this month to forecast");
    const totals = new Map<string, number>();
    for (const scopeId of scope.groupIds.length
      ? scope.groupIds
      : [`/subscriptions/${scope.subscriptionId}`]) {
      let url = `https://management.azure.com${scopeId}/providers/Microsoft.CostManagement/forecast?api-version=2025-03-01`;
      const seen = new Set<string>();
      const body = {
        type: scope.basis,
        timeframe: "Custom",
        timePeriod: { from, to },
        includeActualCost: false,
        includeFreshPartialCost: false,
        dataset: {
          granularity: "Daily",
          aggregation: { cost: { name: "PreTaxCost", function: "Sum" } },
        },
      };
      while (url) {
        if (seen.has(url) || seen.size >= 100)
          throw new Error("Forecast pagination incomplete");
        seen.add(url);
        const p = (await this.rest(url, "post", body))?.properties;
        if (
          !Array.isArray(p?.rows) ||
          !Array.isArray(p?.columns) ||
          !p.rows.length
        )
          throw new Error(
            "Azure has no forecast data for every selected scope",
          );
        for (const values of p.rows) {
          const row = Object.fromEntries(
            p.columns.map((c: any, i: number) => [c.name, values[i]]),
          );
          if (
            row.CostStatus &&
            String(row.CostStatus).toLowerCase() !== "forecast"
          )
            continue;
          const amount = Number(row.PreTaxCost ?? row.Cost ?? row.cost);
          if (
            !Number.isFinite(amount) ||
            typeof row.Currency !== "string" ||
            !/^[A-Z]{3}$/.test(row.Currency)
          )
            throw new Error("Forecast amount or currency missing");
          totals.set(row.Currency, (totals.get(row.Currency) ?? 0) + amount);
        }
        url = p.nextLink ?? "";
      }
    }
    if (!totals.size) throw new Error("No Azure forecast rows returned");
    return [...totals].map(([currency, amount]) => ({
      currency,
      amount,
      basis: `Azure forecast • ${scope.basis} • remaining complete UTC days ${from.slice(0, 10)} → ${to.slice(0, 10)} • exact selected group scopes; future current-month exception to historical date selection • excludes actuals`,
    }));
  }
  async scan(scope: Scope) {
    const snapshot = await this.snapshot(scope),
      vms = snapshot.resources.filter(
        (r) => r.type.toLowerCase() === "microsoft.compute/virtualmachines",
      );
    let completed = 0;
    for (const r of vms) {
      await this.powerState(r);
      await utilization(r, scope, this.cli);
      if (r.metrics?.cpu != null) completed++;
    }
    snapshot.coverage.metrics = `Fleet scan: CPU returned for ${completed}/${vms.length} scoped VMs; memory and network coverage reported independently per resource. Selected period capped to 7 days. No background or cross-subscription scan.`;
    snapshot.findings = [
      ...snapshot.findings.filter((f) => f.source === "Azure Advisor"),
      ...findingRules(snapshot),
    ];
    return snapshot;
  }
  async measure(
    operation: Operation,
  ): Promise<NonNullable<Operation["measurement"]>> {
    if (operation.state !== "succeeded" || !operation.endedAt)
      throw new Error("Only verified completed operations can be measured");
    const action = operation.action,
      end = new Date(operation.endedAt),
      day = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    // Skip operation day and 48 hours of billing lag, require 7 complete post-action UTC days.
    const postFrom = day + DAY,
      postTo = postFrom + 7 * DAY - 1,
      baselineFrom = day - 7 * DAY,
      baselineTo = day - 1;
    if (Date.now() < postTo + 2 * DAY)
      throw new Error(
        `Measurement pending: seven full post-action days plus 48-hour ingestion lag are required. Earliest ${new Date(postTo + 2 * DAY).toISOString()}`,
      );
    const scope: Scope = {
      tenantId: action.target.tenantId,
      subscriptionId: action.target.subscriptionId,
      groupIds: [normalizeId(action.target.groupId)],
      from: new Date(baselineFrom).toISOString(),
      to: new Date(baselineTo).toISOString(),
      basis: "ActualCost",
    };
    await this.account(scope);
    const before = (await this.costs(scope)).filter(
      (c) =>
        c.resourceId &&
        normalizeId(c.resourceId) === normalizeId(action.target.id),
    );
    const after = (
      await this.costs({
        ...scope,
        from: new Date(postFrom).toISOString(),
        to: new Date(postTo).toISOString(),
      })
    ).filter(
      (c) =>
        c.resourceId &&
        normalizeId(c.resourceId) === normalizeId(action.target.id),
    );
    if (!before.length || !after.length)
      throw new Error(
        "A comparison window has no returned target charges. Absence is not a verified zero; measurement remains unknown.",
      );
    const currencies = [
      ...new Set([...before, ...after].map((c) => c.currency)),
    ];
    if (
      !currencies.some(
        (currency) =>
          before.some((c) => c.currency === currency) &&
          after.some((c) => c.currency === currency),
      )
    )
      throw new Error(
        "No currency has charges in both windows; no cross-currency comparison or zero was fabricated.",
      );
    return {
      basis: "ActualCost",
      baselineFrom: scope.from,
      baselineTo: scope.to,
      postFrom: new Date(postFrom).toISOString(),
      postTo: new Date(postTo).toISOString(),
      measuredAt: new Date().toISOString(),
      rows: currencies
        .filter(
          (currency) =>
            before.some((c) => c.currency === currency) &&
            after.some((c) => c.currency === currency),
        )
        .map((currency) => {
          const baseline = before
              .filter((c) => c.currency === currency)
              .reduce((s, c) => s + c.amount, 0),
            post = after
              .filter((c) => c.currency === currency)
              .reduce((s, c) => s + c.amount, 0);
          return { currency, baseline, post, change: baseline - post };
        }),
      explanation:
        "Observed seven-day pre/post actual-cost change for the exact target ID, operation day excluded, 48-hour billing lag. Positive change is lower spending, not proven causal savings. Related-resource charges, commitment purchases, workload changes and credits are not attributed. Missing charge windows remain unknown.",
    };
  }
  private async powerState(r: Resource) {
    try {
      const view = await this.cli(
        [
          "vm",
          "get-instance-view",
          "--ids",
          r.id,
          "--subscription",
          r.subscriptionId,
        ],
        "Read current scoped VM power state",
      );
      const status = (view.instanceView?.statuses ?? view.statuses ?? []).find(
        (s: any) => s.code?.startsWith("PowerState/"),
      );
      r.state = status?.displayStatus ?? status?.code ?? r.state;
      if (!status) r.gaps.push("VM power status absent from instance view.");
    } catch {
      r.gaps.push(
        "VM power state denied/unavailable; no stopped/deallocated conclusion is inferred.",
      );
    }
  }
  async service(target: Target, scope: Scope): Promise<ServiceInspection> {
    if (
      target.tenantId !== scope.tenantId ||
      target.subscriptionId !== scope.subscriptionId
    )
      throw new Error("Service target differs from exact tenant/subscription");
    await this.account(scope);
    const raw = await this.cli(
      [
        "resource",
        "show",
        "--ids",
        target.id,
        "--subscription",
        target.subscriptionId,
        "--query",
        "{id:id,name:name,type:type,kind:kind,location:location,sku:sku,systemData:systemData,properties:{createdOn:properties.createdOn,modifiedOn:properties.modifiedOn,workspaceUrl:properties.workspaceUrl,managedResourceGroupId:properties.managedResourceGroupId,hubResourceId:properties.hubResourceId,storageAccount:properties.storageAccount,keyVault:properties.keyVault,applicationInsights:properties.applicationInsights,containerRegistry:properties.containerRegistry,provisioningState:properties.provisioningState,model:{format:properties.model.format,name:properties.model.name,version:properties.model.version},instanceType:properties.instanceType,scaleSettings:{instanceCount:properties.scaleSettings.instanceCount},computeType:properties.computeType,compute:{vmSize:properties.properties.vmSize,state:properties.properties.state,minNodeCount:properties.properties.scaleSettings.minNodeCount,maxNodeCount:properties.properties.scaleSettings.maxNodeCount,currentNodeCount:properties.properties.currentNodeCount}}}",
      ],
      "Read projected service metadata for exact workspace/account; no secrets or connection material",
    );
    if (
      normalizeId(raw?.id ?? "") !== normalizeId(target.id) ||
      String(raw?.type).toLowerCase() !== target.type.toLowerCase()
    )
      throw new Error("Service resource identity mismatch");
    const r = resourceFromAzure(raw, scope, new Date().toISOString()),
      result = await inspectService(
        r,
        raw,
        scope,
        this.rest.bind(this),
        this.cli,
        this.costs.bind(this),
      );
    if (!result)
      throw new Error(
        "Service inspection adapter unavailable for this resource type",
      );
    result.facts.push(
      {
        name: "Created at",
        value: r.created.value ?? "Unknown",
        source: r.created.source,
      },
      {
        name: "Last control-plane modification",
        value: r.modified?.value ?? "Unknown",
        source: r.modified?.source ?? "Metadata unavailable",
      },
    );
    return result;
  }
  async inspect(target: Target, scope: Scope): Promise<Resource | null> {
    if (
      target.tenantId !== scope.tenantId ||
      target.subscriptionId !== scope.subscriptionId
    )
      throw new Error(
        "Exact action target scope does not match the review scope.",
      );
    await this.account(scope);
    let raw: any;
    try {
      raw = await this.cli(
        [
          "resource",
          "show",
          "--ids",
          target.id,
          "--subscription",
          target.subscriptionId,
        ],
        "Read current resource state",
      );
    } catch (e) {
      if ((e as any).notFound) return null;
      throw e;
    }
    const r = resourceFromAzure(raw, scope, new Date().toISOString());
    try {
      for (const parent of [
        `/subscriptions/${target.subscriptionId}`,
        target.groupId,
        target.id,
      ]) {
        const locks = await this.list(
          `https://management.azure.com${parent}/providers/Microsoft.Authorization/locks?api-version=2016-09-01`,
        );
        r.locks.push(
          ...locks
            .filter(
              (l: any) =>
                normalizeId(
                  normalizeId(l.id).split(
                    "/providers/microsoft.authorization/locks/",
                  )[0],
                ) === normalizeId(parent),
            )
            .map((l: any) => `${l.name} · ${l.properties?.level}`),
        );
      }
      r.lockCoverage = true;
    } catch {
      r.gaps.push(
        "Locks could not be fully read; management actions are blocked.",
      );
    }
    if (r.type.toLowerCase() === "microsoft.compute/virtualmachines") {
      await this.powerState(r);
      await utilization(r, scope, this.cli);
      await resizeOptions(r, raw, this.cli);
    }
    try {
      const from = new Date(
          Math.max(Date.parse(scope.from), Date.now() - 89 * DAY),
        ).toISOString(),
        to = new Date(Math.min(Date.parse(scope.to), Date.now())).toISOString();
      const events = await this.cli(
        [
          "monitor",
          "activity-log",
          "list",
          "--resource-id",
          target.id,
          "--subscription",
          target.subscriptionId,
          "--start-time",
          from,
          "--end-time",
          to,
          "--max-events",
          "200",
        ],
        "Read retained activity (bounded to 200 records; earliest write is not creation proof)",
      );
      r.activityCoverage = {
        from,
        to,
        events: events.length,
        writes: events.filter((e: any) =>
          /\/(write|delete|action)$/i.test(e.operationName?.value ?? ""),
        ).length,
        complete: events.length < 200,
      };
      r.events.push(
        ...events.map((e: any) => ({
          at: e.eventTimestamp,
          title: `${e.operationName?.localizedValue ?? e.operationName?.value ?? "Operation"} · ${e.status?.value ?? "Unknown"}`,
          source: "Activity Log (retained event, not creation proof)",
        })),
      );
      if (events.length === 200)
        r.gaps.push("Activity results capped at 200; history is partial.");
    } catch {
      r.gaps.push("Activity Log permission or coverage unavailable.");
    }
    try {
      const response = await this.rest(
        "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
        "post",
        {
          subscriptions: [target.subscriptionId],
          query: `resourcechanges | where properties.targetResourceId =~ '${target.id.replace(/'/g, "''")}' | where todatetime(properties.changeAttributes.timestamp) between (datetime(${scope.from}) .. datetime(${scope.to})) | project properties | order by todatetime(properties.changeAttributes.timestamp) desc | take 100`,
          options: { resultFormat: "objectArray" },
        },
      );
      for (const e of response.data ?? []) {
        const client = e.properties?.changeAttributes?.clientType;
        if (typeof client === "string" && client && client !== "Unspecified") {
          r.provisioning = {
            value: client,
            confidence: "Inferred",
            source: "Resource Graph changeAttributes.clientType",
            explanation:
              "Client recorded for a retained change; does not establish original provisioning tool or continuing IaC ownership.",
          };
        }
        r.events.push({
          at: e.properties?.changeAttributes?.timestamp,
          title: `${e.properties?.changeType ?? "Change"} · possible spending correlation`,
          source: "Resource Graph changes (normally 14-day retention)",
        });
      }
    } catch {
      r.gaps.push("Resource Graph change history unavailable.");
    }
    await discover(r, raw, this.rest.bind(this), this.cli);
    await origin(r, this.cli, this.list.bind(this));
    return r;
  }
  async act(action: PlanAction) {
    const args = actionArgs(action);
    // Synchronous CLI waits for the Azure long-running operation; verify state afterward.
    await this.cli(
      args,
      `${action.kind} ${action.target.name} in exact subscription ${action.target.subscriptionId}`,
      true,
    );
  }
  async verify(action: PlanAction, scope: Scope) {
    const r = await this.inspect(action.target, scope);
    if (action.kind === "delete") return r === null;
    if (!r) return false;
    if (action.kind === "resize")
      return r.sku === action.size && /deallocated/i.test(r.state);
    if (action.kind === "tags")
      return Object.entries(action.tags ?? {}).every(
        ([k, v]) => r.tags[k] === v,
      );
    if (action.kind === "deallocate") return /deallocated/i.test(r.state);
    if (action.kind === "stop")
      return /stopped/i.test(r.state) && !/deallocated/i.test(r.state);
    return /running/i.test(r.state);
  }
}
