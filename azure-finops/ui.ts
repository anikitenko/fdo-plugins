import type {
  Account,
  Group,
  Mode,
  Operation,
  Resource,
  Review,
  Scope,
  ServiceInspection,
  Settings,
  Snapshot,
  Target,
} from "./types.ts";

/** Serialized iframe callback. All executable Azure requests are built by the backend. */
export function mountFinOps(root: HTMLElement) {
  const win = window as any;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    root.querySelector<T>("#" + id)!;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = "",
  ) => {
    const n = document.createElement(tag);
    n.textContent = text;
    n.className = cls;
    return n;
  };
  const disposers: (() => void)[] = [];
  const charts: any[] = [];
  const listen = (node: EventTarget, event: string, fn: any) => {
    node.addEventListener(event, fn);
    disposers.push(() => node.removeEventListener(event, fn));
  };
  const id = (value: string) => value.replace(/\/+$/, "").toLowerCase();
  const money = (amount: number | null | undefined, currency = "USD") =>
    amount == null
      ? "Not returned"
      : new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
          maximumFractionDigits: 2,
        }).format(amount) +
        (currency === "Unknown" ? " (currency unknown)" : "");
  const badge = (text: string, kind = "") =>
    el("span", text, "af-badge " + kind);
  const button = (text: string, fn: () => unknown, cls = "") => {
    const b = el("button", text, "pure-button " + cls);
    b.type = "button";
    b.onclick = () => {
      Promise.resolve().then(fn).catch(report);
    };
    return b;
  };
  const select = (
    label: string,
    values: [string, string][],
    value: string,
    fn: (v: string) => unknown,
  ) => {
    const l = el("label", label),
      s = el("select");
    s.setAttribute("aria-label", label);
    for (const [v, t] of values) {
      const o = el("option", t);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.onchange = () => {
      Promise.resolve(fn(s.value)).catch(report);
    };
    l.append(s);
    return l;
  };
  let active = true,
    generation = 0,
    detailSequence = 0,
    page = "resources",
    settings: Settings = {
      mode: "demo",
      cli: "/opt/homebrew/bin/az",
      processScope: "azure-finops",
      views: [],
      plan: [],
      operations: [],
      demoOverrides: {},
    },
    accounts: Account[] = [],
    groups: Group[] = [],
    snapshot: Snapshot | undefined,
    scope: Scope;
  let pendingGroups = new Set<string>(),
    pendingAll = true,
    groupsReady = false,
    selection: Resource | undefined,
    detailTab = "origin",
    detailWidth = 0,
    tablePage = 0,
    sort = "cost",
    direction = "desc",
    columns = ["name", "cost", "age", "owner", "state", "findings"];
  let filters: Record<string, string> = {
      search: "",
      type: "",
      region: "",
      age: "",
      state: "",
      owner: "",
      environment: "",
      tag: "",
      cost: "",
      finding: "",
      lock: "",
      preset: "",
    },
    activeJobs = new Set<string>(),
    executing = false,
    operations: Operation[] = [],
    review: Review | undefined;
  let currentRows: Record<string, unknown>[] = [],
    currentColumns: string[] = [];
  let serviceData: ServiceInspection | undefined,
    serviceSequence = 0,
    servicePending = "";
  const navNames: Record<string, string> = {
    overview: "Overview",
    groups: "Resource groups",
    resources: "Resources",
    databricks: "Azure Databricks inspection",
    foundry: "Foundry & AI inspection",
    optimization: "Optimization",
    changes: "Cost changes",
    operations: "Operations",
    settings: "Settings",
  };
  function message(text: string, error = false) {
    const box = $("af-message");
    box.hidden = !text;
    box.dataset.fdoVariant = error ? "error" : "info";
    box.setAttribute("role", error ? "alert" : "status");
    box.querySelector('[data-fdo-slot="message"]')!.textContent = text;
  }
  function report(error: unknown) {
    if (!active) return;
    const text = error instanceof Error ? error.message : String(error);
    message(text, true);
    const d = $<HTMLDialogElement>("af-review-dialog");
    if (d.open) {
      let n = d.querySelector<HTMLElement>("[data-review-error]");
      if (!n) {
        n = el("p", "", "af-callout");
        n.dataset.reviewError = "true";
        d.append(n);
      }
      n.textContent = text;
    }
  }
  async function request(name: string, data: unknown = {}) {
    const response = await win.createBackendReq("UI_MESSAGE", {
      handler: `azure-finops.${name}`,
      content: data,
    });
    const result = response?.result ?? response;
    if (!result?.ok)
      throw new Error(
        result?.error ?? "FDO backend did not return a valid result.",
      );
    return result.data;
  }
  async function run(
    kind: string,
    data: any = {},
    ticket = generation,
    mutating = false,
  ): Promise<any> {
    const opened = await request("start", {
      kind,
      mode: settings.mode,
      scope,
      ...data,
    });
    return drive(opened.jobId, ticket, mutating);
  }
  async function drive(
    jobId: string,
    ticket: number,
    mutating = false,
  ): Promise<any> {
    activeJobs.add(jobId);
    $("af-progress").hidden = false;
    $<HTMLButtonElement>("af-stop-loading").disabled = mutating;
    try {
      while (active) {
        if (!mutating && ticket !== generation) {
          await request("stop", { jobId }).catch(() => {});
          throw new Error("Scope changed; old results were discarded.");
        }
        const poll = await request("poll", { jobId });
        if (poll.operations) {
          operations = poll.operations;
          if (page === "operations") renderOperations();
        }
        if (poll.progress && !poll.request)
          $("af-progress-detail").textContent = poll.progress;
        if (poll.state === "error") throw new Error(poll.error);
        if (poll.state === "done") return poll.result;
        if (poll.request) {
          $("af-progress-detail").textContent = String(
            poll.request.payload?.reason ?? "Awaiting host",
          );
          let response: any;
          try {
            response = await win.createBackendReq(
              "requestPrivilegedAction",
              poll.request,
            );
          } catch {
            response = { ok: false, code: "IPC_FAILURE" };
          }
          await request("accept", { jobId, nonce: poll.nonce, response });
        } else await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      throw new Error("View closed; Azure operations were not cancelled.");
    } finally {
      activeJobs.delete(jobId);
      if (active && !activeJobs.size) $("af-progress").hidden = true;
    }
  }
  function scopeDates(value: string) {
    const now =
      settings.mode === "demo" ? new Date("2026-10-19T12:00:00Z") : new Date();
    const to = new Date(now);
    to.setUTCHours(23, 59, 59, 999);
    const from = new Date(to);
    if (value === "mtd") from.setUTCDate(1);
    else from.setUTCDate(from.getUTCDate() - Number(value || 30) + 1);
    from.setUTCHours(0, 0, 0, 0);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  function readScope() {
    return {
      ...scope,
      groupIds: [...scope.groupIds],
      basis: $<HTMLSelectElement>("af-basis").value as Scope["basis"],
    };
  }
  function total(list: Snapshot["costs"]) {
    const map = new Map<string, number>();
    for (const c of list)
      map.set(c.currency, (map.get(c.currency) ?? 0) + c.amount);
    return [...map].map(([currency, amount]) => ({ currency, amount }));
  }
  const showTotal = (rows: { currency: string; amount: number }[]) =>
    rows.length
      ? rows.map((r) => money(r.amount, r.currency)).join(" · ")
      : "Not returned";
  const resourceCosts = (r: Resource, list = snapshot?.costs ?? []) =>
    total(list.filter((c) => c.resourceId && id(c.resourceId) === id(r.id)));
  function age(r: Resource) {
    return r.created.value
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(snapshot!.now) - Date.parse(r.created.value)) /
              86400000,
          ),
        )
      : null;
  }
  const resourceFindings = (r: Resource) =>
    snapshot?.findings.filter((f) => id(f.target.id) === id(r.id)) ?? [];
  function setOptions(
    node: HTMLSelectElement,
    options: [string, string][],
    value: string,
  ) {
    node.replaceChildren();
    for (const [v, t] of options) {
      const o = el("option", t);
      o.value = v;
      node.append(o);
    }
    node.value = value;
  }
  function accountControls() {
    const tenants = [...new Set(accounts.map((a) => a.tenantId))];
    setOptions(
      $("af-tenant"),
      tenants.map((t) => [
        t,
        t === "11111111-1111-1111-1111-111111111111" ? "Contoso" : t,
      ]),
      scope.tenantId,
    );
    setOptions(
      $("af-subscription"),
      accounts
        .filter((a) => a.tenantId === scope.tenantId)
        .map((a) => [a.id, a.name]),
      scope.subscriptionId,
    );
  }
  function viewOptions() {
    setOptions(
      $("af-view"),
      [
        ["", "Current view"],
        ...settings.views
          .filter((v) => v.mode === settings.mode)
          .map((v) => [v.id, v.name] as [string, string]),
      ],
      "",
    );
  }
  function groupLabel() {
    const selected = scope.groupIds.map((groupId) => ({
      name:
        groups.find((g) => id(g.id) === groupId)?.name ??
        groupId.split("/").at(-1) ??
        groupId,
    }));
    $("af-groups-button").textContent = !scope.groupIds.length
      ? "All accessible groups"
      : selected.length <= 2
        ? selected.map((g) => g.name).join(" + ")
        : `${selected.length} groups selected`;
  }
  function drawGroupPicker() {
    const box = $("af-group-list");
    box.replaceChildren();
    const search = $<HTMLInputElement>("af-group-search").value.toLowerCase();
    for (const g of groups.filter((g) =>
      g.name.toLowerCase().includes(search),
    )) {
      const l = el("label"),
        c = el("input");
      c.type = "checkbox";
      c.value = g.id;
      c.checked = pendingAll || pendingGroups.has(id(g.id));
      c.onchange = () => {
        if (pendingAll) {
          pendingGroups = new Set(groups.map((g) => id(g.id)));
          pendingAll = false;
        }
        if (c.checked) pendingGroups.add(id(g.id));
        else pendingGroups.delete(id(g.id));
        drawGroupPicker();
      };
      l.append(c, el("span", g.name));
      box.append(l);
    }
    if (!groups.length)
      box.append(
        el(
          "p",
          groupsReady
            ? "No accessible resource groups."
            : "Resource groups are unavailable.",
          "af-muted",
        ),
      );
    $("af-group-count").textContent = pendingAll
      ? "All accessible groups"
      : `${pendingGroups.size} selected`;
    $<HTMLButtonElement>("af-groups-apply").disabled =
      !groupsReady || (!pendingAll && !pendingGroups.size);
  }
  function closeGroups() {
    $("af-group-popover").hidden = true;
    $("af-groups-button").setAttribute("aria-expanded", "false");
  }
  function connection(account?: Account) {
    $("af-identity").textContent =
      account?.user ??
      (settings.mode === "demo" ? "Demo profile" : "CLI profile not checked");
    $("af-identity").title = account
      ? `Tenant ${account.tenantId} · Subscription ${account.id} · ${account.userType ?? "CLI profile"}. Subscription metadata is not proof of API permissions.`
      : "No current subscription profile has been read.";
    $("af-connection").textContent =
      settings.mode === "demo"
        ? "Demo · no Azure calls"
        : account
          ? "Live · CLI profile · permissions vary"
          : "Live · connection not checked";
  }
  function invalidate() {
    connection();
    generation++;
    detailSequence++;
    serviceSequence++;
    serviceData = undefined;
    servicePending = "";
    snapshot = undefined;
    selection = undefined;
    groupsReady = false;
    disposeCharts();
    $("af-cards").replaceChildren();
    $("af-main").replaceChildren(el("p", "Loading the new scope…", "af-empty"));
    message("Loading the new scope. Previous results have been cleared.");
  }
  async function loadScope() {
    const ticket = generation;
    try {
      let groupIssue = "";
      try {
        const fetched = await run("groups", {}, ticket);
        if (ticket !== generation || !active) return;
        groups = fetched;
        groupsReady = true;
        const prior = scope.groupIds.length;
        scope.groupIds = scope.groupIds.filter((g) =>
          groups.some((v) => id(v.id) === g),
        );
        if (prior !== scope.groupIds.length)
          groupIssue =
            "Unavailable group selections were cleared. Scope now uses " +
            (scope.groupIds.length
              ? `${scope.groupIds.length} valid groups.`
              : "All accessible groups.");
      } catch (error) {
        if (ticket !== generation || !active) return;
        groups = [];
        groupsReady = false;
        groupIssue =
          "Group selection unavailable: " +
          (error instanceof Error ? error.message : "Permission denied") +
          " Existing exact group IDs were retained; other services may still return scoped data.";
      }
      groupLabel();
      const result = await run("snapshot", { scope: readScope() }, ticket);
      if (ticket !== generation || !active) return;
      snapshot = result;
      if (groupIssue) snapshot!.warnings.unshift(groupIssue);
      scope = result.scope;
      const profile =
        settings.mode === "live"
          ? result.cliAccount
          : accounts.find(
              (a) =>
                a.id === scope.subscriptionId && a.tenantId === scope.tenantId,
            );
      connection(profile);
      if (result.cliAccount) {
        accounts = accounts.map((a) =>
          a.id === result.cliAccount.id &&
          a.tenantId === result.cliAccount.tenantId
            ? { ...a, ...result.cliAccount }
            : a,
        );
        accountControls();
      }
      renderData();
    } catch (error) {
      if (ticket === generation && active) {
        connection();
        report(error);
        $("af-main").replaceChildren(
          el(
            "div",
            "Data is unavailable for this scope. Check connection, permissions and the custom capability in Settings, then Refresh.",
            "af-empty",
          ),
        );
      }
    }
  }
  function disposeCharts() {
    for (const chart of charts.splice(0)) chart.dispose();
  }
  async function chart(container: HTMLElement, config: any) {
    try {
      const api = await win.FDOCharts;
      if (!api?.create) {
        container.append(
          el(
            "p",
            "Charts are unavailable in this host; the data summary remains available.",
            "af-muted",
          ),
        );
        return;
      }
      const controller = await api.create(container, config);
      if (!active || generation !== generation || !container.isConnected)
        controller.dispose();
      else charts.push(controller);
    } catch {
      if (container.isConnected)
        container.append(
          el(
            "p",
            "Chart unavailable. See the accompanying data table.",
            "af-muted",
          ),
        );
    }
  }
  function cards() {
    const box = $("af-cards");
    box.replaceChildren();
    if (!snapshot) return;
    const map = new Map<string, { amount: number; currency: string }>();
    for (const f of snapshot.findings)
      if (f.savings != null && f.currency) {
        const k = f.currency + "|" + f.overlapKey;
        if ((map.get(k)?.amount ?? -Infinity) < f.savings)
          map.set(k, { amount: f.savings, currency: f.currency });
      }
    const savings = new Map<string, number>();
    for (const s of map.values())
      savings.set(s.currency, (savings.get(s.currency) ?? 0) + s.amount);
    const rows = [
      [
        "database",
        "Selected-period spend",
        showTotal(total(snapshot.costs)),
        scope.basis === "ActualCost" ? "Actual cost" : "Amortized cost",
      ],
      [
        "calendar",
        "Month-to-date spend",
        showTotal(total(snapshot.mtd)),
        `UTC · through ${snapshot.now.slice(0, 10)}`,
      ],
      [
        "leaf",
        "Potential monthly savings",
        showTotal(
          [...savings].map(([currency, amount]) => ({ currency, amount })),
        ),
        "Estimates · overlaps deduplicated",
      ],
      [
        "server",
        "Resources",
        String(snapshot.resources.length),
        snapshot.coverage.inventory ?? "Coverage unknown",
      ],
      [
        "user",
        "Missing owner",
        String(snapshot.resources.filter((r) => !r.tags.owner).length),
        "Owner tag · distinct from creator",
      ],
    ];
    for (const [icon, label, value, detail] of rows) {
      const card = el("div", "", "af-card"),
        i = el("i", "", "fa-solid fa-" + icon);
      i.setAttribute("aria-hidden", "true");
      const d = el("div");
      d.append(el("small", label), el("strong", value), el("small", detail));
      card.append(i, d);
      box.append(card);
    }
  }
  function renderData() {
    if (!snapshot) return;
    disposeCharts();
    cards();
    $("af-title").textContent = navNames[page];
    $("af-context").textContent =
      `${accounts.find((a) => a.id === scope.subscriptionId)?.name ?? scope.subscriptionId} · ${scope.groupIds.length ? `${scope.groupIds.length} resource groups` : "All accessible groups"} · ${scope.from.slice(0, 10)} → ${scope.to.slice(0, 10)} UTC · ${scope.basis}`;
    $("af-freshness").textContent =
      `Updated ${new Date(snapshot.fetchedAt).toLocaleString()}${Date.now() - Date.parse(snapshot.fetchedAt) > 300000 ? " · STALE" : ""}${snapshot.coverage.billingFreshness ? " · " + snapshot.coverage.billingFreshness : ""}`;
    message(snapshot.warnings.join(" "));
    if (page === "resources") renderResources();
    else if (page === "overview") renderOverview();
    else if (page === "groups") renderGroups();
    else if (page === "databricks" || page === "foundry") renderServices(page);
    else if (page === "optimization") renderFindings();
    else if (page === "changes") renderChanges();
    else if (page === "operations") renderOperations();
    else renderSettings();
    updatePlan();
  }
  function updatePlan() {
    $("af-plan-count").textContent =
      `${settings.plan.filter((a) => a.mode === settings.mode).length} proposed actions · ${settings.mode.toUpperCase()}`;
    $("af-op-count").textContent = String(
      operations.filter(
        (o) =>
          o.action.mode === settings.mode &&
          ["queued", "running"].includes(o.state),
      ).length || "",
    );
    $<HTMLButtonElement>("af-review").disabled =
      executing || !settings.plan.some((a) => a.mode === settings.mode);
  }
  function navigate(next: string) {
    page = next;
    for (const b of root.querySelectorAll<HTMLElement>("[data-page]"))
      b.setAttribute(
        "aria-current",
        b.dataset.page === page ? "page" : "false",
      );
    $("af-title").textContent = navNames[page];
    if (page === "settings") {
      disposeCharts();
      renderSettings();
    } else if (page === "operations") {
      disposeCharts();
      renderOperations();
    } else if (snapshot) renderData();
    else
      $("af-main").replaceChildren(
        el(
          "p",
          "Choose a connected scope and Refresh to load data.",
          "af-empty",
        ),
      );
  }
  function table(headers: string[], rows: (string | HTMLElement)[][]) {
    const wrap = el("div", "", "af-table-wrap"),
      t = el("table"),
      head = el("thead"),
      hr = el("tr");
    for (const h of headers) hr.append(el("th", h));
    head.append(hr);
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      for (const value of row) {
        const td = el("td");
        typeof value === "string" ? (td.textContent = value) : td.append(value);
        tr.append(td);
      }
      body.append(tr);
    }
    t.append(head, body);
    wrap.append(t);
    if (!rows.length)
      wrap.append(
        el(
          "p",
          "No data matches this scope or filter. Missing data is not treated as zero.",
          "af-empty",
        ),
      );
    return wrap;
  }
  function exportTable(columns = currentColumns, rows = currentRows) {
    if (!columns.length) return;
    const cell = (v: unknown) => {
      let text = String(v ?? "");
      if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const csv = [
      columns.map(cell).join(","),
      ...rows.map((row) => columns.map((k) => cell(row[k])).join(",")),
    ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = el("a");
    a.href = url;
    a.download = `azure-finops-${page}-${settings.mode}.csv`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderResources() {
    const host = $("af-main");
    host.replaceChildren();
    const layout = el(
        "div",
        "",
        "af-layout" + (!selection ? " af-no-detail" : ""),
      ),
      panel = el("section", "", "af-panel"),
      header = el("div", "", "af-row af-between");
    header.append(
      el("h2", "Resources"),
      button("Export current table", exportTable),
    );
    panel.append(header);
    const bar = el("div", "", "af-filters"),
      search = el("input");
    search.type = "search";
    search.placeholder = "Search resources by name, type or tag…";
    search.setAttribute("aria-label", "Search resources");
    search.value = filters.search;
    search.oninput = () => {
      filters.search = search.value;
      tablePage = 0;
      drawRows();
    };
    bar.append(search);
    const choices: [string, string, [string, string][]][] = [
      [
        "preset",
        "Quick view",
        [
          ["", "All resources"],
          ["recent", "Recently created"],
          ["high", "High cost"],
          ["owner", "Missing owner"],
          ["disk", "Unattached disks"],
          ["ip", "Unassociated public IPs"],
        ],
      ],
      [
        "type",
        "Type",
        [
          ["", "All types"],
          ...Array.from(new Set(snapshot!.resources.map((r) => r.type))).map(
            (v) => [v, v.split("/").at(-1)!] as [string, string],
          ),
        ],
      ],
      [
        "region",
        "Region",
        [
          ["", "All regions"],
          ...Array.from(
            new Set(snapshot!.resources.map((r) => r.location)),
          ).map((v) => [v, v] as [string, string]),
        ],
      ],
      [
        "age",
        "Age",
        [
          ["", "Any age"],
          ["30", "Created ≤30 days"],
          ["90", "Created ≥90 days"],
          ["unknown", "Unknown creation date"],
        ],
      ],
      [
        "owner",
        "Owner",
        [
          ["", "Any owner"],
          ["missing", "Missing owner"],
          ...Array.from(
            new Set(
              snapshot!.resources.map((r) => r.tags.owner).filter(Boolean),
            ),
          ).map((v) => [v, v] as [string, string]),
        ],
      ],
      [
        "state",
        "State",
        [
          ["", "Any state"],
          ...Array.from(new Set(snapshot!.resources.map((r) => r.state))).map(
            (v) => [v, v] as [string, string],
          ),
        ],
      ],
      [
        "environment",
        "Environment",
        [
          ["", "Any environment"],
          ["missing", "Missing environment"],
          ...Array.from(
            new Set(
              snapshot!.resources
                .map((r) => r.tags.environment)
                .filter(Boolean),
            ),
          ).map((v) => [v, v] as [string, string]),
        ],
      ],
      [
        "finding",
        "Findings",
        [
          ["", "Any finding"],
          ["yes", "Has findings"],
          ["no", "No returned findings"],
        ],
      ],
      [
        "cost",
        "Cost",
        [
          ["", "Any cost"],
          ["high", "≥100 (billing currency)"],
          ["unknown", "Cost not returned"],
        ],
      ],
      [
        "lock",
        "Locks",
        [
          ["", "Any lock state"],
          ["locked", "Has locks"],
          ["unknown", "Lock coverage incomplete"],
        ],
      ],
    ];
    const more = el("details", "", "af-more-filters"),
      extra = el("div", "", "af-extra-filters");
    more.append(el("summary", "More filters & columns"), extra);
    for (const [key, label, values] of choices)
      (["preset", "type", "age", "owner", "finding"].includes(key)
        ? bar
        : extra
      ).append(
        select(label, values, filters[key], (value) => {
          filters[key] = value;
          tablePage = 0;
          drawRows();
        }),
      );
    const tag = el("input");
    tag.placeholder = "Tag key=value";
    tag.setAttribute("aria-label", "Tag filter");
    tag.value = filters.tag;
    tag.oninput = () => {
      filters.tag = tag.value;
      tablePage = 0;
      drawRows();
    };
    extra.append(tag);
    bar.append(
      button("Clear filters", () => {
        filters = Object.fromEntries(Object.keys(filters).map((k) => [k, ""]));
        tablePage = 0;
        renderResources();
      }),
    );
    const columnsPanel = el("details"),
      summary = el("summary", "Columns");
    columnsPanel.append(summary);
    for (const column of [
      "name",
      "type",
      "group",
      "region",
      "cost",
      "change",
      "age",
      "owner",
      "state",
      "findings",
    ]) {
      const label = el("label", column, "af-check"),
        input = el("input");
      input.type = "checkbox";
      input.checked = columns.includes(column);
      input.onchange = () => {
        columns = input.checked
          ? [...columns, column]
          : columns.filter((c) => c !== column);
        if (!columns.length) columns = ["name"];
        drawRows();
      };
      label.prepend(input);
      columnsPanel.append(label);
    }
    extra.append(columnsPanel);
    const wrap = el("div", "", "af-table-wrap");
    wrap.id = "af-resource-table";
    const footer = el("div", "", "af-pagination");
    footer.id = "af-resource-footer";
    panel.append(bar, more, wrap, footer);
    const detail = el("aside", "", "af-panel af-detail");
    detail.id = "af-detail";
    detail.hidden = !selection;
    detail.setAttribute("aria-label", "Resource details");
    const splitter = el("div", "", "af-splitter");
    splitter.tabIndex = 0;
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-label", "Resize resource details");
    splitter.setAttribute("aria-orientation", "vertical");
    splitter.setAttribute("aria-valuemin", "320");
    splitter.setAttribute("aria-valuemax", "720");
    splitter.setAttribute("aria-valuenow", String(detailWidth || 450));
    const resize = (width: number) => {
      const max = Math.max(320, Math.min(720, layout.clientWidth - 430));
      detailWidth = Math.max(320, Math.min(max, width));
      layout.style.setProperty("--af-detail-size", detailWidth + "px");
      splitter.setAttribute("aria-valuenow", String(detailWidth));
      splitter.setAttribute("aria-valuemax", String(max));
    };
    if (detailWidth)
      layout.style.setProperty("--af-detail-size", detailWidth + "px");
    splitter.onkeydown = (event) => {
      const width = detailWidth || detail.getBoundingClientRect().width || 450;
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        resize(
          event.key === "Home"
            ? 320
            : event.key === "End"
              ? 720
              : width +
                (event.key === "ArrowLeft" ? 1 : -1) *
                  (event.shiftKey ? 64 : 16),
        );
      }
    };
    splitter.onpointerdown = (event) => {
      event.preventDefault();
      const start = event.clientX,
        width = detail.getBoundingClientRect().width;
      splitter.setPointerCapture(event.pointerId);
      splitter.onpointermove = (e) => resize(width + start - e.clientX);
      splitter.onpointerup = (e) => {
        splitter.releasePointerCapture(e.pointerId);
        splitter.onpointermove = null;
        splitter.onpointerup = null;
      };
    };
    layout.append(panel, splitter, detail);
    host.append(layout);
    drawRows();
    if (selection) renderDetail();
  }
  function filteredResources() {
    return snapshot!.resources.filter((r) => {
      const text = [r.name, r.type, r.groupId, ...Object.entries(r.tags).flat()]
          .join(" ")
          .toLowerCase(),
        a = age(r),
        c = resourceCosts(r),
        f = resourceFindings(r);
      if (filters.search && !text.includes(filters.search.toLowerCase()))
        return false;
      if (
        (filters.type && r.type !== filters.type) ||
        (filters.region && r.location !== filters.region) ||
        (filters.state && r.state !== filters.state)
      )
        return false;
      if (
        filters.owner &&
        (filters.owner === "missing"
          ? !!r.tags.owner
          : r.tags.owner !== filters.owner)
      )
        return false;
      if (
        filters.environment &&
        (filters.environment === "missing"
          ? !!r.tags.environment
          : r.tags.environment !== filters.environment)
      )
        return false;
      if (
        (filters.age === "unknown" && a !== null) ||
        (filters.age === "30" && (a === null || a > 30)) ||
        (filters.age === "90" && (a === null || a < 90))
      )
        return false;
      if (
        (filters.finding === "yes" && !f.length) ||
        (filters.finding === "no" && f.length)
      )
        return false;
      if (
        (filters.cost === "unknown" && c.length) ||
        (filters.cost === "high" && !c.some((v) => v.amount >= 100))
      )
        return false;
      if (
        (filters.lock === "locked" && !r.locks.length) ||
        (filters.lock === "unknown" && r.lockCoverage)
      )
        return false;
      if (filters.tag) {
        const [key, ...rest] = filters.tag.split("=");
        if (
          !Object.hasOwn(r.tags, key) ||
          (rest.length && r.tags[key] !== rest.join("="))
        )
          return false;
      }
      return !(
        (filters.preset === "recent" && (a === null || a > 30)) ||
        (filters.preset === "high" && !c.some((v) => v.amount >= 100)) ||
        (filters.preset === "owner" && r.tags.owner) ||
        (filters.preset === "disk" &&
          !(
            r.type.toLowerCase() === "microsoft.compute/disks" &&
            r.attached === false
          )) ||
        (filters.preset === "ip" &&
          !(
            r.type.toLowerCase() === "microsoft.network/publicipaddresses" &&
            r.attached === false
          ))
      );
    });
  }
  function rowData(r: Resource) {
    const cost = resourceCosts(r),
      previous = resourceCosts(r, snapshot!.previous),
      a = age(r);
    const delta =
      cost.length === 1 &&
      previous.length === 1 &&
      cost[0].currency === previous[0].currency
        ? money(cost[0].amount - previous[0].amount, cost[0].currency)
        : cost.length &&
            !previous.length &&
            snapshot!.coverage.comparison === "Available"
          ? "Newly billed"
          : "Not comparable";
    return {
      name: r.name,
      type: r.type,
      group: r.groupId.split("/").at(-1) ?? "Unknown",
      region: r.location,
      cost: showTotal(cost),
      change: delta,
      age: a == null ? "Unknown" : `${a}d`,
      owner: r.tags.owner ?? "Missing",
      state: r.state,
      findings: resourceFindings(r)
        .map((f) => f.title)
        .join("; "),
    };
  }
  function drawRows() {
    if (!snapshot || !$("af-resource-table")) return;
    const wrap = $("af-resource-table"),
      scroll = wrap.scrollTop;
    wrap.replaceChildren();
    let rows = filteredResources();
    rows.sort((a, b) => {
      let cmp = 0;
      if (sort === "cost") {
        const ac = resourceCosts(a),
          bc = resourceCosts(b);
        if (!ac.length && bc.length) return 1;
        if (ac.length && !bc.length) return -1;
        if (
          ac.length === 1 &&
          bc.length === 1 &&
          ac[0].currency === bc[0].currency
        )
          cmp = ac[0].amount - bc[0].amount;
        else cmp = showTotal(ac).localeCompare(showTotal(bc));
      } else if (sort === "age") cmp = (age(a) ?? -1) - (age(b) ?? -1);
      else
        cmp = String((rowData(a) as any)[sort]).localeCompare(
          String((rowData(b) as any)[sort]),
        );
      return direction === "asc" ? cmp : -cmp;
    });
    currentRows = rows.map(rowData);
    currentColumns = columns;
    tablePage = Math.min(
      tablePage,
      Math.max(0, Math.ceil(rows.length / 12) - 1),
    );
    const t = el("table"),
      head = el("thead"),
      hr = el("tr");
    for (const c of columns) {
      const th = el("th");
      th.setAttribute(
        "aria-sort",
        sort === c
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : "none",
      );
      th.append(
        button(
          c + (sort === c ? (direction === "asc" ? " ↑" : " ↓") : ""),
          () => {
            if (sort === c) direction = direction === "asc" ? "desc" : "asc";
            else {
              sort = c;
              direction = "desc";
            }
            drawRows();
          },
        ),
      );
      hr.append(th);
    }
    head.append(hr);
    const body = el("tbody");
    for (const r of rows.slice(tablePage * 12, tablePage * 12 + 12)) {
      const tr = el("tr"),
        values = rowData(r);
      tr.tabIndex = 0;
      tr.setAttribute(
        "aria-selected",
        String((selection && id(selection.id) === id(r.id)) || false),
      );
      const open = () => openResource(r);
      tr.onclick = open;
      tr.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      };
      for (const c of columns) {
        const td = el("td");
        if (c === "name") {
          const div = el("div", "", "af-resource-name"),
            i = el(
              "i",
              "",
              "fa-solid fa-" +
                (r.type.toLowerCase().includes("virtualmachines")
                  ? "desktop"
                  : r.type.toLowerCase().endsWith("/disks")
                    ? "database"
                    : "cube"),
            );
          i.setAttribute("aria-hidden", "true");
          div.append(i, el("strong", r.name));
          td.append(
            div,
            el("small", r.type.split("/").at(-1) + " · " + values.group),
          );
        } else if (c === "findings") {
          const fs = resourceFindings(r);
          td.append(
            fs.length
              ? badge(fs[0].title, "af-warning")
              : el("span", "None returned"),
          );
        } else td.textContent = String((values as any)[c]);
        tr.append(td);
      }
      body.append(tr);
    }
    t.append(head, body);
    wrap.append(t);
    if (!rows.length)
      wrap.append(
        el(
          "p",
          "No resources match. Clear filters or choose another scope.",
          "af-empty",
        ),
      );
    wrap.scrollTop = scroll;
    const footer = $("af-resource-footer");
    footer.replaceChildren(
      el("small", `${rows.length} resources · costs may lag inventory`),
      button("←", () => {
        tablePage--;
        drawRows();
      }),
      el(
        "span",
        `${tablePage + 1} / ${Math.max(1, Math.ceil(rows.length / 12))}`,
      ),
      button("→", () => {
        tablePage++;
        drawRows();
      }),
    );
    (footer.children[1] as HTMLButtonElement).disabled = tablePage === 0;
    (footer.children[3] as HTMLButtonElement).disabled =
      (tablePage + 1) * 12 >= rows.length;
  }
  async function openResource(resource: Resource) {
    selection = structuredClone(resource);
    detailTab = "origin";
    const seq = ++detailSequence,
      ticket = generation;
    const layout = root.querySelector(".af-layout");
    layout?.classList.remove("af-no-detail");
    $("af-detail").hidden = false;
    renderDetail(true);
    drawRows();
    try {
      const detailed = await run("detail", { target: resource }, ticket);
      if (ticket !== generation || seq !== detailSequence || !active) return;
      if (!detailed) {
        report(
          new Error(
            "Resource no longer exists or is inaccessible. Refresh inventory.",
          ),
        );
        return;
      }
      selection = detailed;
      renderDetail();
    } catch (error) {
      if (ticket === generation && seq === detailSequence) {
        report(error);
        renderDetail();
      }
    }
  }
  function evidence(label: string, e: any) {
    const d = el("div", "", "af-row");
    d.append(
      el("span", `${label}: ${e.value ?? "Unknown"}`),
      badge(
        e.confidence,
        e.confidence === "Verified"
          ? "af-success"
          : e.confidence === "Inferred"
            ? "af-warning"
            : "",
      ),
      el("small", e.source + (e.explanation ? " · " + e.explanation : "")),
    );
    return d;
  }
  function renderDetail(loading = false) {
    const panel = $("af-detail");
    if (!panel || !selection) return;
    const r = selection;
    panel.replaceChildren();
    const header = el("div", "", "af-row af-between");
    header.append(
      el("h3", r.name),
      button("×", () => {
        selection = undefined;
        detailSequence++;
        panel.hidden = true;
        root.querySelector(".af-layout")?.classList.add("af-no-detail");
        drawRows();
      }),
    );
    panel.append(
      header,
      el("small", `${r.groupId.split("/").at(-1)} · ${r.location}`),
      badge(r.state, /running/i.test(r.state) ? "af-success" : ""),
    );
    const tabs = el("div", "", "af-detail-tabs");
    tabs.setAttribute("role", "tablist");
    for (const [v, t] of [
      ["summary", "Summary"],
      ["origin", "Origin"],
      ["metrics", "Metrics"],
      ["dependencies", "Dependencies"],
      ["actions", "Actions"],
    ]) {
      const b = button(t, () => {
        detailTab = v;
        renderDetail();
      });
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(detailTab === v));
      b.tabIndex = detailTab === v ? 0 : -1;
      b.dataset.detailTab = v;
      tabs.append(b);
    }
    tabs.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      const buttons = [
          ...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        ],
        current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (current +
                (event.key === "ArrowRight" ? 1 : -1) +
                buttons.length) %
              buttons.length;
      detailTab = buttons[next].dataset.detailTab!;
      renderDetail();
      panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    };
    panel.append(tabs);
    if (loading)
      panel.append(
        el(
          "p",
          "Loading provider evidence, inherited locks and retained history…",
          "af-muted",
        ),
      );
    const body = el("div", "", "af-stack");
    if (detailTab === "summary") {
      const dl = el("dl");
      for (const [k, v] of [
        ["Resource ID", r.id],
        ["Tenant", r.tenantId],
        ["Subscription", r.subscriptionId],
        ["SKU", r.sku ?? "Unknown"],
        ["State", r.state],
        ["Selected-period cost", showTotal(resourceCosts(r))],
      ])
        dl.append(el("dt", k), el("dd", v));
      const a = el("a", "Open in Azure Portal ↗");
      a.href = `https://portal.azure.com/#@${encodeURIComponent(r.tenantId)}/resource${r.id.split("/").map(encodeURIComponent).join("/")}/overview`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      body.append(dl, a, el("pre", JSON.stringify(r.tags, null, 2)));
    }
    if (detailTab === "origin") {
      const a = age(r);
      body.append(
        el("h3", "Origin & ownership"),
        evidence("Created at", r.created),
        el(
          "small",
          a == null
            ? "Resource age is unknown."
            : `${a} days old as of ${snapshot!.now}`,
        ),
        evidence(
          "Last control-plane modification",
          r.modified ?? {
            value: null,
            confidence: "Unknown",
            source: "Metadata not exposed; missing history is not inactivity",
          },
        ),
        el(
          "p",
          r.activityCoverage
            ? `${r.activityCoverage.events} retained control-plane events (${r.activityCoverage.writes} write/delete/action events), ${r.activityCoverage.from} → ${r.activityCoverage.to}; ${r.activityCoverage.complete ? "below the result cap; permissions and retention still limit coverage" : "result cap reached; partial history"}. This is not workload interaction history.`
            : "Control-plane history coverage is unknown. No claim of lifetime inactivity can be made.",
        ),
        el(
          "p",
          a != null && a >= 180
            ? "Long-lived resource: review ownership, workload usage and dependencies. No observed modifications does not establish safe deletion; data-plane requests, jobs and external users may never modify ARM metadata."
            : "Creation/modification metadata and workload interactions are independent signals.",
        ),
        evidence("Created by", r.creator),
        evidence("Provisioned with", r.provisioning),
        el(
          "p",
          `Current owner: ${r.tags.owner ?? "Missing owner tag"} · creator and owner may differ.`,
        ),
        el(
          "small",
          `First observed: ${r.firstObserved}. This is not a creation date.`,
        ),
        el("h3", "Timeline"),
      );
      if (r.creatorName)
        body.append(
          el(
            "p",
            `Creator display name: ${r.creatorName.value ?? "Unknown"} · ${r.creatorName.confidence} · ${r.creatorName.source}`,
          ),
        );
      const timeline = el("ol", "", "af-timeline");
      for (const event of [...r.events].sort((a, b) =>
        String(b.at).localeCompare(String(a.at)),
      ))
        timeline.append(
          el("li", `${event.at} · ${event.title} · ${event.source}`),
        );
      if (!r.events.length)
        timeline.append(el("li", "No retained evidence returned."));
      body.append(timeline, el("small", r.historyCoverage));
    }
    if (detailTab === "metrics") {
      const m = r.metrics;
      body.append(
        el("h3", "Utilization & coverage"),
        el(
          "p",
          m?.cpu != null
            ? `Average CPU ${m.cpu.toFixed(1)}%`
            : "CPU metrics unavailable; missing values are not zero.",
        ),
        el(
          "small",
          m
            ? `${m.from} → ${m.to}; ${m.samples}/${m.expected} expected hourly samples.`
            : "No metric observation window was returned.",
        ),
        el(
          "p",
          "CPU, free memory and network traffic inform investigation; business demand and peak requirements still need operator review.",
        ),
        table(
          ["Signal", "Observed value", "Coverage", "Window & basis"],
          (r.signals ?? []).map((m) => [
            m.name,
            m.value == null
              ? "Unknown"
              : `${m.value.toLocaleString()} ${m.unit}`,
            `${m.samples}/${m.expected} hourly samples`,
            `${m.from} → ${m.to} · ${m.explanation}`,
          ]),
        ),
      );
    }
    if (detailTab === "dependencies") {
      body.append(
        el("h3", "Known related resources"),
        ...r.dependencies.map((d) => el("p", `${d.relation}: ${d.id}`)),
        el("h3", "Checks performed"),
        ...(r.dependencyCoverage ?? []).map((c) => el("p", c)),
        el("h3", "Discovery gaps"),
        ...r.gaps.map((g) => el("p", g, "af-muted")),
        el(
          "small",
          r.lockCoverage
            ? `Lock checks complete: ${r.locks.join(", ") || "no locks returned"}`
            : "Lock discovery incomplete; actions remain blocked.",
        ),
      );
      for (const dep of r.dependencies) {
        const costs = total(
          snapshot!.costs.filter(
            (c) => c.resourceId && id(c.resourceId) === id(dep.id),
          ),
        );
        body.append(
          el(
            "small",
            `${dep.relation} selected-period charges: ${showTotal(costs)}`,
          ),
        );
      }
    }
    if (detailTab === "actions")
      body.append(
        el(
          "p",
          "Propose an action below. Nothing executes until the plan is reviewed and explicitly confirmed.",
        ),
        el(
          "p",
          "Every resource mutation is dangerous. Buttons below only add proposals; execution requires review, typed target names and acknowledgement. Resize requires a deallocated VM, validated same-family hardware contracts and quota headroom.",
          "af-muted",
        ),
      );
    const actions = el("div", "", "af-row");
    if (r.type.split("/").length === 2)
      actions.append(
        button("Edit tags", () => {
          detailTab = "actions";
          renderDetail();
          tagForm();
        }),
      );
    if (r.type.toLowerCase() === "microsoft.compute/virtualmachines") {
      for (const [kind, label] of [
        ["start", "Start"],
        ["restart", "Restart"],
        ["stop", "Power off"],
        ["deallocate", "Deallocate"],
      ])
        actions.append(
          button(`Propose ${label.toLowerCase()}…`, () => addAction(kind, r)),
        );
    }
    if (
      detailTab === "actions" &&
      r.type.toLowerCase() === "microsoft.compute/virtualmachines"
    ) {
      const target = structuredClone(r);
      body.append(
        el("h3", "Resize preflight"),
        ...(r.resize?.errors ?? ["Compatibility data unavailable"]).map((e) =>
          el("p", e, "af-callout"),
        ),
      );
      if (r.resize?.options.length) {
        let chosen = r.resize.options[0].name;
        body.append(
          select(
            "Target VM size",
            r.resize.options.map((o) => [
              o.name,
              `${o.name} · ${o.cores} vCPU · ${o.memoryGB} GiB`,
            ]),
            chosen,
            (v) => {
              chosen = v;
            },
          ),
          button("Propose resize…", () =>
            addAction("resize", target, undefined, chosen),
          ),
          el(
            "small",
            `Preflight ${r.resize.checkedAt}. Capacity is not reserved; starting the resized VM is a separate dangerous action.`,
          ),
        );
      }
    }
    if (
      [
        "microsoft.compute/virtualmachines",
        "microsoft.compute/disks",
        "microsoft.network/publicipaddresses",
      ].includes(r.type.toLowerCase())
    )
      actions.append(
        button("Propose deletion…", () => addAction("delete", r), "af-danger"),
      );
    body.append(
      actions,
      el(
        "small",
        "Proposed actions retain this exact tenant, subscription and resource ID. Review dependencies before execution.",
      ),
    );
    panel.append(body);
  }
  function tagForm() {
    const panel = $("af-detail"),
      area = el("textarea"),
      label = el("label", "Tags to merge (one key=value per line)");
    area.rows = 5;
    area.value = Object.entries(selection!.tags)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    label.append(area);
    const target = structuredClone(selection!);
    panel.append(
      label,
      button("Add tag update to plan", () => {
        const tags: Record<string, string> = {};
        for (const line of area.value.split("\n").filter(Boolean)) {
          const index = line.indexOf("=");
          if (index < 1) throw new Error("Use key=value for every tag.");
          tags[line.slice(0, index)] = line.slice(index + 1);
        }
        return addAction("tags", target, tags);
      }),
    );
    area.focus();
  }
  async function addAction(
    kind: string,
    target: Target,
    tags?: Record<string, string>,
    size?: string,
  ) {
    const action = await request("addAction", {
      mode: settings.mode,
      kind,
      target,
      tags,
      size,
    });
    settings.plan.push(action);
    updatePlan();
    message(
      `${target.name}: ${kind} added to the ${settings.mode.toUpperCase()} plan. No Azure operation was executed.`,
    );
  }
  function renderOverview() {
    const host = $("af-main");
    host.replaceChildren();
    const grid = el("div", "", "af-grid"),
      trend = el("section", "", "af-panel"),
      breakdown = el("section", "", "af-panel");
    trend.append(
      el("h2", "Daily cost trend"),
      el("small", `${scope.basis} · UTC · currencies are charted separately`),
    );
    for (const currency of new Set(snapshot!.costs.map((c) => c.currency))) {
      const rows = new Map<string, number>();
      for (const c of snapshot!.costs.filter((c) => c.currency === currency))
        rows.set(c.day, (rows.get(c.day) ?? 0) + c.amount);
      const container = el("div", "", "af-chart");
      trend.append(el("h3", currency), container);
      void chart(container, {
        type: "area",
        xKey: "day",
        series: [{ key: "cost", label: `Cost (${currency})` }],
        data: [...rows].map(([day, cost]) => ({ day: day.slice(5), cost })),
        label: `Daily ${scope.basis} in ${currency}`,
        height: 250,
      });
      const dataTable = el("details");
      dataTable.append(el("summary", `Daily data · ${rows.size} rows`));
      dataTable.append(
        table(
          ["Day", currency],
          [...rows].map(([day, cost]) => [day, money(cost, currency)]),
        ),
      );
      trend.append(dataTable);
    }
    if (!snapshot!.costs.length)
      trend.append(
        el("p", "Cost data unavailable or no rows returned.", "af-empty"),
      );
    breakdown.append(el("h2", "Spending breakdown"));
    const by = select(
      "Break down by",
      [
        ["group", "Resource group"],
        ["service", "Service"],
        ["region", "Region"],
        ["owner", "Owner tag"],
      ],
      "group",
      (value) => drawBreakdown(value),
    );
    const list = el("div");
    breakdown.append(by, list);
    function drawBreakdown(dimension: string) {
      list.replaceChildren();
      const values = new Map<
        string,
        { name: string; currency: string; amount: number }
      >();
      if (snapshot!.breakdowns?.[dimension]) {
        for (const row of snapshot!.breakdowns[dimension])
          values.set(row.currency + "|" + row.name, row);
      } else
        for (const c of snapshot!.costs) {
          const name =
            dimension === "group"
              ? (c.groupId?.split("/").at(-1) ?? "Unmatched group")
              : dimension === "service"
                ? c.service
                : dimension === "region"
                  ? c.region
                  : (c.tags.owner ?? "Tag not returned");
          const key = c.currency + "|" + name;
          const row = values.get(key) ?? {
            name,
            currency: c.currency,
            amount: 0,
          };
          row.amount += c.amount;
          values.set(key, row);
        }
      list.append(
        table(
          ["Dimension", "Selected-period cost"],
          [...values.values()]
            .sort(
              (a, b) =>
                a.currency.localeCompare(b.currency) || b.amount - a.amount,
            )
            .map((v) => [v.name, money(v.amount, v.currency)]),
        ),
      );
    }
    drawBreakdown("group");
    grid.append(trend, breakdown);
    host.append(grid);
    const extra = el("section", "", "af-panel af-stack");
    extra.append(
      el("h2", "Forecast, budgets & data coverage"),
      el(
        "p",
        snapshot!.forecast.length
          ? snapshot!.forecast
              .map((f) => `${money(f.amount, f.currency)} · ${f.basis}`)
              .join(" · ")
          : "Forecast unavailable. No projection has been substituted for an Azure forecast.",
      ),
    );
    extra.append(
      table(
        ["Budget", "Actual scope", "Period", "Amount", "Current spend"],
        snapshot!.budgets.map((b) => [
          b.name,
          b.scopeId,
          b.period,
          b.currency
            ? money(b.amount, b.currency)
            : `${b.amount} (currency unavailable)`,
          b.currency ? money(b.spent, b.currency) : "Unknown",
        ]),
      ),
    );
    for (const [key, value] of Object.entries(snapshot!.coverage))
      extra.append(el("small", `${key}: ${value}`));
    host.append(
      extra,
      button("Why did spending increase? →", () => navigate("changes")),
    );
  }
  function renderGroups() {
    const host = $("af-main");
    host.replaceChildren();
    const panel = el("section", "", "af-panel af-stack"),
      search = el("input");
    search.placeholder = "Search resource groups";
    search.setAttribute("aria-label", "Search resource groups");
    const results = el("div");
    const draw = () => {
      results.replaceChildren();
      const rows = snapshot!.groups.filter(
        (g) =>
          (!scope.groupIds.length || scope.groupIds.includes(id(g.id))) &&
          g.name.toLowerCase().includes(search.value.toLowerCase()),
      );
      results.append(
        table(
          [
            "Name",
            "Subscription",
            "Region",
            "Resources",
            "Spend",
            "Change",
            "Owner",
            "Budgets",
            "Findings",
            "Locks",
            "Explore",
          ],
          rows.map((g) => {
            const resources = snapshot!.resources.filter(
                (r) => id(r.groupId) === id(g.id),
              ),
              costs = total(
                snapshot!.costs.filter(
                  (c) => c.groupId && id(c.groupId) === id(g.id),
                ),
              ),
              previous = total(
                snapshot!.previous.filter(
                  (c) => c.groupId && id(c.groupId) === id(g.id),
                ),
              );
            const name = button(g.name, () => {
              const detail = el("section", "", "af-panel af-stack");
              detail.append(
                el("h3", g.name),
                evidence("Group created at", g.created),
                el(
                  "p",
                  "This date applies only to the group; resource ages come from each resource’s own evidence.",
                ),
                el("pre", JSON.stringify(g.tags, null, 2)),
                table(
                  ["Resource", "State"],
                  resources.map((r) => [r.name, r.state]),
                ),
                ...snapshot!.findings
                  .filter((f) => id(f.target.groupId) === id(g.id))
                  .map((f) => el("p", f.title + " · " + f.evidence)),
                button("Explore resources", () => exploreGroup(g)),
              );
              results.append(detail);
              const charges = snapshot!.costs.filter(
                (c) => c.groupId && id(c.groupId) === id(g.id),
              );
              for (const currency of new Set(charges.map((c) => c.currency))) {
                const days = new Map<string, number>(),
                  services = new Map<string, number>();
                for (const charge of charges.filter(
                  (c) => c.currency === currency,
                )) {
                  days.set(
                    charge.day,
                    (days.get(charge.day) ?? 0) + charge.amount,
                  );
                  services.set(
                    charge.service,
                    (services.get(charge.service) ?? 0) + charge.amount,
                  );
                }
                const container = el("div", "", "af-chart");
                detail.append(
                  el("h3", `Group cost trend · ${currency}`),
                  container,
                );
                void chart(container, {
                  type: "line",
                  xKey: "day",
                  data: [...days].map(([day, cost]) => ({
                    day: day.slice(5),
                    cost,
                  })),
                  series: [{ key: "cost", label: currency }],
                  height: 220,
                  label: `${g.name} daily costs (${currency})`,
                });
                detail.append(
                  table(
                    ["Service", currency],
                    [...services].map(([service, amount]) => [
                      service,
                      money(amount, currency),
                    ]),
                  ),
                );
              }
              detail.append(
                el("h3", "Available resource activity"),
                ...resources.flatMap((r) =>
                  r.events.map((e) =>
                    el(
                      "small",
                      `${r.name} · ${e.at} · ${e.title} · ${e.source}`,
                    ),
                  ),
                ),
                el(
                  "small",
                  "Group-wide activity may be broader than the returned resource history. Open individual resources for retained Monitor evidence.",
                ),
              );
            });
            return [
              name,
              g.subscriptionId,
              g.location,
              String(resources.length),
              showTotal(costs),
              costs.length === 1 &&
              previous.length === 1 &&
              costs[0].currency === previous[0].currency
                ? money(costs[0].amount - previous[0].amount, costs[0].currency)
                : "Not comparable",
              g.tags.owner ?? "Missing",
              snapshot!.budgets
                .filter((b) => id(b.scopeId) === id(g.id))
                .map((b) => b.name)
                .join(", ") || "None returned",
              String(
                snapshot!.findings.filter(
                  (f) => id(f.target.groupId) === id(g.id),
                ).length,
              ),
              g.locks.join(", ") || "Check details",
              button("Explore resources", () => exploreGroup(g)),
            ];
          }),
        ),
      );
    };
    search.oninput = draw;
    panel.append(el("h2", "Resource group comparison"), search, results);
    host.append(panel);
    draw();
  }
  async function exploreGroup(g: Group) {
    scope.groupIds = [id(g.id)];
    invalidate();
    navigate("resources");
    await loadScope();
  }
  function serviceFamily(r: Resource): "databricks" | "foundry" | null {
    const type = r.type.toLowerCase();
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
  function armLink(resourceId: string, text = "Open Azure resource ↗") {
    const link = el("a", text);
    link.href = `https://portal.azure.com/#@${encodeURIComponent(scope.tenantId)}/resource${resourceId.split("/").map(encodeURIComponent).join("/")}/overview`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }
  function serviceAssetTable(s: ServiceInspection) {
    const wrap = el("div", "", "af-service-inventory af-stack"),
      search = el("input"),
      list = el("div"),
      footer = el("div", "", "af-row");
    search.type = "search";
    search.placeholder = "Search service assets, IDs and configuration…";
    search.setAttribute("aria-label", "Search service inventory");
    let index = 0,
      query = "",
      category = "";
    const rows = () =>
      s.assets.filter(
        (a) =>
          (!category || a.category === category) &&
          `${a.id} ${a.name} ${a.category} ${a.configuration}`
            .toLowerCase()
            .includes(query),
      );
    const draw = () => {
      const filtered = rows();
      index = Math.min(index, Math.max(0, Math.ceil(filtered.length / 25) - 1));
      list.replaceChildren(
        table(
          [
            "Name",
            "Category",
            "State",
            "Configuration / evidence",
            "Lifecycle evidence",
            "Source",
            "Open",
          ],
          filtered.slice(index * 25, index * 25 + 25).map((a) => {
            const life = el("details");
            life.append(
              el(
                "summary",
                `Created ${a.created?.value?.slice(0, 10) ?? "Unknown"} · Modified ${a.modified?.value?.slice(0, 10) ?? "Unknown"}`,
              ),
              el(
                "p",
                `${a.created?.confidence ?? "Unknown"}: ${a.created?.source ?? "No creation evidence"}`,
              ),
              el(
                "p",
                `${a.modified?.confidence ?? "Unknown"}: ${a.modified?.source ?? "No last-modified evidence"}`,
              ),
              el(
                "small",
                "Control-plane metadata is separate from workload interactions.",
              ),
            );
            const link = a.armId
              ? armLink(a.armId)
              : a.url
                ? (() => {
                    const link = el("a", "Open Databricks ↗");
                    link.href = a.url!;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    return link;
                  })()
                : "Workspace controls";
            return [
              a.name,
              a.category,
              a.state,
              a.configuration,
              life,
              a.source,
              link,
            ];
          }),
        ),
      );
      const previous = button("Previous assets", () => {
          index--;
          draw();
        }),
        next = button("Next assets", () => {
          index++;
          draw();
        });
      previous.disabled = index === 0;
      next.disabled = (index + 1) * 25 >= filtered.length;
      footer.replaceChildren(
        previous,
        el(
          "span",
          `${filtered.length ? index * 25 + 1 : 0}–${Math.min(index * 25 + 25, filtered.length)} of ${filtered.length} assets`,
        ),
        next,
      );
    };
    search.oninput = () => {
      query = search.value.toLowerCase();
      index = 0;
      draw();
    };
    wrap.append(
      search,
      select(
        "Asset category",
        [
          ["", "All categories"],
          ...[...new Set(s.assets.map((a) => a.category))]
            .sort()
            .map((c) => [c, c] as [string, string]),
        ],
        category,
        (value) => {
          category = value;
          index = 0;
          draw();
        },
      ),
      button("Export filtered service inventory CSV", () =>
        exportTable(
          [
            "ID",
            "Name",
            "Category",
            "State",
            "Created",
            "Modified",
            "Configuration",
            "Source",
          ],
          rows().map((a) => ({
            ID: a.id,
            Name: a.name,
            Category: a.category,
            State: a.state,
            Created: a.created?.value ?? "Unknown",
            Modified: a.modified?.value ?? "Unknown",
            Configuration: a.configuration,
            Source: a.source,
          })),
        ),
      ),
      list,
      footer,
    );
    draw();
    return wrap;
  }
  function renderServices(kind: "databricks" | "foundry") {
    const host = $("af-main");
    host.replaceChildren();
    const panel = el("section", "", "af-panel af-stack"),
      search = el("input");
    search.type = "search";
    search.placeholder = "Search scoped workspaces, accounts and projects…";
    search.setAttribute("aria-label", `Search ${kind} resources`);
    panel.append(
      el(
        "h2",
        kind === "databricks"
          ? "Databricks cost & cleanup inspection"
          : "Foundry, OpenAI & Azure ML cost inspection",
      ),
      el(
        "p",
        kind === "databricks"
          ? "Inspect workspace compute controls, jobs and managed infrastructure. Workspace DBU charges and managed-group infrastructure are separate cost layers. Managed infrastructure must be cleaned up through Databricks."
          : "Inspect modern Foundry accounts/projects, Azure OpenAI accounts and classic Azure ML hubs/workspaces. Resource kind is shown; shared account charges are not invented as per-project or per-deployment totals.",
        "af-callout",
      ),
      search,
    );
    const list = el("div");
    panel.append(list);
    host.append(panel);
    const draw = () => {
      const rows = snapshot!.resources.filter(
        (r) =>
          serviceFamily(r) === kind &&
          `${r.name} ${r.type} ${r.kind ?? ""}`
            .toLowerCase()
            .includes(search.value.toLowerCase()),
      );
      list.replaceChildren(
        table(
          [
            "Resource",
            "Type / kind",
            "Group",
            "Selected-period direct charges",
            "Owner",
            "Inspect",
          ],
          rows.map((r) => [
            r.name,
            `${r.type} · ${r.kind ?? "Kind unknown"}`,
            r.groupId.split("/").at(-1)!,
            showTotal(resourceCosts(r)),
            r.tags.owner ?? "Missing",
            button("Inspect service", async () => {
              const ticket = generation,
                seq = ++serviceSequence;
              serviceData = undefined;
              servicePending = r.id;
              renderServices(kind);
              message(
                `Inspecting ${r.name}: metadata, usage coverage and cleanup candidates…`,
              );
              try {
                const result = await run("service", { target: r }, ticket);
                if (ticket !== generation || seq !== serviceSequence) return;
                serviceData = result;
                servicePending = "";
                if (page === kind) renderServices(kind);
                message(
                  "Inspection complete. Review coverage, dependencies and workload ownership before cleanup.",
                );
              } catch (e) {
                if (ticket === generation && seq === serviceSequence) {
                  servicePending = "";
                  if (page === kind) renderServices(kind);
                  report(e);
                }
              }
            }),
          ]),
        ),
      );
      if (!rows.length)
        list.append(
          el(
            "p",
            "No matching service resources returned in this scope. Check inventory coverage before concluding none exist.",
            "af-empty",
          ),
        );
    };
    search.oninput = draw;
    draw();
    if (servicePending)
      host.append(
        el(
          "p",
          `Loading service inspection for ${servicePending}…`,
          "af-callout",
        ),
      );
    const s = serviceData;
    if (!s || s.kind !== kind) return;
    const detail = el("section", "", "af-panel af-stack af-service-detail");
    detail.append(
      el("h2", s.target.name),
      el(
        "code",
        `Tenant ${s.target.tenantId} · Subscription ${s.target.subscriptionId} · ${s.target.id}`,
      ),
      el(
        "small",
        `${s.from} → ${s.to} · ${s.basis} · observed ${s.observedAt} · ${settings.mode.toUpperCase()}`,
      ),
      table(
        ["Fact", "Value", "Source"],
        s.facts.map((f) => [f.name, f.value, f.source]),
      ),
      el("h3", "Coverage & permissions"),
      table(
        ["Surface", "Coverage", "Explanation"],
        s.coverage.map((c) => [
          c.name,
          badge(c.state, c.state === "Available" ? "af-success" : "af-warning"),
          c.explanation,
        ]),
      ),
      el("h3", "Visible service inventory"),
      serviceAssetTable(s),
      el("h3", "Usage signals & observation windows"),
      table(
        [
          "Exact asset",
          "Metric",
          "Observed value",
          "Sample coverage",
          "Window / basis",
        ],
        s.signals.map((m) => [
          m.assetId ?? "Account-level only",
          m.metric,
          m.value == null ? "Unknown" : `${m.value.toLocaleString()} ${m.unit}`,
          `${m.samples}/${m.expected}`,
          `${m.from} → ${m.to} · ${m.source}`,
        ]),
      ),
      el("h3", "Cleanup review candidates"),
    );
    if (!s.candidates.length)
      detail.append(
        el(
          "p",
          "No candidates returned. Check usage and discovery coverage; absence does not prove no optimization opportunities.",
        ),
      );
    const candidates = el("div", "", "af-stack"),
      candidatePages = el("div", "", "af-row");
    let candidatePage = 0;
    const drawCandidates = () => {
      candidates.replaceChildren();
      for (const c of s.candidates.slice(
        candidatePage * 25,
        candidatePage * 25 + 25,
      )) {
        const card = el("article", "", "af-panel af-stack");
        card.append(
          el("h4", c.title),
          el("code", c.assetId),
          badge(c.confidence),
          el("p", c.evidence),
          el("small", `Missing signals: ${c.missing.join(" · ")}`),
          el("p", c.suggested),
          el(
            "small",
            "Savings not estimated. This is a review candidate, not permission or evidence that deletion is safe.",
          ),
        );
        candidates.append(card);
      }
      const previous = button("Previous candidates", () => {
          candidatePage--;
          drawCandidates();
        }),
        next = button("Next candidates", () => {
          candidatePage++;
          drawCandidates();
        });
      previous.disabled = candidatePage === 0;
      next.disabled = (candidatePage + 1) * 25 >= s.candidates.length;
      candidatePages.replaceChildren(
        previous,
        el(
          "span",
          `${s.candidates.length ? candidatePage * 25 + 1 : 0}–${Math.min(candidatePage * 25 + 25, s.candidates.length)} of ${s.candidates.length} candidates`,
        ),
        next,
      );
    };
    drawCandidates();
    detail.append(candidates, candidatePages);
    const charges = snapshot!.costs.filter(
      (c) =>
        c.resourceId &&
        (id(c.resourceId) === id(s.target.id) ||
          id(c.resourceId).startsWith(id(s.target.id) + "/")),
    );
    detail.append(
      el("h3", "Direct account/workspace & child charges in global scope"),
      el("p", showTotal(total(charges))),
      el(
        "small",
        "Only returned exact resource IDs and descendants are included. Shared charges are not allocated to every child. Historical/unmatched charges remain in Cost changes.",
      ),
    );
    for (const related of s.relatedCosts) {
      detail.append(
        el("h3", `Related billing scope: ${related.scopeId}`),
        el("p", related.explanation, "af-callout"),
        el("p", showTotal(total(related.costs))),
        table(
          [
            "Charged resource ID",
            "Service",
            "Currency",
            "Selected-period spending",
          ],
          (() => {
            const sums = new Map<
              string,
              { id: string; service: string; currency: string; amount: number }
            >();
            for (const c of related.costs) {
              const key = `${c.resourceId}|${c.service}|${c.currency}`,
                row = sums.get(key) ?? {
                  id: c.resourceId ?? "Unmatched charge",
                  service: c.service,
                  currency: c.currency,
                  amount: 0,
                };
              row.amount += c.amount;
              sums.set(key, row);
            }
            return [...sums.values()].map((c) => [
              c.id,
              c.service,
              c.currency,
              money(c.amount, c.currency),
            ]);
          })(),
        ),
      );
    }
    detail.append(
      el("h3", "Limits & remaining costs"),
      ...s.limitations.map((t) => el("p", t, "af-muted")),
      armLink(s.target.id, "Open owning Azure resource ↗"),
      button("Inspect origin, dependencies & reviewed actions", () => {
        const r = snapshot!.resources.find((r) => id(r.id) === id(s.target.id));
        if (r) {
          navigate("resources");
          void openResource(r);
        }
      }),
      el(
        "p",
        "Service-specific cleanup is currently a handoff to Databricks/Foundry controls. No service deletion, job termination or model capacity change runs from this inspection. Existing supported resource mutations still require the dangerous-action plan.",
        "af-callout",
      ),
    );
    host.append(detail);
  }
  function renderFindings() {
    const host = $("af-main");
    host.replaceChildren();
    const panel = el("section", "", "af-panel af-stack");
    panel.append(
      el("h2", "Optimization opportunities"),
      button("Scan VM utilization", async () => {
        const ticket = generation;
        message(
          "Scanning scoped VMs for CPU, available memory and network volume. Missing metrics stay unknown; stopping local loading does not cancel Azure queries.",
        );
        const result = await run("scan", {}, ticket);
        if (ticket !== generation) return;
        snapshot = result;
        if (selection)
          selection =
            snapshot!.resources.find((r) => id(r.id) === id(selection!.id)) ??
            selection;
        renderData();
        message(
          "VM scan complete. Inspect per-signal coverage before interpreting findings.",
        );
      }),
      el(
        "p",
        "Findings are review candidates. Age, low CPU and unattached state do not establish that deletion is safe. Estimates are projected and are not observed savings.",
        "af-callout",
      ),
    );
    for (const f of snapshot!.findings) {
      const card = el("article", "", "af-panel af-stack");
      card.append(
        el("div", `${f.title} · ${f.target.name}`),
        badge(f.source),
        el("p", f.evidence),
        el("small", `Window: ${f.window} · confidence: ${f.confidence}`),
        el(
          "p",
          `Monthly estimate: ${f.currency ? money(f.savings, f.currency) : "Not estimated"} · ${f.basis}`,
        ),
        el(
          "small",
          `Missing signals: ${f.missing.join(" · ") || "None listed by this rule."}`,
        ),
        el("p", f.suggested),
        button("Inspect exact resource", () => {
          navigate("resources");
          const r = snapshot!.resources.find(
            (r) => id(r.id) === id(f.target.id),
          );
          if (r) void openResource(r);
        }),
      );
      panel.append(card);
    }
    if (!snapshot!.findings.length)
      panel.append(
        el(
          "p",
          "No findings returned. Check coverage before concluding resources are optimized.",
          "af-empty",
        ),
      );
    host.append(panel);
  }
  function costChanges() {
    const rows = new Map<string, any>();
    for (const [list, field] of [
      [snapshot!.costs, "current"],
      [snapshot!.previous, "previous"],
    ] as const)
      for (const c of list) {
        const key = `${c.currency}|${id(c.resourceId ?? "")}|${c.service}`;
        const row = rows.get(key) ?? {
          resourceId: c.resourceId,
          name: c.resourceId?.split("/").at(-1) ?? "Unmatched charge",
          service: c.service,
          currency: c.currency,
          current: 0,
          previous: 0,
        };
        row[field] += c.amount;
        rows.set(key, row);
      }
    return [...rows.values()]
      .map((r) => ({
        ...r,
        delta: r.current - r.previous,
        category:
          r.previous === 0 && r.current > 0
            ? "Newly billed"
            : r.current === 0 && r.previous > 0
              ? "No longer billed"
              : r.current > r.previous
                ? "Increased"
                : r.current < r.previous
                  ? "Decreased"
                  : "Unchanged",
      }))
      .sort(
        (a, b) =>
          a.currency.localeCompare(b.currency) ||
          Math.abs(b.delta) - Math.abs(a.delta),
      );
  }
  function renderChanges() {
    const host = $("af-main");
    host.replaceChildren();
    const insights = el("section", "", "af-panel af-stack");
    const azureLink = el(
      "a",
      "Open Azure subscription Cost Analysis insights ↗",
    );
    azureLink.href = `https://portal.azure.com/#@${encodeURIComponent(scope.tenantId)}/resource/subscriptions/${encodeURIComponent(scope.subscriptionId)}/costanalysis`;
    azureLink.target = "_blank";
    azureLink.rel = "noopener noreferrer";
    insights.append(
      el("h2", "Anomaly investigation"),
      azureLink,
      el(
        "p",
        snapshot!.coverage.anomalies ??
          "Azure anomaly records are not included in this provider.",
      ),
      el("h3", "Azure anomaly alert configuration · subscription scope"),
      table(
        ["Alert", "Status", "Actual scope"],
        (snapshot!.anomalyAlerts ?? []).map((a) => [
          a.name,
          a.status,
          a.scopeId,
        ]),
      ),
      el(
        "small",
        snapshot!.coverage.anomalyAlerts ??
          "No alert configuration returned; absence does not establish that no Azure anomaly exists.",
      ),
      el("h3", "Plugin statistical anomalies"),
      table(
        ["Day", "Daily cost", "Baseline mean", "Threshold", "Evidence"],
        (snapshot!.anomalies ?? []).map((a) => [
          a.day,
          money(a.amount, a.currency),
          money(a.expected, a.currency),
          money(a.threshold, a.currency),
          a.explanation,
        ]),
      ),
      el(
        "small",
        "Scoped statistical check: at least 14 preceding billed days; mean + max(3 standard deviations, 50% of mean); last 48 hours excluded. No returned findings is not an Azure clean bill. This is separate from Azure-provided anomalies.",
      ),
    );
    host.append(insights);

    if (
      (snapshot!.coverage.costs !== "Available" && settings.mode === "live") ||
      snapshot!.coverage.comparison !== "Available"
    ) {
      host.append(
        el(
          "p",
          "Equivalent-period comparison is unavailable. No missing charges are interpreted as zero and no newly billed classifications are inferred.",
          "af-callout",
        ),
      );
      return;
    }
    const panel = el("section", "", "af-panel af-stack"),
      rows = costChanges();
    panel.append(
      el("h2", "Why did spending increase?"),
      el(
        "p",
        `Equivalent immediately preceding period · ${scope.basis} · rankings are per currency. Plugin-calculated changes; not Azure-provided anomalies.`,
        "af-callout",
      ),
      table(
        [
          "Resource / historical charge",
          "Service",
          "Current",
          "Previous",
          "Contribution",
          "Change class",
          "Possible explanation",
        ],
        rows.map((r) => {
          const resource = snapshot!.resources.find(
            (v) => r.resourceId && id(v.id) === id(r.resourceId),
          );
          return [
            r.name + (resource ? "" : " · not in current inventory"),
            r.service,
            money(r.current, r.currency),
            money(r.previous, r.currency),
            money(r.delta, r.currency),
            r.category +
              (r.previous > 0
                ? ` (${((r.delta / r.previous) * 100).toFixed(1)}%)`
                : ""),
            resource?.events.length
              ? `${resource.events[0].title} · ${resource.events[0].at}; correlation, not proven cause.`
              : "No retained event explanation.",
          ];
        }),
      ),
    );
    currentRows = rows;
    currentColumns = [
      "name",
      "service",
      "currency",
      "current",
      "previous",
      "delta",
      "category",
    ];
    panel.append(button("Export current table", exportTable));
    const services = new Map<
      string,
      { name: string; currency: string; current: number; previous: number }
    >();
    for (const row of rows) {
      const key = row.currency + "|" + row.service;
      const value = services.get(key) ?? {
        name: row.service,
        currency: row.currency,
        current: 0,
        previous: 0,
      };
      value.current += row.current;
      value.previous += row.previous;
      services.set(key, value);
    }
    panel.append(
      el("h3", "Service contributions"),
      table(
        ["Service", "Current", "Previous", "Absolute contribution"],
        [...services.values()]
          .sort(
            (a, b) =>
              a.currency.localeCompare(b.currency) ||
              Math.abs(b.current - b.previous) -
                Math.abs(a.current - a.previous),
          )
          .map((s) => [
            s.name,
            money(s.current, s.currency),
            money(s.previous, s.currency),
            money(s.current - s.previous, s.currency),
          ]),
      ),
    );
    host.append(panel);
  }
  function renderOperations() {
    const host = $("af-main");
    host.replaceChildren();
    const panel = el("section", "", "af-panel af-stack");
    panel.append(
      el("h2", "Operations & savings"),
      el(
        "p",
        "Stopping local polling does not cancel an Azure operation. Unknown outcomes require inspection in Azure before retrying. No general rollback is offered.",
        "af-callout",
      ),
    );
    const rows = operations.filter(
      (o) =>
        o.action.mode === settings.mode &&
        (!scope ||
          (o.action.target.tenantId === scope.tenantId &&
            o.action.target.subscriptionId === scope.subscriptionId &&
            (!scope.groupIds.length ||
              scope.groupIds.includes(id(o.action.target.groupId))))),
    );
    panel.append(
      table(
        [
          "Action",
          "Exact target",
          "State",
          "Time",
          "Identity",
          "Correlation IDs",
          "Result",
        ],
        rows.map((o) => [
          o.action.kind,
          o.action.target.id,
          badge(
            o.state,
            o.state === "succeeded"
              ? "af-success"
              : o.state === "failed"
                ? "af-error"
                : "af-warning",
          ),
          `${o.startedAt} → ${o.endedAt ?? "Pending"}`,
          o.identity,
          o.correlationIds.join(", ") || "Not returned",
          o.message,
        ]),
      ),
    );
    panel.append(
      el(
        "p",
        "Measure observed changes per completed operation below: seven complete UTC days before and after, excluding operation day, plus 48 hours of billing lag. Actual costs and currencies remain separate. Positive change means lower spending, not proof that the action caused savings. Missing billing windows remain unknown.",
        "af-muted",
      ),
    );
    for (const op of rows.filter((o) => o.state === "succeeded")) {
      const card = el("article", "", "af-panel af-stack");
      card.append(
        el("h3", `${op.action.kind} · ${op.action.target.name}`),
        button(
          op.measurement
            ? "Refresh observed spending"
            : "Measure observed spending",
          async () => {
            const result = await run(
              "measure",
              { operationId: op.id },
              generation,
            );
            operations = operations.map((o) => (o.id === op.id ? result : o));
            settings.operations = operations;
            if (page === "operations") renderOperations();
          },
        ),
      );
      if (op.measurement) {
        const m = op.measurement;
        card.append(
          el(
            "p",
            `${m.baselineFrom} → ${m.baselineTo} compared with ${m.postFrom} → ${m.postTo} · ${m.basis} · measured ${m.measuredAt}`,
          ),
          table(
            [
              "Currency",
              "Baseline",
              "Post-action",
              "Observed reduction (negative = increase)",
            ],
            m.rows.map((r) => [
              r.currency,
              money(r.baseline, r.currency),
              money(r.post, r.currency),
              money(r.change, r.currency),
            ]),
          ),
          el("p", m.explanation),
        );
      }
      panel.append(card);
    }
    host.append(panel);
  }
  async function reviewPlan() {
    const ticket = generation;
    message("Revalidating targets, dependencies and inherited locks…");
    review = await run("review", {}, ticket);
    if (ticket !== generation) return;
    const dialog = $<HTMLDialogElement>("af-review-dialog"),
      content = $("af-review-content");
    content.replaceChildren();
    dialog.querySelector("[data-review-error]")?.remove();
    const names: Record<string, string> = {};
    let updateConfirmation = () => {};
    content.append(
      el(
        "p",
        `${review!.mode.toUpperCase()} · review expires ${new Date(review!.expires).toLocaleTimeString()}. Actions retain their exact scope even if navigation changes.`,
        "af-callout",
      ),
    );
    const relevant = settings.plan.filter((a) => a.mode === settings.mode);
    const planList = el("div");
    for (const action of relevant) {
      const card = el("div", "", "af-review-item");
      card.append(
        el("h3", `${action.kind.toUpperCase()} · ${action.target.name}`),
        el(
          "code",
          `Tenant ${action.target.tenantId} · Subscription ${action.target.subscriptionId}`,
        ),
        el("code", action.target.id),
      );
      const item = review!.items.find((i) => i.action.id === action.id)!;
      card.append(
        badge("Dangerous operation", "af-error"),
        el("p", item.impact),
        el(
          "p",
          action.kind === "resize"
            ? `Size: ${item.resource?.sku ?? "Unknown"} → ${action.size}`
            : action.kind === "tags"
              ? "Tags can affect policy, automation, ownership and cost allocation."
              : "Review downtime, workload and billing impact before confirming.",
        ),
        el("p", `Remaining resources/charges: ${item.remaining}`),
        el(
          "small",
          "Permission checks: current reads are revalidated; Azure RBAC for the mutation remains authoritative and may deny execution. No universal Azure dry-run is claimed.",
        ),
      );
      if (item.resource) {
        card.append(
          el(
            "small",
            `Known references: ${item.resource.dependencies.map((d) => d.id).join(" · ") || "None returned; not proof of no dependencies."}`,
          ),
          el("small", `Discovery gaps: ${item.resource.gaps.join(" · ")}`),
          el(
            "small",
            `Provisioning: ${item.resource.provisioning.value ?? "Unknown"} · IaC may recreate resources or drift after direct changes.`,
          ),
        );
      }
      for (const error of item.errors)
        card.append(el("p", error, "af-callout"));
      if (action.kind === "tags")
        card.append(el("pre", JSON.stringify(action.tags, null, 2)));
      {
        const label = el(
            "label",
            `Type resource name exactly: ${action.target.name}`,
          ),
          input = el("input");
        input.setAttribute(
          "aria-label",
          action.kind === "delete"
            ? `Confirm deletion ${action.target.name}`
            : `Confirm ${action.kind} ${action.target.name}`,
        );
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("autocapitalize", "off");
        input.oninput = () => {
          names[action.id] = input.value;
          updateConfirmation();
        };
        label.append(input);
        card.append(label);
      }
      const command = el("details"),
        summary = el("summary", "Exact Azure CLI argument preview");
      command.append(summary, el("pre", JSON.stringify(item.command, null, 2)));
      card.append(command);
      card.append(
        button("Remove from plan", async () => {
          settings.plan = await request("removeAction", { id: action.id });
          review = undefined;
          dialog.close();
          updatePlan();
          message("Plan changed. Review again before execution.");
        }),
      );
      planList.append(card);
    }
    content.append(
      planList,
      el(
        "p",
        "Estimated plan savings: not calculated without validated action-specific pricing and eligibility. Finding estimates are not automatically counted as action savings.",
        "af-muted",
      ),
    );
    const label = el("label", "", "af-check"),
      check = el("input");
    check.type = "checkbox";
    check.setAttribute(
      "aria-label",
      "I reviewed every exact target and operational impact",
    );
    label.append(
      check,
      document.createTextNode(
        `I reviewed all ${review!.items.length} exact targets, dependencies and operational impacts.`,
      ),
    );
    const execute = button(
      review!.mode === "demo"
        ? "Simulate reviewed actions"
        : `Execute ${review!.items.length} dangerous action${review!.items.length === 1 ? "" : "s"}`,
      async () => {
        if (execute.disabled) return;
        execute.disabled = true;
        if (!check.checked)
          throw new Error("Review and acknowledge all exact targets.");
        const response = await request("execute", {
          token: review!.token,
          scope,
          names,
          confirmBulk: check.checked,
        });
        executing = true;
        updatePlan();
        dialog.close();
        navigate("operations");
        try {
          const result = await drive(response.jobId, generation, true);
          operations = result.operations;
          settings.plan = result.plan;
          message("Plan processing completed. Review each resource outcome.");
        } finally {
          executing = false;
          const state = await request("state");
          operations = state.operations;
          settings.plan = state.plan;
          updatePlan();
          if (page === "operations") renderOperations();
        }
      },
      "af-danger",
    );
    const pending = el(
      "p",
      "Type every exact resource name and acknowledge the complete plan to enable execution.",
      "af-callout",
    );
    pending.setAttribute("role", "status");
    updateConfirmation = () => {
      const expired = Date.now() >= review!.expires;
      const confirmed = review!.items.filter(
        (i) => names[i.action.id] === i.action.target.name,
      ).length;
      const valid =
        !expired &&
        check.checked &&
        review!.items.every(
          (i) =>
            i.errors.length === 0 &&
            names[i.action.id] === i.action.target.name,
        );
      execute.disabled = !valid;
      pending.textContent = expired
        ? "Review expired. Close this dialog and review again before execution."
        : valid
          ? "Ready for explicit execution. Azure and host authorization still apply."
          : `${confirmed}/${review!.items.length} target names confirmed. Acknowledge the complete plan to enable execution.`;
    };
    check.onchange = updateConfirmation;
    updateConfirmation();
    content.append(label, pending, execute);
    dialog.showModal();
    const expiry = window.setTimeout(
      updateConfirmation,
      Math.max(0, review!.expires - Date.now() + 1),
    );
    dialog.addEventListener("close", () => window.clearTimeout(expiry), {
      once: true,
    });
    disposers.push(() => window.clearTimeout(expiry));
    $("af-review-close").focus();
    message(
      "Plan review ready. Every mutation requires typed target names and explicit acknowledgement before execution.",
    );
  }
  function renderSettings() {
    const host = $("af-main");
    host.replaceChildren();
    const panel = el("section", "", "af-panel af-stack af-settings");
    panel.append(
      el("h2", "Provider & Azure CLI setup"),
      el(
        "p",
        "Demo mode is isolated. Live mode runs only the configured az executable through FDO’s approved process scope. Authentication is performed manually outside FDO.",
        "af-callout",
      ),
    );
    panel.append(
      el(
        "p",
        "The sidebar shows CLI subscription profile metadata, not proof of token identity or API permissions. Check CLI & sign-in refreshes the subscription list and initially selects the CLI default. If the account differs from your Terminal, check that FDO uses the same host user, HOME and AZURE_CONFIG_DIR. Sign in manually with the intended account and tenant in that same CLI profile, then check again. Inventory, costs, metrics and management have independent Azure permissions.",
        "af-muted",
      ),
    );
    let mode = settings.mode;
    const provider = select(
      "Provider",
      [
        ["demo", "Demo · no Azure calls"],
        ["live", "Live · Azure CLI"],
      ],
      mode,
      (v) => {
        mode = v as Mode;
      },
    );
    const path = el("input");
    path.value = settings.cli;
    path.setAttribute("aria-label", "Azure CLI executable");
    const pathLabel = el("label", "Absolute Azure CLI path");
    pathLabel.append(path);
    const scopeInput = el("input");
    scopeInput.value = settings.processScope;
    scopeInput.setAttribute("aria-label", "Host process scope");
    const scopeLabel = el("label", "Host process scope ID");
    scopeLabel.append(scopeInput);
    panel.append(
      provider,
      pathLabel,
      scopeLabel,
      button("Save provider settings", async () => {
        await request("configure", {
          mode,
          cli: path.value,
          processScope: scopeInput.value,
        });
        settings = {
          ...settings,
          mode,
          cli: path.value,
          processScope: scopeInput.value,
        };
        invalidate();
        accounts = [];
        groups = [];
        groupLabel();
        $("af-mode-badge").textContent = mode.toUpperCase();
        message(
          "Settings saved. Check connection to load subscriptions. Authentication stays manual.",
        );
        renderSettings();
      }),
      button("Check CLI & sign-in", async () => {
        invalidate();
        accounts = await run("accounts");
        if (!accounts.length)
          throw new Error(
            "No enabled subscriptions returned. Sign in with az login manually outside FDO.",
          );
        scope = {
          tenantId: accounts[0].tenantId,
          subscriptionId: accounts[0].id,
          groupIds: [],
          basis: "ActualCost",
          ...scopeDates("30"),
        };
        accountControls();
        viewOptions();
        await loadScope();
        navigate("settings");
        message(
          `${settings.mode.toUpperCase()}: CLI/account check completed. No login command was run.`,
        );
      }),
    );
    panel.append(
      el("h2", "Custom capability setup"),
      el(
        "p",
        "FDO’s curated azure-cli scope currently excludes REST, disk and several other commands. Create a dedicated host-approved scope for this plugin. Declaring or saving the ID does not grant permission.",
      ),
    );
    const steps = el("ol");
    for (const text of [
      "In FDO Settings → Shared Process Scopes → Create Shared Scope, set Scope ID to azure-finops and a descriptive name such as Azure FinOps CLI.",
      "Allowed executable paths: add the actual absolute path returned by command -v az in your own Terminal (commonly /opt/homebrew/bin/az or /usr/local/bin/az). Add only the installed az executable; no shell interpreter.",
      "Allowed CWD roots: choose your normal plugin/workspace root. Timeout ceiling: 90000 ms. Keep Require confirmation enabled.",
      "Enable subcommand filtering (first argument). Allow account, group, resource, vm, disk, network, monitor, rest, tag, ad, deployment. Leave leading-option allowances empty; this plugin begins every call with one of these verbs.",
      "Environment variable key allowlist: AZURE_CONFIG_DIR, HOME, PATH, TMPDIR, TMP, TEMP. Use the same CLI profile as your manual login. No credential values belong in this plugin.",
      "Save the scope, then grant this plugin system.process.exec and system.process.scope.azure-finops in its capability settings. In Manage Plugins → Capabilities, enable Storage (storage), expand it, and enable Persistent plugin JSON storage (storage.json). The parent toggle alone is insufficient. Reload the plugin after changing grants; these store plans, views and operation records.",
      "In your own Terminal run az login --tenant YOUR_TENANT_ID. If Azure requests a browser, device code, MFA or Conditional Access, complete it there. The plugin never executes login, logout, account set or account get-access-token.",
      "Set the same scope ID and executable above, Save provider settings, select Live, and Check CLI & sign-in. Azure RBAC still determines access to costs, inventory and management.",
      "Databricks inspection uses the same az executable: allow GET only to each exact ARM-reported adb-<workspace-id>.<shard>.azuredatabricks.net host for clusters/list, sql/warehouses, instance-pools/list, jobs/list and jobs/runs/list when host URL restrictions are enabled. az rest acquires its Entra audience internally. Workspace object permissions and network access are required; no PAT, login automation, admin auto-provisioning or workload query is used.",
    ])
      steps.append(el("li", text));
    panel.append(
      steps,
      el("h3", "Recommended host policy"),
      el(
        "pre",
        JSON.stringify(
          {
            scope: "azure-finops",
            allowedExecutables: [settings.cli],
            allowedCwdRoots: ["/your/approved/workspace"],
            allowedEnvKeys: [
              "AZURE_CONFIG_DIR",
              "HOME",
              "PATH",
              "TMPDIR",
              "TMP",
              "TEMP",
            ],
            timeoutCeilingMs: 90000,
            requireConfirmation: true,
            argumentPolicy: {
              version: 1,
              mode: "first-arg",
              allowedFirstArgs: [
                "account",
                "group",
                "resource",
                "vm",
                "disk",
                "network",
                "monitor",
                "rest",
                "tag",
                "ad",
                "deployment",
              ],
              deniedFirstArgs: ["login", "logout"],
              allowedLeadingOptions: [],
            },
          },
          null,
          2,
        ),
      ),
      el(
        "p",
        "This scope can perform writes and deletes through the approved Azure CLI identity. A first-argument allowlist is coarse: where supported, restrict ARM calls to management.azure.com and documented paths; additionally allow GET only to each ARM-reported adb-<workspace-id>.<shard>.azuredatabricks.net host for the five documented inspection collections. The plugin builds fixed requests, but host confirmation and Azure RBAC remain essential.",
        "af-callout",
      ),
    );
    const links = [
      [
        "Azure CLI installation",
        "https://learn.microsoft.com/cli/azure/install-azure-cli",
      ],
      [
        "Manual Azure CLI authentication",
        "https://learn.microsoft.com/cli/azure/authenticate-azure-cli-interactively",
      ],
      [
        "Cost Management queries",
        "https://learn.microsoft.com/rest/api/cost-management/query/usage?view=rest-cost-management-2025-03-01",
      ],
      [
        "Resource Graph change history",
        "https://learn.microsoft.com/azure/governance/resource-graph/how-to/get-resource-changes",
      ],
    ];
    for (const [label, url] of links) {
      const a = el("a", label + " ↗");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      panel.append(a);
    }
    panel.append(
      el("h3", "Scaffold coverage"),
      el(
        "p",
        "Databricks: read-only clusters/warehouses/pools/jobs/runs and managed-group billing. Foundry: ARM projects, model deployments, classic compute/endpoints and supported Monitor signals. Databricks requires GET-only access to each ARM-reported adb workspace host through az rest with its Entra audience; all service cleanup is handed off to service controls. Live: scoped Azure forecasts, subscription anomaly-alert configuration and separate plugin statistical checks; inventory/costs/budgets/Advisor; deployment correlations, client/tool evidence and permission-aware creator name lookup; explicit fleet CPU/memory/network scans; inbound/outbound ARM and Recovery Services references; guarded same-family VM resize while deallocated; observed pre/post spending measurement. Azure anomaly records open in subscription Cost Analysis. Every mutation is dangerous and requires typed target confirmation. No general rollback or exhaustive external dependency claim.",
      ),
    );
    host.append(panel);
  }
  listen(root, "click", (event: Event) => {
    const nav = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-page]",
    );
    if (nav) navigate(nav.dataset.page!);
  });
  listen($("af-refresh"), "click", async () => {
    try {
      if (!scope) {
        navigate("settings");
        return;
      }
      invalidate();
      await loadScope();
    } catch (e) {
      report(e);
    }
  });
  listen($("af-groups-button"), "click", () => {
    if (!groupsReady) {
      report(
        new Error(
          "Refresh resource groups for this subscription before selecting.",
        ),
      );
      return;
    }
    const open = $("af-group-popover").hidden;
    if (open) {
      pendingAll = !scope.groupIds.length;
      pendingGroups = new Set(scope.groupIds);
      $<HTMLInputElement>("af-group-search").value = "";
      drawGroupPicker();
    }
    $("af-group-popover").hidden = !open;
    $("af-groups-button").setAttribute("aria-expanded", String(open));
    if (open) $("af-group-search").focus();
  });
  listen($("af-group-search"), "input", drawGroupPicker);
  listen($("af-groups-all"), "click", () => {
    pendingAll = true;
    pendingGroups.clear();
    drawGroupPicker();
  });
  listen($("af-groups-clear"), "click", () => {
    pendingAll = false;
    pendingGroups.clear();
    drawGroupPicker();
  });
  listen($("af-groups-cancel"), "click", () => {
    closeGroups();
    $("af-groups-button").focus();
  });
  listen($("af-groups-apply"), "click", async () => {
    scope.groupIds = pendingAll ? [] : [...pendingGroups];
    closeGroups();
    invalidate();
    await loadScope();
  });
  listen($("af-group-popover"), "keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeGroups();
      $("af-groups-button").focus();
    }
  });
  listen($("af-tenant"), "change", async () => {
    const tenant = $<HTMLSelectElement>("af-tenant").value,
      account = accounts.find((a) => a.tenantId === tenant);
    if (!account) return;
    scope = {
      ...scope,
      tenantId: tenant,
      subscriptionId: account.id,
      groupIds: [],
    };
    groups = [];
    closeGroups();
    invalidate();
    accountControls();
    groupLabel();
    await loadScope();
  });
  listen($("af-subscription"), "change", async () => {
    scope = {
      ...scope,
      subscriptionId: $<HTMLSelectElement>("af-subscription").value,
      groupIds: [],
    };
    groups = [];
    closeGroups();
    invalidate();
    groupLabel();
    await loadScope();
  });
  listen($("af-basis"), "change", async () => {
    scope.basis = $<HTMLSelectElement>("af-basis").value as Scope["basis"];
    invalidate();
    await loadScope();
  });
  listen($("af-period"), "change", async () => {
    const value = $<HTMLSelectElement>("af-period").value;
    $("af-custom-dates").hidden = value !== "custom";
    if (value === "custom") {
      ($("af-from") as HTMLInputElement).value = scope.from.slice(0, 10);
      ($("af-to") as HTMLInputElement).value = scope.to.slice(0, 10);
      return;
    }
    scope = { ...scope, ...scopeDates(value) };
    invalidate();
    await loadScope();
  });
  listen($("af-dates-apply"), "click", async () => {
    try {
      scope = {
        ...scope,
        from: new Date(
          $<HTMLInputElement>("af-from").value + "T00:00:00.000Z",
        ).toISOString(),
        to: new Date(
          $<HTMLInputElement>("af-to").value + "T23:59:59.999Z",
        ).toISOString(),
      };
      invalidate();
      await loadScope();
    } catch (e) {
      report(e);
    }
  });
  listen($("af-review"), "click", () => {
    void reviewPlan().catch(report);
  });
  listen($("af-review-close"), "click", () => {
    $<HTMLDialogElement>("af-review-dialog").close();
  });
  listen($("af-save-view"), "click", () => {
    $<HTMLInputElement>("af-view-name").value = "";
    $<HTMLDialogElement>("af-view-dialog").showModal();
    $("af-view-name").focus();
  });
  listen($("af-view-cancel"), "click", () => {
    $<HTMLDialogElement>("af-view-dialog").close();
  });
  listen($("af-view-confirm"), "click", async () => {
    try {
      settings.views = await request("saveView", {
        view: {
          name: $<HTMLInputElement>("af-view-name").value,
          mode: settings.mode,
          scope,
          filters,
          columns,
          sort,
          direction,
        },
      });
      viewOptions();
      $<HTMLDialogElement>("af-view-dialog").close();
      message("Saved view persisted. No credentials were saved.");
    } catch (e) {
      report(e);
    }
  });
  listen($("af-view"), "change", async () => {
    const view = settings.views.find(
      (v) => v.id === $<HTMLSelectElement>("af-view").value,
    );
    if (!view) return;
    scope = structuredClone(view.scope);
    filters = { ...filters, ...view.filters };
    columns = view.columns.length ? view.columns : columns;
    sort = view.sort;
    direction = view.direction;
    $<HTMLSelectElement>("af-basis").value = scope.basis;
    accountControls();
    invalidate();
    await loadScope();
  });
  listen($("af-stop-loading"), "click", () => {
    generation++;
    for (const jobId of activeJobs)
      void request("stop", { jobId }).catch(report);
    message(
      "Local data loading stopped. This does not cancel any Azure operation.",
    );
  });
  const staleTimer = window.setInterval(() => {
    if (snapshot && Date.now() - Date.parse(snapshot.fetchedAt) > 300000)
      $("af-freshness").textContent =
        `STALE · updated ${new Date(snapshot.fetchedAt).toLocaleString()}`;
  }, 10000);
  disposers.push(() => window.clearInterval(staleTimer));
  void (async () => {
    try {
      const boot = await request("bootstrap");
      settings = boot.settings;
      operations = settings.operations;
      $("af-mode-badge").textContent = settings.mode.toUpperCase();
      connection();
      accounts = await run("accounts");
      if (!accounts.length) {
        navigate("settings");
        report(
          new Error(
            "No accessible enabled subscriptions. Complete Azure CLI authentication manually.",
          ),
        );
        return;
      }
      scope = {
        tenantId: accounts[0].tenantId,
        subscriptionId: accounts[0].id,
        groupIds: [],
        basis: "ActualCost",
        ...scopeDates("30"),
      };
      accountControls();
      viewOptions();
      await loadScope();
    } catch (e) {
      if (!settings)
        settings = {
          mode: "demo",
          cli: "/opt/homebrew/bin/az",
          processScope: "azure-finops",
          views: [],
          plan: [],
          operations: [],
          demoOverrides: {},
        };
      connection();
      navigate("settings");
      report(e);
    }
  })();
  const cleanup = () => {
    if (!active) return;
    active = false;
    generation++;
    detailSequence++;
    disposeCharts();
    disposers.forEach((fn) => fn());
    for (const jobId of activeJobs)
      void request("stop", { jobId }).catch(() => {});
  };
  listen(window, "pagehide", cleanup);
  return cleanup;
}
