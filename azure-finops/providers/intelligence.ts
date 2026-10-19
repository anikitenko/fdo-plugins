import type { Resource, Scope, Snapshot } from "../types.ts";
import type { Cli } from "./live.ts";
import { DAY, normalizeId } from "../domain.ts";
export type Rest = (
  url: string,
  method?: string,
  body?: unknown,
  query?: string,
) => Promise<any>;
const arm = "https://management.azure.com";
export async function graph(rest: Rest, subscription: string, query: string) {
  const rows: any[] = [],
    seen = new Set<string>();
  let skip: string | undefined;
  do {
    const result = await rest(
      `${arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      "post",
      {
        subscriptions: [subscription],
        query,
        options: {
          resultFormat: "objectArray",
          $top: 1000,
          ...(skip ? { $skipToken: skip } : {}),
        },
      },
    );
    if (!Array.isArray(result.data))
      throw new Error("Resource Graph schema unavailable");
    rows.push(...result.data);
    skip = result.$skipToken;
    if (skip && (seen.has(skip) || seen.size >= 100))
      throw new Error("Dependency pagination incomplete");
    if (skip) seen.add(skip);
  } while (skip);
  return rows;
}
export function references(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown) => {
    if (
      typeof v === "string" &&
      /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/[^/]+\/.+/i.test(
        v,
      )
    )
      found.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return [...found].sort();
}
export async function discover(r: Resource, raw: any, rest: Rest, cli: Cli) {
  const refs = new Map(r.dependencies.map((d) => [normalizeId(d.id), d]));
  const add = (id: string, relation: string) => {
    if (normalizeId(id) !== normalizeId(r.id) && !refs.has(normalizeId(id)))
      refs.set(normalizeId(id), { id, relation });
  };
  references(raw.properties).forEach((id) =>
    add(id, "Provider outbound reference"),
  );
  r.dependencyCoverage = [
    "Provider properties: recursively inspected resource ID references",
  ];
  const literal = normalizeId(r.id).replace(/'/g, "''");
  try {
    const rows = await graph(
      rest,
      r.subscriptionId,
      `Resources | where tolower(tostring(properties)) contains '${literal}' | project id, properties`,
    );
    for (const row of rows)
      if (
        references(row.properties).some(
          (id) => normalizeId(id) === normalizeId(r.id),
        )
      )
        add(row.id, "Inbound reference (Resource Graph)");
    r.dependencyCoverage.push(
      `Subscription-wide inbound Resource Graph scan: ${rows.length} candidates checked (may extend beyond selected groups)`,
    );
  } catch {
    r.gaps.push("Subscription-wide inbound references unavailable or partial.");
  }
  // Expand NICs one hop to surface IPs, subnets, NSGs and load-balancer pools for VM reviews.
  for (const dep of [...refs.values()].filter((d) =>
    /\/microsoft.network\/networkinterfaces\//i.test(d.id),
  )) {
    if (
      !normalizeId(dep.id).startsWith(
        `/subscriptions/${r.subscriptionId.toLowerCase()}/`,
      )
    )
      continue;
    try {
      const nic = await cli(
        [
          "resource",
          "show",
          "--ids",
          dep.id,
          "--subscription",
          r.subscriptionId,
        ],
        "Read NIC dependencies for the exact resource review",
      );
      references(nic.properties).forEach((id) =>
        add(id, `Via NIC ${dep.id.split("/").at(-1)}`),
      );
      r.dependencyCoverage.push(`NIC ${dep.id}: provider properties inspected`);
    } catch {
      r.gaps.push(`NIC dependency read unavailable: ${dep.id}`);
    }
  }
  try {
    const rows = await graph(
      rest,
      r.subscriptionId,
      `RecoveryServicesResources | where tolower(tostring(properties)) contains '${literal}' | project id, properties`,
    );
    for (const row of rows)
      if (
        references(row.properties).some(
          (id) => normalizeId(id) === normalizeId(r.id),
        )
      )
        add(row.id, "Backup/protection reference");
    r.dependencyCoverage.push(
      "Recovery Services Resource Graph references checked",
    );
  } catch {
    r.gaps.push("Backup/protection reference scan unavailable.");
  }
  r.dependencies = [...refs.values()].sort((a, b) =>
    normalizeId(a.id).localeCompare(normalizeId(b.id)),
  );
  r.gaps = r.gaps.filter(
    (g) => !g.startsWith("References are provider-reported"),
  );
  r.gaps.push(
    "Discovery covers visible ARM references, not runtime traffic, external DNS, hidden permissions, every backup provider or cross-subscription consumers. No references is not proof of independence.",
  );
}
export async function origin(
  r: Resource,
  cli: Cli,
  list: (url: string, query?: string) => Promise<any[]>,
) {
  try {
    const deployments = (
      await list(
        `${arm}${r.groupId}/providers/Microsoft.Resources/deployments?api-version=2022-09-01`,
        "{value:value[].{id:id,name:name,properties:{timestamp:properties.timestamp}},nextLink:nextLink}",
      )
    ).sort((a, b) =>
      String(b.properties?.timestamp).localeCompare(
        String(a.properties?.timestamp),
      ),
    );
    for (const d of deployments.slice(0, 20)) {
      // Never retrieve template parameters, outputs, request/response bodies or deployment debug content.
      const operations = await list(
        `${arm}${d.id}/operations?api-version=2022-09-01`,
        "{value:value[].{properties:{targetResource:properties.targetResource,timestamp:properties.timestamp,provisioningOperation:properties.provisioningOperation,provisioningState:properties.provisioningState}},nextLink:nextLink}",
      );
      const matches = operations.filter(
        (o) =>
          normalizeId(o.properties?.targetResource?.id ?? "") ===
          normalizeId(r.id),
      );
      for (const o of matches)
        r.events.push({
          at: o.properties.timestamp ?? d.properties?.timestamp,
          title: `Deployment ${d.name} · ${o.properties?.provisioningOperation ?? "write"} · ${o.properties?.provisioningState ?? "unknown"} (correlation, not creation proof)`,
          source: "ARM deployment operation exact target ID",
        });
      if (matches.length) {
        try {
          const generator = await cli(
            [
              "deployment",
              "group",
              "export",
              "--resource-group",
              r.groupId.split("/").at(-1)!,
              "--name",
              d.name,
              "--subscription",
              r.subscriptionId,
              "--query",
              "metadata._generator",
            ],
            "Read only compiler metadata from matched deployment template; never expose parameters or outputs",
          );
          if (String(generator?.name).toLowerCase() === "bicep")
            r.provisioning = {
              value: "Bicep",
              confidence: "Inferred",
              source: `Matched deployment ${d.id}; template metadata._generator.name=bicep`,
              explanation:
                "Compiler signature supports Bicep authorship of this retained deployment, not proof of original creation or continuing IaC management. Metadata can be copied.",
            };
        } catch {
          r.gaps.push(
            `Compiler metadata unavailable for matched deployment ${d.name}; no guessed authoring tool.`,
          );
        }
      }
      if (matches.length && r.provisioning.confidence === "Unknown")
        r.provisioning = {
          value: "ARM deployment",
          confidence: "Verified",
          source: `Deployment ${d.id}: exact target operation`,
          explanation:
            "Proves a deployment targeted this resource; does not identify its authoring tool or original creation.",
        };
    }
    r.gaps.push(
      `Deployment evidence: ${Math.min(20, deployments.length)}/${deployments.length} retained group deployments inspected; subscription/management-group deployments and purged history may be missing.`,
    );
  } catch {
    r.gaps.push(
      "Deployment history or operation read denied/unavailable; no negative origin inference.",
    );
  }
  if (r.creator.value) {
    const kind = rawCreatorType(r);
    try {
      const identity = await cli(
        [
          "ad",
          kind,
          "show",
          "--id",
          r.creator.value,
          "--subscription",
          r.subscriptionId,
          "--query",
          "{displayName:displayName,id:id}",
        ],
        "Resolve creator display name using existing directory permissions; never request extra consent",
      );
      if (typeof identity.displayName === "string")
        r.creatorName = {
          value: identity.displayName,
          confidence: "Verified",
          source: `Microsoft Graph via az ad ${kind} show; creator identifier retained separately`,
        };
    } catch {
      r.creatorName = {
        value: null,
        confidence: "Unknown",
        source:
          "Directory resolution denied, deleted identity or unsupported creator type; original identifier retained",
      };
    }
  }
}
function rawCreatorType(r: Resource) {
  return r.creator.source.includes("Application") ||
    r.creator.source.includes("ServicePrincipal")
    ? "sp"
    : "user";
}
export async function utilization(r: Resource, scope: Scope, cli: Cli) {
  const to = new Date(Math.min(Date.parse(scope.to), Date.now())).toISOString();
  const from = new Date(
    Math.max(Date.parse(scope.from), Date.parse(to) - 7 * DAY),
  ).toISOString();
  if (Date.parse(from) >= Date.parse(to)) {
    r.gaps.push("No completed metric window in selected dates.");
    return;
  }
  const expected = Math.max(
    1,
    Math.ceil((Date.parse(to) - Date.parse(from)) / 3600000),
  );
  r.signals = [];
  for (const [name, aggregation, unit] of [
    ["Percentage CPU", "Average", "%"],
    ["Available Memory Bytes", "Average", "bytes available"],
    ["Network In Total", "Total", "bytes received"],
    ["Network Out Total", "Total", "bytes sent"],
  ]) {
    const signal = {
      name,
      value: null as number | null,
      unit,
      samples: 0,
      expected,
      from,
      to,
      explanation:
        "Unavailable; missing metrics are not zero. Guest memory collection may need configuration outside this plugin.",
    };
    try {
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
          name,
          "--start-time",
          from,
          "--end-time",
          to,
          "--interval",
          "PT1H",
          "--aggregation",
          aggregation,
        ],
        `Read ${name} for scoped VM utilization`,
      );
      const key = aggregation.toLowerCase();
      const points = (result.value ?? [])
        .flatMap((m: any) =>
          (m.timeseries ?? []).flatMap((t: any) => t.data ?? []),
        )
        .filter(
          (p: any) => typeof p[key] === "number" && Number.isFinite(p[key]),
        );
      signal.samples = points.length;
      signal.value = points.length
        ? points.reduce((s: number, p: any) => s + p[key], 0) /
          (aggregation === "Average" ? points.length : 1)
        : null;
      signal.explanation = `${aggregation === "Average" ? "Mean" : "Sum"} of returned hourly observations; missing hours excluded. Memory is free bytes, not utilization percent; network totals are observed volume, not link saturation.`;
    } catch {
      /* Preserve the independently missing signal. */
    }
    r.signals.push(signal);
    if (name === "Percentage CPU")
      r.metrics = {
        cpu: signal.value,
        samples: signal.samples,
        expected,
        from,
        to,
      };
  }
}
export function detectAnomalies(s: Snapshot) {
  if (s.coverage.costs !== "Available" || s.coverage.comparison !== "Available")
    return [];
  // No synthetic zero days: only returned billed days count toward the baseline.
  const daily = new Map<string, Map<string, number>>();
  for (const c of [...s.previous, ...s.costs]) {
    if (Date.parse(c.day) >= Date.parse(s.now) - 2 * DAY) continue;
    const days = daily.get(c.currency) ?? new Map<string, number>();
    days.set(c.day, (days.get(c.day) ?? 0) + c.amount);
    daily.set(c.currency, days);
  }
  const result: NonNullable<Snapshot["anomalies"]> = [];
  for (const [currency, days] of daily) {
    const ordered = [...days].sort(([a], [b]) => a.localeCompare(b));
    for (let i = 14; i < ordered.length; i++) {
      const [day, amount] = ordered[i];
      if (day < s.scope.from.slice(0, 10) || day > s.scope.to.slice(0, 10))
        continue;
      const history = ordered.slice(Math.max(0, i - 28), i);
      if (Date.parse(day) - Date.parse(history[0][0]) > 35 * DAY) continue;
      const values = history.map(([, v]) => v),
        expected = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(
        values.reduce((a, b) => a + (b - expected) ** 2, 0) / values.length,
      );
      const threshold = expected + Math.max(3 * sd, Math.abs(expected) * 0.5);
      if (amount > threshold && amount > 0)
        result.push({
          source: "Plugin statistical check",
          day,
          currency,
          amount,
          expected,
          threshold,
          explanation: `Daily charges exceed mean + max(3 standard deviations, 50% of mean); ${values.length} preceding billed days, same scope/basis/currency. Last 48 hours excluded for billing lag. Sparse days, seasonality, credits and delayed ingestion can distort this signal. Not an Azure anomaly or proven cause.`,
        });
    }
  }
  return result;
}
export async function resizeOptions(r: Resource, raw: any, cli: Cli) {
  r.resize = { options: [], checkedAt: new Date().toISOString(), errors: [] };
  const errors = r.resize.errors,
    p = raw.properties ?? {};
  if (!/deallocated/i.test(r.state))
    errors.push(
      "Resize requires a deallocated VM. Propose and complete deallocation separately; downtime is required.",
    );
  if (
    p.availabilitySet ||
    p.virtualMachineScaleSet ||
    p.host ||
    p.hostGroup ||
    p.capacityReservation ||
    p.proximityPlacementGroup ||
    p.storageProfile?.osDisk?.diffDiskSettings
  )
    errors.push(
      "Special placement or ephemeral OS disk configuration needs a dedicated compatibility adapter.",
    );
  if (errors.length) return;
  const blockResize = () => {
    errors.push(
      "Resize SKU/options/quota discovery unavailable; resizing is blocked.",
    );
  };
  try {
    const available = await cli(
      [
        "vm",
        "list-vm-resize-options",
        "--resource-group",
        r.groupId.split("/").at(-1)!,
        "--name",
        r.name,
        "--subscription",
        r.subscriptionId,
      ],
      "Read Azure-reported VM resize options without changing state",
    );
    if (!Array.isArray(available)) {
      blockResize();
      return;
    }
    if (available.length > 100) {
      blockResize();
      return;
    }
    const names = [
      ...new Set([r.sku, ...available.map((o: any) => o.name)].filter(Boolean)),
    ] as string[];
    if (names.some((n) => !/^[-a-zA-Z0-9_]+$/.test(n))) {
      blockResize();
      return;
    }
    const skus = await cli(
      [
        "vm",
        "list-skus",
        "--location",
        r.location,
        "--resource-type",
        "virtualMachines",
        "--all",
        "--subscription",
        r.subscriptionId,
        "--query",
        `[?${names.map((n) => `name=='${n}'`).join(" || ")}].{name:name,family:family,capabilities:capabilities,restrictions:restrictions,locationInfo:locationInfo}`,
      ],
      "Check current and target SKU capabilities and subscription restrictions",
    );
    const usage = await cli(
      [
        "vm",
        "list-usage",
        "--location",
        r.location,
        "--subscription",
        r.subscriptionId,
      ],
      "Check regional and VM-family quota headroom; capacity is not reserved",
    );
    const current = skus.find((s: any) => s.name === r.sku);
    if (!current) {
      blockResize();
      return;
    }
    const caps = (s: any) =>
      Object.fromEntries(
        (s.capabilities ?? []).map((c: any) => [c.name, String(c.value)]),
      );
    const before = caps(current);
    const free = (name: string) => {
      const u = usage.find(
        (u: any) => String(u.name?.value).toLowerCase() === name.toLowerCase(),
      );
      return u && Number.isFinite(u.limit) && Number.isFinite(u.currentValue)
        ? u.limit - u.currentValue
        : null;
    };
    for (const o of available) {
      if (o.name === r.sku) continue;
      const sku = skus.find((s: any) => s.name === o.name);
      if (!sku || sku.family !== current.family || sku.restrictions?.length)
        continue;
      const after = caps(sku);
      // Require explicit equal hardware contracts; no architecture/controller/generation conversion.
      if (
        [
          "CpuArchitectureType",
          "HyperVGenerations",
          "DiskControllerTypes",
          "PremiumIO",
        ].some((k) => !before[k] || !after[k] || before[k] !== after[k])
      )
        continue;
      if (
        p.securityProfile?.securityType &&
        p.securityProfile.securityType !== "Standard"
      )
        continue;
      if (
        before["AcceleratedNetworkingEnabled"] === "True" &&
        after["AcceleratedNetworkingEnabled"] !== "True"
      )
        continue;
      if (
        (raw.zones ?? []).some(
          (z: string) =>
            !(sku.locationInfo ?? []).some((l: any) =>
              (l.zones ?? []).includes(z),
            ),
        )
      )
        continue;
      const oldTemp = Number(before["MaxResourceVolumeMB"]),
        newTemp = Number(after["MaxResourceVolumeMB"]);
      if (
        !Number.isFinite(oldTemp) ||
        !Number.isFinite(newTemp) ||
        oldTemp > 0 !== newTemp > 0
      )
        continue;
      if (
        !["MaxDataDiskCount", "MaxNetworkInterfaces"].every(
          (k) => after[k] && Number.isFinite(Number(after[k])),
        )
      )
        continue;
      if (
        Number(after["MaxDataDiskCount"]) <
          (p.storageProfile?.dataDisks ?? []).length ||
        Number(after["MaxNetworkInterfaces"]) <
          (p.networkProfile?.networkInterfaces ?? []).length
      )
        continue;
      const delta = Math.max(
        0,
        Number(after["vCPUs"]) - Number(before["vCPUs"]),
      );
      const regional = free("cores"),
        family = free(sku.family);
      if (
        !Number.isFinite(delta) ||
        regional === null ||
        family === null ||
        regional < delta ||
        family < delta
      )
        continue;
      if (
        !Number.isFinite(Number(after["MemoryGB"])) ||
        !Number.isFinite(Number(after["vCPUs"]))
      )
        continue;
      r.resize.options.push({
        name: o.name,
        cores: Number(after["vCPUs"]),
        memoryGB: Number(after["MemoryGB"]),
      });
    }
    r.resize.options.sort((a, b) => a.name.localeCompare(b.name));
    if (!r.resize.options.length)
      errors.push(
        "No target passed Azure resize options, same-family hardware contracts, placement restrictions and quota checks. Use Azure for unsupported conversions.",
      );
    r.gaps.push(
      "Resize preflight does not reserve physical capacity. Azure may still reject allocation; no automatic deallocation, controller conversion, restart or fallback size is attempted.",
    );
  } catch {
    blockResize();
  }
}
