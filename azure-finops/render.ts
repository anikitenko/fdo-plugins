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
  const icon = (name: string) =>
    dom.createElement("i", {
      class: `fa-solid fa-${name}`,
      "aria-hidden": "true",
    });
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
      button("af-save-view", "Save view"),
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
          dom.createElement(
            "span",
            { class: "af-azure", "aria-hidden": "true" },
            "A",
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
            text.createSpanText("AZURE CLOUD OPERATIONS", {
              classes: ["af-eyebrow"],
            }),
            text.createHText(1, "Restoring view…", {}, "af-title"),
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
      createInlineAlert(dom, {
        id: "af-message",
        variant: "info",
        message: "Loading scoped Azure data…",
      }),
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
