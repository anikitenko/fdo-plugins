export type Mode = "demo" | "live";
export type Basis = "ActualCost" | "AmortizedCost";
export type Scope = {
  tenantId: string;
  subscriptionId: string;
  groupIds: string[];
  from: string;
  to: string;
  basis: Basis;
};
export type Account = {
  tenantId: string;
  id: string;
  name: string;
  user: string;
};
export type Evidence<T = string> = {
  value: T | null;
  confidence: "Verified" | "Inferred" | "Unknown";
  source: string;
  explanation?: string;
};
export type Target = {
  tenantId: string;
  subscriptionId: string;
  id: string;
  name: string;
  type: string;
  groupId: string;
};
export type Resource = Target & {
  kind?: string;
  location: string;
  sku: string | null;
  state: string;
  tags: Record<string, string>;
  etag?: string;
  created: Evidence;
  modified?: Evidence;
  activityCoverage?: {
    from: string;
    to: string;
    events: number;
    writes: number;
    complete: boolean;
  };
  creator: Evidence;
  provisioning: Evidence;
  firstObserved: string;
  events: { at: string; title: string; source: string }[];
  dependencies: { id: string; relation: string }[];
  gaps: string[];
  locks: string[];
  lockCoverage: boolean;
  creatorName?: Evidence;
  dependencyCoverage?: string[];
  resize?: {
    options: { name: string; cores: number; memoryGB: number }[];
    checkedAt: string;
    errors: string[];
  };
  signals?: {
    name: string;
    value: number | null;
    unit: string;
    samples: number;
    expected: number;
    from: string;
    to: string;
    explanation: string;
  }[];
  metrics?: {
    cpu: number | null;
    samples: number;
    expected: number;
    from: string;
    to: string;
  };
  attached: boolean | null;
  deleteOptions?: string[];
  historyCoverage: string;
};
export type Group = {
  id: string;
  name: string;
  subscriptionId: string;
  location: string;
  tags: Record<string, string>;
  created: Evidence;
  locks: string[];
};
export type Charge = {
  resourceId: string | null;
  groupId: string | null;
  service: string;
  region: string;
  day: string;
  currency: string;
  amount: number;
  tags: Record<string, string>;
};
export type Finding = {
  id: string;
  target: Target;
  title: string;
  source: string;
  evidence: string;
  confidence: string;
  window: string;
  missing: string[];
  savings: number | null;
  currency: string | null;
  basis: string;
  overlapKey: string;
  suggested: string;
};
export type Budget = {
  name: string;
  scopeId: string;
  amount: number;
  currency: string | null;
  spent: number | null;
  period: string;
};
export type Snapshot = {
  scope: Scope;
  now: string;
  fetchedAt: string;
  resources: Resource[];
  groups: Group[];
  costs: Charge[];
  previous: Charge[];
  mtd: Charge[];
  budgets: Budget[];
  findings: Finding[];
  forecast: { amount: number; currency: string; basis: string }[];
  anomalies?: {
    source: string;
    day: string;
    currency: string;
    amount: number;
    expected: number;
    threshold: number;
    explanation: string;
  }[];
  anomalyAlerts?: { name: string; status: string; scopeId: string }[];
  warnings: string[];
  coverage: Record<string, string>;
  breakdowns?: Record<
    string,
    { name: string; amount: number; currency: string }[]
  >;
};
export type ActionKind =
  "start" | "restart" | "stop" | "deallocate" | "tags" | "delete" | "resize";
export type PlanAction = {
  id: string;
  mode: Mode;
  kind: ActionKind;
  target: Target;
  tags?: Record<string, string>;
  size?: string;
  createdAt: string;
};
export type ReviewItem = {
  action: PlanAction;
  resource: Resource | null;
  errors: string[];
  impact: string;
  remaining: string;
  fingerprint: string;
  command: string[];
};
export type Review = {
  token: string;
  expires: number;
  mode: Mode;
  items: ReviewItem[];
  savings: { currency: string; amount: number }[];
};
export type Operation = {
  id: string;
  action: PlanAction;
  state: "queued" | "running" | "succeeded" | "failed" | "unknown";
  startedAt: string;
  endedAt?: string;
  identity: string;
  correlationIds: string[];
  message: string;
  projectedSavings?: number;
  currency?: string;
  measurement?: {
    basis: Basis;
    baselineFrom: string;
    baselineTo: string;
    postFrom: string;
    postTo: string;
    measuredAt: string;
    rows: {
      currency: string;
      baseline: number;
      post: number;
      change: number;
    }[];
    explanation: string;
  };
};
export type SavedView = {
  id: string;
  name: string;
  mode: Mode;
  scope: Scope;
  filters: Record<string, string>;
  columns: string[];
  sort: string;
  direction: string;
};
export type Settings = {
  cli: string;
  processScope: string;
  mode: Mode;
  views: SavedView[];
  plan: PlanAction[];
  operations: Operation[];
  demoOverrides: Record<string, Partial<Resource> & { deleted?: boolean }>;
};
export interface Provider {
  accounts(): Promise<Account[]>;
  groups(scope: Scope): Promise<Group[]>;
  snapshot(scope: Scope): Promise<Snapshot>;
  inspect(target: Target, scope: Scope): Promise<Resource | null>;
  service(target: Target, scope: Scope): Promise<ServiceInspection>;
  act(action: PlanAction): Promise<void>;
  verify(action: PlanAction, scope: Scope): Promise<boolean>;
  scan(scope: Scope): Promise<Snapshot>;
  measure(operation: Operation): Promise<NonNullable<Operation["measurement"]>>;
}

export type ServiceInspection = {
  kind: "databricks" | "foundry";
  target: Target;
  observedAt: string;
  from: string;
  to: string;
  basis: Basis;
  facts: { name: string; value: string; source: string }[];
  coverage: {
    name: string;
    state: "Available" | "Partial" | "Unavailable";
    explanation: string;
  }[];
  assets: {
    id: string;
    armId?: string;
    name: string;
    category: string;
    created?: Evidence;
    modified?: Evidence;
    state: string;
    configuration: string;
    source: string;
    url?: string;
  }[];
  signals: {
    assetId: string | null;
    metric: string;
    value: number | null;
    unit: string;
    samples: number;
    expected: number;
    from: string;
    to: string;
    source: string;
  }[];
  candidates: {
    assetId: string;
    title: string;
    evidence: string;
    missing: string[];
    suggested: string;
    confidence: string;
  }[];
  relatedCosts: { scopeId: string; explanation: string; costs: Charge[] }[];
  limitations: string[];
};
