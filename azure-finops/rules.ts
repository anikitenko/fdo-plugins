import type { Snapshot, Finding } from "./types.ts";
import { normalizeId, totals, DAY, changes } from "./domain.ts";
export function findingRules(snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const r of snapshot.resources) {
    const target = {
      tenantId: r.tenantId,
      subscriptionId: r.subscriptionId,
      id: r.id,
      name: r.name,
      type: r.type,
      groupId: r.groupId,
    };
    const costs = totals(
      snapshot.costs.filter(
        (c) => c.resourceId && normalizeId(c.resourceId) === normalizeId(r.id),
      ),
    );
    const monthly =
      costs.length === 1
        ? (costs[0].amount * 30) /
          Math.max(
            1,
            (Date.parse(snapshot.scope.to) -
              Date.parse(snapshot.scope.from) +
              1) /
              DAY,
          )
        : null;
    const add = (
      key: string,
      title: string,
      evidence: string,
      missing: string[],
      estimate: number | null,
      suggested: string,
      confidence = "Medium",
    ) =>
      findings.push({
        id: `${normalizeId(r.id)}:${key}`,
        target,
        title,
        source: "Plugin rule",
        evidence,
        confidence,
        window: `${snapshot.scope.from} → ${snapshot.scope.to}`,
        missing,
        savings: estimate,
        currency: estimate != null ? (costs[0]?.currency ?? null) : null,
        basis:
          estimate == null
            ? "No defensible estimate; cost or eligibility signals are missing."
            : `Selected-period ${snapshot.scope.basis} × 30 / period days; upper bound, not a quote.`,
        overlapKey: normalizeId(r.id),
        suggested,
      });
    if (
      r.type.toLowerCase() === "microsoft.compute/disks" &&
      r.attached === false
    )
      add(
        "unattached",
        "Unattached disk",
        "Provider reports no managedBy/managedByExtended attachment.",
        ["Backup/restore intent and IaC lifecycle require review."],
        monthly,
        "Review dependencies and retention before proposing deletion.",
      );
    if (
      r.type.toLowerCase() === "microsoft.network/publicipaddresses" &&
      r.attached === false
    )
      add(
        "unassociated",
        "Unassociated public IP",
        "No IP configuration or NAT gateway association was returned.",
        [
          "DNS references, external consumers and planned reuse are not proven absent.",
        ],
        monthly,
        "Review references before proposing deletion.",
      );
    const m = r.metrics;
    if (
      r.type.toLowerCase() === "microsoft.compute/virtualmachines" &&
      m?.cpu != null &&
      m.samples / m.expected >= 0.8 &&
      Date.parse(m.to) - Date.parse(m.from) >= 7 * DAY &&
      m.cpu < 5
    )
      add(
        "lowcpu",
        "Low VM CPU",
        `Average CPU ${m.cpu.toFixed(1)}%; ${m.samples}/${m.expected} hourly samples over at least seven days.`,
        [
          "Memory, latency, disk/network demand and business schedules are not evaluated.",
        ],
        null,
        "Investigate workload requirements and memory/network gaps. Resize requires a separately deallocated VM and fresh compatibility/quota validation.",
      );
    if (r.state.toLowerCase().includes("deallocated"))
      add(
        "deallocated",
        "Deallocated VM: associated charges may continue",
        "Compute is deallocated; disks, IPs and backup resources can remain billed.",
        r.gaps,
        null,
        "Inspect related resources and their individual cost records.",
      );
    if (!r.tags.owner)
      add(
        "owner",
        "Missing owner",
        "No owner tag was returned.",
        [],
        null,
        "Add an accountable owner; creator is a different identity.",
        "High",
      );
    if (!r.tags.environment)
      add(
        "environment",
        "Missing environment",
        "No environment tag was returned.",
        [],
        null,
        "Tag the workload environment.",
        "High",
      );
    const delta =
      snapshot.coverage.comparison === "Available"
        ? changes(snapshot.costs, snapshot.previous).filter(
            (c) => c.id && normalizeId(c.id) === normalizeId(r.id),
          )
        : [];
    if (
      delta.some((c) => c.delta > 20 && (c.percent == null || c.percent > 20))
    )
      add(
        "increase",
        "Spending increase",
        "Plugin-calculated increase against the immediately preceding equal-duration period.",
        ["Correlation with resource events is not proof of causation."],
        null,
        "Investigate the Cost changes view.",
      );
  }
  return findings;
}
