import { actionArgs } from "./actions.ts";
import type {
  Scope,
  Target,
  Charge,
  Resource,
  PlanAction,
  ReviewItem,
  Snapshot,
} from "./types.ts";
export const normalizeId = (id: string) => id.replace(/\/+$/, "").toLowerCase();
export const DAY = 86400000;
export function validateScope(input: any): Scope {
  if (
    !input ||
    !/^[a-f\d-]{36}$/i.test(input.tenantId) ||
    !/^[a-f\d-]{36}$/i.test(input.subscriptionId) ||
    !Array.isArray(input.groupIds) ||
    input.groupIds.length > 200 ||
    !["ActualCost", "AmortizedCost"].includes(input.basis)
  )
    throw new Error("Choose a valid tenant, subscription and cost basis.");
  const prefix =
    `/subscriptions/${input.subscriptionId}/resourcegroups/`.toLowerCase();
  if (
    input.groupIds.some(
      (id: any) =>
        typeof id !== "string" ||
        !normalizeId(id).startsWith(prefix) ||
        id.slice(prefix.length).includes("/"),
    )
  )
    throw new Error(
      "Resource groups must belong to the selected subscription.",
    );
  const from = Date.parse(input.from),
    to = Date.parse(input.to);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to ||
    to - from > 366 * DAY
  )
    throw new Error("Choose a date range of up to 366 days.");
  return {
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    groupIds: [...new Set<string>(input.groupIds.map(normalizeId))],
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    basis: input.basis,
  };
}
export function validateTarget(target: any, allowChildren = false): Target {
  if (
    !target ||
    !["tenantId", "subscriptionId", "id", "groupId", "type", "name"].every(
      (k) =>
        typeof target[k] === "string" &&
        target[k].length > 0 &&
        !/[\x00-\x1f\x7f]/.test(target[k]) &&
        target[k].length < 2048,
    )
  )
    throw new Error("Invalid action target.");
  const prefix =
      `/subscriptions/${target.subscriptionId}/resourcegroups/`.toLowerCase(),
    id = normalizeId(target.id),
    group = normalizeId(target.groupId);
  if (
    !/^[a-f\d-]{36}$/i.test(target.tenantId) ||
    !/^[a-f\d-]{36}$/i.test(target.subscriptionId) ||
    !group.startsWith(prefix) ||
    !id.startsWith(group + "/providers/") ||
    group.slice(prefix.length).includes("/") ||
    (!allowChildren && !id.endsWith("/" + target.name.toLowerCase()))
  )
    throw new Error(
      "Action target identity does not match its subscription/resource group.",
    );
  const resourcePart = id.slice((group + "/providers/").length).split("/");
  const types = [
    resourcePart[0],
    ...resourcePart.filter((_, i) => i % 2 === 1),
  ].join("/");
  const names = resourcePart.filter((_, i) => i >= 2 && i % 2 === 0);
  if (
    resourcePart.length < 3 ||
    resourcePart.length % 2 !== 1 ||
    types !== target.type.toLowerCase() ||
    (!allowChildren && resourcePart.length !== 3) ||
    (allowChildren &&
      ![names.at(-1), names.join("/")].includes(target.name.toLowerCase()))
  )
    throw new Error(
      "Only matching ARM resource identities are inspectable; only top-level supported identities are actionable.",
    );
  return {
    tenantId: target.tenantId,
    subscriptionId: target.subscriptionId,
    id: target.id,
    name: target.name,
    groupId: target.groupId,
    type: target.type,
  };
}
export function previousPeriod(scope: Scope): Scope {
  const duration = Date.parse(scope.to) - Date.parse(scope.from) + 1;
  return {
    ...scope,
    from: new Date(Date.parse(scope.from) - duration).toISOString(),
    to: new Date(Date.parse(scope.from) - 1).toISOString(),
  };
}
export function totals(
  charges: Charge[],
): { currency: string; amount: number }[] {
  const sums = new Map<string, number>();
  for (const c of charges)
    sums.set(c.currency, (sums.get(c.currency) ?? 0) + c.amount);
  return [...sums].map(([currency, amount]) => ({ currency, amount }));
}
export function changes(now: Charge[], before: Charge[]) {
  const rows = new Map<
    string,
    {
      id: string | null;
      service: string;
      currency: string;
      current: number;
      previous: number;
    }
  >();
  for (const [list, field] of [
    [now, "current"],
    [before, "previous"],
  ] as const)
    for (const c of list) {
      const key = `${c.currency}|${normalizeId(c.resourceId || "")}|${c.service}`;
      const row = rows.get(key) ?? {
        id: c.resourceId,
        service: c.service,
        currency: c.currency,
        current: 0,
        previous: 0,
      };
      row[field] += c.amount;
      rows.set(key, row);
    }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      delta: row.current - row.previous,
      percent:
        row.previous > 0
          ? ((row.current - row.previous) / row.previous) * 100
          : null,
      category:
        row.previous === 0 && row.current > 0
          ? "Newly billed"
          : row.current === 0 && row.previous > 0
            ? "No longer billed"
            : row.current > row.previous
              ? "Increased"
              : row.current < row.previous
                ? "Decreased"
                : "Unchanged",
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
export function fingerprint(resource: Resource | null): string {
  return JSON.stringify(
    resource && [
      normalizeId(resource.id),
      resource.type.toLowerCase(),
      resource.state,
      resource.sku,
      resource.etag,
      resource.attached,
      resource.tags,
      resource.locks,
      resource.lockCoverage,
      resource.dependencies,
      resource.dependencyCoverage,
      resource.deleteOptions,
    ],
  );
}
export const impacts: Record<string, { impact: string; remaining: string }> = {
  resize: {
    impact:
      "Changes VM size while deallocated. Downtime is required; temporary data and allocation may change. Starting it later resumes charges at the new size. Capacity is not guaranteed.",
    remaining:
      "Managed disks, IPs, backups and other resources remain and may continue billing. No automatic start or controller conversion.",
  },
  start: {
    impact: "Starts the VM; compute charges resume.",
    remaining: "Existing disks, IPs and other attached resources remain.",
  },
  restart: {
    impact: "Reboots the VM; downtime is expected. Compute remains allocated.",
    remaining: "Compute, disk and network charges continue.",
  },
  stop: {
    impact:
      "Powers off the guest. The VM stays allocated and compute billing can continue.",
    remaining: "Disks, IPs and allocated compute can still be billed.",
  },
  deallocate: {
    impact:
      "Stops the VM and releases compute allocation. Temporary storage and dynamic IPs may change.",
    remaining:
      "Managed disks, public IPs, backups and other resources can continue billing.",
  },
  tags: {
    impact: "Merges the reviewed tags; existing unedited tags are retained.",
    remaining: "No resource deletion or immediate cost reduction.",
  },
  delete: {
    impact:
      "Permanently deletes this exact resource. There is no general undo.",
    remaining:
      "Related resources are retained; their charges may continue. No locks are removed and nothing is force-detached.",
  },
};
export function reviewAction(
  action: PlanAction,
  resource: Resource | null,
): ReviewItem {
  const errors: string[] = [];
  const type = action.target.type.toLowerCase(),
    vm = type === "microsoft.compute/virtualmachines";
  if (
    ![
      "start",
      "restart",
      "stop",
      "deallocate",
      "tags",
      "delete",
      "resize",
    ].includes(action.kind)
  )
    errors.push("Unsupported action.");
  if (!resource) errors.push("Resource is missing or inaccessible.");
  if (
    resource &&
    (normalizeId(resource.id) !== normalizeId(action.target.id) ||
      resource.subscriptionId !== action.target.subscriptionId ||
      resource.tenantId !== action.target.tenantId ||
      resource.type.toLowerCase() !== type)
  )
    errors.push("Resource identity changed.");
  if (resource && !resource.lockCoverage)
    errors.push(
      "Inherited/resource lock discovery is incomplete. Resolve this before execution.",
    );
  if (resource?.locks.length)
    errors.push(
      "Resource or parent scope has locks; review them in Azure. Locks are never removed automatically.",
    );
  if (!vm && ["start", "restart", "stop", "deallocate"].includes(action.kind))
    errors.push("Power operations require a VM.");
  if (action.kind === "resize") {
    if (!vm) errors.push("Resize requires a VM.");
    if (!resource?.resize || resource.resize.errors.length)
      errors.push(
        ...(resource?.resize?.errors ?? [
          "Resize compatibility and quota checks unavailable.",
        ]),
      );
    if (!resource?.resize?.options.some((o) => o.name === action.size))
      errors.push(
        "Requested size did not pass current compatibility, quota and placement checks.",
      );
    if (!resource || !/deallocated/i.test(resource.state))
      errors.push("VM must remain deallocated before resize.");
  }
  if (action.kind === "delete") {
    if (
      ![
        "microsoft.compute/virtualmachines",
        "microsoft.compute/disks",
        "microsoft.network/publicipaddresses",
      ].includes(type)
    )
      errors.push("Deletion adapter is not available for this type.");
    if (!vm && resource?.attached !== false)
      errors.push(
        "Attachment state must be verified as unassociated before deletion.",
      );
    if (
      vm &&
      (!resource?.deleteOptions?.length ||
        resource.deleteOptions.some(
          (option) => option.toLowerCase() !== "detach",
        ))
    )
      errors.push(
        "VM disk/NIC delete options must all be verified as Detach to preserve related resources.",
      );
  }
  return {
    action,
    resource,
    errors,
    ...impacts[action.kind],
    fingerprint: fingerprint(resource),
    command: actionArgs(action),
  };
}
export function savings(snapshot: Snapshot, ids?: Set<string>) {
  const best = new Map<string, { currency: string; amount: number }>();
  for (const f of snapshot.findings)
    if (
      f.savings != null &&
      f.currency &&
      (!ids || ids.has(normalizeId(f.target.id)))
    ) {
      const key = `${f.currency}|${f.overlapKey}`,
        prior = best.get(key);
      if (!prior || prior.amount < f.savings)
        best.set(key, { currency: f.currency, amount: f.savings });
    }
  const total = new Map<string, number>();
  for (const row of best.values())
    total.set(row.currency, (total.get(row.currency) ?? 0) + row.amount);
  return [...total].map(([currency, amount]) => ({ currency, amount }));
}
export function csv(rows: Record<string, unknown>[], columns: string[]) {
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return [
    columns.map(cell).join(","),
    ...rows.map((row) => columns.map((key) => cell(row[key])).join(",")),
  ].join("\r\n");
}
