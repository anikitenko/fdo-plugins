import type { Resource, Scope, ServiceInspection, Charge } from "../types.ts";
import type { Cli } from "./live.ts";
import type { Rest } from "./intelligence.ts";
import { graph } from "./intelligence.ts";
import { DAY, normalizeId } from "../domain.ts";
const ARM = "https://management.azure.com";
export function serviceKind(
  resource: Pick<Resource, "type">,
): ServiceInspection["kind"] | null {
  const type = resource.type.toLowerCase();
  if (type === "microsoft.databricks/workspaces") return "databricks";
  if (
    type.startsWith("microsoft.cognitiveservices/accounts") ||
    /^microsoft\.machinelearningservices\/workspaces(?:\/(?:onlineendpoints|batchendpoints|computes|serverlessendpoints)(?:\/deployments)?)?$/.test(
      type,
    )
  )
    return "foundry";
  return null;
}
function initial(r: Resource, scope: Scope): ServiceInspection {
  return {
    kind: serviceKind(r)!,
    target: {
      tenantId: r.tenantId,
      subscriptionId: r.subscriptionId,
      id: r.id,
      name: r.name,
      type: r.type,
      groupId: r.groupId,
    },
    observedAt: new Date().toISOString(),
    from: scope.from,
    to: scope.to,
    basis: scope.basis,
    facts: [],
    assets: [],
    signals: [],
    candidates: [],
    coverage: [],
    relatedCosts: [],
    limitations: [
      "Read-only inspection. Candidates require workload-owner and dependency review; they are not deletion-safety determinations. No mutations, workload queries, jobs, inference or warehouse starts are issued.",
      "Costs are Azure billing records, not a workload price quote. Missing attribution and usage remain unknown; estimates are not added to savings totals.",
    ],
  };
}
async function attempt(
  s: ServiceInspection,
  name: string,
  work: () => Promise<void>,
) {
  try {
    await work();
    s.coverage.push({
      name,
      state: "Available",
      explanation:
        "Returned visible metadata; hidden objects and permissions can still limit coverage.",
    });
  } catch {
    s.coverage.push({
      name,
      state: "Unavailable",
      explanation:
        "Permission, policy, authentication, private networking, unsupported API or partial pagination prevented complete inspection. No empty/zero conclusion was made.",
    });
  }
}
// Project before data crosses the process boundary. Never return connection credentials, job parameters, code or prompts.
const ARM_FIELDS =
  "{value:value[].{id:id,name:name,type:type,kind:kind,systemData:{createdAt:systemData.createdAt,lastModifiedAt:systemData.lastModifiedAt},sku:{name:sku.name,capacity:sku.capacity,tier:sku.tier},properties:{createdOn:properties.createdOn,modifiedOn:properties.modifiedOn,provisioningState:properties.provisioningState,model:{format:properties.model.format,name:properties.model.name,version:properties.model.version},instanceType:properties.instanceType,scaleSettings:{instanceCount:properties.scaleSettings.instanceCount},computeType:properties.computeType,compute:{vmSize:properties.properties.vmSize,state:properties.properties.state,minNodeCount:properties.properties.scaleSettings.minNodeCount,maxNodeCount:properties.properties.scaleSettings.maxNodeCount,currentNodeCount:properties.properties.currentNodeCount},hubResourceId:properties.hubResourceId}},nextLink:nextLink}";
export async function serviceList(rest: Rest, url: string) {
  const rows: any[] = [],
    seen = new Set<string>(),
    path = new URL(url).pathname.toLowerCase();
  while (url) {
    if (seen.has(url) || seen.size >= 100)
      throw new Error("Service pagination incomplete");
    const parsed = new URL(url);
    if (parsed.origin !== ARM || parsed.pathname.toLowerCase() !== path)
      throw new Error("Service pagination escaped exact ARM collection");
    seen.add(url);
    const result = await rest(url, "get", undefined, ARM_FIELDS);
    if (!Array.isArray(result?.value))
      throw new Error("Unsupported service list schema");
    rows.push(...result.value);
    if (rows.length > 5000)
      throw new Error(
        "Service inspection exceeds 5000 records; narrow the workspace",
      );
    url = result.nextLink ?? "";
  }
  return rows;
}
const timestamp = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? new Date(v).toISOString()
    : "Unknown";
const value = (v: unknown) => (v == null ? "Unknown" : String(v));
function asset(s: ServiceInspection, row: any, category: string) {
  const p = row.properties ?? {},
    c = p.compute ?? {};
  const config = [
    p.model?.name
      ? `Model ${p.model.format ?? ""}/${p.model.name} ${p.model.version ?? ""}`
      : null,
    row.sku?.name
      ? `SKU ${row.sku.name}; capacity ${value(row.sku.capacity)}`
      : null,
    p.instanceType
      ? `Instance ${p.instanceType}; count ${value(p.scaleSettings?.instanceCount)}`
      : null,
    c.vmSize
      ? `VM ${c.vmSize}; nodes ${value(c.currentNodeCount)}; min/max ${value(c.minNodeCount)}/${value(c.maxNodeCount)}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (
    typeof row.id !== "string" ||
    !normalizeId(row.id).startsWith(
      `/subscriptions/${s.target.subscriptionId.toLowerCase()}/`,
    )
  )
    throw new Error("Service object ID outside selected subscription");
  s.assets.push({
    id: row.id,
    armId: row.id,
    name: row.name ?? row.id.split("/").at(-1),
    category,
    created: {
      value:
        row.systemData?.createdAt ??
        (String(row.type).toLowerCase() ===
        "microsoft.machinelearningservices/workspaces/computes"
          ? p.createdOn
          : null) ??
        null,
      confidence:
        row.systemData?.createdAt ||
        (String(row.type).toLowerCase() ===
          "microsoft.machinelearningservices/workspaces/computes" &&
          p.createdOn)
          ? "Verified"
          : "Unknown",
      source: row.systemData?.createdAt
        ? "ARM systemData.createdAt; no group-age inference"
        : String(row.type).toLowerCase() ===
            "microsoft.machinelearningservices/workspaces/computes"
          ? "Azure ML compute properties.createdOn where exposed; otherwise Unknown"
          : "ARM creation metadata not exposed",
    },
    modified: {
      value:
        row.systemData?.lastModifiedAt ??
        (String(row.type).toLowerCase() ===
        "microsoft.machinelearningservices/workspaces/computes"
          ? p.modifiedOn
          : null) ??
        null,
      confidence:
        row.systemData?.lastModifiedAt ||
        (String(row.type).toLowerCase() ===
          "microsoft.machinelearningservices/workspaces/computes" &&
          p.modifiedOn)
          ? "Verified"
          : "Unknown",
      source: row.systemData?.lastModifiedAt
        ? "ARM systemData.lastModifiedAt; control-plane metadata only"
        : String(row.type).toLowerCase() ===
            "microsoft.machinelearningservices/workspaces/computes"
          ? "Azure ML compute properties.modifiedOn where exposed; control-plane metadata only"
          : "Last control-plane modification metadata not exposed",
    },
    state: c.state ?? p.provisioningState ?? "Unknown",
    configuration: config || "No allocation metadata returned",
    source: "ARM provider GET; visible configuration, not billed utilization",
  });
  if (/Provisioned/i.test(row.sku?.name ?? ""))
    s.candidates.push({
      assetId: row.id,
      title: "Review provisioned model capacity",
      evidence: `${row.sku.name}; allocated capacity ${value(row.sku.capacity)}. This is configured capacity, not evidence of waste.`,
      missing: [
        "Utilization, peak workload, reservations/commitment terms, consumers and failover requirements.",
      ],
      suggested:
        "Compare observed utilization with peak demand before proposing a capacity change in Foundry. Commitment charges may remain after deletion.",
      confidence: "Review candidate; utilization unknown",
    });
  if (typeof c.minNodeCount === "number" && c.minNodeCount > 0)
    s.candidates.push({
      assetId: row.id,
      title: "Review minimum compute nodes",
      evidence: `Minimum nodes ${c.minNodeCount}; current ${value(c.currentNodeCount)}; maximum ${value(c.maxNodeCount)}.`,
      missing: [
        "Active/queued jobs, latency objectives, scheduled training and workload utilization.",
      ],
      suggested:
        "Investigate reducing the minimum or using scale-to-zero through the Azure ML/Foundry controls after workload review.",
      confidence: "Verified allocation; cleanup eligibility unknown",
    });
}
function workspaceHost(raw: any): string {
  const host = raw.properties?.workspaceUrl;
  if (
    typeof host !== "string" ||
    !/^adb-\d+\.\d+\.azuredatabricks\.net$/i.test(host)
  )
    throw new Error(
      "Workspace URL must be an ARM-provided public Azure Databricks hostname",
    );
  return host.toLowerCase();
}
const DB_ROUTES = {
  clusters: {
    path: "/api/2.1/clusters/list",
    query:
      "{items:clusters[].{id:cluster_id,name:cluster_name,state:state,creator:creator_user_name,node:node_type_id,workers:num_workers,min:autoscale.min_workers,max:autoscale.max_workers,auto:autotermination_minutes,pool:instance_pool_id,started:start_time,terminated:terminated_time},next:next_page_token,more:has_more}",
    category: "Cluster",
  },
  warehouses: {
    path: "/api/2.0/sql/warehouses",
    query:
      "{items:warehouses[].{id:id,name:name,state:state,size:cluster_size,min:min_num_clusters,max:max_num_clusters,auto:auto_stop_mins,serverless:enable_serverless_compute},next:next_page_token,more:has_more}",
    category: "SQL warehouse",
  },
  pools: {
    path: "/api/2.0/instance-pools/list",
    query:
      "{items:instance_pools[].{id:instance_pool_id,name:instance_pool_name,node:node_type_id,min:min_idle_instances,max:max_capacity,idle:stats.idle_count,used:stats.used_count,auto:idle_instance_autotermination_minutes},next:next_page_token,more:has_more}",
    category: "Instance pool",
  },
  jobs: {
    path: "/api/2.2/jobs/list",
    query:
      "{items:jobs[].{id:job_id,name:settings.name,creator:creator_user_name,paused:settings.schedule.pause_status,created:created_time,cluster:settings.existing_cluster_id,taskClusters:settings.tasks[].existing_cluster_id},next:next_page_token,more:has_more}",
    category: "Job",
  },
  runs: {
    path: "/api/2.2/jobs/runs/list",
    query:
      "{items:runs[].{id:run_id,job:job_id,state:state.life_cycle_state,result:state.result_state,start:start_time,end:end_time,cluster:cluster_instance.cluster_id},next:next_page_token,more:has_more}",
    category: "Job run",
  },
} as const;
export async function databricksRead(
  cli: Cli,
  raw: any,
  r: Resource,
  key: keyof typeof DB_ROUTES,
  scope: Scope,
) {
  const host = workspaceHost(raw),
    route = DB_ROUTES[key],
    rows: any[] = [],
    seen = new Set<string>();
  let token = "";
  do {
    if (seen.has(token) || seen.size >= 100)
      throw new Error("Databricks pagination incomplete");
    seen.add(token);
    const url = new URL(`https://${host}${route.path}`);
    if (key === "clusters") url.searchParams.set("page_size", "100");
    if (key === "jobs" || key === "runs") url.searchParams.set("limit", "100");
    if (key === "runs") {
      url.searchParams.set("start_time_from", String(Date.parse(scope.from)));
      url.searchParams.set(
        "start_time_to",
        String(Math.min(Date.parse(scope.to), Date.now())),
      );
    }
    if (token) url.searchParams.set("page_token", token);
    const result = await cli(
      [
        "rest",
        "--method",
        "get",
        "--url",
        url.toString(),
        "--resource",
        "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d",
        "--subscription",
        r.subscriptionId,
        "--query",
        route.query,
      ],
      `Read ${route.category} metadata from exact Databricks workspace ${r.name}; no workloads are started`,
    );
    if (!Array.isArray(result?.items))
      throw new Error("Databricks collection absent; coverage unknown");
    rows.push(...result.items);
    if (rows.length > 5000)
      throw new Error("Databricks records exceed inspection bound");
    token = typeof result.next === "string" ? result.next : "";
    if (result.more === true && !token)
      throw new Error(
        "Databricks reported more records without a usable cursor",
      );
  } while (token);
  return rows;
}
async function databricks(
  s: ServiceInspection,
  r: Resource,
  raw: any,
  scope: Scope,
  rest: Rest,
  cli: Cli,
  costs: (scope: Scope) => Promise<Charge[]>,
) {
  const managed = raw.properties?.managedResourceGroupId;
  s.facts.push(
    {
      name: "Workspace URL",
      value: value(raw.properties?.workspaceUrl),
      source: "Workspace ARM properties.workspaceUrl",
    },
    {
      name: "Managed resource group",
      value: value(managed),
      source: "Workspace ARM properties.managedResourceGroupId",
    },
  );
  if (
    typeof managed === "string" &&
    new RegExp(
      `^/subscriptions/${r.subscriptionId}/resourceGroups/[^/]+$`,
      "i",
    ).test(managed)
  ) {
    await attempt(
      s,
      "Managed infrastructure (broader than selected groups)",
      async () => {
        const rows = await serviceList(
          rest,
          `${ARM}${managed}/resources?api-version=2021-04-01`,
        );
        for (const row of rows)
          asset(
            s,
            row,
            "Databricks managed infrastructure · do not delete directly",
          );
      },
    );
    await attempt(
      s,
      "Managed-group costs (separate billing scope)",
      async () => {
        s.relatedCosts.push({
          scopeId: managed,
          explanation:
            "Exact managed-group charges for selected period/basis. Broader than global group selection where applicable. These can overlap global costs: do not add twice. Shared/serverless infrastructure and DBU meters may be charged elsewhere.",
          costs: await costs({ ...scope, groupIds: [normalizeId(managed)] }),
        });
      },
    );
  } else
    s.coverage.push({
      name: "Managed group",
      state: "Unavailable",
      explanation:
        "No valid same-subscription managed group ID exposed. No managed-group name is guessed.",
    });
  for (const key of Object.keys(DB_ROUTES) as (keyof typeof DB_ROUTES)[]) {
    await attempt(s, `Databricks ${DB_ROUTES[key].category}`, async () => {
      const rows = await databricksRead(cli, raw, r, key, scope),
        host = workspaceHost(raw);
      for (const row of rows) {
        const id = String(row.id),
          category = DB_ROUTES[key].category;
        const config =
          key === "clusters"
            ? `Node ${value(row.node)} · workers ${value(row.workers)} · autoscale ${value(row.min)}–${value(row.max)} · auto-termination ${value(row.auto)} min · pool ${value(row.pool)} · last start ${timestamp(row.started)} (not creation) · last termination ${timestamp(row.terminated)}`
            : key === "warehouses"
              ? `Size ${value(row.size)} · clusters ${value(row.min)}–${value(row.max)} · auto-stop ${value(row.auto)} min · serverless ${value(row.serverless)}`
              : key === "pools"
                ? `Node ${value(row.node)} · min idle ${value(row.min)} · idle/used ${value(row.idle)}/${value(row.used)} · auto-termination ${value(row.auto)} min`
                : key === "jobs"
                  ? `Creator ${value(row.creator)} · schedule ${value(row.paused)} · cluster ${value(row.cluster)} · task cluster references ${(row.taskClusters ?? []).join(", ") || "Unknown"}`
                  : `Job ${value(row.job)} · cluster ${value(row.cluster)} · start ${row.start ? new Date(row.start).toISOString() : "Unknown"} · result ${value(row.result)}`;
        s.assets.push({
          id,
          name: String(row.name ?? row.id),
          category,
          created: {
            value:
              key === "jobs" && Number.isFinite(row.created) && row.created > 0
                ? timestamp(row.created)
                : null,
            confidence:
              key === "jobs" && Number.isFinite(row.created) && row.created > 0
                ? "Verified"
                : "Unknown",
            source:
              key === "jobs"
                ? "Databricks job created_time"
                : "Creation not exposed here; cluster last start is not creation",
          },
          state: value(row.state),
          configuration: config,
          source: `Databricks ${DB_ROUTES[key].path}; creator is not current owner`,
          url: `https://${host}/${key === "warehouses" ? "sql/warehouses/" : key === "jobs" || key === "runs" ? "jobs/" : key === "pools" ? "compute/pools/" : "compute/clusters/"}${encodeURIComponent(key === "runs" ? String(row.job) : id)}`,
        });
        if ((key === "clusters" || key === "warehouses") && row.auto === 0)
          s.candidates.push({
            assetId: id,
            title: `${category}: automatic shutdown disabled`,
            evidence: `Provider explicitly reports auto-${key === "clusters" ? "termination" : "stop"}=0 minutes; current state ${value(row.state)}.`,
            missing: [
              "Interactive users, job dependencies, peak demand and continuous-service requirements. Running does not establish idle.",
            ],
            suggested:
              "Review enabling automatic shutdown and confirm schedules with the owner in Databricks. Do not terminate on this signal alone.",
            confidence: "Verified configuration; idle status unknown",
          });
        if (key === "pools" && typeof row.min === "number" && row.min > 0)
          s.candidates.push({
            assetId: id,
            title: "Pool retains minimum idle capacity",
            evidence: `Minimum idle instances ${row.min}; currently idle ${value(row.idle)}, used ${value(row.used)}.`,
            missing: [
              "Cold-start requirements, scheduled workloads and pool consumers.",
            ],
            suggested:
              "Review a lower minimum idle allocation in Databricks; do not delete managed VMs or disks directly.",
            confidence: "Verified allocation; cleanup eligibility unknown",
          });
      }
    });
  }
  s.limitations.push(
    "Workspace data-plane reads require existing Entra access, Databricks object permissions and network connectivity. Azure Reader alone is insufficient. az rest obtains the Databricks audience token internally; the plugin never extracts it or attempts admin auto-provisioning.",
    "Cluster lists are retained/visible metadata, not a complete historical inventory. Job schedules and returned runs do not cover notebooks, all serverless products, active SQL sessions, streaming, external callers or every task-level cluster reference.",
    "No SQL statements or system.billing queries are executed because they may start paid compute. Per-cluster DBU attribution, idle runtime and comprehensive query history remain unknown; DBU and managed-group infrastructure costs must be reviewed separately.",
    "Databricks managed infrastructure is service-owned. Clean up through Databricks controls; do not directly delete its VMs/disks or the managed group.",
  );
}
async function foundryMetrics(
  s: ServiceInspection,
  r: Resource,
  scope: Scope,
  cli: Cli,
) {
  const to = new Date(Math.min(Date.parse(scope.to), Date.now())).toISOString(),
    from = new Date(
      Math.max(Date.parse(scope.from), Date.parse(to) - 7 * DAY),
    ).toISOString();
  if (Date.parse(from) >= Date.parse(to))
    throw new Error("No past observation window");
  const definitions = await cli(
    [
      "monitor",
      "metrics",
      "list-definitions",
      "--resource",
      r.id,
      "--subscription",
      r.subscriptionId,
      "--query",
      "[].{name:name.value,unit:unit,aggregations:supportedAggregationTypes,dimensions:dimensions[].value}",
    ],
    "Discover available Foundry metrics; no inference or model calls",
  );
  if (!Array.isArray(definitions))
    throw new Error("Metric definitions unavailable");
  const expected = Math.ceil((Date.parse(to) - Date.parse(from)) / 3600000);
  let collected = 0;
  for (const [metric, aggregation] of [
    ["AzureOpenAIRequests", "Total"],
    ["ProcessedPromptTokens", "Total"],
    ["GeneratedTokens", "Total"],
    ["AzureOpenAIProvisionedManagedUtilizationV2", "Average"],
  ]) {
    const definition = definitions.find((d: any) => d.name === metric);
    if (!definition) continue;
    await attempt(s, `Metric ${metric}`, async () => {
      const split = definition.dimensions?.includes("ModelDeploymentName");
      const result = await cli(
        [
          "monitor",
          "metrics",
          "list",
          "--resource",
          r.id,
          "--subscription",
          r.subscriptionId,
          "--metric",
          metric,
          "--start-time",
          from,
          "--end-time",
          to,
          "--interval",
          "PT1H",
          "--aggregation",
          aggregation,
          ...(split
            ? ["--filter", "ModelDeploymentName eq '*'", "--top", "1000"]
            : []),
        ],
        `Read Foundry ${metric}, split by deployment only where supported`,
      );
      if (!Array.isArray(result?.value))
        throw new Error("Metrics schema unavailable");
      const seriesList = result.value.flatMap((m: any) => m.timeseries ?? []);
      if (!seriesList.length)
        s.signals.push({
          assetId: null,
          metric,
          value: null,
          unit: definition.unit ?? "Unknown",
          samples: 0,
          expected,
          from,
          to,
          source:
            "No returned time series; missing observations are not zero usage",
        });
      if (seriesList.length >= 1000)
        s.coverage.push({
          name: `${metric} time series`,
          state: "Partial",
          explanation:
            "Metric series limit reached; no complete deployment utilization claim is made.",
        });
      for (const series of seriesList) {
        const name = series.metadatavalues?.find(
          (v: any) => v.name?.value === "ModelDeploymentName",
        )?.value;
        const assetId =
          split && typeof name === "string"
            ? `${r.id}/deployments/${name}`
            : null;
        const key = aggregation.toLowerCase(),
          byHour = new Map<number, number>();
        for (const point of series.data ?? []) {
          const at = Date.parse(point.timeStamp);
          if (
            typeof point[key] !== "number" ||
            !Number.isFinite(point[key]) ||
            !Number.isFinite(at) ||
            at < Date.parse(from) ||
            at > Date.parse(to)
          )
            continue;
          const hour = Math.floor(at / 3600000);
          byHour.set(hour, Math.max(byHour.get(hour) ?? -Infinity, point[key]));
        }
        const points = [...byHour.values()];
        s.signals.push({
          assetId,
          metric,
          value: points.length
            ? points.reduce((sum: number, v: number) => sum + v, 0) /
              (aggregation === "Average" ? points.length : 1)
            : null,
          unit: definition.unit ?? "Unknown",
          samples: points.length,
          expected,
          from,
          to,
          source: `Azure Monitor ${aggregation}; ${assetId ? "deployment dimension" : "account-level only; never allocated to every deployment"}`,
        });
      }
      collected++;
    });
  }
  if (!collected)
    throw new Error(
      "No supported usage metrics returned; not a zero-usage account",
    );
  const flagged = new Set<string>();
  for (const signal of s.signals) {
    if (
      s.coverage.some(
        (c) => c.state === "Partial" && c.name.includes("time series"),
      )
    )
      continue;
    if (
      !signal.assetId ||
      signal.value == null ||
      signal.samples / expected < 0.8 ||
      Date.parse(to) - Date.parse(from) < 7 * DAY
    )
      continue;
    if (flagged.has(`${signal.assetId}:${signal.metric}`)) continue;
    const same = s.signals.filter(
      (s) => s.assetId === signal.assetId && s.metric === signal.metric,
    );
    if (
      same.some(
        (s) =>
          s.value == null ||
          s.samples / expected < 0.8 ||
          (signal.metric === "AzureOpenAIRequests"
            ? s.value !== 0
            : s.value! >= 10),
      )
    )
      continue;
    flagged.add(`${signal.assetId}:${signal.metric}`);
    if (
      (signal.metric === "AzureOpenAIRequests" && signal.value === 0) ||
      (signal.metric === "AzureOpenAIProvisionedManagedUtilizationV2" &&
        signal.value < 10)
    )
      s.candidates.push({
        assetId: signal.assetId,
        title:
          signal.metric === "AzureOpenAIRequests"
            ? "Deployment: no observed requests in covered window"
            : "Provisioned deployment: low observed utilization",
        evidence: `${signal.metric} ${signal.value}; ${signal.samples}/${expected} hourly samples, ${from} → ${to}.`,
        missing: [
          "Peak/seasonal demand, failover, consumers, other APIs, reservation terms and complete billing attribution.",
        ],
        suggested:
          "Review owners, dependency impact and commitment charges before changing or removing this deployment in Foundry. Low usage alone never establishes safe deletion.",
        confidence: "Observed signal; cleanup eligibility unknown",
      });
  }
}
async function foundry(
  s: ServiceInspection,
  r: Resource,
  raw: any,
  scope: Scope,
  rest: Rest,
  cli: Cli,
) {
  const type = r.type.toLowerCase(),
    isAccount = type === "microsoft.cognitiveservices/accounts",
    isWorkspace = type === "microsoft.machinelearningservices/workspaces";
  s.facts.push(
    {
      name: "Resource kind",
      value: value(raw.kind),
      source:
        "ARM kind; Cognitive Services and Azure ML are labelled separately from confirmed Foundry kinds",
    },
    {
      name: "Hub link",
      value: value(raw.properties?.hubResourceId),
      source: "ARM properties.hubResourceId",
    },
  );
  if (isAccount) {
    await attempt(s, "Account model deployments", async () => {
      for (const row of await serviceList(
        rest,
        `${ARM}${r.id}/deployments?api-version=2025-06-01`,
      ))
        asset(s, row, "Model deployment");
    });
    await attempt(s, "Foundry account projects", async () => {
      for (const row of await serviceList(
        rest,
        `${ARM}${r.id}/projects?api-version=2025-06-01`,
      ))
        asset(s, row, "Foundry project");
    });
    await attempt(s, "Account usage metrics", () =>
      foundryMetrics(s, r, scope, cli),
    );
  }
  if (isWorkspace) {
    for (const [collection, label] of [
      ["computes", "Azure ML compute"],
      ["onlineEndpoints", "Online endpoint"],
      ["batchEndpoints", "Batch endpoint"],
      ["serverlessEndpoints", "Serverless endpoint"],
    ]) {
      await attempt(s, label, async () => {
        const rows = await serviceList(
          rest,
          `${ARM}${r.id}/${collection}?api-version=2024-10-01`,
        );
        for (const row of rows) asset(s, row, label);
        if (
          collection === "onlineEndpoints" ||
          collection === "batchEndpoints"
        ) {
          for (const row of rows.slice(0, 50))
            await attempt(s, `${label} deployments: ${row.name}`, async () => {
              if (!normalizeId(row.id).startsWith(normalizeId(r.id) + "/"))
                throw new Error("Endpoint outside workspace");
              for (const deployment of await serviceList(
                rest,
                `${ARM}${row.id}/deployments?api-version=2024-10-01`,
              ))
                asset(s, deployment, `${label} deployment`);
            });
          if (rows.length > 50)
            s.coverage.push({
              name: `${label} deployment expansion`,
              state: "Partial",
              explanation:
                "Only the first 50 endpoints were expanded. Other endpoint deployments are uninspected.",
            });
        }
      });
    }
    await attempt(
      s,
      "Linked classic projects (subscription-wide discovery)",
      async () => {
        const rows = await graph(
          rest,
          r.subscriptionId,
          `Resources | where type =~ 'Microsoft.MachineLearningServices/workspaces' | where properties.hubResourceId =~ '${r.id.replace(/'/g, "''")}' | project id, name, type, kind, properties=pack('provisioningState',properties.provisioningState)`,
        );
        for (const row of rows)
          asset(
            s,
            row,
            "Classic project linked to hub · may be outside selected groups",
          );
      },
    );
  }
  if (!isAccount && !isWorkspace) {
    asset(s, raw, "Selected service resource");
    s.coverage.push({
      name: "Parent-level usage / deployment enumeration",
      state: "Partial",
      explanation:
        "Select the owning Cognitive Services account or Azure ML workspace to inspect siblings and supported usage metrics. This child retains its exact target ID.",
    });
  }
  for (const [label, id] of Object.entries({
    Storage: raw.properties?.storageAccount,
    "Key Vault": raw.properties?.keyVault,
    "Application Insights": raw.properties?.applicationInsights,
    "Container registry": raw.properties?.containerRegistry,
    Hub: raw.properties?.hubResourceId,
  }))
    if (typeof id === "string")
      s.facts.push({
        name: `Related ${label}`,
        value: id,
        source:
          "Explicit provider resource ID reference; shared dependency, not a cleanup permission",
      });
  s.limitations.push(
    "Account-level charges are not apportioned to projects or deployments without returned billing dimensions. Foundry/Marketplace/serverless charges can appear under other resource IDs; unmatched charges remain visible in Cost changes.",
    "Provisioned model units, online replicas, compute minimums and linked storage/search/monitoring services can continue billing independently. Removing a deployment does not necessarily end reservations or commitments.",
    "Projects, agents, connections, vector indexes, stored data, runtime callers and secrets are not exhaustively enumerated. No prompt/completion content, credentials, connection secrets or inference calls are requested.",
    "Classic hub/project workspaces, Cognitive Services/OpenAI accounts and modern Foundry accounts are distinct ARM types/kinds. Missing permissions or unsupported surfaces never mean a workspace is empty.",
  );
}
export async function inspectService(
  r: Resource,
  raw: any,
  scope: Scope,
  rest: Rest,
  cli: Cli,
  costs: (scope: Scope) => Promise<Charge[]>,
): Promise<ServiceInspection | undefined> {
  if (!serviceKind(r)) return undefined;
  const s = initial(r, scope);
  if (s.kind === "databricks")
    await databricks(s, r, raw, scope, rest, cli, costs);
  else await foundry(s, r, raw, scope, rest, cli);
  return s;
}
