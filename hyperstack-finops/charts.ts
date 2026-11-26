import { changes, filterResources, totals, projectionCoverage } from "./domain";
import type { View } from "./render";
import type { ViewState } from "./types";
export interface ChartSpec {
  id: string;
  title: string;
  note: string;
  config: {
    type: "bar" | "area";
    xKey: string;
    series: { key: string; label: string; color: string }[];
    data: Record<string, string | number | null>[];
    label: string;
    height: number;
    theme: "dark";
  };
}
export function chartSpecs(state: ViewState, view: View): ChartSpec[] {
  const snap = state.snapshot;
  if (!snap) return [];
  const resources = filterResources(
    snap.resources,
    view.environment,
    view.region,
    view.query,
    view.kind,
  );
  const round = (n: number | null | undefined) =>
    n == null ? null : Math.round(n * 100) / 100;
  const make = (
    id: string,
    title: string,
    note: string,
    data: ChartSpec["config"]["data"],
    series: ChartSpec["config"]["series"],
  ): ChartSpec => ({
    id,
    title,
    note,
    config: {
      type: "bar",
      xKey: "resource",
      series,
      data,
      label: `${title} · USD`,
      height: 270,
      theme: "dark",
    },
  });
  const series = [
    { key: "previous", label: "Previous range · USD", color: "#657d9b" },
    { key: "current", label: "Selected dates · USD", color: "#1bd0ef" },
  ];
  if (view.page === "resources") {
    const r = resources.find((r) => r.key === view.selected);
    return r && view.tab === "billing"
      ? [
          make(
            "hf-chart-inspector",
            "Resource billing comparison",
            "Reported amounts for this resource. A gap means the bill was not returned; it is not zero.",
            [
              {
                resource: r.name.slice(0, 28),
                previous: round(r.previous?.cost),
                current: round(r.current?.cost),
              },
            ],
            series,
          ),
        ]
      : [];
  }
  if (!["overview", "changes"].includes(view.page)) return [];
  const compared = changes(resources, snap.windows.current.start)
    .sort(
      (a, b) =>
        Math.max(
          b.resource.current?.cost ?? 0,
          b.resource.previous?.cost ?? 0,
        ) -
        Math.max(a.resource.current?.cost ?? 0, a.resource.previous?.cost ?? 0),
    )
    .slice(0, 8);
  const result = [
    make(
      "hf-chart-comparison",
      "Selected vs previous resource spend",
      "Largest eight resource bills · grouped VM/IP amounts use the same accounting basis in both ranges. Missing bills remain gaps. Full precision stays in calculations; graph dollars are rounded to cents.",
      compared.map((c) => ({
        resource: c.resource.name.slice(0, 24),
        current: round(c.resource.current?.cost),
        previous: round(c.resource.previous?.cost),
      })),
      series,
    ),
  ];
  if (view.page === "overview") {
    const chargeRows = resources.filter(
      (r) =>
        r.kind !== "public-ip" ||
        !resources.find((p) => p.key === r.parent)?.current?.includesPublicIp,
    );
    result.push(
      make(
        "hf-chart-breakdown",
        "Spend by resource type",
        "Each reported charge is counted once. Public-IP components already grouped into a VM are excluded from the separate IP bar. Missing costs are excluded, not filled with estimates.",
        ["vm", "volume", "public-ip"].map((kind) => ({
          resource:
            kind === "vm"
              ? "VM bills"
              : kind === "volume"
                ? "Volumes"
                : "Separate IP charges",
          spend: round(
            totals(chargeRows.filter((r) => r.kind === kind)).current,
          ),
        })),
        [{ key: "spend", label: "Reported spend · USD", color: "#1bd0ef" }],
      ),
    );
    const projected = projectionCoverage(snap, resources);
    if (projected.value !== null)
      result.push(
        make(
          "hf-chart-budget",
          "Month-end run rate and budget",
          projected.complete
            ? "Linear projection from complete month-to-date reported spend; future behavior can change."
            : `Partial run rate only: excludes ${projected.missing} resource bill(s). It cannot establish total budget headroom.`,
          [
            {
              resource: "Known spend",
              amount: round(totals(resources).current),
            },
            {
              resource: projected.complete
                ? "Projected month end"
                : "Known-spend projection",
              amount: round(projected.value),
            },
            { resource: "Budget", amount: round(state.budget) },
          ],
          [{ key: "amount", label: "USD", color: "#1bd0ef" }],
        ),
      );
  } else
    result.push(
      make(
        "hf-chart-change",
        "Dollar change by resource",
        "Positive bars increased; negative bars decreased. Resources missing either bill have no calculated change.",
        changes(resources, snap.windows.current.start)
          .slice(0, 10)
          .map((c) => ({
            resource: c.resource.name.slice(0, 24),
            change: round(c.delta),
          })),
        [{ key: "change", label: "Change · USD", color: "#56df91" }],
      ),
    );
  return result;
}
