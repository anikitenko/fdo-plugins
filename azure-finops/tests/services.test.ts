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
    const url = new URL(args[args.indexOf("--url") + 1]);
    assert.ok(
      [
        "/api/2.1/clusters/list",
        "/api/2.0/clusters/events",
        "/api/2.0/sql/warehouses",
        "/api/2.0/sql/history/queries",
        "/api/2.0/instance-pools/list",
        "/api/2.2/jobs/list",
        "/api/2.2/jobs/runs/list",
        "/api/2.0/pipelines",
        "/api/2.0/serving-endpoints",
        "/api/2.0/vector-search/endpoints",
      ].includes(url.pathname),
      url.pathname,
    );
    assert.equal(url.searchParams.get("include_metrics"), url.pathname.endsWith("history/queries") ? "false" : null);
    assert.doesNotMatch(
      args[args.indexOf("--query") + 1],
      /query_text|spark_conf|notebook_path|secret|access_token|environment_vars|init_scripts|spark_env/,
    );
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
    11,
  );
  assert.ok(
    s.coverage.some(
      (c) => c.name === "Databricks SQL history" && c.state === "Unavailable",
    ),
  );
  assert.ok(
    s.coverage.some(
      (c) =>
        c.name === "Databricks cluster activity events" &&
        c.state === "Unavailable",
    ),
  );
  assert.ok(s.limitations.some((l) => l.includes("Reader alone")));
});
test("Databricks usage distinguishes idle, referenced, job-owned and non-billing cleanup", async () => {
  const r = resourceFromAzure(rawDB, scope, now),
    hour = 3600000,
    calls: URL[] = [];
  const s = (await inspectService(
    r,
    rawDB,
    scope,
    async () => ({ value: [] }),
    async (args) => {
      const url = new URL(args[args.indexOf("--url") + 1]);
      calls.push(url);
      const path = url.pathname;
      if (path.endsWith("/clusters/list"))
        return {
          items: [
            { id: "c-job", name: "job-cluster", state: "RUNNING", source: "JOB", auto: 0 },
            { id: "c-busy", name: "busy", state: "RUNNING", source: "UI", auto: 0, activity: Date.now() - 2 * hour },
            { id: "c-idle", name: "idle", state: "RUNNING", source: "UI", auto: 0, activity: Date.now() - 10 * 24 * hour },
            { id: "c-old", name: "old-batch", state: "TERMINATED", source: "API", auto: 120, terminated: Date.now() - 20 * 24 * hour },
            { id: "c-recent", name: "recent-stop", state: "TERMINATED", source: "UI", auto: 0, terminated: Date.now() - hour },
            { id: "c-ref", name: "shared", state: "RUNNING", source: "UI", auto: 0, pool: "pool-used" },
          ],
        };
      if (path.endsWith("/clusters/events")) {
        assert.equal(url.searchParams.get("order"), "DESC");
        assert.equal(url.searchParams.get("limit"), "100");
        assert.doesNotMatch(args[args.indexOf("--query") + 1], /details/);
        const id = url.searchParams.get("cluster_id");
        return id === "c-busy"
          ? { items: [{ time: Date.now(), type: "RUNNING" }], total: 1 }
          : { items: [], total: 0 };
      }
      if (path.endsWith("/sql/warehouses"))
        return {
          items: [
            { id: "wh-used", name: "bi", state: "RUNNING", auto: 0, serverless: false, min: 1, sessions: 2, type: "PRO" },
            { id: "wh-quiet", name: "adhoc", state: "RUNNING", auto: 0, serverless: false, sessions: 0, min: 1, type: "CLASSIC" },
            { id: "wh-warm", name: "etl", state: "RUNNING", auto: 15, serverless: false, min: 3, sessions: 0, type: "CLASSIC" },
          ],
        };
      if (path.endsWith("/sql/history/queries")) {
        assert.equal(url.searchParams.get("include_metrics"), "false");
        assert.ok(url.searchParams.get("filter_by.query_start_time_range.start_time_ms"));
        assert.doesNotMatch(args[args.indexOf("--query") + 1], /query_text/);
        return {
          items: [
            { warehouse: "wh-used", status: "FINISHED", user: "dave", start: Date.now() - 1000, end: Date.now() - 500, duration: 500 },
            { warehouse: "wh-used", status: "FINISHED", user: "eve", duration: 1500, end: Date.now() - 400 },
          ],
        };
      }
      if (path.includes("instance-pools"))
        return {
          items: [
            { id: "pool-orphan", name: "warm-empty", min: 2, idle: 2, used: 0 },
            { id: "pool-used", name: "shared-pool", min: 1, idle: 0, used: 2 },
          ],
        };
      if (path.endsWith("/jobs/list"))
        return {
          items: [
            { id: 10, name: "nightly", paused: "UNPAUSED", cron: "0 0 2 * * ?", cluster: "c-ref", jobClusters: 0 },
            { id: 11, name: "sql-job", paused: "UNPAUSED", warehouse: ["wh-quiet"], jobClusters: 1 },
          ],
        };
      if (path.endsWith("/jobs/runs/list"))
        return {
          items: [
            { id: 1, job: 10, cluster: "c-ref", state: "RUNNING", start: Date.now() },
            { id: 2, job: 11, state: "TERMINATED", start: Date.now() - 1000, result: "SUCCESS" },
          ],
        };
      if (path.endsWith("/pipelines"))
        return { items: [{ id: "p1", name: "ingest", state: "RUNNING", cluster: "c-busy", updated: Date.now() }] };
      if (path.endsWith("/serving-endpoints"))
        return { items: [{ name: "recs", state: "READY", scales: [false], sizes: ["Small"], minC: [0], maxT: [0] }] };
      if (path.endsWith("/vector-search/endpoints"))
        return {
          items: [
            { name: "docs", type: "STANDARD", state: "ONLINE", indexes: 0 },
            { name: "archive", type: "STORAGE_OPTIMIZED", state: "ONLINE", indexes: 4 },
          ],
        };
      throw new Error("Unexpected Databricks path " + path);
    },
    async () => [],
  ))!;
  const ids = s.candidates.map((c) => c.assetId).sort();
  assert.deepEqual(ids, [
    "10",
    "c-busy",
    "c-idle",
    "c-old",
    "c-recent",
    "c-ref",
    "pool-orphan",
    "pool-used",
    "serving:recs",
    "vector:docs",
    "wh-quiet",
    "wh-used",
    "wh-warm",
  ]);
  const card = (id: string) => s.candidates.find((c) => c.assetId === id)!;
  const steps = (id: string) => card(id).steps!.join("\n");
  assert.match(s.assets.find((a) => a.id === "c-job")!.configuration, /not a manual cleanup target/);
  assert.match(steps("c-busy"), /ingest/);
  assert.match(steps("c-busy"), /last 24 hours/);
  assert.match(card("c-idle").suggested, /do not reference it/i);
  assert.match(steps("c-idle"), /managed resource group/i);
  assert.doesNotMatch(steps("c-idle"), /safe to delete/i);
  assert.match(card("c-old").evidence, /not billing workers/i);
  assert.match(steps("c-old"), /Permanently delete the cluster definition/);
  assert.doesNotMatch(steps("c-recent"), /Permanently delete/);
  assert.match(steps("c-ref"), /still active/);
  assert.match(steps("c-ref"), /nightly/);
  assert.match(card("wh-used").evidence, /dave/);
  assert.match(steps("wh-used"), /Do not delete the warehouse while queries/);
  assert.match(card("wh-quiet").evidence, /sql-job/);
  assert.match(steps("wh-quiet"), /sql-job/);
  assert.match(card("wh-warm").title, /warm/);
  assert.match(steps("pool-orphan"), /Minimum idle instances to 0/);
  assert.match(steps("pool-used"), /Keep the pool/);
  assert.match(steps("10"), /job cluster/);
  assert.match(card("serving:recs").missing.join(" "), /Invocation count/);
  assert.match(steps("serving:recs"), /scale to zero/i);
  assert.match(card("vector:docs").title, /no returned indexes/i);
  assert.equal(s.signals.find((m) => m.assetId === "wh-used" && m.metric === "SQL history queries")!.value, 2);
  assert.equal(s.signals.find((m) => m.assetId === "wh-quiet" && m.metric === "SQL history queries")!.value, 0);
  assert.equal(s.assets.some((a) => a.category === "SQL history"), false);
  const eventIds = calls.filter((url) => url.pathname.endsWith("/clusters/events")).map((url) => url.searchParams.get("cluster_id")).sort();
  assert.deepEqual(eventIds, ["c-idle", "c-recent", "c-ref"]);
  assert.match(
    s.assets.find((a) => a.id === "c-busy")!.configuration,
    /under 24 hours/,
  );
});
test("Databricks activity events stay capped and do not invent usage for the remainder", async () => {
  const r = resourceFromAzure(rawDB, scope, now),
    seen: string[] = [];
  const s = (await inspectService(
    r,
    rawDB,
    scope,
    async () => ({ value: [] }),
    async (args) => {
      const url = new URL(args[args.indexOf("--url") + 1]);
      if (url.pathname.endsWith("/clusters/list"))
        return {
          items: Array.from({ length: 21 }, (_, i) => ({
            id: `c${i}`,
            name: `cluster-${i}`,
            state: "RUNNING",
            source: "UI",
            auto: 0,
          })),
        };
      if (url.pathname.endsWith("/clusters/events")) {
        seen.push(url.searchParams.get("cluster_id")!);
        return { items: [], total: 0 };
      }
      return { items: [] };
    },
    async () => [],
  ))!;
  assert.equal(seen.length, 20);
  assert.equal(seen.includes("c20"), false);
  assert.equal(
    s.coverage.find((c) => c.name === "Databricks cluster activity events")!.state,
    "Partial",
  );
  assert.match(s.candidates.find((c) => c.assetId === "c20")!.missing.join(" "), /at most 20/);
});
test("a capped SQL history stays a lower bound and a denied read does not keep the failure text", async () => {
  const r = resourceFromAzure(rawDB, scope, now);
  let historyPages = 0;
  const partial = (await inspectService(
    r,
    rawDB,
    scope,
    async () => ({ value: [] }),
    async (args) => {
      const url = new URL(args[args.indexOf("--url") + 1]);
      if (url.pathname.endsWith("/sql/warehouses"))
        return {
          items: [
            { id: "wh-used", name: "bi", state: "RUNNING", auto: 0, sessions: 0 },
            { id: "wh-quiet", name: "adhoc", state: "RUNNING", auto: 0, sessions: 0 },
          ],
        };
      if (url.pathname.endsWith("/sql/history/queries")) {
        historyPages++;
        return {
          items: Array.from({ length: 100 }, () => ({
            warehouse: "wh-used",
            status: "FINISHED",
            duration: 1000,
          })),
          next: "page-" + historyPages,
          more: true,
        };
      }
      if (url.pathname.endsWith("/jobs/list")) return { items: [] };
      return { items: [] };
    },
    async () => [],
  ))!;
  const quiet = partial.candidates.find((c) => c.assetId === "wh-quiet")!;
  assert.equal(
    partial.coverage.find((c) => c.name === "Databricks SQL history")!.state,
    "Partial",
  );
  assert.ok((partial.signals.find((m) => m.assetId === "wh-used")!.value ?? 0) >= 5000);
  assert.equal(historyPages > 1, true);
  assert.doesNotMatch(quiet.suggested, /No returned SQL history, jobs, or current sessions/);
  assert.match(quiet.steps!.join("\n"), /capped/);
  assert.equal(quiet.disposition, "Change policy");
  const denied = (await inspectService(
    r,
    rawDB,
    scope,
    async () => {
      throw new Error("AuthorizationFailed secret-token-abc");
    },
    async () => {
      throw new Error("AuthorizationFailed secret-token-abc");
    },
    async () => {
      throw new Error("AuthorizationFailed secret-token-abc");
    },
  ))!;
  const explanation = denied.coverage
    .filter((c) => c.state === "Unavailable")
    .map((c) => c.explanation)
    .join("\n");
  assert.match(explanation, /Access was denied/);
  assert.doesNotMatch(explanation, /secret-token-abc/);
});
test("system.billing assigns each DBU once and never starts a stopped warehouse", async () => {
  const classic = "a1b2c3d4e5f60718",
    serverless = "b1b2c3d4e5f60718",
    billed = {
      ...rawDB,
      properties: { ...rawDB.properties, workspaceId: "445566" },
    },
    r = resourceFromAzure(billed, scope, now),
    usageColumns = [
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
    ],
    priceColumns = ["sku_name", "usage_unit", "currency_code", "list_price"],
    stamp = (ms: number) => {
      const d = new Date(ms),
        p = (n: number) => String(n).padStart(2, "0");
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    },
    end = Date.parse(scope.to),
    recent = Math.max(Date.parse(scope.from), end - 7 * DAY);
  const urls: URL[] = [],
    bodies: any[] = [];
  const s = (await inspectService(
    r,
    billed,
    scope,
    async () => ({ value: [] }),
    async (args) => {
      const url = new URL(args[args.indexOf("--url") + 1]);
      urls.push(url);
      assert.equal(url.hostname, "adb-123456789.12.azuredatabricks.net");
      assert.ok(!args.includes("get-access-token"));
      const method = args[args.indexOf("--method") + 1];
      if (url.pathname.endsWith("/clusters/list"))
        return {
          items: [
            { id: "c-idle", name: "idle", state: "RUNNING", source: "UI", auto: 0, activity: Date.now() - 10 * DAY },
            { id: "c-old", name: "old", state: "TERMINATED", source: "API", auto: 120, terminated: Date.now() - 20 * DAY },
          ],
        };
      if (url.pathname.endsWith("/clusters/events")) return { items: [], total: 0 };
      if (url.pathname.endsWith("/sql/warehouses"))
        return {
          items: [
            { id: classic, name: "bi", state: "RUNNING", serverless: false, size: "Small", auto: 10, min: 1, sessions: 0 },
            { id: serverless, name: "tiny", state: "RUNNING", serverless: true, size: "X-Small", auto: 10, min: 1, sessions: 0 },
            { id: "c1b2c3d4e5f60719", name: "down", state: "STOPPED", serverless: false, size: "Small", auto: 10 },
          ],
        };
      if (url.pathname === `/api/2.0/sql/warehouses/${classic}`) {
        assert.equal(method, "get");
        return { state: "RUNNING", serverless: false };
      }
      if (url.pathname === "/api/2.0/sql/statements") {
        assert.equal(method, "post");
        const body = JSON.parse(args[args.indexOf("--body") + 1]);
        bodies.push(body);
        assert.equal(body.warehouse_id, classic);
        assert.equal(body.on_wait_timeout, "CANCEL");
        assert.equal(body.disposition, "INLINE");
        assert.equal(body.format, "JSON_ARRAY");
        assert.equal(body.wait_timeout, "50s");
        assert.doesNotMatch(body.statement, /identity_metadata|custom_tags|notebook_id|query_text/);
        assert.doesNotMatch(args[args.indexOf("--query") + 1], /external_links\[|https?:/);
        if (body.statement.includes("system.billing.usage")) {
          assert.match(body.statement, /workspace_id = '445566'/);
          assert.match(body.statement, new RegExp(`TIMESTAMP '${stamp(Date.parse(scope.from))}'`));
          assert.match(body.statement, new RegExp(`TIMESTAMP '${stamp(end)}'`));
          assert.match(body.statement, new RegExp(`TIMESTAMP '${stamp(recent)}'`));
          return {
            id: "stmt-0001",
            state: "SUCCEEDED",
            columns: usageColumns,
            rows: [["c-idle", null, null, null, null, null, "PREMIUM_ALL_PURPOSE_COMPUTE", "DBU", 10, 3]],
            chunk: 1,
            external: 0,
            truncated: false,
          };
        }
        return {
          id: "stmt-price",
          state: "SUCCEEDED",
          columns: priceColumns,
          rows: [
            ["PREMIUM_ALL_PURPOSE_COMPUTE", "DBU", "USD", 0.5],
            ["PREMIUM_SQL_COMPUTE", "DBU", "USD", 0.5],
            ["PREMIUM_JOBS_COMPUTE", "DBU", "USD", 0.5],
          ],
          chunk: null,
          external: 0,
          truncated: false,
        };
      }
      if (url.pathname === "/api/2.0/sql/statements/stmt-0001/result/chunks/1") {
        assert.equal(method, "get");
        return {
          rows: [
            ["c-idle", classic, null, null, null, null, "PREMIUM_SQL_COMPUTE", "DBU", 4, 1],
            [null, null, null, null, null, null, "PREMIUM_JOBS_COMPUTE", "DBU", 1.5, 0],
          ],
          chunk: null,
          external: 0,
        };
      }
      if (
        ["/jobs/list", "/jobs/runs/list", "/pipelines", "/sql/history/queries", "/instance-pools/list", "/serving-endpoints", "/vector-search/endpoints"].some((path) =>
          url.pathname.endsWith(path),
        )
      )
        return { items: [] };
      throw new Error("Unexpected Databricks path " + url.pathname);
    },
    async () => [],
  ))!;
  const card = (id: string) => s.candidates.find((c) => c.assetId === id)!;
  const metric = (id: string, name: string) =>
    s.signals.find((item) => item.assetId === id && item.metric === name)!;
  assert.equal(card("c-idle").disposition, "Keep; in use");
  assert.match(card("c-idle").suggested, /3 DBUs in the last 7 days/);
  assert.match(card("c-idle").steps!.join("\n"), /keep it/i);
  assert.doesNotMatch(card("c-idle").steps!.join("\n"), /Permanently delete/);
  assert.equal(card("c-old").disposition, "Definition only");
  assert.match(card("c-old").evidence, /no DBUs for this object/);
  assert.doesNotMatch(card("c-old").missing.join(" "), /until system\.billing/);
  assert.equal(metric("c-idle", "DBUs").value, 10);
  assert.equal(metric(classic, "DBUs").value, 4);
  assert.equal(metric("workspace-unattributed", "Unattributed DBUs").value, 1.5);
  assert.equal(metric("c-idle", "DBU list-price estimate").value, 5);
  assert.match(
    s.facts.find((f) => f.name === "DBU attribution")!.value,
    /15\.5 DBU returned, of which 1\.5/,
  );
  assert.match(s.facts.find((f) => f.name === "DBU attribution")!.value, /USD 7\.75/);
  assert.match(s.facts.find((f) => f.name === "DBU attribution")!.source, /not added to managed-group/i);
  assert.equal(
    s.coverage.find((c) => c.name === "Databricks DBU attribution")!.state,
    "Available",
  );
  assert.equal(bodies.filter((body) => body.statement.includes("system.billing.usage")).length, 1);
  assert.equal(bodies.filter((body) => body.statement.includes("list_prices")).length, 1);
  assert.ok(!urls.some((url) => url.pathname.includes(serverless)));
  assert.equal(s.relatedCosts.some((related) => related.costs.some((cost) => cost.amount === 7.75)), false);
  const guard = async (
    warehouses: any[],
    reply: (url: URL, args: string[]) => any,
  ) =>
    (await inspectService(
      r,
      billed,
      scope,
      async () => ({ value: [] }),
      async (args) => {
        const url = new URL(args[args.indexOf("--url") + 1]);
        if (url.pathname.endsWith("/clusters/list"))
          return {
            items: [
              { id: "c-idle", name: "idle", state: "RUNNING", source: "UI", auto: 0, activity: Date.now() - 10 * DAY },
            ],
          };
        if (url.pathname.endsWith("/clusters/events")) return { items: [], total: 0 };
        if (url.pathname.endsWith("/sql/warehouses")) return { items: warehouses };
        if (
          ["/jobs/list", "/jobs/runs/list", "/pipelines", "/sql/history/queries", "/instance-pools/list", "/serving-endpoints", "/vector-search/endpoints"].some((path) =>
            url.pathname.endsWith(path),
          )
        )
          return { items: [] };
        return reply(url, args);
      },
      async () => [],
    ))!;
  const stopped = await guard(
    [{ id: classic, name: "bi", state: "STOPPED", serverless: false, size: "Small" }],
    () => {
      throw new Error("statement sent to a stopped warehouse");
    },
  );
  assert.match(
    stopped.coverage.find((c) => c.name === "Databricks DBU attribution")!.explanation,
    /stopped warehouse can start/,
  );
  assert.equal(stopped.signals.some((item) => item.metric === "DBUs"), false);
  const recheck = await guard(
    [{ id: classic, name: "bi", state: "RUNNING", serverless: false, size: "Small", auto: 10, min: 1, sessions: 0 }],
    (url) => {
      if (url.pathname === `/api/2.0/sql/warehouses/${classic}`) return { state: "STOPPED" };
      throw new Error("statement sent after a stopped recheck");
    },
  );
  assert.match(
    recheck.coverage.find((c) => c.name === "Databricks DBU attribution")!.explanation,
    /not RUNNING on the immediate recheck/,
  );
  const external = await guard(
    [{ id: classic, name: "bi", state: "RUNNING", serverless: false, size: "Small", auto: 0, min: 1, sessions: 0 }],
    (url, args) => {
      if (url.pathname === `/api/2.0/sql/warehouses/${classic}`) return { state: "RUNNING", serverless: false };
      if (url.pathname === "/api/2.0/sql/statements") {
        const body = JSON.parse(args[args.indexOf("--body") + 1]);
        if (body.statement.includes("list_prices"))
          return { id: "stmt-price", state: "FAILED", code: "SCHEMA", columns: [], rows: [] };
        return {
          id: "stmt-0001",
          state: "SUCCEEDED",
          columns: usageColumns,
          rows: [["c-idle", null, null, null, null, null, "PREMIUM_ALL_PURPOSE_COMPUTE", "DBU", 10, 3]],
          chunk: 1,
          external: 1,
          truncated: false,
        };
      }
      throw new Error("followed an external billing link " + url.pathname);
    },
  );
  assert.equal(
    external.coverage.find((c) => c.name === "Databricks DBU attribution")!.state,
    "Partial",
  );
  assert.match(
    external.coverage.find((c) => c.name === "Databricks DBU attribution")!.explanation,
    /external links were not followed/i,
  );
  assert.equal(external.candidates.find((c) => c.assetId === "c-idle")!.disposition, "Review shutdown");
  assert.match(external.candidates.find((c) => c.assetId === "c-idle")!.evidence, /lower bound/);
  const cancelled = await guard(
    [{ id: classic, name: "bi", state: "RUNNING", serverless: false, size: "Small", auto: 10, min: 1, sessions: 0 }],
    (url, args) => {
      if (url.pathname === `/api/2.0/sql/warehouses/${classic}`) return { state: "RUNNING", serverless: false };
      if (url.pathname === "/api/2.0/sql/statements")
        return { id: "stmt-0001", state: "RUNNING", rows: null };
      if (url.pathname === "/api/2.0/sql/statements/stmt-0001/cancel") {
        assert.equal(args[args.indexOf("--method") + 1], "post");
        return { state: "CANCELED" };
      }
      throw new Error("unexpected path after cancel " + url.pathname);
    },
  );
  assert.match(
    cancelled.coverage.find((c) => c.name === "Databricks DBU attribution")!.explanation,
    /cancelled/,
  );
  assert.equal(cancelled.signals.some((item) => item.metric === "DBUs"), false);
  const denied = await guard(
    [{ id: classic, name: "bi", state: "RUNNING", serverless: false, size: "Small", auto: 10, min: 1, sessions: 0 }],
    (url) => {
      if (url.pathname === `/api/2.0/sql/warehouses/${classic}`) return { state: "RUNNING", serverless: false };
      throw new Error("AuthorizationFailed secret-token-abc");
    },
  );
  const deniedText = denied.coverage
    .filter((c) => c.name === "Databricks DBU attribution")
    .map((c) => c.explanation)
    .join("\n");
  assert.match(deniedText, /Access was denied/);
  assert.doesNotMatch(deniedText, /secret-token-abc/);
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
