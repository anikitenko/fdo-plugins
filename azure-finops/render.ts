import { DOM, createInlineAlert } from "@anikitenko/fdo-sdk";
import styles from "./styles.css";
import { mountFinOps } from "./ui.ts";
export function render(): string {
  const dom = new DOM().collectStylesFrom();
  if (!styles.shell)
    return '<section role="alert">Azure FinOps stylesheet unavailable. Rebuild with FDO’s CSS compiler.</section>';
  const cls = dom.createClassFromStyle(styles.shell);
  const button = (id: string, label: string, extra = "") =>
    `<button type="button" id="${id}" class="pure-button ${extra.includes("af-primary") ? "af-primary" : ""}" ${extra.replace(/class="[^"]*"/g, "")}>${label}</button>`;
  const tabs = [
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
  return dom.renderHTML(`<main id="azure-finops" class="${cls}">
    <aside class="af-sidebar"><header class="af-brand"><span class="af-azure" aria-hidden="true">A</span><div><strong>Azure FinOps</strong><span>&amp; Resource Manager</span></div></header><span id="af-mode-badge" class="af-badge">DEMO</span><nav aria-label="FinOps navigation">${tabs.map(([id, icon, label]) => `<button type="button" data-page="${id}" aria-current="${id === "resources" ? "page" : "false"}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i>${label}<span ${id === "operations" ? 'id="af-op-count"' : ""}></span></button>`).join("")}</nav><footer><span class="af-dot"></span><strong id="af-connection">Demo · no Azure calls</strong><p id="af-identity">Contoso engineering</p><small>CLI only · credentials stay in Azure CLI</small></footer></aside>
    <section class="af-workspace"><header class="af-heading"><div><span class="af-eyebrow">AZURE CLOUD OPERATIONS</span><h1 id="af-title">Resources</h1></div><div class="af-row">${button("af-refresh", "↻ Refresh")}<small id="af-freshness">Loading…</small></div></header>
      <section class="af-scope" aria-label="Global Azure scope"><label>Tenant<select id="af-tenant" aria-label="Tenant"></select></label><label>Subscription<select id="af-subscription" aria-label="Subscription"></select></label>
        <div class="af-group-picker">${button("af-groups-button", "All accessible groups", 'aria-expanded="false" aria-controls="af-group-popover"')}<section id="af-group-popover" hidden="hidden" aria-label="Choose resource groups"><input id="af-group-search" type="search" aria-label="Search resource groups" placeholder="Search resource groups…" /><div class="af-row">${button("af-groups-all", "All accessible groups")}${button("af-groups-clear", "Clear selection")}</div><div id="af-group-list"></div><footer><span id="af-group-count"></span>${button("af-groups-cancel", "Cancel")}${button("af-groups-apply", "Apply", 'class="pure-button af-primary"')}</footer></section></div>
        <label>Period<select id="af-period"><option value="30">Last 30 days</option><option value="7">Last 7 days</option><option value="mtd">Month to date</option><option value="custom">Custom</option></select></label><label>Cost basis<select id="af-basis"><option value="ActualCost">Actual</option><option value="AmortizedCost">Amortized</option></select></label><label>Saved view<select id="af-view"><option value="">Current view</option></select></label>${button("af-save-view", "Save view")}
        <div id="af-custom-dates" class="af-row" hidden="hidden"><label>From<input id="af-from" type="date" /></label><label>Through<input id="af-to" type="date" /></label>${button("af-dates-apply", "Apply dates")}</div>
      </section>
      ${createInlineAlert(dom, { id: "af-message", variant: "info", message: "Loading scoped Azure data…" })}
      <div id="af-progress" role="status" hidden="hidden">Loading… <span id="af-progress-detail"></span> ${button("af-stop-loading", "Stop local loading")}</div>
      <div id="af-context" class="af-muted"></div><section id="af-cards" class="af-cards" aria-label="Cost and resource summary"></section>
      <section id="af-main"></section>
      <footer id="af-plan-bar" class="af-plan-bar"><div><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i><strong>Action plan</strong><span id="af-plan-count">0 proposed actions</span><small>Adding an action never executes it</small></div>${button("af-review", "Review plan →", 'class="pure-button af-primary"')}</footer>
    </section>
    <dialog id="af-review-dialog" aria-labelledby="af-review-title"><header class="af-row af-between"><h2 id="af-review-title">Review action plan</h2>${button("af-review-close", "Close")}</header><div id="af-review-content"></div></dialog>
    <dialog id="af-view-dialog" aria-labelledby="af-view-title"><h2 id="af-view-title">Save current view</h2><label>View name<input id="af-view-name" maxlength="80" /></label><div class="af-row">${button("af-view-cancel", "Cancel")}${button("af-view-confirm", "Save view")}</div></dialog>
  </main>`);
}
export function onLoad(): string {
  return `(()=>{const root=document.getElementById('azure-finops');if(!root)return;if(root.__afCleanup)root.__afCleanup();root.__afCleanup=(${mountFinOps.toString()})(root);})();`;
}
