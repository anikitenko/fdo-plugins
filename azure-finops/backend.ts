import {
  createScopedProcessExecActionRequest,
  type StoreWithLifecycle,
} from "@anikitenko/fdo-sdk";
import type {
  Settings,
  Mode,
  Provider,
  PlanAction,
  Review,
  Operation,
  SavedView,
} from "./types.ts";
import {
  validateScope,
  validateTarget,
  normalizeId,
  reviewAction,
  fingerprint,
} from "./domain.ts";
import { normalizeExploration } from "./exploration.ts";
import { CostReadCoordinator, retryAfterMs } from "./providers/cost-policy.ts";
import { DemoProvider } from "./providers/demo.ts";
import { LiveProvider, type Cli } from "./providers/live.ts";
type Job = {
  id: string;
  mode: Mode;
  state: "running" | "done" | "error";
  result?: unknown;
  error?: string;
  touched: number;
  pending?: {
    nonce: string;
    request: unknown;
    resolve: (value: any) => void;
    reject: (error: any) => void;
    deadline: ReturnType<typeof setTimeout>;
    delivered: boolean;
  };
  operation?: Operation;
  progress?: string;
};
export const defaultSettings = (): Settings => ({
  cli: "/opt/homebrew/bin/az",
  processScope: "azure-finops",
  mode: "demo",
  views: [],
  plan: [],
  operations: [],
  demoOverrides: {},
});
export function createBackend(getStore: () => StoreWithLifecycle) {
  let settings = defaultSettings(),
    loaded = false,
    persistTail = Promise.resolve();
  const jobs = new Map<string, Job>(),
    reviews = new Map<string, Review>();
  let executing = false;
  let durableExplorationJSON: string | undefined;
  const billing = new CostReadCoordinator();
  function load() {
    if (loaded) return;
    const raw = getStore().get("settings") as Settings | undefined;
    if (raw) {
      if (
        !Array.isArray(raw.plan) ||
        !Array.isArray(raw.operations) ||
        !Array.isArray(raw.views)
      )
        throw new Error(
          "Saved settings are invalid; repair storage before proceeding.",
        );
      settings = { ...defaultSettings(), ...raw };
      settings.operations = settings.operations.map((op) =>
        op.state === "running" || op.state === "queued"
          ? {
              ...op,
              state: "unknown",
              message:
                "FDO restarted before completion was verified. Inspect Azure; no automatic retry.",
            }
          : op,
      );
    }
    const savedExploration = getStore().get("exploration");
    if (savedExploration !== undefined)
      durableExplorationJSON = JSON.stringify(savedExploration);
    loaded = true;
  }
  function persist() {
    return persistValue("settings", settings);
  }
  async function persistValue(key: string, value: unknown) {
    const snapshot = structuredClone(value);
    const next = persistTail.then(async () => {
      const encoded =
        key === "exploration" ? JSON.stringify(snapshot) : undefined;
      if (key === "exploration" && encoded === durableExplorationJSON) return;
      const store = getStore();
      if (!store.flush)
        throw new Error("Durable storage flush is unavailable.");
      store.set(key, snapshot);
      await store.flush();
      if (key === "exploration") durableExplorationJSON = encoded;
    });
    persistTail = next.catch(() => {});
    await next;
  }
  const modeOf = (input: any): Mode => {
    if (!["demo", "live"].includes(input?.mode))
      throw new Error("Choose Demo or Live.");
    return input.mode;
  };
  function current(id: string) {
    const job = jobs.get(id);
    if (!job)
      throw new Error(
        "This request expired. Refresh explicitly; mutations are never retried.",
      );
    job.touched = Date.now();
    return job;
  }
  function errorFrom(response: any) {
    const text = String(response?.result?.stderr ?? response?.error ?? ""),
      code = String(response?.code ?? "CLI_FAILED");
    const missing =
      /ENOENT|not found|not executable/i.test(text) ||
      code === "PROCESS_SPAWN_FAILED";
    const auth = /az login|please run|AADSTS|expired|not logged/i.test(text);
    const throttled =
      !missing &&
      !auth &&
      ["PROCESS_EXIT_NON_ZERO", "CLI_FAILED"].includes(code) &&
      /\b429\b|\bTooManyRequests\b|\bthrottled\b|\bthrottling\b/i.test(text);
    const invalidArgs =
      /unrecognized arguments|the following arguments are required|invalid choice|usage: az\b/i.test(
        text,
      );
    const azureDenied =
      /AuthorizationFailed|Forbidden|AuthorizationPermissionMismatch|DenyAssignmentAuthorizationFailed/i.test(
        text,
      );
    const network =
      /NameResolutionError|Failed to resolve|Temporary failure in name resolution|CERTIFICATE_VERIFY_FAILED|ConnectionError|connection refused|connection timed out/i.test(
        text,
      );
    return Object.assign(
      new Error(
        missing
          ? "Azure CLI was not found at the configured host-approved path. Install it manually or correct the path in Settings."
          : auth
            ? "Azure CLI is not authenticated for this tenant. Run az login manually outside FDO, then Check connection."
            : throttled
              ? "Azure throttled this request. Billing reads use a bounded retry/cooldown policy; resource mutations are never automatically retried."
              : invalidArgs
                ? "Azure CLI rejected the command arguments. Check the installed Azure CLI version and the host-approved argument policy; this failure was not retried."
                : azureDenied
                  ? `Azure denied this request (${code}). Check the signed-in identity's permissions for the exact target; this failure was not retried.`
                  : network
                    ? `Azure CLI could not connect to Azure (${code}). Check host connectivity, proxy and certificate configuration; this failure was not retried.`
                    : code === "ACCESS_DENIED" ||
                        /scope|argument|allowlist|capability|denied/i.test(text)
                      ? `Host or Azure access denied (${code}). See Settings → Custom capability setup. The plugin did not bypass policy.`
                      : `Azure CLI request failed (${code}). Inspect sanitized host diagnostics; no credentials or raw output were saved.`,
      ),
      {
        code,
        throttled,
        retryAfterMs: throttled ? retryAfterMs(text) : undefined,
        notFound: /ResourceNotFound|ResourceGroupNotFound/i.test(text),
        uncertain: ["TIMEOUT", "CANCELLED", "IPC_FAILURE"].includes(code),
        definitiveRejection:
          code === "ACCESS_DENIED" ||
          /AuthorizationFailed|DenyAssignmentAuthorizationFailed|ScopeLocked|RequestDisallowedByPolicy|InvalidParameter/i.test(
            text,
          ),
      },
    );
  }
  function cli(job: Job): Cli {
    // Capture configuration for the entire job; settings edits cannot retarget an in-flight command.
    const executable = settings.cli,
      scope = settings.processScope;
    return (args, reason, mutating = false) =>
      new Promise((resolve, reject) => {
        if (job.state !== "running") {
          reject(
            new Error(
              "Local request was stopped. Azure operations were not cancelled.",
            ),
          );
          return;
        }
        job.progress = `Awaiting host: ${reason}`;
        const nonce = crypto.randomUUID();
        const request = createScopedProcessExecActionRequest(scope, {
          command: executable,
          args: [...args, "--output", "json", "--only-show-errors"],
          timeoutMs: 90000,
          encoding: "utf8",
          reason,
          dryRun: false,
        });
        const deadline = setTimeout(() => {
          if (job.pending?.nonce === nonce) {
            job.pending = undefined;
            reject(
              Object.assign(
                new Error(
                  mutating
                    ? "Azure operation outcome is unknown after the host response deadline. Inspect the exact target before retrying."
                    : "Host response timed out. Refresh explicitly.",
                ),
                { uncertain: mutating },
              ),
            );
          }
        }, 180000);
        deadline.unref?.();
        job.pending = {
          nonce,
          request,
          resolve,
          reject,
          deadline,
          delivered: false,
        };
      });
  }
  const provider = (mode: Mode, job: Job): Provider =>
    mode === "demo"
      ? new DemoProvider(settings)
      : new LiveProvider(cli(job), billing, {
          namespace: JSON.stringify([settings.cli, settings.processScope]),
          active: () => job.state === "running",
          progress: (message) => {
            job.progress = message;
          },
        });
  function start(
    mode: Mode,
    work: (p: Provider, job: Job) => Promise<unknown>,
  ) {
    if (jobs.size >= 12)
      throw new Error(
        "Too many active requests. Stop polling an unused request first.",
      );
    const job: Job = {
      id: crypto.randomUUID(),
      mode,
      state: "running",
      touched: Date.now(),
    };
    jobs.set(job.id, job);
    void work(provider(mode, job), job).then(
      (result) => {
        if (job.state === "running") {
          job.result = result;
          job.state = "done";
        }
      },
      (error) => {
        job.error = error instanceof Error ? error.message : "Request failed.";
        job.state = "error";
      },
    );
    return { jobId: job.id };
  }
  async function addAction(input: any) {
    const mode = modeOf(input),
      target = validateTarget(input.target),
      kind = input.kind;
    if (
      ![
        "start",
        "restart",
        "stop",
        "deallocate",
        "tags",
        "delete",
        "resize",
      ].includes(kind)
    )
      throw new Error("This action adapter is not available.");
    if (
      kind === "resize" &&
      (typeof input.size !== "string" ||
        !/^Standard_[A-Za-z0-9_]{1,100}$/.test(input.size))
    )
      throw new Error(
        "Provide an Azure Standard VM size from validated options.",
      );
    const tags: Record<string, string> = {};
    if (kind === "tags") {
      if (
        !input.tags ||
        typeof input.tags !== "object" ||
        Array.isArray(input.tags) ||
        Object.keys(input.tags).length > 50
      )
        throw new Error("Provide up to 50 tag values.");
      for (const [k, v] of Object.entries(input.tags)) {
        if (
          !k ||
          k.startsWith("-") ||
          k.length > 512 ||
          /[<>%&\\?/]/.test(k) ||
          typeof v !== "string" ||
          v.length > 256
        )
          throw new Error("Invalid Azure tag key/value.");
        tags[k] = v;
      }
      if (!Object.keys(tags).length)
        throw new Error("Provide at least one tag to merge.");
    }
    if (settings.plan.length >= 100)
      throw new Error("Action plan limit is 100 targets.");
    if (
      settings.plan.some(
        (a) =>
          a.mode === mode &&
          normalizeId(a.target.id) === normalizeId(target.id) &&
          a.kind === kind,
      )
    )
      throw new Error("This exact action is already in the plan.");
    const action: PlanAction = {
      id: crypto.randomUUID(),
      mode,
      kind,
      target,
      ...(kind === "tags" ? { tags } : {}),
      ...(kind === "resize" ? { size: input.size } : {}),
      createdAt: new Date().toISOString(),
    };
    settings.plan.push(action);
    try {
      await persist();
    } catch (e) {
      settings.plan = settings.plan.filter((a) => a.id !== action.id);
      throw e;
    }
    reviews.clear();
    return action;
  }
  const timer = setInterval(() => {
    for (const [id, j] of jobs)
      if (Date.now() - j.touched > 240000) {
        if (j.pending) {
          clearTimeout(j.pending.deadline);
          j.pending.reject(
            Object.assign(
              new Error(
                "View lease expired. Azure operation completion is unknown; polling stopped.",
              ),
              { uncertain: true },
            ),
          );
        }
        jobs.delete(id);
      }
    for (const [id, r] of reviews)
      if (r.expires < Date.now()) reviews.delete(id);
  }, 1000);
  timer.unref?.();
  return {
    async bootstrap() {
      load();
      const saved = getStore().get("exploration");
      let exploration;
      if (saved) {
        try {
          exploration = normalizeExploration(saved, settings);
        } catch {
          /* Optional preferences from an old configuration are discarded. */
        }
      }
      return {
        settings,
        exploration,
        storage: "Durable JSON storage ready",
        hostNote:
          "Custom process scope required for the full Azure read/manage journey. Sign in manually; tokens never enter plugin storage.",
      };
    },
    async saveExploration(input: any) {
      load();
      const exploration = normalizeExploration(input?.view, settings);
      await persistValue("exploration", exploration);
      return { saved: true };
    },
    async configure(input: any) {
      load();
      if (executing || [...jobs.values()].some((j) => j.state === "running"))
        throw new Error(
          "Wait for active requests before changing the provider or CLI settings.",
        );
      if (
        !["/opt/homebrew/bin/az", "/usr/local/bin/az", "/usr/bin/az"].includes(
          input.cli,
        ) &&
        !(
          typeof input.cli === "string" &&
          (/^(?:\/[\w .-]+)+\/az$/.test(input.cli) ||
            /^[A-Z]:\\[\w \\.-]+\\az\.cmd$/i.test(input.cli))
        )
      )
        throw new Error(
          "Use an absolute az executable path approved by the host.",
        );
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.processScope))
        throw new Error(
          "Enter the host scope ID, without the capability prefix.",
        );
      billing.clear();
      settings.cli = input.cli;
      settings.processScope = input.processScope;
      settings.mode = modeOf(input);
      reviews.clear();
      await persist();
      return { saved: true };
    },
    async saveView(input: any) {
      load();
      const view = input.view as SavedView;
      if (
        typeof view?.name !== "string" ||
        !view.name.trim() ||
        view.name.length > 80 ||
        settings.views.length >= 40
      )
        throw new Error(
          "Name this view (up to 80 characters; maximum 40 views).",
        );
      const filters = Object.fromEntries(
        Object.entries(view.filters ?? {}).filter(
          ([k, v]) =>
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
            ].includes(k) &&
            typeof v === "string" &&
            v.length < 300,
        ),
      ) as Record<string, string>;
      settings.views.push({
        id: crypto.randomUUID(),
        name: view.name.trim(),
        mode: modeOf(view),
        scope: validateScope(view.scope),
        filters,
        columns: (view.columns ?? []).filter((v: any) =>
          [
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
          ].includes(v),
        ),
        sort: String(view.sort ?? "cost").slice(0, 20),
        direction: view.direction === "asc" ? "asc" : "desc",
      });
      await persist();
      return settings.views;
    },
    addAction: async (input: any) => {
      load();
      return addAction(input);
    },
    async removeAction(input: any) {
      load();
      if (executing) throw new Error("A plan is executing.");
      settings.plan = settings.plan.filter((a) => a.id !== input.id);
      reviews.clear();
      await persist();
      return settings.plan;
    },
    start(input: any) {
      load();
      const mode = modeOf(input),
        kind = input.kind;
      if (kind === "accounts") return start(mode, (p) => p.accounts());
      const scope = validateScope(input.scope);
      if (kind === "groups") return start(mode, (p) => p.groups(scope));
      if (kind === "scan") return start(mode, (p) => p.scan(scope));
      if (kind === "measure") {
        const operation = settings.operations.find(
          (o) => o.id === input.operationId && o.action.mode === mode,
        );
        if (!operation)
          throw new Error("Operation not found in this provider mode.");
        if (
          operation.action.target.tenantId !== scope.tenantId ||
          operation.action.target.subscriptionId !== scope.subscriptionId
        )
          throw new Error(
            "Measurement target differs from current tenant/subscription.",
          );
        return start(mode, async (p) => {
          operation.measurement = await p.measure(operation);
          await persist();
          return operation;
        });
      }
      if (kind === "snapshot") return start(mode, (p) => p.snapshot(scope));
      if (kind === "service") {
        const target = validateTarget(input.target, true);
        return start(mode, (p) => p.service(target, scope));
      }
      if (kind === "detail") {
        const target = validateTarget(input.target, true);
        return start(mode, (p) => p.inspect(target, scope));
      }
      if (kind === "review")
        return start(mode, async (p) => {
          const actions = settings.plan.filter((a) => a.mode === mode);
          if (!actions.length)
            throw new Error("Add an action to the plan first.");
          const items = [];
          for (const action of actions) {
            const exact = {
              ...scope,
              tenantId: action.target.tenantId,
              subscriptionId: action.target.subscriptionId,
              groupIds: [normalizeId(action.target.groupId)],
            };
            const resource = await p.inspect(action.target, exact);
            const item = reviewAction(action, resource);
            if (
              actions.filter(
                (a) =>
                  normalizeId(a.target.id) === normalizeId(action.target.id),
              ).length > 1
            )
              item.errors.push(
                "Conflicting/duplicate target operations. Keep one action per resource.",
              );
            items.push(item);
          }
          const review: Review = {
            token: crypto.randomUUID(),
            mode,
            expires: Date.now() + 300000,
            items,
            savings: [],
          };
          // No estimate is assigned to an action without a validated pricing/eligibility model.
          reviews.set(review.token, review);
          return review;
        });
      throw new Error("Unknown data request.");
    },
    execute(input: any) {
      load();
      if (executing) throw new Error("A plan is already executing.");
      const review = reviews.get(input.token);
      if (!review || review.expires < Date.now())
        throw new Error("Review expired or already used. Review again.");
      if (
        input.confirmBulk !== true ||
        review.items.some((i) => i.errors.length)
      )
        throw new Error(
          "Review every exact target and resolve validation errors.",
        );
      for (const item of review.items)
        if (input.names?.[item.action.id] !== item.action.target.name)
          throw new Error(
            `Type the exact resource name to confirm this dangerous ${item.action.kind} operation: ${item.action.target.name}`,
          );
      if (
        settings.plan.filter((a) => a.mode === review.mode).length !==
          review.items.length ||
        review.items.some(
          (i) =>
            !settings.plan.some(
              (a) =>
                a.id === i.action.id &&
                JSON.stringify(a) === JSON.stringify(i.action),
            ),
        )
      )
        throw new Error("The plan changed after review.");
      const scope = validateScope(input.scope);
      reviews.delete(review.token);
      executing = true;
      return start(review.mode, async (p, job) => {
        try {
          for (const item of review.items) {
            const action = item.action,
              exact = {
                ...scope,
                tenantId: action.target.tenantId,
                subscriptionId: action.target.subscriptionId,
                groupIds: [normalizeId(action.target.groupId)],
              };
            const op: Operation = {
              id: crypto.randomUUID(),
              action,
              state: "queued",
              startedAt: new Date().toISOString(),
              identity: "Unknown (identity lookup pending)",
              correlationIds: [],
              message: "Queued after explicit review.",
            };
            settings.operations.unshift(op);
            settings.operations = settings.operations.slice(0, 500);
            await persist();
            job.operation = op;
            try {
              const accounts = await p.accounts();
              op.identity =
                accounts.find(
                  (a) =>
                    a.tenantId === action.target.tenantId &&
                    a.id === action.target.subscriptionId,
                )?.user ?? "Unknown";
              const fresh = await p.inspect(action.target, exact),
                validation = reviewAction(action, fresh);
              if (
                validation.errors.length ||
                fingerprint(fresh) !== item.fingerprint
              ) {
                op.state = "failed";
                op.message =
                  "Resource state, locks, tags or dependencies changed since review. Review this target again.";
              } else {
                op.state = "running";
                op.message =
                  "Dispatched; waiting for Azure completion and state verification.";
                await persist();
                await p.act(action);
                await persist();
                if (await p.verify(action, exact)) {
                  op.state = "succeeded";
                  op.message =
                    "CLI completion and post-action state verified. Associated charges may remain.";
                  settings.plan = settings.plan.filter(
                    (a) => a.id !== action.id,
                  );
                } else {
                  op.state = "unknown";
                  op.message =
                    "CLI returned, but the expected final state was not verified. Inspect Azure; no automatic retry.";
                }
              }
            } catch (error) {
              op.state =
                !(error as any).definitiveRejection &&
                (op.state === "running" || (error as any).uncertain)
                  ? "unknown"
                  : "failed";
              op.message =
                error instanceof Error ? error.message : "Operation failed.";
            }
            op.endedAt = new Date().toISOString();
            await persist();
            job.operation = undefined;
          }
          return { operations: settings.operations, plan: settings.plan };
        } finally {
          executing = false;
        }
      });
    },
    poll(input: any) {
      const job = current(input.jobId);
      const pending = job.pending;
      if (pending && !pending.delivered) {
        pending.delivered = true;
        return {
          state: job.state,
          nonce: pending.nonce,
          request: pending.request,
        };
      }
      const response = {
        state: job.state,
        result: job.result,
        error: job.error,
        operations: settings.operations,
        progress: job.progress,
      };
      if (job.state !== "running") jobs.delete(job.id);
      return response;
    },
    accept(input: any) {
      const job = current(input.jobId),
        pending = job.pending;
      if (!pending || pending.nonce !== input.nonce || !pending.delivered)
        throw new Error("Stale or mismatched host response.");
      clearTimeout(pending.deadline);
      job.pending = undefined;
      job.progress = undefined;
      const response = input.response;
      if (job.operation && typeof response?.correlationId === "string")
        job.operation.correlationIds.push(response.correlationId.slice(0, 200));
      if (!response?.ok) {
        pending.reject(errorFrom(response));
        return { accepted: true };
      }
      if (response.result?.truncated) {
        pending.reject(
          new Error(
            "CLI output was truncated; narrow the scope. Incomplete data is not used as a complete result.",
          ),
        );
        return { accepted: true };
      }
      try {
        const output = response.result?.stdout;
        pending.resolve(
          typeof output === "string"
            ? output.trim()
              ? JSON.parse(output)
              : null
            : (output ?? null),
        );
      } catch {
        pending.reject(
          new Error(
            "Azure CLI returned invalid JSON. No raw output was retained.",
          ),
        );
      }
      return { accepted: true };
    },
    stop(input: any) {
      const job = current(input.jobId);
      if (job.operation || executing)
        throw new Error(
          "Stopping this view does not cancel Azure. Keep Operations open for completion, or inspect the exact target in Azure.",
        );
      if (job.pending) {
        clearTimeout(job.pending.deadline);
        job.pending.reject(new Error("Local data loading stopped."));
        job.pending = undefined;
      }
      job.state = "error";
      job.error =
        "Local data loading stopped. Azure operations were not cancelled.";
      return { stopped: true };
    },
    state() {
      load();
      return {
        plan: settings.plan,
        operations: settings.operations,
        views: settings.views,
      };
    },
  };
}
