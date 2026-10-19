import { normalizeId, validateScope } from "./domain.ts";
import type { Settings } from "./types.ts";

/** Project UI preferences only. Never retain inventory, credentials, reviews or confirmations. */
export function normalizeExploration(input: any, settings: Settings) {
  if (
    input?.version !== 1 ||
    input.mode !== settings.mode ||
    input.cli !== settings.cli ||
    input.processScope !== settings.processScope
  )
    throw new Error(
      "Exploration preferences belong to a different provider configuration.",
    );
  const scope = validateScope(input.scope);
  if (scope.groupIds.some((id) => id.length > 2048))
    throw new Error("Invalid exploration scope.");
  const text = (value: unknown, limit = 512) =>
    typeof value === "string" ? value.slice(0, limit) : "";
  const integer = (value: unknown, max = 100000) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(0, Math.floor(value)))
      : 0;
  const resourceId = (value: unknown) => {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      return undefined;
    const normalized = normalizeId(value);
    return normalized.startsWith(
      `/subscriptions/${scope.subscriptionId}/resourcegroups/`.toLowerCase(),
    ) && /\/resourcegroups\/[^/]+\/providers\/[^/]+\/[^/]+\//i.test(value)
      ? value
      : undefined;
  };
  const pages = [
    "overview",
    "groups",
    "resources",
    "databricks",
    "foundry",
    "optimization",
    "changes",
    "operations",
    "settings",
  ];
  const columns = [
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
  ];
  const filters = Object.fromEntries(
    [
      "search",
      "type",
      "region",
      "age",
      "state",
      "owner",
      "environment",
      "tag",
      "cost",
      "finding",
      "lock",
      "preset",
    ].map((key) => [key, text(input.filters?.[key])]),
  );
  const assetViews = Object.fromEntries(
    Object.entries(input.assetViews ?? {})
      .slice(-20)
      .flatMap(([id, raw]) => {
        if (!resourceId(id)) return [];
        const view = raw as any;
        return [
          [
            id,
            {
              query: text(view?.query),
              category: text(view?.category),
              index: integer(view?.index),
              candidatePage: integer(view?.candidatePage),
            },
          ],
        ];
      }),
  );
  return {
    version: 1,
    mode: settings.mode,
    cli: settings.cli,
    processScope: settings.processScope,
    page: pages.includes(input.page) ? input.page : "resources",
    scope,
    filters,
    columns: Array.isArray(input.columns)
      ? [
          ...new Set<string>(
            input.columns.filter(
              (key: unknown) =>
                typeof key === "string" && columns.includes(key),
            ),
          ),
        ]
      : [],
    sort: columns.includes(input.sort) ? input.sort : "cost",
    direction: input.direction === "asc" ? "asc" : "desc",
    tablePage: integer(input.tablePage),
    detailTab: [
      "summary",
      "origin",
      "metrics",
      "dependencies",
      "actions",
    ].includes(input.detailTab)
      ? input.detailTab
      : "origin",
    detailWidth: integer(input.detailWidth, 3000),
    selectionId: resourceId(input.selectionId),
    serviceId: resourceId(input.serviceId),
    serviceSearch: {
      databricks: text(input.serviceSearch?.databricks),
      foundry: text(input.serviceSearch?.foundry),
    },
    assetViews,
    scroll: integer(input.scroll, 10000000),
    tableScroll: integer(input.tableScroll, 10000000),
  };
}
