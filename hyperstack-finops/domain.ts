import { usd } from "./format";
import type {
  Bill,
  Finding,
  Period,
  Resource,
  Snapshot,
  Windows,
} from "./types";
const day = 86400000;
export function windows(
  period: Period,
  now = new Date(),
  range?: { start: string; end: string },
): Windows {
  const end = now.getTime();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  let start: number,
    finish = end,
    previousStart: number,
    previousEnd: number;
  if (period === "custom") {
    const parseDay = (s: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
        throw new Error("Invalid date range. Choose both calendar dates.");
      const d = Date.parse(`${s}T00:00:00Z`);
      if (!Number.isFinite(d) || new Date(d).toISOString().slice(0, 10) !== s)
        throw new Error("Invalid date range. Choose valid calendar dates.");
      return d;
    };
    if (!range)
      throw new Error("Invalid date range. Choose start and end dates.");
    start = parseDay(range.start);
    const lastDay = parseDay(range.end);
    if (
      lastDay < start ||
      lastDay > midnight ||
      start >= end ||
      lastDay - start >= day * 366
    )
      throw new Error(
        "Invalid date range. Use up to 366 days, ordered from start to end, with no future dates.",
      );
    finish = Math.min(lastDay + day, end);
    previousEnd = start;
    previousStart = start - (finish - start);
  } else if (period === "month") {
    start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    previousStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    previousEnd = Math.min(start, previousStart + end - start);
  } else if (period === "last-month") {
    finish = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    previousEnd = start;
    previousStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1);
  } else {
    finish = period === "yesterday" ? midnight : end;
    start = finish - (period === "yesterday" ? day : day * 7);
    previousEnd = start;
    previousStart = start - (finish - start);
  }
  const w = (a: number, b: number) => ({
    start: new Date(a).toISOString(),
    end: new Date(b).toISOString(),
  });
  return {
    period,
    current: w(start, finish),
    previous: w(previousStart, previousEnd),
  };
}
export function filterResources(
  resources: Resource[],
  environment = "",
  region = "",
  query = "",
  kind = "",
) {
  const q = query.toLowerCase().trim();
  return resources.filter(
    (r) =>
      (!environment || r.environment === environment) &&
      (!region || r.region === region) &&
      (!kind || r.kind === kind) &&
      (!q ||
        `${r.id} ${r.name} ${r.flavor} ${r.gpu} ${r.state}`
          .toLowerCase()
          .includes(q)),
  );
}
export function sumKnown(values: (number | null | undefined)[]): number | null {
  return values.every((v) => typeof v === "number")
    ? values.reduce<number>((a, b) => a + (b ?? 0), 0)
    : null;
}
export function coveredCosts(
  resources: Resource[],
  field: "current" | "previous",
) {
  const byKey = new Map(resources.map((r) => [r.key, r]));
  let includedIps = 0,
    missing = 0,
    known = 0,
    total = 0;
  for (const r of resources) {
    const parent =
      r.kind === "public-ip" ? byKey.get(r.parent ?? "") : undefined;
    if (parent?.[field]?.includesPublicIp && parent[field]?.cost != null) {
      includedIps++;
      continue;
    }
    const cost = r[field]?.cost;
    if (cost == null) missing++;
    else {
      known++;
      total += cost;
    }
  }
  return {
    total: known > 0 || resources.length === 0 ? total : null,
    missing,
    includedIps,
  };
}
export function totals(resources: Resource[]) {
  const a = coveredCosts(resources, "current"),
    b = coveredCosts(resources, "previous");
  const complete = a.missing === 0 && b.missing === 0;
  const delta =
    complete && a.total !== null && b.total !== null ? a.total - b.total : null;
  return {
    current: a.total,
    previous: b.total,
    delta,
    currentMissing: a.missing,
    previousMissing: b.missing,
    currentIncludedIps: a.includedIps,
    previousIncludedIps: b.includedIps,
    percent:
      delta !== null && b.total !== null && b.total > 0
        ? (delta / b.total) * 100
        : null,
  };
}
export function projection(
  snapshot: Snapshot,
  resources: Resource[],
): number | null {
  if (snapshot.windows.period !== "month") return null;
  const summary = totals(resources);
  const spend = summary.current;
  const end = new Date(snapshot.windows.current.end);
  const elapsed = end.getTime() - Date.parse(snapshot.windows.current.start);
  const next = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1);
  return spend === null || summary.currentMissing > 0 || elapsed <= 0
    ? null
    : (spend / elapsed) * (next - Date.parse(snapshot.windows.current.start));
}
export function findings(resources: Resource[]): Finding[] {
  return resources.flatMap((r) => {
    if (
      !r.live ||
      !r.billingActive ||
      r.currentRate === null ||
      r.currentRate <= 0
    )
      return [];
    const stopped =
      r.kind === "vm" &&
      (r.gpuCount ?? 0) > 0 &&
      ["SHUTOFF", "STOPPED"].includes(r.state);
    const detached =
      r.kind === "volume" &&
      r.attachmentsKnown &&
      r.dependencies.length === 0 &&
      r.state === "AVAILABLE";
    if (!stopped && !detached) return [];
    return [
      {
        resourceKey: r.key,
        title: stopped
          ? "Stopped GPU VM still billing"
          : "Detached volume accruing charges",
        evidence: stopped
          ? `State ${r.state}; ${r.gpuCount} × ${r.gpu}; active usage reports $${r.currentRate.toFixed(4)}/h. Compute remains allocated.`
          : `State AVAILABLE; zero current attachments; active usage reports $${r.currentRate.toFixed(4)}/h. Confirm the data is no longer needed before deletion.`,
        observedAt: r.observedAt,
        hourlySavings: r.contract
          ? null
          : stopped
            ? (r.current?.computeRate ?? null)
            : r.currentRate,
      },
    ];
  });
}
export function explainChange(r: Resource, windowStart: string): string {
  const a = r.current,
    b = r.previous;
  if (!a || !b || a.cost === null || b.cost === null)
    return "Billing coverage incomplete";
  if (a.cost === 0 && b.cost === 0) return "No charges in either range";
  if (
    r.createdAt &&
    Date.parse(r.createdAt) >= Date.parse(windowStart) &&
    b.cost === 0
  )
    return "Newly created resource";
  if (b.cost === 0 && a.cost > 0) return "Newly billed in selected dates";
  if (a.cost === 0 && b.cost > 0)
    return r.deletedAt
      ? "Resource deleted; charges ended"
      : "No charges in selected dates";
  if (Math.abs(a.cost - b.cost) < 0.000001) return "Spend unchanged";
  if (r.kind === "public-ip") return "Public-IP charge changed";
  if (
    a.hours === null ||
    b.hours === null ||
    a.rate === null ||
    b.rate === null
  )
    return "Reported spend changed; usage detail not supplied";
  const more = a.hours > b.hours + 0.001,
    fewer = a.hours < b.hours - 0.001;
  const rate = Math.abs(a.rate - b.rate) > 0.00001;
  return (more || fewer) && rate
    ? `${more ? "More" : "Fewer"} billed hours and changed effective rate`
    : more
      ? "More billed hours"
      : fewer
        ? "Fewer billed hours"
        : rate
          ? "Changed effective rate"
          : "Reported spend changed";
}
export function changeDetails(
  r: Resource,
  start: string,
): {
  explanation: string;
  details: string[];
  hoursImpact: number | null;
  rateImpact: number | null;
} {
  const explanation = explainChange(r, start),
    a = r.current,
    b = r.previous;
  const dollars = (n: number) => usd(n);
  const n = (v: number) =>
    v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const details: string[] = [];
  let hoursImpact: number | null = null,
    rateImpact: number | null = null;
  if (!a || a.cost === null)
    details.push(
      "Selected-date billing could not be loaded. Sync again to retrieve this amount; it is not assumed to be zero.",
    );
  if (!b || b.cost === null)
    details.push(
      "Previous-range billing could not be loaded. A comparison needs both reported amounts.",
    );
  if (a?.cost != null && b?.cost != null) {
    details.push(
      `${dollars(b.cost)} previously → ${dollars(a.cost)} in selected dates (${dollars(a.cost - b.cost)} change).`,
    );
    if (r.createdAt && explanation === "Newly created resource")
      details.push(
        `Provider creation timestamp: ${r.createdAt}. No charge was reported in the preceding range.`,
      );
    else if (b.cost === 0 && a.cost > 0)
      details.push(
        "The previous range reports zero spend. This can be an existing resource resuming billing; creation is not inferred without a matching timestamp.",
      );
    if (r.deletedAt && a.cost < b.cost)
      details.push(
        `Provider termination timestamp: ${r.deletedAt}. Historical charges remain visible after deletion.`,
      );
    if (a.hours !== null && b.hours !== null)
      details.push(
        `Billed hours: ${n(b.hours)} → ${n(a.hours)} (${n(a.hours - b.hours)} hours).`,
      );
    if (a.rate !== null && b.rate !== null)
      details.push(
        `Effective billed rate: ${usd(b.rate, true)}/h → ${usd(a.rate, true)}/h. This is cost ÷ billed hours, not necessarily a pricebook change; discounts and billing mix can affect it.`,
      );
    if (
      a.hours !== null &&
      b.hours !== null &&
      a.rate !== null &&
      b.rate !== null &&
      a.hours > 0 &&
      b.hours > 0
    ) {
      hoursImpact = (a.hours - b.hours) * b.rate;
      rateImpact = a.hours * (a.rate - b.rate);
      details.push(
        `Arithmetic attribution: ${dollars(hoursImpact)} from hours at the previous rate; ${dollars(rateImpact)} from the effective-rate difference at selected-date hours. These sum to the spend change and are not proof of a provider price increase.`,
      );
    } else if (r.kind === "public-ip")
      details.push(
        "Hyperstack supplies public-IP dollars inside the VM bill, without independent IP usage hours. Hour and rate effects cannot be separated from those totals.",
      );
    else if (a.cost !== b.cost && (a.hours === null || b.hours === null))
      details.push(
        "The API did not supply both usage-hour values, so duration and rate effects cannot be separated reliably.",
      );
  }
  return { explanation, details, hoursImpact, rateImpact };
}
export function changes(resources: Resource[], start: string) {
  const combinedParents = new Set(
    resources
      .filter(
        (r) =>
          r.kind === "vm" &&
          (r.current?.includesPublicIp || r.previous?.includesPublicIp),
      )
      .map((r) => r.key),
  );
  return resources
    .filter(
      (r) =>
        !(r.kind === "public-ip" && r.parent && combinedParents.has(r.parent)),
    )
    .map((resource) => {
      const r = structuredClone(resource);
      const combined = combinedParents.has(r.key);
      if (combined)
        for (const field of ["current", "previous"] as const) {
          const ip = resources.find(
            (ip) => ip.parent === r.key && ip.kind === "public-ip",
          );
          if (
            r[field]?.cost != null &&
            !r[field]?.includesPublicIp &&
            ip?.[field]?.cost != null
          ) {
            r[field]!.cost! += ip[field]!.cost!;
            r[field]!.rate = r[field]!.hours
              ? r[field]!.cost! / r[field]!.hours!
              : null;
          }
        }
      const evidence = changeDetails(r, start);
      if (combined)
        evidence.details.unshift(
          "The full VM bill is compared in both ranges, including any public-IP charges, because one separate breakdown is unavailable. Billed hours belong to the VM; arithmetic attribution does not measure independent IP usage.",
        );
      return {
        resource: r,
        combinedPublicIp: combined,
        delta:
          r.current?.cost != null && r.previous?.cost != null
            ? r.current.cost - r.previous.cost
            : null,
        ...evidence,
      };
    })
    .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
}
export const emptyBill = (): Bill => ({ cost: 0, hours: 0, rate: null });

/** Honest partial run rate; never presented as a complete account forecast. */
export function projectionCoverage(snapshot: Snapshot, resources: Resource[]) {
  const summary = totals(resources),
    full = projection(snapshot, resources);
  const elapsed =
    Date.parse(snapshot.windows.current.end) -
    Date.parse(snapshot.windows.current.start);
  const end = new Date(snapshot.windows.current.end),
    month =
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1) -
      Date.parse(snapshot.windows.current.start);
  const partial =
    snapshot.windows.period === "month" &&
    summary.current !== null &&
    elapsed > 0
      ? (summary.current / elapsed) * month
      : null;
  return {
    value: full ?? partial,
    complete: full !== null,
    missing: summary.currentMissing,
  };
}
export function missingBills(resources: Resource[]) {
  const byKey = new Map(resources.map((r) => [r.key, r]));
  return resources.flatMap((r) =>
    (["current", "previous"] as const).flatMap((field) => {
      const parent = r.parent ? byKey.get(r.parent) : undefined;
      return r[field]?.cost == null &&
        !(parent?.[field]?.includesPublicIp && parent[field]?.cost != null)
        ? [{ resource: r, field }]
        : [];
    }),
  );
}
