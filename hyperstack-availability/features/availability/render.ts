import type {DOM} from "@anikitenko/fdo-sdk";
import {
  AVAILABILITY_STATUS_LABELS,
  filterAvailability,
  getAvailabilityFilterOptions,
  summarizeAvailability,
} from "./logic";
import type {
  AvailabilityFilters,
  AvailabilityItem,
  AvailabilitySnapshot,
  AvailabilityStatus,
} from "./logic";
import type {AvailabilityConfiguration} from "./backend";

export const AVAILABILITY_VIEW_IDS = {
  root: "hyperstack-availability",
  connection: "hyperstack-connection",
  connectionStatus: "hyperstack-connection-status",
  connectionHelp: "hyperstack-connection-help",
  apiKey: "hyperstack-api-key",
  saveConnection: "hyperstack-save-connection",
  clearConnection: "hyperstack-clear-connection",
  refresh: "hyperstack-refresh",
  region: "hyperstack-region",
  gpu: "hyperstack-gpu",
  status: "hyperstack-stock-status",
  query: "hyperstack-query",
  polling: "hyperstack-polling",
  loading: "hyperstack-loading",
  error: "hyperstack-error",
  stale: "hyperstack-stale",
  lastCheck: "hyperstack-last-check",
  summary: "hyperstack-summary",
  results: "hyperstack-results",
  resultsBody: "hyperstack-results-body",
  empty: "hyperstack-empty",
} as const;

export interface AvailabilityViewState {
  readonly configuration?: AvailabilityConfiguration;
  readonly snapshot?: AvailabilitySnapshot | null;
  readonly filters?: AvailabilityFilters;
  readonly loading?: boolean;
  readonly savingConfiguration?: boolean;
  readonly error?: string | null;
  /** Explicitly set after a failed check; old results remain visible. */
  readonly stale?: boolean;
  readonly pollingSeconds?: number;
}

/** Registered classes owned by the shared DOM composition entry. */
export interface AvailabilityViewClasses {
  readonly root?: string;
  readonly header?: string;
  readonly panel?: string;
  readonly controls?: string;
  readonly field?: string;
  readonly command?: string;
  readonly muted?: string;
  readonly notice?: string;
  readonly error?: string;
  readonly summary?: string;
  readonly tableWrap?: string;
  readonly table?: string;
  readonly badge?: string;
  readonly available?: string;
  readonly unavailable?: string;
  readonly unknown?: string;
  readonly empty?: string;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function classNames(...values: readonly (string | undefined)[]): string {
  return values.filter((value) => Boolean(value)).join(" ");
}

function hiddenUnless(visible: boolean): Record<string, string> {
  return visible ? {} : {hidden: "hidden"};
}

function disabledWhen(disabled: boolean): Record<string, string> {
  return disabled ? {disabled: "disabled"} : {};
}

function paragraph(
  dom: DOM,
  text: string,
  attributes: Record<string, string> = {},
): string {
  return dom.createElement("p", attributes, escapeText(text));
}

function option(
  dom: DOM,
  value: string,
  label: string,
  selected: boolean,
): string {
  return dom.createElement(
    "option",
    {value, ...(selected ? {selected: "selected"} : {})},
    escapeText(label),
  );
}

function labeledField(
  dom: DOM,
  id: string,
  label: string,
  control: string,
  classes: AvailabilityViewClasses,
): string {
  return dom.createElement(
    "div",
    {class: classes.field ?? ""},
    dom.createElement("label", {for: id}, escapeText(label)),
    control,
  );
}

function command(
  dom: DOM,
  id: string,
  label: string,
  disabled: boolean,
  classes: AvailabilityViewClasses,
  primary = false,
): string {
  return dom.createElement(
    "button",
    {
      id,
      type: "button",
      class: classNames(
        "pure-button",
        primary ? "pure-button-primary" : undefined,
        classes.command,
      ),
      ...disabledWhen(disabled),
    },
    escapeText(label),
  );
}

function connectionCopy(
  configuration: AvailabilityConfiguration | undefined,
): {status: string; help: string} {
  if (!configuration) {
    return {
      status: "Connection has not been checked.",
      help: "Secure storage is checked when this view opens. "
        + "You can enter and save your Hyperstack API key to set up the connection.",
    };
  }

  // Backend configuration supplies the current recovery guidance. Render it
  // unchanged through the escaped paragraph builder rather than duplicating it.
  switch (configuration.status) {
    case "ready":
      return {
        status: "An API key is saved.",
        help: configuration.message,
      };
    case "credential_required":
      return {
        status: "No API key is saved.",
        help: configuration.message,
      };
    case "permission_denied":
      return {
        status: "Permission to access saved credentials was denied.",
        help: configuration.message,
      };
    case "storage_locked":
      return {
        status: "Secure credential storage is locked.",
        help: configuration.message,
      };
    case "storage_unavailable":
      return {
        status: "Secure credential storage could not be reached.",
        help: configuration.message,
      };
  }
}

export function renderConnectionControls(
  dom: DOM,
  state: AvailabilityViewState = {},
  classes: AvailabilityViewClasses = {},
): string {
  const ids = AVAILABILITY_VIEW_IDS;
  const configuration = state.configuration;
  const busy = Boolean(state.loading || state.savingConfiguration);
  const copy = connectionCopy(configuration);

  // Storage and permission failures must leave a path to retry setup.
  const keyInput = dom.createElement("input", {
    id: ids.apiKey,
    type: "password",
    name: "hyperstack-api-key",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": ids.connectionHelp,
    ...disabledWhen(busy),
  });

  return dom.createElement(
    "section",
    {
      id: ids.connection,
      class: classes.panel ?? "",
      "aria-labelledby": `${ids.connection}-heading`,
      "aria-busy": String(busy),
    },
    dom.createElement("h2", {id: `${ids.connection}-heading`}, "Connection"),
    paragraph(dom, copy.status, {
      id: ids.connectionStatus,
      role: "status",
      "aria-live": "polite",
    }),
    paragraph(dom, copy.help, {
      id: ids.connectionHelp,
      class: classes.muted ?? "",
    }),
    dom.createElement(
      "div",
      {
        class: classNames("pure-form", "pure-form-stacked", classes.controls),
        role: "group",
        "aria-label": "Hyperstack connection controls",
      },
      labeledField(dom, ids.apiKey, "Hyperstack API key", keyInput, classes),
      command(
        dom,
        ids.saveConnection,
        state.savingConfiguration ? "Saving…" : "Save API key",
        busy,
        classes,
        true,
      ),
      command(
        dom,
        ids.clearConnection,
        "Remove saved key",
        busy || configuration?.configured !== true,
        classes,
      ),
    ),
  );
}

export function renderAvailabilityFilters(
  dom: DOM,
  state: AvailabilityViewState = {},
  classes: AvailabilityViewClasses = {},
): string {
  const ids = AVAILABILITY_VIEW_IDS;
  const filters = state.filters ?? {};
  const options = getAvailabilityFilterOptions(state.snapshot?.items ?? []);

  const buildOptions = (
    values: readonly string[],
    selected: string | undefined,
    allLabel: string,
  ): string[] => {
    const current = selected ?? "";
    const complete = current && !values.includes(current)
      ? [current, ...values]
      : values;
    return [
      option(dom, "", allLabel, current === ""),
      ...complete.map((value) => option(dom, value, value, value === current)),
    ];
  };

  const region = dom.createElement(
    "select",
    {id: ids.region},
    ...buildOptions(options.regions, filters.region, "All regions"),
  );
  const gpu = dom.createElement(
    "select",
    {id: ids.gpu},
    ...buildOptions(options.gpus, filters.gpu, "All GPUs"),
  );
  const statuses: readonly AvailabilityStatus[] = [
    "available", "unavailable", "unknown",
  ];
  const status = dom.createElement(
    "select",
    {id: ids.status},
    option(
      dom,
      "all",
      "All stock states",
      !filters.status || filters.status === "all",
    ),
    ...statuses.map((value) => option(
      dom,
      value,
      value === "unknown"
        ? "Unknown availability"
        : AVAILABILITY_STATUS_LABELS[value],
      filters.status === value,
    )),
  );
  const query = dom.createElement("input", {
    id: ids.query,
    type: "search",
    value: filters.query ?? "",
    placeholder: "Search region, GPU or flavor",
  });
  const pollingSeconds = state.pollingSeconds ?? 0;
  const polling = dom.createElement(
    "select",
    {id: ids.polling},
    option(dom, "0", "Manual checks", pollingSeconds === 0),
    ...[60, 300, 600].map((seconds) => option(
      dom,
      String(seconds),
      `Every ${seconds / 60} minute${seconds === 60 ? "" : "s"}`,
      pollingSeconds === seconds,
    )),
    ...(![0, 60, 300, 600].includes(pollingSeconds)
      ? [option(
          dom,
          String(pollingSeconds),
          `Every ${pollingSeconds} seconds`,
          true,
        )]
      : []),
  );

  return dom.createElement(
    "section",
    {
      class: classes.panel ?? "",
      "aria-labelledby": `${ids.root}-filters-heading`,
    },
    dom.createElement("h2", {id: `${ids.root}-filters-heading`}, "Find a VM"),
    dom.createElement(
      "div",
      {
        class: classNames("pure-form", "pure-form-stacked", classes.controls),
        role: "group",
        "aria-label": "Availability filters",
      },
      labeledField(dom, ids.region, "Region", region, classes),
      labeledField(dom, ids.gpu, "GPU", gpu, classes),
      labeledField(dom, ids.status, "Stock status", status, classes),
      labeledField(dom, ids.query, "Search", query, classes),
      labeledField(dom, ids.polling, "Automatic refresh", polling, classes),
    ),
  );
}

export function renderAvailabilitySummary(
  dom: DOM,
  items: readonly AvailabilityItem[],
  classes: AvailabilityViewClasses = {},
): string {
  const summary = summarizeAvailability(items);
  return paragraph(
    dom,
    `${summary.total} matching options · ${summary.available} available · `
      + `${summary.unavailable} out of stock · ${summary.unknown} unknown`,
    {
      id: AVAILABILITY_VIEW_IDS.summary,
      class: classes.summary ?? "",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  );
}

export function renderAvailabilityRows(
  dom: DOM,
  items: readonly AvailabilityItem[],
  classes: AvailabilityViewClasses = {},
): string {
  return items.map((item) => {
    const label = item.status === "unknown"
      ? "Unknown availability"
      : AVAILABILITY_STATUS_LABELS[item.status];
    const badge = dom.createElement(
      "span",
      {
        class: classNames(classes.badge, classes[item.status]),
        "data-stock-status": item.status,
      },
      escapeText(label),
    );
    const cell = (value: string): string =>
      dom.createElement("td", {}, escapeText(value));

    return dom.createElement(
      "tr",
      {
        "data-availability-id": item.id,
        "data-availability-status": item.status,
        "data-stock-status": item.status,
      },
      cell(item.flavor),
      cell(item.region),
      cell(item.gpu),
      dom.createElement("td", {}, badge),
      cell(item.availableCount === null ? "Not reported" : String(item.availableCount)),
    );
  }).join("");
}

export function renderLastCheck(
  dom: DOM,
  snapshot: AvailabilitySnapshot | null | undefined,
  classes: AvailabilityViewClasses = {},
): string {
  const checkedAt = snapshot?.checkedAt;
  const attributes = {
    id: AVAILABILITY_VIEW_IDS.lastCheck,
    class: classes.muted ?? "",
  };

  if (checkedAt && Number.isFinite(Date.parse(checkedAt))) {
    return dom.createElement(
      "p",
      attributes,
      "Last successful check: ",
      dom.createElement("time", {datetime: checkedAt}, escapeText(checkedAt)),
    );
  }

  return dom.createElement("p", attributes, "Last successful check: Never");
}

export function renderAvailabilityResults(
  dom: DOM,
  state: AvailabilityViewState = {},
  classes: AvailabilityViewClasses = {},
): string {
  const ids = AVAILABILITY_VIEW_IDS;
  const snapshot = state.snapshot;
  const items = filterAvailability(snapshot?.items ?? [], state.filters);
  const hasResults = items.length > 0;
  const stale = Boolean(snapshot && (state.stale || state.error));
  const emptyMessage = !snapshot
    ? state.configuration?.ready
      ? "No availability checked yet. Choose Check availability."
      : "No availability checked yet. Save your Hyperstack API key, "
        + "resolve any connection setup message, then choose Check availability."
    : snapshot.items.length === 0
      ? "The last successful check returned no VM options."
      : "No VM options match these filters. Try another region, GPU or stock status.";

  const headings = ["VM flavor", "Region", "GPU", "Stock status", "Available VMs"];
  const table = dom.createElement(
    "table",
    {class: classNames("pure-table", "pure-table-horizontal", classes.table)},
    dom.createElement("caption", {}, "Hyperstack VM availability"),
    dom.createElement(
      "thead",
      {},
      dom.createElement(
        "tr",
        {},
        ...headings.map((heading) =>
          dom.createElement("th", {scope: "col"}, escapeText(heading)),
        ),
      ),
    ),
    dom.createElement(
      "tbody",
      {id: ids.resultsBody},
      ...items.map((item) => renderAvailabilityRows(dom, [item], classes)),
    ),
  );

  return dom.createElement(
    "section",
    {
      id: ids.results,
      class: classes.panel ?? "",
      "aria-labelledby": `${ids.results}-heading`,
      "aria-busy": String(Boolean(state.loading)),
      "data-stale": String(stale),
    },
    dom.createElement("h2", {id: `${ids.results}-heading`}, "Availability"),
    renderLastCheck(dom, snapshot, classes),
    paragraph(
      dom,
      "Previous results are stale. They do not confirm current stock. "
        + "Resolve the reported issue and choose Check availability to retry.",
      {
        id: ids.stale,
        class: classes.notice ?? "",
        role: "status",
        ...hiddenUnless(stale),
      },
    ),
    renderAvailabilitySummary(dom, items, classes),
    dom.createElement(
      "div",
      {
        class: classes.tableWrap ?? "",
        role: "region",
        "aria-label": "VM availability table",
        tabindex: "0",
        ...hiddenUnless(hasResults),
      },
      table,
    ),
    paragraph(dom, emptyMessage, {
      id: ids.empty,
      class: classes.empty ?? "",
      ...hiddenUnless(!hasResults),
    }),
    paragraph(
      dom,
      "Unknown means the provider has not confirmed launchable stock. "
        + "Availability can change before a VM is created.",
      {class: classes.muted ?? ""},
    ),
  );
}

/**
 * Compose SDK-built fragments using the caller's shared DOM instance.
 * The composition entry owns palette registration and the final renderHTML.
 */
export function renderAvailability(
  dom: DOM,
  state: AvailabilityViewState = {},
  classes: AvailabilityViewClasses = {},
): string {
  const ids = AVAILABILITY_VIEW_IDS;
  const busy = Boolean(state.loading || state.savingConfiguration);

  return dom.createElement(
    "div",
    {id: ids.root, class: classes.root ?? ""},
    dom.createElement(
      "header",
      {class: classes.header ?? ""},
      dom.createElement("h1", {}, "Hyperstack availability"),
      paragraph(
        dom,
        "Check VM stock by region and GPU without searching the console.",
        {class: classes.muted ?? ""},
      ),
      command(
        dom,
        ids.refresh,
        state.loading ? "Checking…" : "Check availability",
        busy || state.configuration?.ready !== true,
        classes,
        true,
      ),
    ),
    paragraph(dom, "Checking Hyperstack availability…", {
      id: ids.loading,
      role: "status",
      "aria-live": "polite",
      class: classes.notice ?? "",
      ...hiddenUnless(Boolean(state.loading)),
    }),
    paragraph(dom, state.error ?? "", {
      id: ids.error,
      role: "alert",
      "aria-atomic": "true",
      class: classes.error ?? "",
      ...hiddenUnless(Boolean(state.error)),
    }),
    renderConnectionControls(dom, state, classes),
    renderAvailabilityFilters(dom, state, classes),
    renderAvailabilityResults(dom, state, classes),
    renderDeploymentControls(dom, classes),
  );
}

function renderDeploymentControls(dom: DOM, classes: AvailabilityViewClasses): string {
  const field = (id: string, label: string, type = "text") => labeledField(
    dom, `hyperstack-deploy-${id}`, label,
    dom.createElement("input", {id: `hyperstack-deploy-${id}`, type, ...(type === "text" ? {maxlength: id === "image" ? "255" : "50", required: "required"} : {})}),
    classes,
  );
  return dom.createElement("section", {class: classes.panel ?? "", "aria-labelledby": "hyperstack-deploy-heading"},
    dom.createElement("h2", {id: "hyperstack-deploy-heading"}, "Create a VM when available"),
    paragraph(dom, "Choose a VM type after checking stock. Enter an existing environment in that region, an API image name and an SSH keypair from that environment.", {class: classes.muted ?? ""}),
    dom.createElement("div", {class: classNames("pure-form", "pure-form-stacked", classes.controls)},
      labeledField(dom, "hyperstack-deploy-type", "Desired VM type and region", dom.createElement("select", {id: "hyperstack-deploy-type", disabled: "disabled"}, option(dom, "", "Check availability first", true)), classes),
      field("name", "New VM name"),
      field("environment", "Existing environment name"),
      field("image", "API image name"),
      field("keypair", "Existing SSH keypair name"),
      field("public-ip", "Assign a public IP", "checkbox"),
      field("charges", "I authorize creation of one VM and the resulting Hyperstack charges", "checkbox"),
    ),
    paragraph(dom, "Arming checks stock immediately, then every minute while this view stays open, including when hidden. Creation stops after one request. Closing or reloading the view stops automatic checks. No inbound firewall rules are added; configure access in Hyperstack.", {class: classes.muted ?? ""}),
    dom.createElement("div", {class: classes.controls ?? ""},
      command(dom, "hyperstack-deploy-arm", "Create one VM when available", true, classes, true),
      command(dom, "hyperstack-deploy-cancel", "Cancel waiting", true, classes),
    ),
    paragraph(dom, "No VM creation is armed.", {id: "hyperstack-deploy-status", role: "status", "aria-live": "polite"}),
  );
}
