import {
  DOM,
  DOMInput,
  DOMSemantic,
  DOMText,
  createInlineAlert,
} from "@anikitenko/fdo-sdk";
import styles from "./styles.css";
import { mountFinOps } from "./ui.ts";

const TABS: ReadonlyArray<readonly [string, string, string]> = [
  ["overview", "chart-line", "Overview"],
  ["groups", "layer-group", "Resource groups"],
  ["resources", "server", "Resources"],
  ["databricks", "cubes", "Databricks"],
  ["foundry", "brain", "Foundry & AI"],
  ["optimization", "leaf", "Optimization"],
  ["changes", "arrow-trend-up", "Cost changes"],
  ["operations", "list-check", "Operations"],
  ["settings", "gear", "Settings"],
];

export function render(): string {
  const text = new DOMText();
  const fields = new DOMInput();
  const sem = new DOMSemantic();
  const dom = new DOM().collectStylesFrom(text, fields, sem);
  if (!styles.shell)
    return dom.renderHTML(
      dom.createElement(
        "section",
        { role: "alert" },
        text.createText(
          "Azure FinOps stylesheet unavailable. Rebuild with FDO’s CSS compiler.",
        ),
      ),
    );
  const cls = dom.createClassFromStyle(styles.shell);
  const button = (
    id: string,
    label: string,
    primary = false,
    attrs: Record<string, string> = {},
  ) =>
    dom.createElement(
      "button",
      {
        type: "button",
        id,
        class: primary ? "pure-button af-primary" : "pure-button",
        ...attrs,
      },
      text.createText(label),
    );
  const select = (
    id: string,
    options: Array<readonly [string, string]>,
    attrs: Record<string, string> = {},
  ) => {
    const control = new DOMInput(id, {}, attrs);
    dom.collectStylesFrom(control);
    return control.createSelect(
      options.map(([label, value]) => fields.createOption(label, value)),
    );
  };
  const input = (id: string, type: string, attrs: Record<string, string> = {}) => {
    const control = new DOMInput(id, {}, attrs);
    dom.collectStylesFrom(control);
    return control.createInput(type);
  };
  const icon = (name: string) => {
    const paths: Record<string, string> = {
      "chart-line": "M4 4v16h17 M7 14l4-5 4 3 5-7",
      "layer-group": "m12 3 9 5-9 5-9-5 9-5 M3 12l9 5 9-5 M3 16l9 5 9-5",
      server: "M4 3h16v18H4z M8 7h1 M13 7h3 M8 12h1 M13 12h3 M8 17h1 M13 17h3",
      cubes: "m12 2 9 5v10l-9 5-9-5V7z m0 0v10 m-9-5 9 5 9-5 m-9 5v10",
      brain: "M9 4C5 1 2 7 5 9c-4 3-1 9 3 8 0 5 5 5 5 1V6c0-4 5-4 5 0 4-1 6 5 2 7 4 5-2 9-5 6 M8 7v5m8-4v6",
      leaf: "M20 3C7 2 2 7 5 15s14 4 15-12 M4 22 16 8",
      "arrow-trend-up": "M3 17l6-6 4 4 8-10 M15 5h6v6",
      "list-check": "M9 5h11 M9 12h11 M9 19h11 M2 5l2 2 3-4 M2 12l2 2 3-4 M2 19l2 2 3-4",
      gear: "m10 2 4 0 1 3 3 1 3 3-2 3 1 3-3 3-3-1-2 3-3-2-3 1-3-3 1-3-2-3 3-3 3 1z M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
      "clipboard-list": "M8 4H4v18h16V4h-4 M8 2h8v5H8z M8 11h8 M8 15h8 M8 19h5",
    };
    return dom.createElement("svg", {viewBox: "0 0 24 24", width: "22", height: "22", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "af-icon"}, dom.createElement("path", {d: paths[name] ?? paths.server}));
  };
  const label = (caption: string, control: string) =>
    dom.createElement("label", {}, text.createText(caption), control);

  const nav = sem.createNav(
    TABS.map(([id, name, caption]) =>
      dom.createElement(
        "button",
        { type: "button", "data-page": id, "aria-current": "false" },
        icon(name),
        text.createText(caption),
        dom.createElement(
          "span",
          id === "operations" ? { id: "af-op-count" } : {},
        ),
      ),
    ),
    {
      disableDefaultClass: true,
      customAttributes: { "aria-label": "FinOps navigation" },
    },
  );

  const groupPopover = sem.createSection(
    [
      input("af-group-search", "search", {
        "aria-label": "Search resource groups",
        placeholder: "Search resource groups…",
      }),
      dom.createElement(
        "div",
        { class: "af-row" },
        button("af-groups-all", "All accessible groups"),
        button("af-groups-clear", "Clear selection"),
      ),
      dom.createElement("div", { id: "af-group-list" }),
      sem.createFooter(
        [
          dom.createElement("span", { id: "af-group-count" }),
          button("af-groups-cancel", "Cancel"),
          button("af-groups-apply", "Apply", true),
        ],
        { disableDefaultClass: true },
      ),
    ],
    {
      disableDefaultClass: true,
      customAttributes: {
        hidden: "hidden",
        "aria-label": "Choose resource groups",
      },
    },
    "af-group-popover",
  );

  const scope = sem.createSection(
    [
      label(
        "Tenant",
        select("af-tenant", [], { "aria-label": "Tenant" }),
      ),
      label(
        "Subscription",
        select("af-subscription", [], { "aria-label": "Subscription" }),
      ),
      dom.createElement(
        "div",
        { class: "af-group-picker" },
        button("af-groups-button", "All accessible groups", false, {
          "aria-expanded": "false",
          "aria-controls": "af-group-popover",
        }),
        groupPopover,
      ),
      label(
        "Period",
        select("af-period", [
          ["Last 30 days", "30"],
          ["Last 7 days", "7"],
          ["Month to date", "mtd"],
          ["Custom", "custom"],
        ]),
      ),
      label(
        "Cost basis",
        select("af-basis", [
          ["Actual", "ActualCost"],
          ["Amortized", "AmortizedCost"],
        ]),
      ),
      label("Saved view", select("af-view", [["Current view", ""]])),
      button("af-save-view", "Save view", false, {title: "Save current view"}),
      dom.createElement(
        "div",
        { id: "af-custom-dates", class: "af-row", hidden: "hidden" },
        label("From", input("af-from", "date")),
        label("Through", input("af-to", "date")),
        button("af-dates-apply", "Apply dates"),
      ),
    ],
    {
      classes: ["af-scope"],
      disableDefaultClass: true,
      customAttributes: { "aria-label": "Global Azure scope" },
    },
  );

  const sidebar = sem.createAside(
    [
      sem.createHeader(
        [
          dom.createElement("svg", {class: "af-azure", viewBox: "0 0 32 32", width: "38", height: "38", "aria-hidden": "true"},
            dom.createElement("path", {d: "M11 2h10L12 29H2z", fill: "#168bd2"}),
            dom.createElement("path", {d: "M16 2h7l9 27H15l4-7h4z", fill: "#35baff"}),
          ),
          dom.createElement(
            "div",
            {},
            text.createStrongText("Azure FinOps"),
            text.createSpanText("& Resource Manager"),
          ),
        ],
        { classes: ["af-brand"], disableDefaultClass: true },
      ),
      text.createSpanText("DEMO", { classes: ["af-badge"] }, "af-mode-badge"),
      nav,
      sem.createFooter(
        [
          dom.createElement("span", { class: "af-dot" }),
          text.createStrongText("Initializing…", {}, "af-connection"),
          text.createPText("CLI profile not checked", {}, "af-identity"),
          text.createSmallText("CLI only · credentials stay in Azure CLI"),
        ],
        { disableDefaultClass: true },
      ),
    ],
    { classes: ["af-sidebar"], disableDefaultClass: true },
  );

  const workspace = sem.createSection(
    [
      sem.createHeader(
        [
          dom.createElement(
            "div",
            {},
            text.createSpanText("Azure resource workspace", {classes: ["af-eyebrow"]}),
            dom.createElement("div", {class: "af-heading-title"}, text.createHText(1, "Restoring view…", {}, "af-title"), dom.createElement("span", {id: "af-heading-mode", class: "af-badge"}, "Demo")),
          ),
          dom.createElement(
            "div",
            { class: "af-row" },
            button("af-refresh", "↻ Refresh"),
            text.createSmallText("Loading…", {}, "af-freshness"),
          ),
        ],
        { classes: ["af-heading"], disableDefaultClass: true },
      ),
      scope,
      dom.createElement("div", {id: "af-scope-summary", class: "af-scope-summary"}),
      dom.createElement("details", {id: "af-data-notes", class: "af-data-notes", hidden: "hidden"},
        dom.createElement("summary", {}, "Data coverage & notes"),
        createInlineAlert(dom, {id: "af-message", variant: "info", message: "Loading scoped Azure data…"}),
      ),
      dom.createElement(
        "div",
        { id: "af-progress", role: "status", hidden: "hidden" },
        text.createText("Loading… "),
        dom.createElement("span", { id: "af-progress-detail" }),
        button("af-stop-loading", "Stop local loading"),
      ),
      dom.createElement("div", { id: "af-context", class: "af-muted" }),
      sem.createSection([], {
        classes: ["af-cards"],
        disableDefaultClass: true,
        customAttributes: { "aria-label": "Cost and resource summary" },
      }, "af-cards"),
      dom.createElement("div", {id: "af-cost-alert", hidden: "hidden", class: "af-cost-alert", role: "status"}),
      sem.createSection([], { disableDefaultClass: true }, "af-main"),
      sem.createFooter(
        [
          dom.createElement(
            "div",
            {},
            icon("clipboard-list"),
            text.createStrongText("Action plan"),
            text.createSpanText(
              "0 proposed actions",
              {},
              "af-plan-count",
            ),
            text.createSmallText("Adding an action never executes it"),
          ),
          button("af-review", "Review plan →", true),
        ],
        { classes: ["af-plan-bar"], disableDefaultClass: true },
        "af-plan-bar",
      ),
    ],
    { classes: ["af-workspace"], disableDefaultClass: true },
  );

  const reviewDialog = dom.createElement(
    "dialog",
    { id: "af-review-dialog", "aria-labelledby": "af-review-title" },
    sem.createHeader(
      [
        text.createHText(2, "Review action plan", {}, "af-review-title"),
        button("af-review-close", "Close"),
      ],
      { classes: ["af-row", "af-between"], disableDefaultClass: true },
    ),
    dom.createElement("div", { id: "af-review-content" }),
  );
  const viewDialog = dom.createElement(
    "dialog",
    { id: "af-view-dialog", "aria-labelledby": "af-view-title" },
    text.createHText(2, "Save current view", {}, "af-view-title"),
    label("View name", input("af-view-name", "text", { maxlength: "80" })),
    dom.createElement(
      "div",
      { class: "af-row" },
      button("af-view-cancel", "Cancel"),
      button("af-view-confirm", "Save view", true),
    ),
  );

  return dom.renderHTML(
    sem.createMain(
      [sidebar, workspace, reviewDialog, viewDialog],
      { classes: [cls], disableDefaultClass: true },
      "azure-finops",
    ),
  );
}

export function onLoad(): string {
  return `(()=>{const root=document.getElementById('azure-finops');if(!root)return;if(root.__afCleanup)return root.__afCleanup;if(window.__afFinOpsCleanup)window.__afFinOpsCleanup();const cleanup=(${mountFinOps.toString()})(root);root.__afCleanup=cleanup;window.__afFinOpsCleanup=cleanup;return cleanup;})();`;
}
