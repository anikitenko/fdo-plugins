import { createProgressBar } from "@anikitenko/fdo-sdk";
import { usd } from "./format";
import { chartSpecs } from "./charts";
import type { ChartSpec } from "./charts";
import { diagnosticText } from "./diagnostics";
import { DOM } from "@anikitenko/fdo-sdk";
import css from "./styles.css";
import type { Plan, Resource, ViewState } from "./types";
import {
  changes,
  filterResources,
  findings,
  projectionCoverage,
  missingBills,
  totals,
} from "./domain";
export interface View {
  page: string;
  tab: string;
  selected: string;
  environment: string;
  region: string;
  query: string;
  kind: string;
}
export function readView(input: unknown): View {
  const v =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const str = (k: string) =>
    typeof v[k] === "string" ? String(v[k]).slice(0, 300) : "";
  return {
    page: [
      "overview",
      "resources",
      "optimization",
      "changes",
      "operations",
      "plan",
    ].includes(str("page"))
      ? str("page")
      : "overview",
    tab: ["billing", "origin", "dependencies", "activity"].includes(str("tab"))
      ? str("tab")
      : "billing",
    selected: str("selected"),
    environment: str("environment"),
    region: str("region"),
    query: str("query"),
    kind: ["vm", "volume", "public-ip"].includes(str("kind"))
      ? str("kind")
      : "",
  };
}
export const escape = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const money = usd;
const num = (n: number | null | undefined) =>
  n == null
    ? "Not reported"
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const stamp = (s: string | null) =>
  s
    ? `<time datetime="${escape(s)}" data-local-date="${escape(s)}">${escape(s)}</time>`
    : "Unknown";
const icon = (kind: string) =>
  kind === "vm" ? "▧" : kind === "volume" ? "▱" : "⌘";
function builders(dom: DOM) {
  const e = (
    tag: string,
    attrs: Record<string, string>,
    ...children: string[]
  ) => dom.createElement(tag, attrs, ...children);
  const p = (s: string, cls = "muted") => e("p", { class: cls }, escape(s));
  const button = (
    label: string,
    attrs: Record<string, string> = {},
    cls = "button",
  ) => e("button", { type: "button", class: cls, ...attrs }, escape(label));
  const card = (
    label: string,
    value: string,
    detail: string,
    attrs: Record<string, string> = {},
  ) =>
    e(
      "div",
      { class: "metric", ...attrs },
      p(label, "eyebrow"),
      e("strong", {}, escape(value)),
      p(detail, "metric-detail"),
    );
  return { e, p, button, card };
}
export function renderContent(state: ViewState, view = readView({})): string {
  const dom = new DOM();
  const { e, p, button, card } = builders(dom);
  const snap = state.snapshot;
  if (!snap)
    return e(
      "section",
      { class: "welcome panel" },
      p("VISIBILITY BEFORE ACTION", "eyebrow accent"),
      e("h2", {}, "Make every GPU hour count."),
      p(
        "Connect Hyperstack to follow your infrastructure spend, investigate cost changes, and review opportunities to save.",
      ),
      e(
        "div",
        { class: "empty-illustration", "aria-hidden": "true" },
        "▧  ───  ▱  ───  ⌘",
      ),
      p(
        state.configured
          ? "Connection saved. Choose Sync billing to load your account."
          : "Save an API key in Connection, or explore the read-only example.",
      ),
      button("Explore example", { "data-action": "demo" }, "button primary"),
      e(
        "div",
        { class: "onboarding-grid" },
        card(
          "01 / Understand",
          "Reported spend",
          "Compare equivalent billing windows.",
        ),
        card(
          "02 / Investigate",
          "Resource evidence",
          "Keep completed training runs discoverable.",
        ),
        card(
          "03 / Act",
          "Reviewed plans",
          "Verify dependencies before any operation.",
        ),
      ),
    );
  const resources = filterResources(
    snap.resources,
    view.environment,
    view.region,
    view.query,
    view.kind,
  );
  const allFindings = findings(snap.resources),
    scopedFindings = findings(resources);
  const summary = totals(resources),
    forecast = projectionCoverage(snap, resources),
    projected = forecast.value;
  const missing = missingBills(resources);
  const comparable = changes(resources, snap.windows.current.start).filter(
    (c) => c.delta !== null,
  );
  const comparableDelta = comparable.length
    ? comparable.reduce((n, c) => n + c.delta!, 0)
    : null;
  const shownDelta = summary.delta ?? comparableDelta;
  const notices =
    snap.warnings.length > 3
      ? e(
          "details",
          { class: "notice" },
          e(
            "summary",
            {},
            escape(
              `${snap.warnings.length} billing coverage notes · expand for affected resources`,
            ),
          ),
          ...snap.warnings.map((w) => p(w)),
        )
      : e(
          "div",
          { class: "notices" },
          ...snap.warnings.map((w) => p(w, "notice")),
        );
  const rangeLabel = `${snap.windows.current.start.slice(0, 10)} – ${new Date(Date.parse(snap.windows.current.end) - 1).toISOString().slice(0, 10)}`;
  const periodNames: Record<string, string> = {
    month: "This month",
    "last-month": "Last month",
    "7d": "Last 7 days",
    yesterday: "Yesterday",
    custom: "Custom range",
  };
  const rangeNote = e(
    "div",
    { class: "range-note", id: "hf-loaded-range" },
    e(
      "strong",
      {},
      escape(`${periodNames[snap.windows.period]} · ${rangeLabel} (UTC dates)`),
    ),
    e(
      "small",
      {},
      "Every resource cost below is the reported total for this loaded range, not a lifetime cost or an estimate. State and attachments reflect the latest Sync.",
    ),
    e(
      "small",
      {},
      "Exact billing interval: ",
      stamp(snap.windows.current.start),
      " to ",
      stamp(snap.windows.current.end),
      " (end exclusive).",
    ),
  );
  const onlyUnsplitIps =
    resources.length > 0 &&
    resources.every(
      (r) =>
        r.kind === "public-ip" &&
        r.current?.cost == null &&
        snap.resources.find((p) => p.key === r.parent)?.current
          ?.includesPublicIp,
    );
  const metrics = e(
    "div",
    { class: "metrics" },
    card(
      summary.currentMissing ? "Known reported spend" : "Reported spend",
      onlyUnsplitIps ? "Included in VM bills" : money(summary.current),
      onlyUnsplitIps
        ? "Separate IP amounts were not returned; inspect the parent VM bill"
        : summary.currentMissing
          ? `${summary.currentMissing} resource bills not loaded; shown amount is a subtotal`
          : summary.currentIncludedIps
            ? `${resources.length} resource${resources.length === 1 ? "" : "s"} · ${summary.currentIncludedIps} IP components already included in VM bills`
            : `${resources.length} resource${resources.length === 1 ? "" : "s"} · selected dates · USD`,
    ),
    card(
      summary.delta === null && comparableDelta !== null
        ? "Comparable-resource change"
        : "Period change",
      onlyUnsplitIps
        ? "Compare parent VM"
        : shownDelta === null
          ? "Waiting for a bill"
          : `${shownDelta >= 0 ? "+" : "−"}${money(Math.abs(shownDelta))}`,
      onlyUnsplitIps
        ? "IP charges are included in the parent bill; an independent IP comparison is not available."
        : summary.delta === null
          ? `${missing.length} resource bill${missing.length === 1 ? " is" : "s are"} missing. See Billing coverage below; ${comparable.length} complete resource comparison${comparable.length === 1 ? " is" : "s are"} shown.`
          : summary.percent === null
            ? "Previous range reports zero spend; a percentage does not apply"
            : `${num(summary.percent)}% vs previous period`,
    ),
    card(
      !forecast.complete && projected !== null
        ? "Known-spend month-end run rate"
        : "Month-end projection",
      onlyUnsplitIps
        ? "See parent VM run rate"
        : projected !== null
          ? money(projected)
          : snap.windows.period === "month"
            ? "No reported spend to project"
            : "This month only",
      onlyUnsplitIps
        ? "The API has not separated IP charges from the parent VM. Repeating the same read cannot create an itemized amount."
        : snap.windows.period !== "month"
          ? "Choose This month to view a month-end forecast"
          : forecast.complete
            ? "Linear run rate from complete month-to-date reported spend"
            : projected !== null
              ? `Partial estimate: excludes ${forecast.missing} resource bill(s). It does not establish total budget headroom.`
              : "Retry the missing selected-date bill(s) in Billing coverage to calculate a forecast.",
    ),
    card(
      "Savings opportunities",
      String(scopedFindings.length),
      "Evidence to review · not realized savings",
    ),
  );
  const coverage = missing.length
    ? e(
        "section",
        {
          id: "hf-billing-coverage",
          class: "panel billing-coverage",
          "aria-labelledby": "hf-coverage-heading",
        },
        e(
          "h2",
          { id: "hf-coverage-heading" },
          onlyUnsplitIps
            ? "Public-IP charges are included in the parent bill"
            : "Billing coverage · what is missing?",
        ),
        p(
          onlyUnsplitIps
            ? "The provider returned a parent VM bill but did not separately itemize this IP charge. Open the parent bill to compare its reported totals; this is not a reason to keep retrying."
            : "Missing means the provider did not return a usable cost for that resource and date range. It is not a zero-cost resource. A full comparison needs both selected and previous bills. Comparable-resource change excludes missing pairs; a partial run rate excludes missing selected-date amounts.",
        ),
        ...missing.map(({ resource: r, field }) => {
          const issue = snap.billingIssues?.find(
            (i) => i.resourceKey === r.key && i.field === field,
          );
          const parent =
            r.kind === "public-ip"
              ? snap.resources.find((p) => p.key === r.parent)
              : undefined;
          if (parent?.[field]?.includesPublicIp && parent[field]?.cost != null)
            return e(
              "article",
              { class: "coverage-row" },
              e(
                "div",
                {},
                e("strong", {}, escape(`${r.name} · ${r.key}`)),
                p(
                  "Not separately itemized. The charge is already included in the reported parent VM bill. No additional cost is added and no zero amount is inferred.",
                ),
              ),
              button("Open parent VM bill", { "data-select": parent.key }),
            );
          return e(
            "article",
            { class: "coverage-row" },
            e(
              "div",
              {},
              button(
                `${r.name} · ${r.key}`,
                { "data-select": r.key },
                "resource-link",
              ),
              p(
                `${field === "current" ? "Selected-date cost is missing" : "Previous-range cost is missing"}. ${issue?.message ?? "This billing read did not provide a usable amount. Retry it below or Sync billing after checking billing permissions."}`,
              ),
              ...(issue?.attempts
                ? [
                    p(
                      `Still unavailable after ${issue.attempts} read attempt${issue.attempts === 1 ? "" : "s"}. Repeating an unchanged request may not help.`,
                      "finding-label",
                    ),
                    e(
                      "small",
                      {},
                      "Last attempt: ",
                      stamp(issue.lastAttemptAt ?? null),
                    ),
                  ]
                : []),
              ...(issue?.diagnostics
                ? [
                    e(
                      "details",
                      {},
                      e("summary", {}, "Request diagnostics"),
                      p(diagnosticText(issue.diagnostics)),
                    ),
                  ]
                : []),
            ),
            button(
              issue?.retryBlocked === "provider-data"
                ? "Provider data unavailable"
                : issue?.attempts &&
                    issue?.diagnostics &&
                    [401, 403].includes(issue.diagnostics.httpStatus)
                  ? "Access change required"
                  : issue?.attempts
                    ? "Try billing read again"
                    : `Retry ${field === "current" ? "selected" : "previous"} bill`,
              {
                "data-retry-bill": r.key,
                "data-field": field,
                ...(state.demo ||
                issue?.retryBlocked === "provider-data" ||
                (issue?.attempts &&
                  issue?.diagnostics &&
                  [401, 403].includes(issue.diagnostics.httpStatus))
                  ? { disabled: "disabled" }
                  : {}),
              },
            ),
          );
        }),
        button(onlyUnsplitIps ? "Refresh billing" : "Retry all billing reads", {
          "data-action": "sync",
        }),
        p(
          onlyUnsplitIps
            ? "Use the grouped parent VM bill for comparison. Refresh billing if the provider later supplies an independent IP breakdown."
            : "If retry is denied, grant billing read access for the resource's organization/environment. Request diagnostics show the endpoint, HTTP status and provider reason when supplied.",
        ),
      )
    : "";
  const graphs = (specs: ChartSpec[]) => {
    const panels = specs.map((spec) => {
      const head = e(
        "thead",
        {},
        e(
          "tr",
          {},
          e("th", { scope: "col" }, "Resource / measure"),
          ...spec.config.series.map((series) =>
            e("th", { scope: "col" }, escape(series.label)),
          ),
        ),
      );
      const rows = spec.config.data.map((row) =>
        e(
          "tr",
          {},
          e("td", {}, escape(row.resource)),
          ...spec.config.series.map((series) =>
            e(
              "td",
              {},
              escape(
                money(
                  typeof row[series.key] === "number"
                    ? (row[series.key] as number)
                    : null,
                ),
              ),
            ),
          ),
        ),
      );
      const table = e(
        "div",
        { class: "table-scroll" },
        e("table", {}, head, e("tbody", {}, ...rows)),
      );
      return e(
        "section",
        { class: "panel chart-panel" },
        e("h2", {}, escape(spec.title)),
        p(spec.note),
        e(
          "div",
          { id: spec.id, class: "chart", "aria-label": spec.config.label },
          p("Loading graph…", "chart-status"),
        ),
        e(
          "details",
          { class: "chart-data" },
          e("summary", {}, "View graph data (USD)"),
          table,
        ),
      );
    });
    return specs.length ? e("div", { class: "charts-grid" }, ...panels) : "";
  };
  const found = (r: Resource) =>
    allFindings.find((f) => f.resourceKey === r.key);
  const badge = (r: Resource) =>
    e(
      "span",
      {
        class: `badge ${["ACTIVE", "IN-USE", "ALLOCATED"].includes(r.state) ? "green" : r.state === "DELETED" ? "muted" : "neutral"}`,
      },
      escape(r.state),
    );
  const costLabel = (r: Resource) =>
    r.current?.cost != null
      ? money(r.current.cost)
      : r.kind === "public-ip" &&
          snap.resources.find((p) => p.key === r.parent)?.current
            ?.includesPublicIp
        ? "Included in VM bill"
        : "Not reported";
  const row = (r: Resource) =>
    e(
      "tr",
      {
        class:
          view.page === "resources" && view.selected === r.key
            ? "selected"
            : "",
      },
      e(
        "td",
        {},
        button(
          `${icon(r.kind)}  ${r.name}`,
          { "data-select": r.key },
          "resource-link",
        ),
        e(
          "small",
          {},
          escape(`${r.kind} #${r.id} · ${r.environment} · ${r.region}`),
        ),
      ),
      e(
        "td",
        {},
        escape(
          r.kind === "vm"
            ? `${r.flavor} · ${r.gpu} × ${r.gpuCount ?? "?"}`
            : r.flavor,
        ),
      ),
      e("td", {}, badge(r)),
      e(
        "td",
        { class: "numeric" },
        escape(costLabel(r)),
        ...(r.kind === "public-ip" &&
        snap.resources.find((p) => p.key === r.parent)?.current
          ?.includesPublicIp &&
        r.current?.cost != null
          ? [e("small", {}, "Component already counted in VM total")]
          : []),
        ...(r.current?.includesPublicIp
          ? [e("small", {}, "Includes public-IP charges (grouped billing)")]
          : []),
      ),
      e(
        "td",
        {},
        r.createdAt
          ? escape(
              `${Math.max(0, Math.floor((Date.parse(snap.observedAt) - Date.parse(r.createdAt)) / 86400000))}d`,
            )
          : "Unknown",
      ),
      e(
        "td",
        {},
        found(r)
          ? e("span", { class: "finding-label" }, escape(found(r)!.title))
          : "—",
      ),
    );
  const table = (items: Resource[]) =>
    e(
      "div",
      {
        class: "table-scroll",
        tabindex: "0",
        role: "region",
        "aria-label": "Resource costs",
      },
      e(
        "table",
        {},
        e(
          "thead",
          {},
          e(
            "tr",
            {},
            ...[
              "Resource",
              "Configuration",
              "State",
              "Cost (selected dates)",
              "Age",
              "Finding",
            ].map((t) => e("th", { scope: "col" }, escape(t))),
          ),
        ),
        e(
          "tbody",
          {},
          ...(items.length
            ? items.map(row)
            : [
                e(
                  "tr",
                  {},
                  e(
                    "td",
                    { colspan: "6", class: "empty" },
                    "No resources match these filters. Try another environment, region, or search.",
                  ),
                ),
              ]),
        ),
      ),
    );
  const inspector = (r: Resource) => {
    const f = found(r);
    let content = "";
    if (view.tab === "billing") {
      const parent = snap.resources.find((p) => p.key === r.parent);
      const noHours = r.current?.hours == null;
      content = [
        e(
          "div",
          { class: "inspector-metrics" },
          ...(r.kind === "public-ip"
            ? [
                card(
                  "Public-IP cost",
                  costLabel(r),
                  `Reported charges · ${rangeLabel}`,
                ),
                card(
                  "Billing source",
                  "Parent VM",
                  "Public-IP dollars are a component of the VM bill",
                ),
              ]
            : [
                card(
                  "Effective billed rate",
                  r.current?.rate != null
                    ? `${money(r.current.rate, true)}/h`
                    : r.current?.hours === 0
                      ? "No billed hours"
                      : "Not supplied",
                  "Selected-date cost ÷ billed hours; not a live price quote",
                ),
                card(
                  "Billed hours",
                  noHours ? "Not supplied" : num(r.current!.hours),
                  `Provider-reported usage for ${rangeLabel}`,
                ),
              ]),
        ),
        e(
          "dl",
          {},
          e("dt", {}, "Cost in selected dates"),
          e("dd", {}, escape(costLabel(r))),
          e("dt", {}, "Loaded date range"),
          e("dd", {}, escape(`${rangeLabel} (UTC)`)),
          ...(r.kind !== "public-ip"
            ? [
                e("dt", {}, "Current observed rate"),
                e(
                  "dd",
                  {},
                  escape(
                    r.currentRate == null
                      ? "Not supplied by active usage"
                      : `${money(r.currentRate, true)}/h`,
                  ),
                ),
              ]
            : []),
        ),
        ...(r.kind === "public-ip"
          ? [
              p(
                "Hyperstack reports public-IP charges inside the parent VM's billing breakdown. It does not report independent IP usage hours or an effective IP hourly rate. VM uptime is not substituted for IP usage.",
              ),
              ...(parent
                ? [
                    button(
                      `Open parent VM: ${parent.name} →`,
                      { "data-select": parent.key },
                      "text-button",
                    ),
                  ]
                : []),
              ...(r.current?.cost == null && parent?.current?.includesPublicIp
                ? [
                    p(
                      "A separate IP amount was not returned for these dates. Its charge is already counted in the full parent VM bill, so it is not added a second time.",
                      "notice",
                    ),
                  ]
                : []),
            ]
          : [
              p(
                r.current?.includesPublicIp
                  ? "This VM amount includes public-IP charges so both date ranges use the same basis when either separate breakdown is unavailable. Any IP component shown separately is already counted here; overall spend counts the reported bill once."
                  : "Costs are actual billed amounts for the selected dates. Current observed rates and pricebook estimates are shown separately.",
              ),
            ]),
        f
          ? e(
              "div",
              { class: "warning" },
              e("strong", {}, escape(`⚠ ${f.title}`)),
              p(f.evidence),
              p(
                f.hourlySavings == null
                  ? "A reliable savings amount is not available. Review billing detail and contract terms before estimating savings."
                  : `Estimated avoidable usage: ${money(f.hourlySavings, true)}/h. Contract charges and retained resources may remain.`,
              ),
              e("small", {}, "Observed ", stamp(f.observedAt)),
            )
          : "",
      ].join("");
    }
    if (view.tab === "billing") content += graphs(chartSpecs(state, view));
    if (view.tab === "origin")
      content = e(
        "dl",
        {},
        e("dt", {}, "Created"),
        e("dd", {}, stamp(r.createdAt)),
        e("dt", {}, "Owner"),
        e("dd", {}, escape(r.owner)),
        e("dt", {}, "Origin"),
        e("dd", {}, escape(r.origin)),
        e("dt", {}, "Environment"),
        e("dd", {}, escape(r.environment)),
        e("dt", {}, "Region"),
        e("dd", {}, escape(r.region)),
        e("dt", {}, "Deleted"),
        e("dd", {}, stamp(r.deletedAt)),
      );
    if (view.tab === "dependencies")
      content =
        p(
          "Attached storage and retained IPs can continue billing independently.",
        ) +
        (r.dependencies.length
          ? e(
              "ul",
              { class: "dependency-list" },
              ...r.dependencies.map((key) => {
                const d = snap.resources.find((x) => x.key === key);
                return e(
                  "li",
                  {},
                  button(
                    d ? `${icon(d.kind)} ${d.name} · ${key}` : key,
                    { "data-select": key },
                    "resource-link",
                  ),
                  p(
                    d
                      ? `${money(d.current?.cost)} in period`
                      : "Metadata unavailable",
                  ),
                );
              }),
            )
          : p(
              r.attachmentsKnown
                ? "No current attachments reported."
                : "Current attachments: Unknown. Historical links may be incomplete.",
            ));
    if (view.tab === "activity")
      content = e(
        "ol",
        { class: "timeline" },
        e("li", {}, stamp(r.createdAt), p("Created · provider metadata")),
        ...(r.deletedAt
          ? [e("li", {}, stamp(r.deletedAt), p("Deleted · provider usage"))]
          : []),
        e("li", {}, stamp(r.observedAt), p(`Observed ${r.state} · last Sync`)),
        ...state.operations
          .filter(
            (o) =>
              o.plan.resourceKey === r.key &&
              o.plan.organizationId === snap.organizationId,
          )
          .map((o) =>
            e("li", {}, stamp(o.at), p(`${o.status} · ${o.message}`)),
          ),
      );
    return e(
      "aside",
      { class: "panel inspector", "aria-label": "Resource inspector" },
      e(
        "div",
        { class: "inspector-heading" },
        e(
          "span",
          { class: "resource-icon", "aria-hidden": "true" },
          icon(r.kind),
        ),
        e(
          "div",
          {},
          e("h2", {}, escape(r.name)),
          p(`${r.kind.toUpperCase()} · #${r.id} · ${r.region}`),
        ),
        badge(r),
        button(
          "Close",
          {
            "data-clear-selection": "true",
            "aria-label": "Close resource inspector",
          },
          "text-button",
        ),
      ),
      e(
        "div",
        { class: "tabs", role: "tablist", "aria-label": "Resource details" },
        ...["billing", "origin", "dependencies", "activity"].map((tab) =>
          button(
            tab[0].toUpperCase() + tab.slice(1),
            {
              id: `hf-tab-${tab}`,
              "data-tab": tab,
              role: "tab",
              "aria-controls": "hf-tab-panel",
              "aria-selected": String(view.tab === tab),
            },
            view.tab === tab ? "tab active" : "tab",
          ),
        ),
      ),
      e(
        "div",
        {
          id: "hf-tab-panel",
          role: "tabpanel",
          "aria-labelledby": `hf-tab-${view.tab}`,
          class: "tab-body",
        },
        content,
      ),
      r.kind !== "public-ip" && r.live && r.state !== "DELETED"
        ? e(
            "div",
            { class: "inspector-actions" },
            p(
              r.kind === "vm"
                ? "Hibernation releases compute and ephemeral data. Saved root disk, volumes and retained IPs continue billing."
                : "Deleting this volume permanently removes its data. Detachment alone does not imply it is safe to delete.",
            ),
            p(
              r.kind === "volume"
                ? "Choose a future savings window to estimate charges avoided after deletion: current storage rate × hours. Example: $0.10/h × 24h = $2.40 avoided. Deletion happens when confirmed; this is not a delay, schedule, or refund for the selected billing dates."
                : "Choose how long you expect to keep the VM hibernated. Avoided compute charges are estimated as the observed compute rate × pause hours; retained disk, volume and IP charges continue.",
            ),
            e(
              "label",
              { for: "hf-pause" },
              r.kind === "volume"
                ? "Savings estimate window (hours after deletion)"
                : "Expected hibernation duration (hours)",
            ),
            e("input", {
              id: "hf-pause",
              type: "number",
              min: "1",
              max: "8760",
              value: r.kind === "volume" ? "24" : "12",
              "aria-describedby": "hf-estimate-note",
            }),
            e(
              "small",
              { id: "hf-estimate-note" },
              "Estimate only. No action is scheduled by this field.",
            ),
            ...(r.kind === "vm"
              ? [
                  e(
                    "label",
                    { class: "check" },
                    e("input", {
                      id: "hf-retain",
                      type: "checkbox",
                      checked: "checked",
                    }),
                    "Retain public IP (continues billing)",
                  ),
                ]
              : []),
            button(
              state.demo
                ? "Connect to manage resources"
                : r.kind === "vm"
                  ? "☾  Review hibernation →"
                  : "Review volume cleanup →",
              {
                "data-stage": r.key,
                "data-kind": r.kind === "vm" ? "hibernate" : "delete-volume",
                ...(state.demo ? { disabled: "disabled" } : {}),
              },
              "button primary",
            ),
          )
        : p(
            "Historical resources remain available for cost investigation. Public-IP management is reviewed with its parent VM.",
          ),
    );
  };
  const planCard = (plan: Plan) => {
    const r = snap.resources.find((r) => r.key === plan.resourceKey);
    return e(
      "section",
      { class: "panel plan-card" },
      e(
        "div",
        { class: "section-heading" },
        e(
          "div",
          {},
          p(
            plan.kind === "hibernate"
              ? "HIBERNATION PLAN"
              : "PERMANENT VOLUME CLEANUP",
            "eyebrow accent",
          ),
          e("h2", {}, escape(plan.name)),
        ),
        e("span", { class: "badge neutral" }, escape(`#${plan.resourceId}`)),
      ),
      e(
        "div",
        { class: "plan-grid" },
        e(
          "div",
          {},
          e(
            "dl",
            {},
            e("dt", {}, "Organization"),
            e("dd", {}, escape(plan.organizationId ?? "Unknown")),
            e("dt", {}, "Affected resource"),
            e("dd", {}, escape(plan.resourceKey)),
            e(
              "dt",
              {},
              plan.kind === "hibernate"
                ? "Expected pause"
                : "Future savings estimate window",
            ),
            e("dd", {}, escape(`${plan.hours} hours`)),
            e("dt", {}, "Estimated avoided charges"),
            e(
              "dd",
              { class: "accent" },
              escape(
                money(
                  plan.hourlySavings === null
                    ? null
                    : plan.hourlySavings * plan.hours,
                ),
              ),
            ),
            e("dt", {}, "Root disk and storage"),
            e(
              "dd",
              {},
              plan.kind === "hibernate"
                ? "Retained and billed; additional to the avoided-compute estimate"
                : "Target volume permanently deleted",
            ),
            e("dt", {}, "Resume capacity"),
            e("dd", {}, escape(plan.capacity)),
            e("dt", {}, "Capacity observed"),
            e("dd", {}, stamp(plan.capacityAt)),
          ),
          p(
            "Estimate assumes the observed rate continues. Savings are not guaranteed and exclude retained storage, IP charges and contractual commitments.",
          ),
        ),
        e(
          "div",
          {},
          e("h3", {}, "Dependencies"),
          ...plan.dependencies.map((key) =>
            e(
              "div",
              { class: "dependency" },
              e("strong", {}, escape(key)),
              p(
                key.startsWith("public-ip:")
                  ? plan.retainIp
                    ? "Retain public IP · continues billing"
                    : "Release public IP · address may change on resume"
                  : "Retain attached volume · continues billing",
              ),
            ),
          ),
          ...(!plan.dependencies.length
            ? [p("No attached dependencies reported.")]
            : []),
          plan.kind === "hibernate"
            ? button("↻  Refresh capacity", { "data-capacity": plan.id })
            : p("Only a detached AVAILABLE volume can be deleted."),
        ),
      ),
      ...(plan.blocked ? [p(plan.blocked, "warning")] : []),
      ...(!state.managementAllowed
        ? [
            p(
              "FDO HTTPS management access is unavailable. Grant the declared network capabilities before execution.",
              "warning",
            ),
          ]
        : []),
      e(
        "div",
        { class: "plan-footer" },
        button("Remove from plan", { "data-unstage": plan.id }),
        e(
          "div",
          { class: "confirmation" },
          ...(plan.kind === "delete-volume"
            ? [
                e(
                  "label",
                  { for: `hf-confirm-id-${plan.id}` },
                  "Type volume ID to confirm deletion",
                ),
                e("input", {
                  id: `hf-confirm-id-${plan.id}`,
                  inputmode: "numeric",
                  autocomplete: "off",
                  placeholder: String(plan.resourceId),
                }),
              ]
            : []),
          e(
            "label",
            { class: "check" },
            e("input", { id: `hf-confirm-${plan.id}`, type: "checkbox" }),
            plan.kind === "hibernate"
              ? "I reviewed data loss, retained costs and resume availability."
              : "I verified this data is no longer needed; deletion is permanent.",
          ),
          button(
            plan.kind === "hibernate"
              ? "Confirm hibernation"
              : "Confirm volume deletion",
            {
              "data-execute": plan.id,
              "data-target": String(r?.id ?? plan.resourceId),
              ...(plan.blocked || !state.managementAllowed || state.demo
                ? { disabled: "disabled" }
                : {}),
            },
            "button primary",
          ),
        ),
      ),
    );
  };
  let content = "";
  if (view.page === "overview") {
    const byKind = (["vm", "volume", "public-ip"] as const).map((kind) => ({
      kind,
      amount: totals(resources.filter((r) => r.kind === kind)).current,
      missing: totals(resources.filter((r) => r.kind === kind)).currentMissing,
    }));
    content =
      e(
        "div",
        { class: "overview-grid" },
        e(
          "section",
          { class: "panel" },
          e(
            "div",
            { class: "section-heading" },
            e(
              "div",
              {},
              p("WHERE YOUR SPEND GOES", "eyebrow"),
              e("h2", {}, "Cost drivers"),
            ),
            e("span", { class: "badge neutral" }, "USD"),
          ),
          ...byKind.map((k) =>
            button(
              `${icon(k.kind)}  ${k.kind === "vm" ? "GPU compute & VM storage" : k.kind === "volume" ? "Shared volumes" : "Public IP"}    ${k.kind === "public-ip" && summary.currentIncludedIps ? (k.amount === null ? "Included in VM bills" : `${money(k.amount)} known component · already included in VM totals`) : k.amount === null ? "Billing not returned" : `${money(k.amount)}${k.missing ? " known subtotal" : ""}`}  →`,
              { "data-driver": k.kind },
              "driver",
            ),
          ),
          p(
            "VM costs include saved root disks and other VM components. Public-IP amounts are split out only when the provider supplies the breakdown.",
          ),
        ),
        e(
          "section",
          { class: "panel" },
          p("STAY WITHIN PLAN", "eyebrow"),
          e("h2", {}, "Monthly budget"),
          e(
            "div",
            { class: "budget-value" },
            escape(
              projected !== null
                ? money(projected)
                : snap.windows.period === "month"
                  ? "Billing incomplete"
                  : "Choose This month",
            ),
            e(
              "small",
              {},
              projected === null
                ? " to show a month-end forecast"
                : forecast.complete
                  ? " projected"
                  : " partial known-spend projection",
            ),
          ),
          state.budget === null
            ? p("Set your monthly budget to compare the current run rate.")
            : p(
                `${money(state.budget)} monthly budget · ${projected === null ? "Choose This month to project spend" : !forecast.complete ? "Missing bills prevent a complete budget comparison" : money(Math.abs(projected - state.budget)) + (projected > state.budget ? " projected over budget" : " projected headroom")}`,
              ),
          e(
            "label",
            { for: "hf-budget" },
            "Budget (USD / month, selected scope)",
          ),
          e(
            "div",
            { class: "input-action" },
            e("input", {
              id: "hf-budget",
              type: "number",
              min: "0",
              step: "0.01",
              value: state.budget === null ? "" : String(state.budget),
              placeholder: "e.g. 2500",
            }),
            button("Save budget", { "data-action": "budget" }),
          ),
          p(
            "One saved comparison budget. It applies to the environment and region filters currently selected; it does not enforce a spending limit.",
          ),
        ),
      ) +
      e(
        "section",
        { class: "panel" },
        e(
          "div",
          { class: "section-heading" },
          e("h2", {}, "Largest cost drivers"),
          button(
            "View resources →",
            { "data-page": "resources" },
            "text-button",
          ),
        ),
        table(
          [...resources]
            .sort((a, b) => (b.current?.cost ?? -1) - (a.current?.cost ?? -1))
            .slice(0, 6),
        ),
      ) +
      e(
        "div",
        { class: "source-note" },
        `Organization reported total: ${escape(money(snap.organizationCost))}. The resource view covers VMs, volumes and VM public-IP charges. Other services, credits or contracts may differ.`,
      );
  } else if (view.page === "resources") {
    const selected = resources.find((r) => r.key === view.selected);

    content = e(
      "div",
      { class: "explorer" },
      e(
        "section",
        { class: "panel resource-table" },
        e(
          "div",
          { class: "section-heading" },
          e("h2", {}, "Resource explorer"),
          e(
            "span",
            { class: "badge neutral" },
            `${resources.length} resource${resources.length === 1 ? "" : "s"}`,
          ),
        ),
        table(resources),
        p(
          "Historical billing stays discoverable after deletion. Unknown origin means the provider did not supply it.",
        ),
      ),
      selected
        ? inspector(selected)
        : e(
            "aside",
            { class: "panel" },
            e("h2", {}, "Select a resource"),
            p(
              "Choose a resource name to open its billing, origin, dependencies and activity. Nothing is selected automatically.",
            ),
          ),
    );
  } else if (view.page === "optimization")
    content = e(
      "section",
      { class: "panel" },
      p("VERIFY, THEN SAVE", "eyebrow accent"),
      e("h2", {}, "Cost savings opportunities"),
      p(
        "These findings combine current resource state, attachment evidence and active billing. They do not infer utilization from VM state.",
      ),
      ...(scopedFindings.length
        ? scopedFindings.map((f) => {
            const r = resources.find((r) => r.key === f.resourceKey)!;
            return e(
              "article",
              { class: "finding-card" },
              e(
                "div",
                {},
                e("span", { class: "finding-label" }, escape(f.title)),
                e("h3", {}, escape(r.name)),
                p(f.evidence),
                e("small", {}, "Observed ", stamp(f.observedAt)),
              ),
              e(
                "div",
                {},
                e(
                  "strong",
                  { class: "accent" },
                  `${escape(money(f.hourlySavings === null ? null : f.hourlySavings * 730))} / 730h`,
                ),
                p("Estimated avoided usage · review retained costs"),
                button("Inspect opportunity →", { "data-select": r.key }),
              ),
            );
          })
        : [
            p(
              "No verified opportunities in this scope. Unknown billing or attachment data cannot establish a finding.",
              "empty",
            ),
          ]),
    );
  else if (view.page === "changes") {
    const ranked = changes(resources, snap.windows.current.start);
    const changeRows = ranked.map((c) => {
      const evidence = e(
        "details",
        {},
        e("summary", {}, "Evidence & calculation"),
        e("ul", {}, ...c.details.map((d) => e("li", {}, escape(d)))),
      );
      return e(
        "tr",
        {},
        e(
          "td",
          {},
          button(
            c.resource.name,
            { "data-select": c.resource.key },
            "resource-link",
          ),
          ...(c.combinedPublicIp
            ? [
                e(
                  "small",
                  {},
                  "Full VM bills compared together, including any IP charges; one split is missing",
                ),
              ]
            : []),
        ),
        e("td", {}, escape(money(c.resource.previous?.cost))),
        e("td", {}, escape(money(c.resource.current?.cost))),
        e(
          "td",
          {
            class: c.delta !== null && c.delta > 0 ? "finding-label" : "accent",
          },
          escape(
            c.delta === null
              ? "Needs both bills"
              : `${c.delta > 0 ? "+" : ""}${money(c.delta)}`,
          ),
        ),
        e(
          "td",
          { class: "change-evidence" },
          e("strong", {}, escape(c.explanation)),
          evidence,
        ),
      );
    });
    const headings = [
      "Resource",
      "Previous range",
      "Selected dates",
      "Change (USD)",
      "Why it changed",
    ];
    const changeTable = e(
      "div",
      { class: "table-scroll" },
      e(
        "table",
        {},
        e(
          "thead",
          {},
          e("tr", {}, ...headings.map((h) => e("th", { scope: "col" }, h))),
        ),
        e("tbody", {}, ...changeRows),
      ),
    );
    content = e(
      "section",
      { class: "panel" },
      e("h2", {}, "What changed in your bill?"),
      p(
        "Sorted by dollar change, largest increases first. Expand Evidence & calculation to see reported amounts, billed hours, effective rates and arithmetic attribution. Decreases and unchanged resources follow; missing comparisons stay visible.",
      ),
      e(
        "div",
        { class: "range-note" },
        e("strong", {}, "Comparing loaded billing ranges"),
        e(
          "small",
          {},
          "Selected: ",
          stamp(snap.windows.current.start),
          " to ",
          stamp(snap.windows.current.end),
        ),
        e(
          "small",
          {},
          "Previous: ",
          stamp(snap.windows.previous.start),
          " to ",
          stamp(snap.windows.previous.end),
        ),
        e(
          "small",
          {},
          "Month-to-date uses the same elapsed part of the previous month, capped at month end; full months may differ in length. Custom ranges use the immediately preceding interval of equal duration. All source intervals end exclusively.",
        ),
      ),
      changeTable,
      ...(!ranked.length
        ? [p("No resources match these filters.", "empty")]
        : []),
    );
  } else if (view.page === "plan")
    content = state.plans.length
      ? e("div", { class: "plan-list" }, ...state.plans.map(planCard))
      : e(
          "section",
          { class: "panel empty" },
          e("h2", {}, "No actions staged"),
          p(
            "Inspect a VM or volume to build a plan with its dependencies and estimated impact.",
          ),
          button("Browse resources →", { "data-page": "resources" }),
        );
  else
    content = e(
      "section",
      { class: "panel" },
      e("h2", {}, "Operation history"),
      p(
        "Persistent outcomes from reviewed plans. Submitted means accepted by the API; it does not confirm completion. Uncertain operations are never retried automatically.",
      ),
      ...(state.operations.length
        ? [...state.operations].reverse().map((o) =>
            e(
              "article",
              { class: "operation" },
              e(
                "div",
                {},
                e(
                  "strong",
                  {},
                  escape(
                    `${o.plan.kind} · ${o.plan.name} · ${o.plan.resourceKey}`,
                  ),
                ),
                p(o.message),
                ...(o.diagnostics
                  ? [
                      e(
                        "details",
                        {},
                        e("summary", {}, "Request diagnostics"),
                        p(diagnosticText(o.diagnostics)),
                      ),
                    ]
                  : []),
                stamp(o.at),
                e(
                  "small",
                  {},
                  escape(
                    `Organization ${o.plan.organizationId ?? "Unknown"} · Operation ${o.id}`,
                  ),
                ),
              ),
              e(
                "span",
                {
                  class: `badge ${o.status === "submitted" ? "green" : "neutral"}`,
                },
                escape(o.status),
              ),
            ),
          )
        : [p("No operations recorded.", "empty")]),
    );
  return (
    notices +
    rangeNote +
    metrics +
    coverage +
    (view.page === "overview" || view.page === "changes"
      ? graphs(chartSpecs(state, view))
      : "") +
    content +
    e(
      "footer",
      { class: "source-note" },
      "Observed ",
      stamp(snap.observedAt),
      " · Billing windows use UTC boundaries. Dates display in your local timezone.",
      e("br", {}),
      "Current: ",
      stamp(snap.windows.current.start),
      " – ",
      stamp(snap.windows.current.end),
      " · Previous: ",
      stamp(snap.windows.previous.start),
      " – ",
      stamp(snap.windows.previous.end),
    )
  );
}
export function renderShell(): string {
  const dom = new DOM();
  dom.collectStylesFrom();
  const app = dom.createClassFromStyle(css.app);
  const { e, p, button } = builders(dom);
  const select = (id: string, label: string, options: [string, string][]) =>
    e(
      "label",
      { class: "filter", for: id },
      escape(label),
      e(
        "select",
        { id },
        ...options.map(([value, label]) =>
          e("option", { value }, escape(label)),
        ),
      ),
    );
  const html = e(
    "main",
    { id: "hf-app", class: app, "aria-label": "Hyperstack FinOps" },
    e(
      "aside",
      { class: "sidebar" },
      e(
        "div",
        { class: "brand" },
        e("span", { class: "brand-icon", "aria-hidden": "true" }, "›_"),
        e(
          "div",
          {},
          e("strong", {}, "Hyperstack FinOps"),
          p("GPU infrastructure · FinOps"),
        ),
      ),
      e(
        "nav",
        { "aria-label": "FinOps views" },
        ...[
          ["overview", "⌂", "Overview"],
          ["resources", "▱", "Resources"],
          ["optimization", "ϟ", "Optimization"],
          ["changes", "↗", "Cost changes"],
          ["plan", "☾", "Action plan"],
          ["operations", "⚙", "Operations"],
        ].map(([page, icon, label]) =>
          button(
            `${icon}   ${label}`,
            {
              "data-page": page,
              "aria-current": page === "overview" ? "page" : "false",
            },
            `nav-item ${page === "overview" ? "active" : ""}`,
          ),
        ),
      ),
      e(
        "div",
        { class: "sidebar-bottom" },
        e("span", { class: "status-dot" }),
        e("span", { id: "hf-connection-status" }, "Not connected"),
        p(
          "Evidence before action. Every operation starts with a reviewed plan.",
        ),
      ),
    ),
    e(
      "div",
      { class: "workspace" },
      e(
        "header",
        { class: "topbar" },
        e(
          "div",
          {},
          p("INFRASTRUCTURE INTELLIGENCE", "eyebrow accent"),
          e("h1", { id: "hf-page-title" }, "Spend with clarity."),
          p("Understand your bill. Find the waste. Keep control."),
        ),
        e(
          "div",
          { class: "header-actions" },
          e("span", { id: "hf-mode", class: "badge neutral" }, "LIVE ACCOUNT"),
          button(
            "↻  Sync billing",
            { "data-action": "sync", id: "hf-sync" },
            "button primary",
          ),
        ),
      ),
      e(
        "details",
        { class: "connection panel", id: "hf-connection" },
        e("summary", {}, "Connection & API access"),
        p(
          "Use an API key with billing and resource read access. Execution additionally needs the corresponding VM or volume permission in Hyperstack and FDO’s declared HTTPS grants.",
        ),
        e("label", { for: "hf-api-key" }, "Hyperstack API key"),
        e(
          "div",
          { class: "input-action" },
          e("input", {
            id: "hf-api-key",
            type: "password",
            autocomplete: "off",
            placeholder: "Stored securely by FDO",
          }),
          button("Save key", { "data-action": "configure" }),
          button("Remove key", { "data-action": "disconnect" }),
        ),
        button("Explore example", { "data-action": "demo" }, "text-button"),
      ),
      e(
        "div",
        { class: "filters", role: "group", "aria-label": "Report filters" },
        select("hf-environment", "Environment", [["", "All environments"]]),
        select("hf-region", "Region", [["", "All regions"]]),
        select("hf-period", "Period", [
          ["month", "This month"],
          ["last-month", "Last month"],
          ["7d", "Last 7 days"],
          ["yesterday", "Yesterday"],
          ["custom", "Custom date range"],
        ]),
        select("hf-kind", "Resource type", [
          ["", "All resources"],
          ["vm", "Virtual machines"],
          ["volume", "Volumes"],
          ["public-ip", "Public IPs"],
        ]),
        e(
          "label",
          { class: "filter search", for: "hf-search" },
          "Search resources",
          e("input", {
            id: "hf-search",
            type: "search",
            placeholder: "Name, ID, GPU, flavor…",
          }),
        ),
      ),
      e(
        "div",
        {
          class: "date-controls",
          role: "group",
          "aria-label": "Billing date range",
        },
        e(
          "label",
          { for: "hf-range-start" },
          "From (UTC date)",
          e("input", {
            id: "hf-range-start",
            type: "date",
            value: new Date().toISOString().slice(0, 7) + "-01",
            max: new Date().toISOString().slice(0, 10),
          }),
        ),
        e(
          "label",
          { for: "hf-range-end" },
          "Through (UTC date, inclusive)",
          e("input", {
            id: "hf-range-end",
            type: "date",
            value: new Date().toISOString().slice(0, 10),
            max: new Date().toISOString().slice(0, 10),
          }),
        ),
        button("Apply date range", { "data-action": "apply-range" }),
      ),
      p(
        "Adjust dates and Apply date range to load a custom period (up to 366 days). Today ends at Sync time. The loaded range is shown with the costs below.",
        "source-note",
      ),
      e(
        "p",
        {
          id: "hf-status",
          role: "status",
          "aria-live": "polite",
          class: "status-line",
        },
        "Checking connection…",
      ),
      e(
        "div",
        {
          id: "hf-progress-panel",
          class: "operation-progress",
          hidden: "hidden",
          role: "status",
          "aria-live": "polite",
        },
        e("strong", { id: "hf-progress-label" }, "Working…"),
        createProgressBar(dom, {
          id: "hf-progress",
          label: "Hyperstack operation progress",
          value: null,
          ariaDescribedBy: "hf-progress-detail",
        }),
        e("small", { id: "hf-progress-detail" }, "Waiting for the backend…"),
      ),
      e("div", {
        id: "hf-error",
        role: "alert",
        hidden: "hidden",
        class: "warning",
      }),
      e(
        "details",
        {
          id: "hf-error-details",
          class: "panel request-diagnostics",
          hidden: "hidden",
        },
        e("summary", {}, "Request diagnostics"),
        e("pre", { id: "hf-error-diagnostics" }),
      ),
      p(
        "USD amounts use a decimal point and no thousands separators: USD 81.00 means 81 dollars and 0 cents. Charges are rounded to cents; hourly rates may show four decimal places.",
        "source-note",
      ),
      e(
        "div",
        { id: "hf-content", "aria-busy": "false" },
        renderContent({
          configured: false,
          managementAllowed: false,
          budget: null,
          snapshot: null,
          plans: [],
          operations: [],
          demo: false,
        }),
      ),
    ),
  );
  return dom
    .renderHTML(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
}
