import type { Resource, Snapshot } from "./types";
import { windows } from "./domain";
export function demoSnapshot(now = new Date()): Snapshot {
  const w = windows("month", now),
    observedAt = now.toISOString();
  const ago = (days: number) =>
    new Date(now.getTime() - days * 86400000).toISOString();
  const item = (
    id: number,
    kind: Resource["kind"],
    name: string,
    state: string,
    cost: number,
    previous: number,
    rate: number,
    extra: Partial<Resource> = {},
  ): Resource => ({
    key: `${kind}:${id}`,
    id,
    kind,
    name,
    state,
    environment: "training",
    region: "NORWAY-1",
    createdAt: ago(12),
    deletedAt: null,
    owner: "Unknown",
    origin: "Unknown",
    flavor:
      kind === "vm"
        ? "n3-H100x1"
        : kind === "volume"
          ? "500 GB Cloud-SSD"
          : "Public IP",
    gpu: "H100",
    gpuCount: kind === "vm" ? 1 : null,
    dependencies: [],
    attachmentsKnown: true,
    hibernationSupported: true,
    contract: false,
    live: true,
    observedAt,
    current: {
      cost,
      hours: kind === "public-ip" ? null : cost / rate,
      rate,
      computeRate: kind === "vm" ? rate : null,
    },
    previous: {
      cost: previous,
      hours: kind === "public-ip" ? null : previous / rate,
      rate,
    },
    currentRate: rate,
    billingActive: true,
    ...extra,
  });
  return {
    organizationId: 999,
    windows: w,
    observedAt,
    organizationCost: 900,
    warnings: [
      "Example data · read-only. Connect your own Hyperstack account to investigate and manage resources.",
    ],
    resources: [
      item(101, "vm", "train-a100-04", "ACTIVE", 480, 300, 4, {
        flavor: "n3-A100x4",
        gpu: "A100",
        gpuCount: 4,
      }),
      item(102, "vm", "eval-h100-01", "SHUTOFF", 240, 80, 4, {
        dependencies: ["volume:201", "public-ip:102"],
      }),
      item(201, "volume", "dataset-cache", "IN-USE", 90, 85, 0.15, {
        dependencies: ["vm:102"],
      }),
      item(202, "volume", "checkpoint-archive", "AVAILABLE", 75, 65, 0.12),
      item(102, "public-ip", "eval-public-ip", "ALLOCATED", 15, 10, 0.025, {
        parent: "vm:102",
        dependencies: ["vm:102"],
      }),
      item(103, "vm", "completed-training-run", "DELETED", 0, 180, 3, {
        live: false,
        billingActive: false,
        deletedAt: ago(20),
        createdAt: ago(40),
      }),
    ],
  };
}
