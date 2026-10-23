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
      "Read-only inspection. Candidates require workload-owner and dependency review; they are not deletion-safety determinations. No resource mutations, job runs, inference, or compute starts are issued.",
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
  } catch (error) {
    s.coverage.push({
      name,
      state: "Unavailable",
      explanation: coverageFailure(error),
    });
  }
}
function coverageFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out/i.test(message))
    return "The host or service timed out. Coverage is unknown, not empty. The failure text was not stored.";
  if (
    /AuthorizationFailed|access denied|forbidden|\b403\b|not authorized|membership denied/i.test(
      message,
    )
  )
    return "Access was denied. Permissions do not cover this surface. No empty conclusion was made, and the failure text was not stored.";
  if (/cursor|schema|absent|unsupported/i.test(message))
    return "The response did not match the projected read contract, or a page cursor was unusable. Coverage is unknown, not empty.";
  if (/hostname|Workspace URL/i.test(message))
    return "The workspace hostname was not an ARM-reported public Databricks host. No data-plane call was made.";
  if (/bound|pagination incomplete|exceed/i.test(message))
    return "The read stopped because pagination could not be completed. No empty conclusion was made.";
  return "Permission, policy, authentication, private networking, unsupported API or partial pagination prevented complete inspection. No empty/zero conclusion was made.";
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
// Fixed GET paths. Settings, README and the host allowlist must name the same paths.
type DbRoute = {
  path: string;
  query: string;
  category: string;
  page?: readonly [string, string];
  window?: "runs" | "history";
  inventory: boolean;
};
const DB_ROUTES = {
  clusters: {
    path: "/api/2.1/clusters/list",
    query:
      "{items:clusters[].{id:cluster_id,name:cluster_name,state:state,source:cluster_source,creator:creator_user_name,node:node_type_id,driver:driver_node_type_id,workers:num_workers,min:autoscale.min_workers,max:autoscale.max_workers,auto:autotermination_minutes,pool:instance_pool_id,driverPool:driver_instance_pool_id,started:start_time,terminated:terminated_time,activity:last_activity_time,runtime:runtime_engine,single:single_user_name},next:next_page_token,more:has_more}",
    category: "Cluster",
    page: ["page_size", "100"],
    inventory: true,
  },
  warehouses: {
    path: "/api/2.0/sql/warehouses",
    query:
      "{items:warehouses[].{id:id,name:name,state:state,size:cluster_size,type:warehouse_type,min:min_num_clusters,max:max_num_clusters,running:num_clusters,sessions:num_active_sessions,auto:auto_stop_mins,serverless:enable_serverless_compute,photon:enable_photon,spot:spot_instance_policy,creator:creator_name,health:health.status},next:next_page_token,more:has_more}",
    category: "SQL warehouse",
    inventory: true,
  },
  pools: {
    path: "/api/2.0/instance-pools/list",
    query:
      "{items:instance_pools[].{id:instance_pool_id,name:instance_pool_name,node:node_type_id,min:min_idle_instances,max:max_capacity,idle:stats.idle_count,used:stats.used_count,pending:stats.pending_idle_count,auto:idle_instance_autotermination_minutes},next:next_page_token,more:has_more}",
    category: "Instance pool",
    inventory: true,
  },
  jobs: {
    path: "/api/2.2/jobs/list",
    query:
      "{items:jobs[].{id:job_id,name:settings.name,creator:creator_user_name,runAs:run_as_user_name,paused:settings.schedule.pause_status,cron:settings.schedule.quartz_cron_expression,continuous:settings.continuous.pause_status,trigger:settings.trigger.pause_status,created:created_time,cluster:settings.existing_cluster_id,taskClusters:settings.tasks[].existing_cluster_id,warehouse:settings.tasks[].sql_task.warehouse_id,jobClusters:length(settings.job_clusters)},next:next_page_token,more:has_more}",
    category: "Job",
    page: ["limit", "100"],
    inventory: true,
  },
  runs: {
    path: "/api/2.2/jobs/runs/list",
    query:
      "{items:runs[].{id:run_id,job:job_id,state:state.life_cycle_state,result:state.result_state,start:start_time,end:end_time,cluster:cluster_instance.cluster_id},next:next_page_token,more:has_more}",
    category: "Job run",
    page: ["limit", "100"],
    window: "runs",
    inventory: true,
  },
  queries: {
    path: "/api/2.0/sql/history/queries",
    query:
      "{items:res[].{warehouse:warehouse_id,status:status,user:user_name,start:query_start_time_ms,end:query_end_time_ms,duration:duration},next:next_page_token,more:has_next_page}",
    category: "SQL history",
    page: ["max_results", "100"],
    window: "history",
    inventory: false,
  },
  pipelines: {
    path: "/api/2.0/pipelines",
    query:
      "{items:statuses[].{id:pipeline_id,name:name,state:state,creator:creator_user_name,runAs:run_as_user_name,cluster:cluster_id,updated:latest_updates[0].creation_time,updateState:latest_updates[0].state},next:next_page_token,more:has_more}",
    category: "Pipeline",
    page: ["max_results", "100"],
    inventory: true,
  },
  serving: {
    path: "/api/2.0/serving-endpoints",
    query:
      "{items:endpoints[].{id:id,name:name,state:state.ready,created:creation_timestamp,updated:last_updated_timestamp,scales:config.served_entities[].scale_to_zero_enabled,sizes:config.served_entities[].workload_size,minC:config.served_entities[].min_provisioned_concurrency,maxT:config.served_entities[].max_provisioned_throughput},next:next_page_token}",
    category: "Serving endpoint",
    inventory: true,
  },
  vectors: {
    path: "/api/2.0/vector-search/endpoints",
    query:
      "{items:endpoints[].{name:name,type:endpoint_type,state:endpoint_status.state,indexes:num_indexes,creator:creator,created:creation_timestamp},next:next_page_token}",
    category: "Vector search endpoint",
    inventory: true,
  },
} as const satisfies Record<string, DbRoute>;
type DbKey = keyof typeof DB_ROUTES;
const EPHEMERAL = new Set(["JOB", "PIPELINE", "PIPELINE_MAINTENANCE"]);
const LIVE_CLUSTER = new Set(["RUNNING", "PENDING", "RESIZING", "RESTARTING"]);
const ACTIVE_RUN = new Set([
  "QUEUED",
  "PENDING",
  "RUNNING",
  "TERMINATING",
  "BLOCKED",
  "WAITING_FOR_RETRY",
]);
const EVENT_CAP = 20;
const CLUSTER_ID = /^[A-Za-z0-9_-]{1,200}$/;
type ActivitySample = {
  count: number | null;
  samples: number;
  expected: number;
  last: number | null;
  lastType: string | null;
  complete: boolean;
};
const strings = (v: unknown) =>
  Array.isArray(v)
    ? [...new Set(v.filter((item) => typeof item === "string" && item))]
    : [];
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const hoursSince = (ms: number | null) => {
  if (ms == null) return null;
  const hours = (Date.now() - ms) / 36e5;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
};
const ageText = (ms: number | null) => {
  const hours = hoursSince(ms);
  if (ms == null || hours == null) return "Unknown";
  return hours < 48
    ? `${Math.round(hours)} hours ago (${timestamp(ms)})`
    : `${Math.round(hours / 24)} days ago (${timestamp(ms)})`;
};
const titled = (rows: { name?: unknown; id?: unknown }[], limit = 5) => {
  const names = rows
    .map((row) =>
      typeof row.name === "string" && row.name
        ? row.name
        : row.id == null
          ? ""
          : String(row.id),
    )
    .filter(Boolean);
  const shown = names.slice(0, limit).join(", ");
  return names.length > limit
    ? `${shown}, and ${names.length - limit} more`
    : shown || "unnamed";
};
const brief = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((item) => item != null)
        .map(String)
        .join(", ") || "none returned"
    : value(v);
function assetId(key: DbKey, row: any): string | null {
  if (key === "serving" || key === "vectors") {
    if (
      typeof row.name !== "string" ||
      row.name.length === 0 ||
      row.name.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(row.name)
    )
      return null;
    return `${key === "serving" ? "serving" : "vector"}:${row.name}`;
  }
  if (typeof row.id === "number" && Number.isFinite(row.id)) return String(row.id);
  if (typeof row.id === "string" && row.id.length > 0 && row.id.length <= 300)
    return row.id;
  return null;
}
function jobClusterIds(job: any) {
  return [...new Set([job.cluster, ...strings(job.taskClusters)].filter((id) => typeof id === "string" && id))];
}
function signal(
  s: ServiceInspection,
  assetId: string,
  metric: string,
  value: number | null,
  unit: string,
  samples: number,
  expected: number,
  source: string,
) {
  s.signals.push({
    assetId,
    metric,
    value,
    unit,
    samples,
    expected,
    from: s.from,
    to: s.to,
    source,
  });
}
function annotate(
  s: ServiceInspection,
  category: string,
  assetId: string,
  text: string,
) {
  const asset = s.assets.find(
    (item) => item.category === category && item.id === assetId,
  );
  if (asset) asset.configuration += ` · ${text}`;
}
const MANAGED_STEP =
  "Do not delete the managed resource group or its virtual machines, disks, or public IPs from Azure. Databricks releases that infrastructure when the compute stops.";
const DBU_GAP =
  "Per-object DBU charges until system.billing.usage completes for this workspace. A missing billing read is unknown, not zero.";
const USAGE_GAPS = [
  "Notebooks, streams, JDBC/ODBC sessions, dashboards, Genie, and callers outside the collected APIs.",
  DBU_GAP,
];
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
    seen = new Set<string>(),
    finish = (complete: boolean) => Object.assign(rows, { complete });
  let token = "";
  do {
    if (seen.has(token))
      throw new Error("Databricks pagination repeated a cursor");
    if (seen.size >= 100) return finish(false);
    seen.add(token);
    const url = new URL(`https://${host}${route.path}`),
      page = "page" in route ? route.page : undefined;
    if (page) url.searchParams.set(page[0], page[1]);
    if ("window" in route && route.window === "runs") {
      url.searchParams.set("start_time_from", String(Date.parse(scope.from)));
      url.searchParams.set(
        "start_time_to",
        String(Math.min(Date.parse(scope.to), Date.now())),
      );
    }
    if ("window" in route && route.window === "history") {
      url.searchParams.set("include_metrics", "false");
      url.searchParams.set(
        "filter_by.query_start_time_range.start_time_ms",
        String(Date.parse(scope.from)),
      );
      url.searchParams.set(
        "filter_by.query_start_time_range.end_time_ms",
        String(Math.min(Date.parse(scope.to), Date.now())),
      );
    }
    if (token) url.searchParams.set("page_token", token);
    const history = "window" in route && route.window === "history";
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
      history
        ? `Read SQL history metadata for exact Databricks workspace ${r.name}; statement text is not requested and no warehouse is started`
        : `Read ${route.category} metadata from exact Databricks workspace ${r.name}; no workloads are started`,
    );
    if (!Array.isArray(result?.items))
      throw new Error("Databricks collection absent; coverage unknown");
    if (rows.length + result.items.length > 5000) return finish(false);
    rows.push(...result.items);
    token = typeof result.next === "string" ? result.next : "";
    if (result.more === true && !token)
      throw new Error(
        "Databricks reported more records without a usable cursor",
      );
  } while (token);
  return finish(true);
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
  const got: Partial<Record<DbKey, any[]>> = {};
  for (const key of Object.keys(DB_ROUTES) as DbKey[]) {
    await attempt(s, `Databricks ${DB_ROUTES[key].category}`, async () => {
      const rows = await databricksRead(cli, raw, r, key, scope);
      if (DB_ROUTES[key].inventory) {
        const host = workspaceHost(raw);
        for (const row of rows) pushDatabricksAsset(s, key, row, host);
      }
      got[key] = rows;
    });
  }
  for (const key of Object.keys(DB_ROUTES) as DbKey[]) {
    const rows = got[key] as (any[] & { complete?: boolean }) | undefined;
    if (!rows || rows.complete !== false) continue;
    const coverage = s.coverage.find(
      (item) => item.name === `Databricks ${DB_ROUTES[key].category}`,
    );
    if (!coverage) continue;
    coverage.state = "Partial";
    coverage.explanation = `Returned the first ${rows.length} records, then stopped at the 5,000-record or 100-page cap. Counts are a lower bound. An object missing from this prefix is not a zero.`;
  }
  const events = new Map<string, ActivitySample>(),
    sampled = new Set<string>(),
    failedEvents = new Set<string>();
  let matchedEvents = 0,
    cappedEvents = false,
    freshActivity = 0;
  if (!got.clusters)
    s.coverage.push({
      name: "Databricks cluster activity events",
      state: "Unavailable",
      explanation:
        "Cluster list did not succeed, so activity events were not requested. No idle conclusion was made.",
    });
  else {
    const ranked = got.clusters
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const source = String(row.source ?? "");
        const eligible =
          !EPHEMERAL.has(source) &&
          typeof row.id === "string" &&
          CLUSTER_ID.test(row.id) &&
          (row.state === "RUNNING" || row.auto === 0);
        if (!eligible) return false;
        const age = hoursSince(finite(row.activity));
        if (age != null && age < 24) {
          freshActivity++;
          return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          Number(b.row.state === "RUNNING") - Number(a.row.state === "RUNNING") ||
          Number(a.row.auto !== 0) - Number(b.row.auto !== 0) ||
          a.index - b.index,
      );
    matchedEvents = ranked.length;
    cappedEvents = ranked.length > EVENT_CAP;
    const chosen = ranked.slice(0, EVENT_CAP);
    for (const { row } of chosen) {
      sampled.add(row.id);
      try {
        events.set(row.id, await clusterEvents(cli, raw, r, scope, row.id));
      } catch {
        failedEvents.add(row.id);
      }
    }
    s.coverage.push({
      name: "Databricks cluster activity events",
      state:
        chosen.length === 0
          ? "Available"
          : failedEvents.size === chosen.length
            ? "Unavailable"
            : cappedEvents || failedEvents.size
              ? "Partial"
              : "Available",
      explanation:
        chosen.length === 0
          ? freshActivity
            ? `${freshActivity} running or termination-disabled clusters had last activity within 24 hours, so no activity-event read was issued. last_activity_time is the usage signal for those clusters.`
            : "No running or termination-disabled all-purpose clusters were returned, so no activity-event reads were issued. Job and pipeline clusters are excluded because Databricks manages their lifetime."
          : `Read the newest event types for ${chosen.length - failedEvents.size} of ${ranked.length} clusters whose last activity was missing or older than 24 hours (cap ${EVENT_CAP}). ${freshActivity} newer clusters were not sampled. ${failedEvents.size} reads failed. Event payloads and driver logs are not requested. A short or empty page is not proof of idleness.`,
    });
  }
  const billing = await readSystemBilling(s, cli, raw, r, scope, got);
  assessDatabricks(s, got, {
    events,
    sampled,
    failed: failedEvents,
    matched: matchedEvents,
    capped: cappedEvents,
  });
  applyBilling(s, billing);
  s.limitations.push(
    "Workspace data-plane reads require existing Entra access, Databricks object permissions and network connectivity. Azure Reader alone is insufficient. az rest obtains the Databricks audience token internally; the plugin never extracts it or attempts admin auto-provisioning.",
    "Cluster lists are retained visible objects, not a complete historical inventory. Job and pipeline clusters are not manual cleanup targets. Runs that started before the selected window can still be active, and task-level cluster references outside the projected fields stay unknown.",
    "SQL history is a control-plane list with statement text omitted. It does not start a warehouse and it is not a DBU total. A read that hits the 5,000-record cap is a lower bound: a warehouse missing from that prefix is not unused. Retention, dashboards, Genie and external BI can still be missing. Activity events are requested only when last activity is missing or older than 24 hours, for at most 20 clusters, and only as event type plus timestamp.",
    "system.billing.usage is read only when ARM exposes a numeric workspace id and a SQL warehouse is rechecked as RUNNING. The plugin does not call a start API. A warehouse that stops in the moment between that recheck and the statement can still auto-resume. The statement is a fixed aggregate of object ids, SKU, unit and DBU quantity; tags, identity and notebook ids are not selected. It is cancelled if it exceeds 50 seconds. External result links are not followed. Each usage row is assigned to one object. List prices are Databricks' published Azure price, not the invoice, and are not added to managed-group or workspace Azure charges. Usage can lag. A partial billing read is a lower bound, not a zero.",
    "Serving invocation counts and vector-search query volume are not collected. Pipeline continuous and serverless flags are not read, because the pipeline specification can contain configuration values. IDLE versus RUNNING and the latest returned update are the pipeline signals.",
    "Databricks managed infrastructure is service-owned. Cleanup steps are instructions for Databricks controls. Do not directly delete its VMs, disks or the managed group.",
  );
}
const UI_PATH: Record<DbKey, (row: any, id: string) => string> = {
  clusters: (_row, id) => `compute/clusters/${id}`,
  warehouses: (_row, id) => `sql/warehouses/${id}`,
  pools: (_row, id) => `compute/pools/${id}`,
  jobs: (_row, id) => `jobs/${id}`,
  runs: (row) => `jobs/${encodeURIComponent(String(row.job ?? ""))}`,
  queries: (_row, id) => id,
  pipelines: (_row, id) => `pipelines/${id}`,
  serving: (row) => `ml/endpoints/${encodeURIComponent(String(row.name))}`,
  vectors: (row) => `vector-search/${encodeURIComponent(String(row.name))}`,
};
function pushDatabricksAsset(
  s: ServiceInspection,
  key: DbKey,
  row: any,
  host: string,
) {
  const id = assetId(key, row);
  if (!id) return;
  const category = DB_ROUTES[key].category,
    createdMs =
      key === "jobs" || key === "serving" || key === "vectors"
        ? finite(row.created)
        : null,
    config =
      key === "clusters"
        ? `Node ${value(row.node)} · driver ${value(row.driver)} · workers ${value(row.workers)} · autoscale ${value(row.min)}–${value(row.max)} · auto-termination ${value(row.auto)} min · pool ${value(row.pool)} · driver pool ${value(row.driverPool)} · source ${value(row.source)} · runtime ${value(row.runtime)} · assigned user ${value(row.single)} · last start ${timestamp(row.started)} (not creation) · last termination ${timestamp(row.terminated)} · last activity ${timestamp(row.activity)} (not creation)`
        : key === "warehouses"
          ? `Size ${value(row.size)} · type ${value(row.type)} · clusters min/max/running ${value(row.min)}/${value(row.max)}/${value(row.running)} · active sessions ${value(row.sessions)} (snapshot) · auto-stop ${value(row.auto)} min · serverless ${value(row.serverless)} · photon ${value(row.photon)} · health ${value(row.health)} · creator ${value(row.creator)}`
          : key === "pools"
            ? `Node ${value(row.node)} · min idle ${value(row.min)} · max ${value(row.max)} · idle/used/pending ${value(row.idle)}/${value(row.used)}/${value(row.pending)} · auto-termination ${value(row.auto)} min`
            : key === "jobs"
              ? `Creator ${value(row.creator)} · run as ${value(row.runAs)} · schedule ${value(row.paused)} ${typeof row.cron === "string" ? row.cron : ""} · continuous ${value(row.continuous)} · trigger ${value(row.trigger)} · existing cluster ${value(row.cluster)} · task clusters ${strings(row.taskClusters).join(", ") || "none returned"} · SQL warehouses ${strings(row.warehouse).join(", ") || "none returned"} · job clusters ${value(row.jobClusters)}`
              : key === "runs"
                ? `Job ${value(row.job)} · cluster ${value(row.cluster)} · start ${timestamp(row.start)} · result ${value(row.result)}`
                : key === "pipelines"
                  ? `Creator ${value(row.creator)} · run as ${value(row.runAs)} · reported cluster ${value(row.cluster)} · latest returned update ${timestamp(row.updated)} ${value(row.updateState)}`
                  : key === "serving"
                    ? `Scale-to-zero ${brief(row.scales)} · sizes ${brief(row.sizes)} · min concurrency ${brief(row.minC)} · max provisioned throughput ${brief(row.maxT)} · updated ${timestamp(row.updated)}`
                    : `Type ${value(row.type)} · indexes ${value(row.indexes)} · creator ${value(row.creator)}`;
  const linkId = encodeURIComponent(
    key === "serving" || key === "vectors" ? String(row.name) : id,
  );
  s.assets.push({
    id,
    name: String(row.name ?? row.id ?? id),
    category,
    created: {
      value: createdMs != null && createdMs > 0 ? timestamp(createdMs) : null,
      confidence: createdMs != null && createdMs > 0 ? "Verified" : "Unknown",
      source:
        key === "jobs"
          ? "Databricks job created_time"
          : key === "serving"
            ? "Databricks serving creation_timestamp"
            : key === "vectors"
              ? "Databricks vector-search creation_timestamp where returned"
              : "Creation not exposed here; cluster last start and last activity are not creation",
    },
    state: value(row.state),
    configuration: config.trim(),
    source: `Databricks ${DB_ROUTES[key].path}; creator and run-as are not the current owner`,
    url:
      key === "queries"
        ? undefined
        : `https://${host}/${UI_PATH[key](row, linkId)}`,
  });
}
async function clusterEvents(
  cli: Cli,
  raw: any,
  r: Resource,
  scope: Scope,
  clusterId: string,
): Promise<ActivitySample> {
  const start = Date.parse(scope.from),
    end = Math.min(Date.parse(scope.to), Date.now());
  if (!CLUSTER_ID.test(clusterId) || !Number.isFinite(start) || start >= end)
    throw new Error("Cluster activity window unavailable");
  const url = new URL(`https://${workspaceHost(raw)}/api/2.0/clusters/events`);
  url.searchParams.set("cluster_id", clusterId);
  url.searchParams.set("start_time", String(start));
  url.searchParams.set("end_time", String(end));
  url.searchParams.set("order", "DESC");
  url.searchParams.set("limit", "100");
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
      "{items:events[].{time:timestamp,type:type},next:next_page_token,total:total_count}",
    ],
    `Read Databricks cluster activity event types for ${r.name}; payloads and logs are not requested`,
  );
  if (!Array.isArray(result?.items))
    throw new Error("Cluster events absent; activity unknown");
  let last: number | null = null,
    lastType: string | null = null;
  for (const item of result.items) {
    if (typeof item?.time === "number" && (last == null || item.time > last)) {
      last = item.time;
      lastType = typeof item.type === "string" ? item.type : null;
    }
  }
  const total = finite(result.total),
    complete = !result.next && result.more !== true,
    page = result.items.length;
  return {
    count: total ?? (complete ? page : null),
    samples: page === 0 && complete ? 1 : page,
    expected: total ?? (complete ? Math.max(page, 1) : page + 1),
    last,
    lastType,
    complete,
  };
}
type EventScan = {
  events: Map<string, ActivitySample>;
  sampled: Set<string>;
  failed: Set<string>;
  matched: number;
  capped: boolean;
};
const AUDIENCE = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";
const WAREHOUSE_ID = /^[a-f0-9]{16}$/i;
const STATEMENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const WORKSPACE_NUM = /^\d{1,20}$/;
const SQL_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const BILLING_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
const SKU_TEXT = /^[A-Za-z0-9_ .:+-]{1,120}$/;
const WAREHOUSE_SIZES = [
  "2X-Small",
  "X-Small",
  "Small",
  "Medium",
  "Large",
  "X-Large",
  "2X-Large",
  "3X-Large",
  "4X-Large",
];
const USAGE_COLUMNS = [
  "cluster_id",
  "warehouse_id",
  "job_id",
  "pipeline_id",
  "endpoint_name",
  "pool_id",
  "sku_name",
  "usage_unit",
  "quantity",
  "recent_quantity",
];
const PRICE_COLUMNS = ["sku_name", "usage_unit", "currency_code", "list_price"];
const STATEMENT_QUERY =
  "{id:statement_id,state:status.state,code:status.error.error_code,truncated:manifest.truncated,columns:manifest.schema.columns[].name,rows:result.data_array,chunk:result.next_chunk_index,external:length(result.external_links)}";
const CHUNK_QUERY =
  "{rows:data_array,chunk:next_chunk_index,external:length(external_links)}";
type SkuQty = { sku: string; unit: string; quantity: number; recent: number };
type ObjectUse = { total: number; recent: number; skus: SkuQty[] };
type ListPrice = { currency: string; price: number };
type BillingUse = {
  complete: boolean;
  byAsset: Map<string, ObjectUse>;
  prices: Map<string, ListPrice>;
  workspaceId: string;
  warehouseId: string;
};
type UsageRow = {
  cluster: string | null;
  warehouse: string | null;
  job: string | null;
  pipeline: string | null;
  endpoint: string | null;
  pool: string | null;
  sku: string;
  unit: string;
  quantity: number;
  recent: number;
};
const dbus = (n: number) => String(Math.round(n * 1e6) / 1e6);
const sqlStamp = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const text = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  if (!SQL_STAMP.test(text)) throw new Error("schema");
  return text;
};
function workspaceNumericId(raw: any): string | null {
  const id = raw.properties?.workspaceId;
  const text =
    typeof id === "number" && Number.isInteger(id) && id >= 0
      ? String(id)
      : typeof id === "string"
        ? id
        : "";
  return WORKSPACE_NUM.test(text) ? text : null;
}
function sameColumns(got: unknown, expected: string[]) {
  return (
    Array.isArray(got) &&
    got.length === expected.length &&
    got.every((item, index) => item === expected[index])
  );
}
function billingText(value: unknown, pattern: RegExp): string | null | undefined {
  if (value == null || value === "") return null;
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!text || !pattern.test(text)) return undefined;
  return text;
}
function billingQuantity(value: unknown) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function emptyUse(): ObjectUse {
  return { total: 0, recent: 0, skus: [] };
}
function addUse(map: Map<string, ObjectUse>, key: string, row: UsageRow) {
  const use = map.get(key) ?? emptyUse();
  use.total += row.quantity;
  use.recent += row.recent;
  const sku = use.skus.find((item) => item.sku === row.sku && item.unit === row.unit);
  if (sku) {
    sku.quantity += row.quantity;
    sku.recent += row.recent;
  } else
    use.skus.push({
      sku: row.sku,
      unit: row.unit,
      quantity: row.quantity,
      recent: row.recent,
    });
  map.set(key, use);
}
function usageSql(workspaceId: string, from: string, to: string, recent: string) {
  if (
    !WORKSPACE_NUM.test(workspaceId) ||
    !SQL_STAMP.test(from) ||
    !SQL_STAMP.test(to) ||
    !SQL_STAMP.test(recent)
  )
    throw new Error("schema");
  return `SELECT usage_metadata.cluster_id AS cluster_id, usage_metadata.warehouse_id AS warehouse_id, CAST(usage_metadata.job_id AS STRING) AS job_id, usage_metadata.dlt_pipeline_id AS pipeline_id, usage_metadata.endpoint_name AS endpoint_name, usage_metadata.instance_pool_id AS pool_id, sku_name, usage_unit, SUM(usage_quantity) AS quantity, SUM(CASE WHEN usage_start_time >= TIMESTAMP '${recent}' THEN usage_quantity ELSE 0 END) AS recent_quantity FROM system.billing.usage WHERE workspace_id = '${workspaceId}' AND usage_start_time >= TIMESTAMP '${from}' AND usage_start_time < TIMESTAMP '${to}' GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`;
}
const PRICE_SQL =
  "SELECT sku_name, usage_unit, currency_code, pricing.default AS list_price FROM system.billing.list_prices WHERE cloud = 'AZURE' AND price_end_time IS NULL";
function chooseWarehouse(rows: any[]) {
  const running = rows.filter(
    (row) =>
      row?.state === "RUNNING" &&
      typeof row.id === "string" &&
      WAREHOUSE_ID.test(row.id),
  );
  const sizeRank = (size: unknown) => {
    const index = WAREHOUSE_SIZES.indexOf(String(size));
    return index === -1 ? 50 : index;
  };
  running.sort(
    (a, b) =>
      Number(b.serverless === false) - Number(a.serverless === false) ||
      sizeRank(a.size) - sizeRank(b.size) ||
      String(a.id).localeCompare(String(b.id)),
  );
  return running[0] ?? null;
}
function billingOwner(
  row: UsageRow,
  got: Partial<Record<DbKey, any[]>>,
): string {
  if (row.warehouse) return row.warehouse;
  const cluster = row.cluster
    ? (got.clusters ?? []).find((item) => assetId("clusters", item) === row.cluster)
    : undefined;
  if (cluster && !EPHEMERAL.has(String(cluster.source ?? ""))) return row.cluster!;
  if (row.pipeline) return row.pipeline;
  if (row.job) return row.job;
  if (row.endpoint) {
    if ((got.serving ?? []).some((item) => item?.name === row.endpoint))
      return `serving:${row.endpoint}`;
    if ((got.vectors ?? []).some((item) => item?.name === row.endpoint))
      return `vector:${row.endpoint}`;
    return `endpoint:${row.endpoint}`;
  }
  if (row.pool) return row.pool;
  if (row.cluster) return row.cluster;
  return "workspace-unattributed";
}
function parseUsage(columns: unknown, rows: unknown): UsageRow[] {
  if (!sameColumns(columns, USAGE_COLUMNS) || !Array.isArray(rows))
    throw new Error("schema");
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== USAGE_COLUMNS.length)
      throw new Error("schema");
    const id = (value: unknown) => billingText(value, BILLING_ID);
    const cluster = id(row[0]),
      warehouse = id(row[1]),
      job = id(row[2]),
      pipeline = id(row[3]),
      endpoint = id(row[4]),
      pool = id(row[5]),
      sku = billingText(row[6], SKU_TEXT),
      unit = billingText(row[7], SKU_TEXT),
      quantity = billingQuantity(row[8]),
      recent = billingQuantity(row[9]);
    if (
      cluster === undefined ||
      warehouse === undefined ||
      job === undefined ||
      pipeline === undefined ||
      endpoint === undefined ||
      pool === undefined ||
      !sku ||
      !unit ||
      quantity == null ||
      recent == null ||
      recent > quantity + 1e-9
    )
      throw new Error("schema");
    return { cluster, warehouse, job, pipeline, endpoint, pool, sku, unit, quantity, recent };
  });
}
function parsePrices(columns: unknown, rows: unknown) {
  if (!sameColumns(columns, PRICE_COLUMNS) || !Array.isArray(rows))
    throw new Error("schema");
  const prices = new Map<string, ListPrice>(),
    ambiguous = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== PRICE_COLUMNS.length)
      throw new Error("schema");
    const sku = billingText(row[0], SKU_TEXT),
      unit = billingText(row[1], SKU_TEXT),
      currency = billingText(row[2], /^[A-Z]{3}$/),
      price = billingQuantity(row[3]);
    if (!sku || !unit || !currency || price == null) throw new Error("schema");
    const key = `${sku}\0${unit}`;
    if (ambiguous.has(key)) continue;
    const prev = prices.get(key);
    if (!prev) prices.set(key, { currency, price });
    else if (prev.currency !== currency || prev.price !== price) {
      prices.delete(key);
      ambiguous.add(key);
    }
  }
  return prices;
}
async function runStatement(
  cli: Cli,
  raw: any,
  r: Resource,
  warehouseId: string,
  statement: string,
  reason: string,
) {
  const host = workspaceHost(raw);
  if (!WAREHOUSE_ID.test(warehouseId)) throw new Error("schema");
  const submitted = await cli(
    [
      "rest",
      "--method",
      "post",
      "--url",
      `https://${host}/api/2.0/sql/statements`,
      "--resource",
      AUDIENCE,
      "--subscription",
      r.subscriptionId,
      "--body",
      JSON.stringify({
        warehouse_id: warehouseId,
        statement,
        catalog: "system",
        schema: "billing",
        wait_timeout: "50s",
        on_wait_timeout: "CANCEL",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: 4000,
      }),
      "--query",
      STATEMENT_QUERY,
    ],
    reason,
  );
  const links = (value: unknown) => {
    if (value == null || value === 0) return 0;
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : Number.isFinite(count) ? 0 : 1;
  };
  let external = links(submitted?.external),
    chunk = submitted?.chunk,
    rows = Array.isArray(submitted?.rows) ? [...submitted.rows] : submitted?.rows,
    seen = new Set<number>(),
    fetches = 0;
  const statementId = typeof submitted?.id === "string" ? submitted.id : "";
  if (
    (submitted?.state === "PENDING" || submitted?.state === "RUNNING") &&
    STATEMENT_ID.test(statementId)
  ) {
    try {
      await cli(
        [
          "rest",
          "--method",
          "post",
          "--url",
          `https://${host}/api/2.0/sql/statements/${statementId}/cancel`,
          "--resource",
          AUDIENCE,
          "--subscription",
          r.subscriptionId,
          "--query",
          "{state:status.state}",
        ],
        `Cancel the unfinished system.billing statement for ${r.name}. This does not change a Databricks asset.`,
      );
    } catch {
      /* The statement result stays unknown. The cancel failure text is not stored. */
    }
  }
  if (
    submitted?.state === "SUCCEEDED" &&
    typeof chunk === "number" &&
    !STATEMENT_ID.test(statementId)
  )
    throw new Error("schema");
  while (
    submitted?.state === "SUCCEEDED" &&
    typeof chunk === "number" &&
    Number.isInteger(chunk) &&
    chunk >= 0 &&
    chunk <= 1000 &&
    STATEMENT_ID.test(statementId) &&
    !seen.has(chunk) &&
    !(external > 0) &&
    fetches < 5 &&
    Array.isArray(rows) &&
    rows.length < 4000
  ) {
    seen.add(chunk);
    fetches++;
    const page = await cli(
      [
        "rest",
        "--method",
        "get",
        "--url",
        `https://${host}/api/2.0/sql/statements/${statementId}/result/chunks/${chunk}`,
        "--resource",
        AUDIENCE,
        "--subscription",
        r.subscriptionId,
        "--query",
        CHUNK_QUERY,
      ],
      `Read the next inline system.billing chunk for ${r.name}. External links are not followed.`,
    );
    if (!STATEMENT_ID.test(statementId)) throw new Error("schema");
    if (!Array.isArray(page?.rows)) throw new Error("schema");
    rows.push(...page.rows);
    chunk = page.chunk;
    external = links(page.external);
  }
  const unfinished =
    submitted?.state === "PENDING" ||
    submitted?.state === "RUNNING" ||
    submitted?.state === "CANCELED" ||
    submitted?.state === "CANCELLED" ||
    submitted?.state === "CLOSED";
  return {
    state: typeof submitted?.state === "string" ? submitted.state : "",
    code: typeof submitted?.code === "string" ? submitted.code : "",
    columns: submitted?.columns,
    rows,
    truncated: submitted?.truncated === true || (Array.isArray(rows) && rows.length >= 4000),
    external: external > 0,
    more:
      unfinished ||
      external > 0 ||
      (fetches >= 5 && typeof chunk === "number") ||
      (Array.isArray(rows) && rows.length >= 4000),
  };
}
async function readSystemBilling(
  s: ServiceInspection,
  cli: Cli,
  raw: any,
  r: Resource,
  scope: Scope,
  got: Partial<Record<DbKey, any[]>>,
): Promise<BillingUse | null> {
  const name = "Databricks DBU attribution";
  try {
    const wid = workspaceNumericId(raw);
    s.facts.push({
      name: "Workspace id",
      value: wid ?? "Unknown",
      source:
        "Workspace ARM properties.workspaceId. system.billing is account-scoped, so this id is required before a query.",
    });
    const stop = (explanation: string, state: "Unavailable" | "Partial" = "Unavailable") => {
      s.coverage.push({ name, state, explanation });
      return null;
    };
    if (!wid)
      return stop(
        "ARM properties.workspaceId was not a numeric workspace id, so system.billing was not queried. An unfiltered read would include other workspaces, and no warehouse was started.",
      );
    const start = Date.parse(scope.from),
      end = Math.min(Date.parse(scope.to), Date.now());
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      return stop(
        "The selected window is not a usable past interval, so system.billing was not queried and no warehouse was started.",
      );
    const warehouses = got.warehouses as (any[] & { complete?: boolean }) | undefined;
    if (!warehouses)
      return stop(
        "The SQL warehouse list did not succeed, so system.billing was not queried. No warehouse was started, and DBU totals are unknown.",
      );
    const chosen = chooseWarehouse(warehouses);
    if (!chosen)
      return stop(
        warehouses.some((row) => row?.state === "RUNNING")
          ? "A RUNNING warehouse was returned without a usable 16-character id, so system.billing was not queried and no statement was sent."
          : warehouses.complete === false
            ? "The warehouse list stopped early and did not include a RUNNING warehouse, so system.billing was not queried. A stopped warehouse was not started, and a warehouse missing from the prefix is not a zero."
            : "No returned SQL warehouse was RUNNING. system.billing was not queried, because sending a statement to a stopped warehouse can start it.",
      );
    const host = workspaceHost(raw);
    const current = await cli(
      [
        "rest",
        "--method",
        "get",
        "--url",
        `https://${host}/api/2.0/sql/warehouses/${chosen.id}`,
        "--resource",
        AUDIENCE,
        "--subscription",
        r.subscriptionId,
        "--query",
        "{state:state,serverless:enable_serverless_compute}",
      ],
      `Recheck SQL warehouse ${chosen.id} on ${r.name} before system.billing. This read does not start the warehouse.`,
    );
    if (current?.state !== "RUNNING")
      return stop(
        `Warehouse ${chosen.id} was not RUNNING on the immediate recheck, so the system.billing statement was not sent and no warehouse was started.`,
      );
    const from = sqlStamp(start),
      to = sqlStamp(end),
      recent = sqlStamp(Math.max(start, end - 7 * DAY));
    const usage = await runStatement(
      cli,
      raw,
      r,
      chosen.id,
      usageSql(wid, from, to, recent),
      `Read system.billing.usage DBUs for workspace ${wid} through already-running SQL warehouse ${chosen.id}. Tags, identity and notebook ids are not selected. A stopped warehouse is not started.`,
    );
    if (usage.state !== "SUCCEEDED" || usage.more && !Array.isArray(usage.rows)) {
      if (/DENIED|FORBIDDEN|PERMISSION|UNAUTHORIZED|ACCESS/i.test(usage.code))
        throw new Error("access denied");
      return stop(
        usage.state === "PENDING" || usage.state === "RUNNING" || usage.state === "CANCELED" || usage.state === "CANCELLED"
          ? "The system.billing statement did not finish within 50 seconds and was cancelled. No DBU total was treated as zero, and no warehouse was started."
          : "system.billing did not return a complete inline result. External links were not followed. No DBU total was treated as zero.",
      );
    }
    const rawRows = Array.isArray(usage.rows)
      ? usage.rows
      : usage.rows == null
        ? []
        : null;
    if (rawRows == null) throw new Error("schema");
    const parsed =
      rawRows.length === 0 &&
      (usage.columns == null || sameColumns(usage.columns, USAGE_COLUMNS))
        ? []
        : parseUsage(usage.columns, rawRows);
    const complete = !usage.truncated && !usage.external && !usage.more;
    const byAsset = new Map<string, ObjectUse>();
    for (const row of parsed) addUse(byAsset, billingOwner(row, got), row);
    const serverless =
      current.serverless !== false
        ? " The warehouse is serverless, or its serverless flag was not returned, so the statement itself can consume SQL DBUs."
        : " The warehouse is not serverless.";
    s.coverage.push({
      name,
      state: complete ? "Available" : "Partial",
      explanation: complete
        ? `Read system.billing.usage for workspace ${wid} on SQL warehouse ${chosen.id}, which was RUNNING at recheck.${serverless} Each row is assigned to one object. Usage can lag. This is not the Azure invoice.`
        : `system.billing.usage for workspace ${wid} stopped early on SQL warehouse ${chosen.id}.${serverless} Returned DBUs are a lower bound. An object missing from this prefix is not a zero, and external links were not followed.`,
    });
    const use: BillingUse = {
      complete,
      byAsset,
      prices: new Map(),
      workspaceId: wid,
      warehouseId: chosen.id,
    };
    try {
      const priced = await runStatement(
        cli,
        raw,
        r,
        chosen.id,
        PRICE_SQL,
        `Read current Azure Databricks list prices for ${r.name}. These are not the invoice and do not start a stopped warehouse.`,
      );
      if (/DENIED|FORBIDDEN|PERMISSION|UNAUTHORIZED|ACCESS/i.test(priced.code))
        throw new Error("access denied");
      if (priced.state !== "SUCCEEDED" || priced.truncated || priced.external || priced.more)
        throw new Error(priced.truncated ? "pagination incomplete" : "schema");
      use.prices = parsePrices(priced.columns, Array.isArray(priced.rows) ? priced.rows : []);
      s.coverage.push({
        name: "Databricks DBU list prices",
        state: "Available",
        explanation:
          "Current Azure list prices were read from system.billing.list_prices. They are not the negotiated price or the Azure invoice, and they are not added to managed-group charges.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      s.coverage.push({
        name: "Databricks DBU list prices",
        state: "Unavailable",
        explanation: /schema/.test(message)
          ? "List prices did not match the projected columns, so no estimate was made. DBU quantities stand alone and are not an invoice amount."
          : /pagination incomplete|bound/.test(message)
            ? "List prices stopped early, so no estimate was made. DBU quantities stand alone and are not an invoice amount."
            : coverageFailure(error),
      });
    }
    return use;
  } catch (error) {
    s.coverage.push({
      name,
      state: "Unavailable",
      explanation: coverageFailure(error),
    });
    return null;
  }
}
function listPrice(use: ObjectUse, prices: Map<string, ListPrice>) {
  let currency = "",
    amount = 0,
    priced = 0;
  for (const sku of use.skus) {
    const price = prices.get(`${sku.sku}\0${sku.unit}`);
    if (!price) continue;
    if (currency && currency !== price.currency) return null;
    currency = price.currency;
    amount += sku.quantity * price.price;
    priced++;
  }
  if (!priced) return null;
  return {
    amount: Math.round(amount * 1e6) / 1e6,
    currency,
    complete: priced === use.skus.length,
  };
}
function skuBrief(use: ObjectUse) {
  const names = [...new Set(use.skus.map((sku) => sku.sku))];
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown}, and ${names.length - 5} more` : shown;
}
function describeUse(use: ObjectUse | undefined, billing: BillingUse) {
  if (!billing.complete && use)
    return ` system.billing returned at least ${dbus(use.total)} DBU for this object before the read stopped. That is a lower bound, not a total, and it is not the Azure invoice.`;
  if (!billing.complete) return "";
  if (!use || use.total === 0)
    return " system.billing returned no DBUs for this object in the selected window. Usage can lag, and rows without this id stay unattributed. This is not an Azure invoice zero.";
  const price = listPrice(use, billing.prices);
  const priceText = price
    ? price.complete
      ? ` List-price estimate ${price.currency} ${dbus(price.amount)}.`
      : ` List-price estimate ${price.currency} ${dbus(price.amount)} covers only the SKUs with one current Azure list price.`
    : " No list-price estimate was applied.";
  return ` system.billing assigned ${dbus(use.total)} DBU in the selected window, ${dbus(use.recent)} of that in the last 7 days (${skuBrief(use)}).${priceText} This is not the Azure invoice and is not added to managed-group charges.`;
}
function applyBilling(s: ServiceInspection, billing: BillingUse | null) {
  if (!billing) return;
  let returned = 0;
  for (const use of billing.byAsset.values()) returned += use.total;
  const unattributed = billing.byAsset.get("workspace-unattributed") ?? emptyUse();
  const priced = [...billing.byAsset.values()]
    .map((use) => listPrice(use, billing.prices))
    .filter((price): price is NonNullable<typeof price> => !!price && price.complete);
  const oneCurrency = priced.every((price) => price.currency === priced[0]?.currency);
  s.facts.push({
    name: "DBU attribution",
    value: billing.complete
      ? `${dbus(returned)} DBU returned, of which ${dbus(unattributed.total)} had no object id${priced.length && oneCurrency ? `; list-price estimate ${priced[0].currency} ${dbus(priced.reduce((sum, price) => sum + price.amount, 0))} for fully priced objects` : ""}`
      : `At least ${dbus(returned)} DBU returned before system.billing stopped. Per-object figures are a lower bound.`,
    source: `system.billing.usage for workspace ${billing.workspaceId} through SQL warehouse ${billing.warehouseId}. Each row is assigned once. Not the Azure invoice and not added to managed-group charges.`,
  });
  for (const [assetId, use] of billing.byAsset) {
    const asset = s.assets.find((item) => item.id === assetId);
    if (asset)
      asset.configuration += ` · system.billing ${dbus(use.total)} DBU in the selected window`;
    signal(
      s,
      assetId,
      assetId === "workspace-unattributed" ? "Unattributed DBUs" : "DBUs",
      Math.round(use.total * 1e6) / 1e6,
      "DBU",
      billing.complete ? 1 : 1,
      billing.complete ? 1 : 2,
      `${describeUse(use, billing).trim()} Workspace ${billing.workspaceId}.`,
    );
    const price = listPrice(use, billing.prices);
    if (price)
      signal(
        s,
        assetId,
        "DBU list-price estimate",
        price.amount,
        price.currency,
        price.complete ? 1 : use.skus.filter((sku) => billing.prices.has(`${sku.sku}\0${sku.unit}`)).length,
        price.complete ? 1 : use.skus.length,
        price.complete
          ? "system.billing.list_prices current Azure list price times returned DBUs. Not the negotiated price, not the Azure invoice, and not added to managed-group charges."
          : "Partial list-price estimate for SKUs with one current Azure price. Unpriced SKUs are omitted. Not the Azure invoice.",
      );
  }
  for (const candidate of s.candidates) {
    const use = billing.byAsset.get(candidate.assetId);
    candidate.missing = candidate.missing.filter((item) => item !== DBU_GAP);
    if (!billing.complete)
      candidate.missing.push(
        "system.billing stopped early. DBU figures on this card are a lower bound, and an object with no row is not a zero.",
      );
    candidate.evidence += describeUse(use, billing);
    if (
      billing.complete &&
      use &&
      use.recent > 0 &&
      (candidate.disposition === "Review shutdown" ||
        candidate.disposition === "Definition only")
    ) {
      candidate.disposition = "Keep; in use";
      candidate.suggested = `system.billing shows ${dbus(use.recent)} DBUs in the last 7 days of this window, so this is not an idle or definition-only shutdown. ${candidate.suggested}`;
      candidate.confidence =
        "DBUs returned in the last 7 days; shutdown was not recommended";
      candidate.steps = [
        `Open the object in Databricks and keep it. system.billing assigned ${dbus(use.total)} DBU in the selected window, including ${dbus(use.recent)} in the last 7 days.`,
        "Those DBUs are a published quantity, not an Azure invoice, and they are not added to the managed-group total.",
        "Change the auto-stop or scale policy only with the owner. Do not delete the managed resource group.",
      ];
    }
  }
  sortCandidates(s);
}
function sortCandidates(s: ServiceInspection) {
  const posture = [
    ["Review shutdown", 0],
    ["Change policy", 1],
    ["Definition only", 2],
    ["Keep; in use", 3],
  ] as const;
  s.candidates.sort(
    (a, b) =>
      (posture.find((item) => item[0] === a.disposition)?.[1] ?? 9) -
        (posture.find((item) => item[0] === b.disposition)?.[1] ?? 9) ||
      a.assetId.localeCompare(b.assetId),
  );
}
type QueryUse = {
  count: number;
  active: number;
  users: string[];
  durationMs: number;
  durationKnown: number;
  last: number | null;
};
function assessDatabricks(
  s: ServiceInspection,
  got: Partial<Record<DbKey, any[]>>,
  scan: EventScan,
) {
  const jobs = got.jobs ?? null,
    runs = got.runs ?? null,
    pipelines = got.pipelines ?? null,
    queries = got.queries ?? null,
    clusters = got.clusters ?? null,
    historyComplete =
      !!queries && (queries as { complete?: boolean }).complete !== false;
  const runsByCluster = new Map<string, { count: number; active: number }>(),
    runsByJob = new Map<string, { count: number; active: number }>();
  if (runs)
    for (const run of runs) {
      const active = ACTIVE_RUN.has(String(run.state ?? ""));
      if (typeof run.cluster === "string" && run.cluster) {
        const row = runsByCluster.get(run.cluster) ?? { count: 0, active: 0 };
        row.count++;
        if (active) row.active++;
        runsByCluster.set(run.cluster, row);
      }
      if (run.job != null) {
        const key = String(run.job),
          row = runsByJob.get(key) ?? { count: 0, active: 0 };
        row.count++;
        if (active) row.active++;
        runsByJob.set(key, row);
      }
    }
  const queriesByWarehouse = new Map<string, QueryUse>();
  let unscopedQueries = 0;
  if (queries)
    for (const query of queries) {
      if (typeof query.warehouse !== "string" || !query.warehouse) {
        unscopedQueries++;
        continue;
      }
      const row = queriesByWarehouse.get(query.warehouse) ?? {
        count: 0,
        active: 0,
        users: [],
        durationMs: 0,
        durationKnown: 0,
        last: null,
      };
      row.count++;
      if (query.status === "RUNNING" || query.status === "QUEUED") row.active++;
      if (typeof query.user === "string" && query.user && !row.users.includes(query.user))
        row.users.push(query.user);
      const duration = finite(query.duration);
      if (duration != null && duration >= 0) {
        row.durationMs += duration;
        row.durationKnown++;
      }
      const end = finite(query.end) ?? finite(query.start);
      if (end != null && (row.last == null || end > row.last)) row.last = end;
      queriesByWarehouse.set(query.warehouse, row);
    }
  const clusterById = new Map<string, any>();
  if (clusters)
    for (const row of clusters) {
      const id = assetId("clusters", row);
      if (id) clusterById.set(id, row);
    }
  const count = (rows?: any[]) => (rows ? String(rows.length) : "unknown");
  s.facts.push({
    name: "Returned usage snapshot",
    value: `clusters ${count(got.clusters)} · warehouses ${count(got.warehouses)} · pools ${count(got.pools)} · jobs ${count(got.jobs)} · runs ${count(got.runs)} · SQL history rows ${count(got.queries)} · pipelines ${count(got.pipelines)} · serving endpoints ${count(got.serving)} · vector endpoints ${count(got.vectors)}`,
    source:
      "Returned record counts. Unknown means that collection failed and is not a zero. SQL history rows are not warehouse assets.",
  });
  if (clusters)
    for (const row of clusters) {
      const id = assetId("clusters", row);
      if (!id) continue;
      const source = String(row.source ?? "");
      if (EPHEMERAL.has(source)) {
        annotate(
          s,
          "Cluster",
          id,
          "Databricks-managed lifetime; not a manual cleanup target",
        );
        continue;
      }
      const jobHits = jobs
          ? jobs.filter((job) => jobClusterIds(job).includes(id))
          : null,
        pipelineHits = pipelines
          ? pipelines.filter((item) => item.cluster === id)
          : null,
        runUse = runs ? runsByCluster.get(id) ?? { count: 0, active: 0 } : null,
        activity = finite(row.activity),
        activityHours = hoursSince(activity),
        event = scan.events.get(id);
      if (runUse)
        signal(
          s,
          id,
          "Job runs referencing cluster",
          runUse.count,
          "runs started in the selected window",
          1,
          1,
          runUse.active
            ? `${runUse.active} returned runs are still active. 1/1 means the run list completed. Runs that started before the window are excluded.`
            : "1/1 means the run list completed. The value is the count. Runs that started before the selected window are excluded and can still be active.",
        );
      if (activityHours != null)
        signal(
          s,
          id,
          "Hours since cluster last activity",
          Math.round(activityHours * 10) / 10,
          "hours",
          1,
          1,
          "Databricks last_activity_time. This is not creation time and does not include every notebook or stream.",
        );
      if (event)
        signal(
          s,
          id,
          "Cluster activity events",
          event.count,
          "event types in the selected window",
          event.samples,
          event.expected,
          event.complete
            ? `Newest returned event ${event.lastType ?? "none"} at ${ageText(event.last)}. An empty page is not proof the cluster was idle.`
            : "Descending first page only. Older events in the window can be omitted, so the count is a lower bound when total_count is absent.",
        );
      const usage = [
        `source ${source || "not returned"}`,
        `last activity ${ageText(activity)}`,
        jobHits
          ? jobHits.length
            ? `jobs ${titled(jobHits)}`
            : "no returned job references this cluster"
          : "job references unknown",
        pipelineHits
          ? pipelineHits.length
            ? `pipelines ${titled(pipelineHits)}`
            : "no returned pipeline reports this cluster"
          : "pipeline references unknown",
        runUse
          ? `${runUse.count} returned runs (${runUse.active} active)`
          : "runs unknown",
        event
          ? `${event.count ?? "at least " + event.samples} activity events`
          : scan.failed.has(id)
            ? "activity events unread"
            : scan.capped && !scan.sampled.has(id)
              ? `activity events not read (cap ${EVENT_CAP} of ${scan.matched})`
              : activityHours != null && activityHours < 24
                ? "activity events skipped; last activity is under 24 hours"
                : "activity events not requested",
      ].join("; ");
      annotate(s, "Cluster", id, usage);
      const consumers =
        (jobHits?.length ?? 0) +
        (pipelineHits?.length ?? 0) +
        (runUse?.active ?? 0);
      const missing = [
        ...USAGE_GAPS,
        jobs ? "" : "The job list failed, so consumers are unknown.",
        pipelines ? "" : "The pipeline list failed, so pipeline consumers are unknown.",
        runs
          ? "Runs that started before the selected window are not in this list."
          : "Job runs failed, so active runs are unknown.",
        scan.failed.has(id)
          ? "Activity events could not be read."
          : scan.capped && !scan.sampled.has(id)
            ? `Activity events were not read because inspection samples at most ${EVENT_CAP} clusters.`
            : "",
        source
          ? ""
          : "Cluster source was not returned, so this may be a job cluster that Databricks already stops.",
        activityHours == null ? "Last activity was not returned, so idleness is unknown." : "",
      ].filter(Boolean);
      const live = LIVE_CLUSTER.has(String(row.state ?? "")) || row.state == null;
      if (live && row.auto === 0) {
        const idle =
          activityHours != null &&
          activityHours >= 24 * 7 &&
          consumers === 0 &&
          jobs &&
          pipelines &&
          runs &&
          runUse?.count === 0;
        s.candidates.push({
          assetId: id,
          title: "Cluster: automatic shutdown disabled",
          evidence: `Auto-termination is 0 minutes and state is ${value(row.state)}. ${usage}.`,
          missing,
          suggested: idle
            ? "Review setting automatic termination or terminating this cluster in Databricks. Collected jobs, pipelines and runs do not reference it, but that is not permission to delete it."
            : "Review enabling automatic termination with the owner. Do not terminate on this signal alone.",
          steps: [
            "Open this cluster from the inventory link in Databricks Compute.",
            jobHits?.length
              ? `Edit the jobs that use it (${titled(jobHits)}) to a job cluster before changing this cluster. An all-purpose cluster keeps billing between runs.`
              : pipelineHits?.length
                ? `Pipeline ${titled(pipelineHits)} reports this cluster. Confirm that pipeline can stop before terminating the cluster.`
                : "If a notebook, stream, or job still needs it, leave the cluster running until that owner confirms.",
            runUse?.active
              ? "A returned run is still active. Wait until it finishes before terminating the cluster."
              : activityHours != null && activityHours < 24
                ? "Databricks reported activity in the last 24 hours. Set Terminate after to a non-zero value such as 60 minutes so it stops once that work is idle, rather than terminating it immediately."
                : "Set Terminate after to a non-zero value the owner accepts, commonly 60 minutes. Terminate the cluster in Databricks only after that confirmation.",
            MANAGED_STEP,
          ],
          confidence: idle
            ? "Verified configuration; no returned consumers in the collected surfaces"
            : activityHours != null && activityHours < 24
              ? "Verified configuration; recent activity returned"
              : "Verified configuration; idle status incomplete",
          disposition:
            (runUse?.active ?? 0) > 0 ||
            (jobHits?.length ?? 0) > 0 ||
            (pipelineHits?.length ?? 0) > 0 ||
            (activityHours != null && activityHours < 24)
              ? "Keep; in use"
              : idle
                ? "Review shutdown"
                : "Change policy",
        });
      } else if (String(row.state ?? "") === "TERMINATED") {
        const old =
          hoursSince(finite(row.terminated)) != null &&
          hoursSince(finite(row.terminated))! >= 24 * 14;
        const knownInteractive = source === "UI" || source === "API" || source === "SQL";
        const unreferenced =
          !!jobs &&
          !!pipelines &&
          !!runs &&
          !jobHits?.length &&
          !pipelineHits?.length &&
          runUse?.count === 0;
        if (knownInteractive && old && unreferenced)
          s.candidates.push({
            assetId: id,
            title: "Terminated cluster definition is still retained",
            evidence: `State is TERMINATED since ${ageText(finite(row.terminated))}. It is not billing workers right now. ${usage}.`,
            missing,
            suggested:
              "Review permanently deleting the cluster definition in Databricks if the owner agrees. This does not remove notebooks, tables, or the managed resource group, and it is not a current compute-charge saving by itself.",
            steps: [
              "Open Compute and confirm the cluster is terminated and that no job or pipeline still names it.",
              row.auto === 0
                ? "If you keep the definition, set automatic termination before the next start. A terminated cluster with termination disabled will stay up the next time someone starts it."
                : "If you keep the definition, leave its existing termination policy in place unless the owner wants a different window.",
              "Permanently delete the cluster definition from Databricks only after the owner confirms the notebooks and tables are kept elsewhere.",
              MANAGED_STEP,
            ],
            confidence:
              "Definition review; no current worker billing established from the cluster state",
            disposition: "Definition only",
          });
        else if (row.auto === 0)
          s.candidates.push({
            assetId: id,
            title: "Stopped cluster will not auto-stop on the next start",
            evidence: `State is TERMINATED and auto-termination is 0 minutes. ${usage}.`,
            missing,
            suggested:
              "Review setting automatic termination before this cluster is started again. Do not delete it from this signal alone.",
            steps: [
              "Open the terminated cluster in Databricks Compute.",
              jobHits?.length
                ? `Jobs still reference it (${titled(jobHits)}). Change those jobs or keep the cluster.`
                : "Confirm with the assigned user or creator that the next start is still expected.",
              "Set Terminate after to a non-zero value such as 60 minutes so the next session stops itself.",
              MANAGED_STEP,
            ],
            confidence: "Verified configuration; cluster is not running now",
            disposition: "Change policy",
          });
      }
    }
  if (got.warehouses)
    for (const row of got.warehouses) {
      const id = assetId("warehouses", row);
      if (!id) continue;
      const use = queries ? queriesByWarehouse.get(id) ?? emptyQuery() : null,
        jobHits = jobs
          ? jobs.filter((job) => strings(job.warehouse).includes(id))
          : null,
        sessions = finite(row.sessions);
      if (use)
        signal(
          s,
          id,
          "SQL history queries",
          use.count,
          "queries",
          historyComplete ? 1 : use.count,
          historyComplete ? 1 : use.count + 1,
          `${historyComplete ? "1/1 means the SQL history list completed." : "Sample coverage is short of the cap because the read stopped. This count is a lower bound, and a zero is not proof of no queries."} The value is the count. Distinct users ${use.users.length}. ${use.durationKnown} rows reported duration. Retention and non-SQL clients can be missing. ${unscopedQueries} history rows had no warehouse id. This did not start a warehouse.`,
        );
      if (sessions != null)
        signal(
          s,
          id,
          "Active SQL sessions",
          sessions,
          "sessions",
          1,
          1,
          "Point-in-time warehouse list snapshot, not a usage history.",
        );
      const history = use
        ? `${use.count} SQL history rows (${use.active} queued or running)${use.users.length ? `; users ${use.users.slice(0, 3).join(", ")}` : ""}${use.durationKnown ? `; ${use.durationMs < 60000 ? `${Math.round(use.durationMs / 1000)} seconds` : `${Math.round(use.durationMs / 60000)} minutes`} of reported duration` : ""}; last ${ageText(use.last)}`
        : "SQL history unknown";
      annotate(
        s,
        "SQL warehouse",
        id,
        `${history}; ${jobHits ? (jobHits.length ? `jobs ${titled(jobHits)}` : "no returned SQL task references this warehouse") : "job references unknown"}`,
      );
      const warm =
        row.state === "RUNNING" &&
        typeof row.min === "number" &&
        row.min > 1 &&
        row.serverless !== true;
      if (row.auto !== 0 && !warm) continue;
      const busy = (use?.count ?? 0) > 0 || (use?.active ?? 0) > 0 || (sessions ?? 0) > 0 || (jobHits?.length ?? 0) > 0;
      const provenQuiet =
        historyComplete &&
        !!use &&
        use.count === 0 &&
        sessions === 0 &&
        !!jobs &&
        !(jobHits?.length);
      s.candidates.push({
        assetId: id,
        title:
          row.auto === 0 && warm
            ? "SQL warehouse: automatic stop disabled and warm minimum"
            : row.auto === 0
              ? "SQL warehouse: automatic stop disabled"
              : "SQL warehouse keeps extra clusters warm",
        evidence: `Auto-stop ${value(row.auto)} minutes; minimum clusters ${value(row.min)}; state ${value(row.state)}; type ${value(row.type)}; serverless ${value(row.serverless)}; active sessions ${value(row.sessions)}. ${history}. ${jobHits ? (jobHits.length ? `Jobs ${titled(jobHits)} reference it.` : "No returned SQL task references it.") : "Job references were not collected."}`,
        missing: [
          ...USAGE_GAPS,
          queries
            ? historyComplete
              ? "SQL history retention can omit older queries. Dashboards and Genie may not appear here."
              : "SQL history stopped at the inspection cap. A zero for this warehouse is a lower bound, not proof of no queries."
            : "SQL history failed. Do not treat the query count as zero.",
          jobs ? "" : "Jobs were not collected, so scheduled SQL consumers are unknown.",
        ].filter(Boolean),
        suggested: busy
          ? "Review enabling auto-stop or lowering the cluster minimum. Returned usage means this is a shutdown-policy change, not evidence to delete the warehouse."
          : provenQuiet
            ? "Review stopping the warehouse or enabling auto-stop. No returned SQL history, jobs, or current sessions reference it. That is still not proof it is unused."
            : "Review the auto-stop and minimum-cluster settings with the owner. Do not delete the warehouse on this signal alone.",
        steps: [
          "Open this warehouse from the inventory link under SQL Warehouses.",
          jobHits?.length
            ? `Jobs reference it (${titled(jobHits)}). Confirm those schedules still need this warehouse before changing it.`
            : use && use.count > 0
              ? `The selected window has ${use.count} retained SQL history rows${use.users.length ? ` from ${use.users.slice(0, 3).join(", ")}` : ""}. Ask those users before deleting anything.`
              : !historyComplete
                ? "SQL history was capped before this warehouse was attributed a query. Do not treat the missing rows as no usage."
                : "No returned SQL task or history row is attributed to this warehouse. Confirm dashboards and external BI with the owner before treating it as unused.",
          row.auto === 0
            ? row.serverless === true
              ? "Set Auto stop to a non-zero value such as 10 or 30 minutes. Serverless warehouses bill mainly while queries run; classic warehouses bill while their clusters are up."
              : "Set Auto stop to a non-zero value such as 10 or 30 minutes. A classic warehouse with a minimum above 1 keeps extra clusters warm while it is running."
            : `Lower the minimum cluster count from ${row.min} after checking concurrency. A minimum of 1 is normal; this warehouse keeps more than one cluster.`,
          row.state === "RUNNING" && !busy
            ? "The warehouse is running now. Stop it in Databricks if the owner agrees, or let auto-stop do that after you enable it. Do not delete the workspace."
            : "Do not delete the warehouse while queries, jobs, or sessions still use it.",
          MANAGED_STEP,
        ],
        confidence: busy
          ? "Verified configuration; returned usage argues against deletion"
          : provenQuiet
            ? "Verified configuration; no returned SQL history or current sessions"
            : "Verified configuration; usage incomplete",
        disposition: busy
          ? "Keep; in use"
          : provenQuiet
            ? "Review shutdown"
            : "Change policy",
      });
    }
  if (got.pools && clusters)
    for (const row of got.pools) {
      const id = assetId("pools", row);
      if (!id || typeof row.min !== "number" || row.min <= 0) continue;
      const users = clusters.filter(
        (cluster) => cluster.pool === id || cluster.driverPool === id,
      );
      if (finite(row.idle) != null)
        signal(
          s,
          id,
          "Idle pool instances",
          finite(row.idle),
          "instances",
          1,
          1,
          "Point-in-time pool stats, not a history of how long instances stayed idle.",
        );
      annotate(
        s,
        "Instance pool",
        id,
        users.length
          ? `referenced by ${titled(users)}`
          : "no returned cluster references this pool",
      );
      s.candidates.push({
        assetId: id,
        title: "Pool retains minimum idle capacity",
        evidence: `Minimum idle instances ${row.min}; snapshot idle ${value(row.idle)}, used ${value(row.used)}, pending idle ${value(row.pending)}. ${users.length ? `Clusters ${titled(users)} reference it.` : "No returned cluster references it."}`,
        missing: [
          "Cold-start requirements and scheduled workloads that have not attached a cluster yet.",
          "Clusters hidden from the cluster list can still request this pool.",
          ...USAGE_GAPS,
        ],
        suggested: users.length
          ? "Review a lower minimum idle value. Do not delete a pool that returned clusters still reference."
          : "Review setting minimum idle instances to 0 so Databricks can release warm VMs. Confirm no later job needs the pool.",
        steps: users.length
          ? [
              "Open Compute → Instance pools → this pool.",
              `Keep the pool while ${titled(users)} still use it. Deleting the pool can prevent those clusters from starting.`,
              `Lower Minimum idle instances from ${row.min} toward 0 after the owner accepts the longer cold start.`,
              MANAGED_STEP,
            ]
          : [
              "Open Compute → Instance pools → this pool.",
              "Confirm scheduled jobs will not need warm capacity. The cluster list does not show a current consumer, and a future job can still request the pool.",
              "Set Minimum idle instances to 0. Databricks then releases idle VMs; do not delete those VMs yourself.",
              MANAGED_STEP,
            ],
        confidence: users.length
          ? "Verified allocation; returned clusters consume the pool"
          : "Verified allocation; no returned cluster consumer",
        disposition: users.length ? "Change policy" : "Review shutdown",
      });
    }
  else if (got.pools)
    for (const row of got.pools) {
      const id = assetId("pools", row);
      if (!id || typeof row.min !== "number" || row.min <= 0) continue;
      s.candidates.push({
        assetId: id,
        title: "Pool retains minimum idle capacity",
        evidence: `Minimum idle instances ${row.min}; snapshot idle ${value(row.idle)}, used ${value(row.used)}. Cluster references were not collected.`,
        missing: ["Cluster consumers are unknown because the cluster list failed.", ...USAGE_GAPS],
        suggested:
          "Review a lower minimum idle allocation in Databricks. Do not delete the pool while its consumers are unknown.",
        steps: [
          "Open Compute → Instance pools → this pool.",
          "The cluster list failed, so do not assume the pool is unused.",
          "Lower Minimum idle instances only after the owner confirms cold starts are acceptable.",
          MANAGED_STEP,
        ],
        confidence: "Verified allocation; consumers unknown",
        disposition: "Change policy",
      });
    }
  if (jobs && clusters)
    for (const job of jobs) {
      const id = assetId("jobs", job);
      if (!id) continue;
      const runUse = runs ? runsByJob.get(id) ?? { count: 0, active: 0 } : null;
      if (runUse)
        signal(
          s,
          id,
          "Job runs started in window",
          runUse.count,
          "runs",
          1,
          1,
          "1/1 means the run list completed. The value is the count of runs whose start time is inside the selected window. Earlier active runs can be missing.",
        );
      const bound = jobClusterIds(job)
        .map((clusterId) => clusterById.get(clusterId))
        .filter(
          (cluster) =>
            cluster && !EPHEMERAL.has(String(cluster.source ?? "")),
        );
      if (!bound.length) continue;
      s.candidates.push({
        assetId: id,
        title: "Job uses an all-purpose cluster",
        evidence: `Schedule ${value(job.paused)} ${typeof job.cron === "string" ? job.cron : ""}; continuous ${value(job.continuous)}; existing clusters ${titled(bound.map((cluster) => ({ name: cluster.name, id: assetId("clusters", cluster) })))}. ${runUse ? `${runUse.count} runs started in the window (${runUse.active} active).` : "Run history was not collected."}`,
        missing: [
          "Task-level clusters that were not returned in the projected existing-cluster fields.",
          ...USAGE_GAPS,
        ],
        suggested:
          "Review moving the job to a job cluster so compute stops when the run ends. The all-purpose cluster bills while it is running between tasks.",
        steps: [
          "Open Workflows and this job from the inventory link.",
          `In each task that uses ${titled(bound.map((cluster) => ({ name: cluster.name, id: cluster.id })))}, switch compute to a job cluster after the owner confirms libraries and policies.`,
          runUse?.active
            ? "A returned run is still active. Change the compute setting for later runs rather than cancelling this one from here."
            : "Leave the schedule unchanged until the owner agrees. Pausing the job stops future runs but does not stop an all-purpose cluster that other work uses.",
          "This inspection does not edit the job. Do not delete the cluster until every job that names it has been moved.",
        ],
        confidence: "Verified binding; savings depend on the cluster actually stopping",
        disposition: "Change policy",
      });
    }
  if (got.pipelines)
    for (const row of got.pipelines) {
      const id = assetId("pipelines", row);
      if (!id) continue;
      const updated = finite(row.updated),
        updateHours = hoursSince(updated);
      if (updateHours != null)
        signal(
          s,
          id,
          "Hours since latest returned pipeline update",
          Math.round(updateHours * 10) / 10,
          "hours",
          1,
          1,
          "latest_updates[0] from the pipeline list. The list order is the provider's newest returned update, not a full update history.",
        );
      if (row.state === "RUNNING")
        annotate(
          s,
          "Pipeline",
          id,
          "RUNNING pipelines are in use; do not delete their storage or cluster to save cost",
        );
    }
  if (got.serving)
    for (const row of got.serving) {
      const id = assetId("serving", row);
      if (!id) continue;
      const scales = Array.isArray(row.scales) ? row.scales : [],
        scaleOff = scales.some((item: unknown) => item === false),
        warmConcurrency = Array.isArray(row.minC) && row.minC.some((item: unknown) => typeof item === "number" && item > 0),
        warmThroughput = Array.isArray(row.maxT) && row.maxT.some((item: unknown) => typeof item === "number" && item > 0);
      if (!scaleOff && !warmConcurrency && !warmThroughput) continue;
      s.candidates.push({
        assetId: id,
        title: scaleOff
          ? "Serving endpoint does not scale to zero"
          : "Serving endpoint keeps provisioned capacity",
        evidence: `State ${value(row.state)}. Scale-to-zero flags: ${brief(row.scales)}. Minimum concurrency ${brief(row.minC)}. Maximum provisioned throughput ${brief(row.maxT)}. Workload sizes ${brief(row.sizes)}.`,
        missing: [
          "Invocation count, latency, and production traffic. READY is not proof of traffic or of idleness.",
          ...USAGE_GAPS,
        ],
        suggested:
          "Review scale-to-zero or a lower workload size and provisioned minimum in Serving. Do not delete the endpoint from Azure.",
        steps: [
          "Open Serving and this endpoint from the inventory link.",
          scaleOff
            ? "Enable scale to zero on each served entity that is currently false, after the owner accepts the cold-start delay."
            : "Lower the provisioned concurrency or throughput minimum after checking peak traffic.",
          "This inspection does not read invocation metrics. Ask the endpoint owner for traffic before reducing a production endpoint.",
          "Do not delete the endpoint, its model, or the workspace from this card.",
        ],
        confidence: "Verified configuration; traffic unknown",
        disposition: "Change policy",
      });
    }
  if (got.vectors)
    for (const row of got.vectors) {
      const id = assetId("vectors", row);
      if (!id || row.type !== "STANDARD") continue;
      const indexes = finite(row.indexes);
      s.candidates.push({
        assetId: id,
        title:
          indexes === 0
            ? "Standard vector endpoint has no returned indexes"
            : "Standard vector endpoint keeps capacity allocated",
        evidence: `Endpoint type STANDARD; status ${value(row.state)}; indexes ${value(row.indexes)}. STANDARD keeps compute allocated. STORAGE_OPTIMIZED is a different billing shape and is not flagged here.`,
        missing: [
          "Query volume and which indexes are still queried.",
          indexes == null ? "Index count was not returned." : "",
          ...USAGE_GAPS,
        ].filter(Boolean),
        suggested:
          indexes === 0
            ? "Review deleting the endpoint in Vector Search after the owner confirms no index is about to be created. No query volume was collected."
            : "Review whether STORAGE_OPTIMIZED fits the workload, or whether the endpoint is still required. Query volume was not collected.",
        steps: [
          "Open Vector Search and this endpoint from the inventory link.",
          indexes === 0
            ? "Confirm no application is about to create an index. An endpoint with zero returned indexes may still be reserved capacity."
            : `Confirm the ${indexes} returned indexes are still queried before changing the endpoint type or deleting it.`,
          "Change the endpoint type or delete the endpoint only in Databricks, and only with the index owner.",
          "Do not delete the workspace or its storage account to remove this endpoint.",
        ],
        confidence:
          indexes === 0
            ? "Verified endpoint type; no indexes returned; query volume unknown"
            : "Verified endpoint type; query volume unknown",
        disposition: indexes === 0 ? "Review shutdown" : "Change policy",
      });
    }
  sortCandidates(s);
}
function emptyQuery(): QueryUse {
  return { count: 0, active: 0, users: [], durationMs: 0, durationKnown: 0, last: null };
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
