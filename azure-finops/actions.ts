import type { PlanAction } from "./types.ts";
/** Shared by review preview and dispatch; no shell interpolation. */
export function actionArgs(action: PlanAction): string[] {
  const sub = ["--subscription", action.target.subscriptionId],
    id = action.target.id,
    type = action.target.type.toLowerCase();
  if (action.kind === "resize")
    return ["vm", "resize", "--ids", id, "--size", action.size!, ...sub];
  if (action.kind === "tags")
    return [
      "tag",
      "update",
      "--resource-id",
      id,
      "--operation",
      "Merge",
      "--tags",
      ...Object.entries(action.tags ?? {}).map(([k, v]) => `${k}=${v}`),
      ...sub,
    ];
  if (action.kind === "delete")
    return type === "microsoft.compute/virtualmachines"
      ? ["vm", "delete", "--ids", id, "--yes", ...sub]
      : type === "microsoft.compute/disks"
        ? ["disk", "delete", "--ids", id, "--yes", ...sub]
        : ["network", "public-ip", "delete", "--ids", id, ...sub];
  return ["vm", action.kind, "--ids", id, ...sub];
}
