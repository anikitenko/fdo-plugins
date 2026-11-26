import type { RequestDiagnostics } from "./diagnostics";
export type Kind = "vm" | "volume" | "public-ip";
export type Period = "month" | "last-month" | "7d" | "yesterday" | "custom";
export interface Window {
  start: string;
  end: string;
}
export interface Windows {
  current: Window;
  previous: Window;
  period: Period;
}
export interface Bill {
  cost: number | null;
  hours: number | null;
  rate: number | null;
  computeRate?: number | null;
  /** Unsplit VM bill still includes its public-IP component. */
  includesPublicIp?: boolean;
}
export interface Resource {
  key: string;
  id: number;
  kind: Kind;
  name: string;
  environment: string;
  region: string;
  state: string;
  createdAt: string | null;
  deletedAt: string | null;
  owner: string;
  origin: string;
  flavor: string;
  gpu: string;
  gpuCount: number | null;
  dependencies: string[];
  attachmentsKnown: boolean;
  hibernationSupported: boolean;
  contract: boolean;
  live: boolean;
  observedAt: string;
  current: Bill | null;
  previous: Bill | null;
  currentRate: number | null;
  billingActive: boolean;
  parent?: string;
}
export interface Finding {
  resourceKey: string;
  title: string;
  evidence: string;
  observedAt: string;
  hourlySavings: number | null;
}
export interface Snapshot {
  organizationId: number | null;
  observedAt: string;
  windows: Windows;
  resources: Resource[];
  warnings: string[];
  organizationCost: number | null;
  billingIssues?: {
    resourceKey: string;
    field: "current" | "previous";
    message: string;
    diagnostics?: RequestDiagnostics;
    retryBlocked?: "access" | "provider-data";
    attempts?: number;
    lastAttemptAt?: string;
  }[];
}
export interface Plan {
  id: string;
  organizationId: number | null;
  resourceKey: string;
  resourceId: number;
  name: string;
  kind: "hibernate" | "delete-volume";
  stagedAt: string;
  hours: number;
  retainIp: boolean;
  dependencies: string[];
  hourlySavings: number | null;
  capacity: string;
  capacityAt: string | null;
  blocked: string | null;
}
export interface Operation {
  id: string;
  plan: Plan;
  at: string;
  status: "running" | "submitted" | "completed" | "failed" | "uncertain";
  message: string;
  diagnostics?: RequestDiagnostics;
}
export interface Saved {
  version: 1;
  budget: number | null;
  metadata: Resource[];
  operations: Operation[];
}
export interface ViewState {
  configured: boolean;
  managementAllowed: boolean;
  budget: number | null;
  snapshot: Snapshot | null;
  plans: Plan[];
  operations: Operation[];
  demo: boolean;
  billingRetry?: {
    resourceKey: string;
    field: "current" | "previous";
    outcome: "restored" | "unavailable";
    message: string;
    diagnostics?: RequestDiagnostics;
  };
}
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const text = (v: unknown, fallback = "Unknown"): string =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 1000) : fallback;
export const number = (v: unknown): number | null => {
  if (
    typeof v !== "number" &&
    !(typeof v === "string" && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v))
  )
    return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export const identifier = (v: unknown): number => {
  const n = number(v);
  if (!n || !Number.isSafeInteger(n))
    throw new Error("Invalid resource identifier.");
  return n;
};
export const date = (v: unknown): string | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null;

export interface WorkProgress {
  active: boolean;
  label: string;
  completed?: number;
  total?: number;
  updatedAt: string;
}
export type ProgressUpdate = Omit<WorkProgress, "updatedAt">;
