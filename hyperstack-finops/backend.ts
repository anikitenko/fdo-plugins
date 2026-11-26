import { ProviderError, diagnosticText } from "./diagnostics";
import type { ProgressUpdate } from "./types";
import { randomUUID } from "node:crypto";
import type { FDO_SDK } from "@anikitenko/fdo-sdk";
import type { Operation, Plan, Resource, Saved, ViewState } from "./types";
import { number, record, text } from "./types";
import { windows } from "./domain";
import type { Provider } from "./provider";
import { demoSnapshot } from "./demo";
export interface Persistence {
  load(): Promise<unknown>;
  save(value: Saved): Promise<void>;
}
export function createBackend(options: {
  provider: Provider;
  secrets: Pick<FDO_SDK["secrets"], "get" | "set" | "delete">;
  persistence: Persistence;
  authorizeManagement(): void;
  signal?: AbortSignal;
  report?: (update: ProgressUpdate) => void;
}) {
  let snapshot: ViewState["snapshot"] = null,
    plans: Plan[] = [],
    demo = false,
    configured = false;
  let saved: Saved = { version: 1, budget: null, metadata: [], operations: [] };
  let billingRetry: ViewState["billingRetry"];
  let initialized = false;
  let chain = Promise.resolve();
  const persist = () => options.persistence.save(saved);
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(async () => {
      options.signal?.throwIfAborted();
      billingRetry = undefined;
      options.report?.({
        active: true,
        label: "Checking connection and preparing the requested operation…",
      });
      try {
        return await fn();
      } finally {
        options.report?.({ active: false, label: "Operation finished." });
      }
    });
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async function init() {
    if (initialized) return;
    const value = await options.persistence.load();
    if (value !== undefined && value !== null) {
      if (
        !record(value) ||
        value.version !== 1 ||
        !Array.isArray(value.metadata) ||
        !Array.isArray(value.operations) ||
        value.metadata.length > 20000 ||
        value.operations.length > 1000 ||
        (value.budget !== null &&
          (typeof value.budget !== "number" || number(value.budget) === null))
      )
        throw new Error(
          "Saved FinOps data is invalid. Restore plugin storage before executing operations.",
        );
      // Metadata is only a reporting aid. Persisted operations are never replayed.
      if (
        !value.metadata.every(
          (r) =>
            record(r) && typeof r.key === "string" && typeof r.id === "number",
        ) ||
        !value.operations.every(
          (o) =>
            record(o) &&
            typeof o.id === "string" &&
            record(o.plan) &&
            typeof o.plan.resourceKey === "string" &&
            [
              "running",
              "submitted",
              "completed",
              "failed",
              "uncertain",
            ].includes(String(o.status)),
        )
      )
        throw new Error(
          "Saved operations are invalid. Restore plugin storage.",
        );
      saved = value as unknown as Saved;
      saved.operations = saved.operations.map((o) =>
        o.status === "running"
          ? {
              ...o,
              status: "uncertain",
              message:
                "Backend restarted during execution. Verify in Hyperstack; this operation will not be retried.",
            }
          : o,
      );
      await persist();
    }
    configured = Boolean(
      await options.secrets.get("hyperstack-finops.api-key"),
    );
    initialized = true;
  }
  async function key() {
    const v = await options.secrets.get("hyperstack-finops.api-key");
    if (typeof v !== "string" || !v.trim())
      throw new Error("Save a Hyperstack API key in Connection first.");
    return v;
  }
  function state(): ViewState {
    let managementAllowed = false;
    try {
      options.authorizeManagement();
      managementAllowed = true;
    } catch {
      /* FDO grants may be revoked while the view is open. */
    }
    return {
      configured,
      managementAllowed,
      budget: saved.budget,
      snapshot,
      plans,
      operations: saved.operations,
      demo,
      ...(billingRetry ? { billingRetry } : {}),
    };
  }
  function resource(input: unknown): Resource {
    if (!record(input) || typeof input.resourceKey !== "string")
      throw new Error("Select a resource first.");
    const r = snapshot?.resources.find((r) => r.key === input.resourceKey);
    if (!r)
      throw new Error(
        "Resource is no longer in this report. Sync and select it again.",
      );
    return r;
  }
  function blocked(r: Resource, kind: Plan["kind"]): string | null {
    if (!r.live || r.state === "DELETED")
      return "Historical or deleted resources cannot be changed.";
    if (!r.attachmentsKnown)
      return "Dependencies could not be verified. Sync and review again.";
    if (kind === "hibernate") {
      if (r.kind !== "vm") return "Only VMs can be hibernated.";
      if (r.state !== "ACTIVE")
        return "Hyperstack requires an ACTIVE VM to hibernate. Review its state in Hyperstack first; this plugin will not start it automatically.";
      if (!r.hibernationSupported)
        return "This flavor has not confirmed hibernation support.";
      if (r.contract)
        return "Contract billing may continue. Review the reservation terms in Hyperstack before changing this VM.";
    } else if (
      r.kind !== "volume" ||
      r.state !== "AVAILABLE" ||
      r.dependencies.length
    )
      return "Only verified detached AVAILABLE volumes can be deleted.";
    return null;
  }
  return {
    state: () =>
      exclusive(async () => {
        await init();
        return state();
      }),
    configure: (input: unknown) =>
      exclusive(async () => {
        await init();
        if (!record(input)) throw new Error("Invalid connection settings.");
        if (input.remove === true) {
          await options.secrets.delete("hyperstack-finops.api-key");
          configured = false;
        } else {
          if (
            typeof input.apiKey !== "string" ||
            !input.apiKey.trim() ||
            input.apiKey.length > 4096 ||
            /[\r\n]/.test(input.apiKey)
          )
            throw new Error("Enter a valid API key.");
          await options.secrets.set(
            "hyperstack-finops.api-key",
            input.apiKey.trim(),
          );
          configured = true;
        }
        snapshot = null;
        plans = [];
        demo = false;
        saved.metadata = [];
        await persist();
        return state();
      }),
    budget: (input: unknown) =>
      exclusive(async () => {
        await init();
        if (
          !record(input) ||
          (input.budget !== null &&
            (typeof input.budget !== "number" || number(input.budget) === null))
        )
          throw new Error("Budget must be a nonnegative USD amount.");
        saved.budget = input.budget as number | null;
        await persist();
        return state();
      }),
    sync: (input: unknown) =>
      exclusive(async () => {
        await init();
        const period = record(input) ? input.period : "month";
        if (
          !["month", "last-month", "7d", "yesterday", "custom"].includes(
            String(period),
          )
        )
          throw new Error("Invalid reporting period.");
        options.report?.({
          active: true,
          label: "Loading selected and previous billing ranges…",
        });
        const next = await options.provider.load(
          await key(),
          windows(
            period as import("./types").Period,
            new Date(),
            record(input) &&
              typeof input.start === "string" &&
              typeof input.end === "string"
              ? { start: input.start, end: input.end }
              : undefined,
          ),
          saved.metadata,
        );
        options.signal?.throwIfAborted();
        snapshot = next;
        demo = false;
        plans = [];
        for (const operation of saved.operations) {
          const r = next.resources.find(
            (r) => r.key === operation.plan.resourceKey,
          );
          if (
            operation.plan.organizationId === next.organizationId &&
            ["submitted", "uncertain"].includes(operation.status) &&
            r &&
            (operation.plan.kind === "hibernate"
              ? r.live && r.state === "HIBERNATED"
              : r.state === "DELETED" && r.deletedAt !== null)
          ) {
            operation.status = "completed";
            operation.message = `Provider confirmed ${r.state} during Sync at ${next.observedAt}.`;
          }
        }
        options.report?.({
          active: true,
          label: "Saving billing report and historical resource metadata…",
        });
        const metadata = new Map(saved.metadata.map((r) => [r.key, r]));
        for (const r of next.resources) metadata.set(r.key, r);
        saved.metadata = [...metadata.values()].slice(-20000);
        await persist();
        return state();
      }),
    retryBilling: (input: unknown) =>
      exclusive(async () => {
        await init();
        if (demo)
          throw new Error(
            "Example data is read-only. Connect and Sync to retry real billing reads.",
          );
        const r = resource(input);
        if (
          !record(input) ||
          !["current", "previous"].includes(String(input.field))
        )
          throw new Error("Invalid billing interval.");
        const field = input.field as "current" | "previous";
        options.report?.({
          active: true,
          label: `Retrying ${field === "current" ? "selected-date" : "previous-range"} billing for ${r.kind} #${r.id}…`,
        });
        let bill: import("./types").Bill;
        try {
          bill = await options.provider.billing(
            await key(),
            r,
            snapshot!.windows[field],
          );
          if (
            typeof bill.cost !== "number" ||
            !Number.isFinite(bill.cost) ||
            bill.cost < 0
          )
            throw new Error(
              "Invalid provider cost: the retry did not return a usable amount.",
            );
        } catch (error) {
          const diagnostics =
            error instanceof ProviderError ? error.diagnostics : undefined;
          const message = diagnostics
            ? diagnosticText(diagnostics)
            : error instanceof Error &&
                /^(Invalid provider|Billing detail|Hyperstack)/.test(
                  error.message,
                )
              ? error.message
              : "The provider did not return usable billing data for this read.";
          const previous = snapshot!.billingIssues?.find(
            (i) => i.resourceKey === r.key && i.field === field,
          );
          const issue = {
            resourceKey: r.key,
            field,
            message,
            ...(diagnostics && [401, 403].includes(diagnostics.httpStatus)
              ? { retryBlocked: "access" as const }
              : /^(Invalid provider|Billing detail)/.test(message)
                ? { retryBlocked: "provider-data" as const }
                : {}),
            attempts: (previous?.attempts ?? 0) + 1,
            lastAttemptAt: new Date().toISOString(),
            ...(diagnostics ? { diagnostics } : {}),
          };
          snapshot!.billingIssues = [
            ...(snapshot!.billingIssues ?? []).filter(
              (i) => !(i.resourceKey === r.key && i.field === field),
            ),
            issue,
          ];
          billingRetry = {
            resourceKey: r.key,
            field,
            outcome: "unavailable",
            message: `Bill still unavailable for ${r.name}. The retry returned no usable amount; its latest outcome is shown in Billing coverage.`,
            ...(diagnostics ? { diagnostics } : {}),
          };
          return state();
        }
        r[field] = bill;
        // A retried VM detail is a full bill: normalize both ranges before comparing.
        const vm =
          r.kind === "vm"
            ? r
            : r.parent
              ? snapshot!.resources.find((p) => p.key === r.parent)
              : undefined;
        if (
          vm &&
          (vm.current?.includesPublicIp || vm.previous?.includesPublicIp)
        ) {
          const ip = snapshot!.resources.find(
            (p) => p.parent === vm.key && p.kind === "public-ip",
          );
          for (const f of ["current", "previous"] as const)
            if (vm[f]?.cost != null) {
              if (!vm[f]!.includesPublicIp && ip?.[f]?.cost != null)
                vm[f]!.cost! += ip[f]!.cost!;
              vm[f]!.includesPublicIp = true;
              vm[f]!.rate = vm[f]!.hours ? vm[f]!.cost! / vm[f]!.hours! : null;
            }
        }
        snapshot!.billingIssues = snapshot!.billingIssues?.filter(
          (i) => !(i.resourceKey === r.key && i.field === field),
        );
        saved.metadata = saved.metadata
          .filter((p) => p.key !== r.key)
          .concat(r);
        await persist();
        billingRetry = {
          resourceKey: r.key,
          field,
          outcome: "restored",
          message: `Billing data restored for ${r.name}: ${field === "current" ? "selected dates" : "previous range"}. The report and comparison have been recalculated.`,
        };
        return state();
      }),
    demo: () =>
      exclusive(async () => {
        await init();
        snapshot = demoSnapshot();
        demo = true;
        plans = [];
        return state();
      }),
    stage: (input: unknown) =>
      exclusive(async () => {
        await init();
        if (demo)
          throw new Error(
            "Example data is read-only. Connect and Sync to manage real resources.",
          );
        const r = resource(input);
        if (!record(input)) throw new Error("Invalid plan.");
        const kind = input.kind;
        if (kind !== "hibernate" && kind !== "delete-volume")
          throw new Error("Unsupported operation.");
        const hours = number(input.hours);
        if (hours === null || hours <= 0 || hours > 8760)
          throw new Error("Planned pause must be between 0 and 8760 hours.");
        if (typeof input.retainIp !== "boolean")
          throw new Error("Choose whether to retain the public IP.");
        options.report?.({
          active: true,
          label: `Verifying ${r.kind} #${r.id} state and attachments before staging…`,
        });
        const fresh =
          r.live && r.kind !== "public-ip"
            ? await options.provider.inspect(await key(), r)
            : r;
        const p: Plan = {
          id: randomUUID(),
          organizationId: snapshot!.organizationId,
          resourceKey: r.key,
          resourceId: r.id,
          name: r.name,
          kind,
          hours,
          retainIp: input.retainIp,
          stagedAt: new Date().toISOString(),
          dependencies: [...fresh.dependencies].sort(),
          hourlySavings: r.contract
            ? null
            : kind === "hibernate"
              ? (r.current?.computeRate ?? null)
              : r.currentRate,
          capacity: "Not checked; resume capacity is not guaranteed",
          capacityAt: null,
          blocked:
            snapshot!.organizationId === null
              ? "Organization identity is Unknown. Sync before executing management operations."
              : blocked(fresh, kind),
        };
        plans = [...plans.filter((p) => p.resourceKey !== r.key), p];
        return state();
      }),
    unstage: (input: unknown) =>
      exclusive(async () => {
        if (record(input)) plans = plans.filter((p) => p.id !== input.planId);
        return state();
      }),
    capacity: (input: unknown) =>
      exclusive(async () => {
        const p = plans.find((p) => record(input) && p.id === input.planId);
        if (!p) throw new Error("Stage a plan first.");
        const r = resource({ resourceKey: p.resourceKey });
        p.capacity = await options.provider.capacity(await key(), r);
        p.capacityAt = new Date().toISOString();
        return state();
      }),
    execute: (input: unknown) =>
      exclusive(async () => {
        await init();
        options.authorizeManagement();
        if (demo || !record(input) || input.confirm !== true)
          throw new Error("Review the plan and acknowledge its impact first.");
        const p = plans.find((p) => p.id === input.planId);
        if (!p) throw new Error("Plan is no longer available. Stage it again.");
        if (Date.now() - Date.parse(p.stagedAt) > 15 * 60000)
          throw new Error("Plan expired. Stage and review a fresh plan.");
        if (
          p.organizationId === null ||
          snapshot?.organizationId !== p.organizationId
        )
          throw new Error(
            "Resource organization changed. Sync and review a new plan.",
          );
        if (
          saved.operations.some(
            (o) =>
              o.plan.organizationId === p.organizationId &&
              o.plan.resourceKey === p.resourceKey &&
              ["running", "uncertain", "submitted"].includes(o.status),
          )
        )
          throw new Error(
            "A previous operation may already be applied. Verify it in Hyperstack; automatic retry is blocked.",
          );
        options.report?.({
          active: true,
          label:
            "Revalidating organization, resource state and dependencies before execution…",
        });
        const apiKey = await key();
        if (
          (await options.provider.organization(
            apiKey,
            snapshot!.windows.current,
          )) !== p.organizationId
        )
          throw new Error(
            "Resource organization changed. Reconnect and review a new plan.",
          );
        const fresh = await options.provider.inspect(
          apiKey,
          resource({ resourceKey: p.resourceKey }),
        );
        const reason = blocked(fresh, p.kind);
        if (reason) throw new Error(reason);
        if (
          JSON.stringify([...fresh.dependencies].sort()) !==
          JSON.stringify(p.dependencies)
        )
          throw new Error("Dependencies changed. Stage and review a new plan.");
        if (
          p.kind === "delete-volume" &&
          input.confirmResourceId !== String(p.resourceId)
        )
          throw new Error(
            "Type the exact volume ID to confirm permanent deletion.",
          );
        const operation: Operation = {
          id: randomUUID(),
          plan: structuredClone(p),
          at: new Date().toISOString(),
          status: "running",
          message: "Submitting request to Hyperstack.",
        };
        if (saved.operations.length >= 1000)
          throw new Error(
            "Operation audit log is full. Export and archive plugin storage before further operations.",
          );
        saved.operations.push(operation);
        // A durable consumed marker must precede any management request.
        try {
          await persist();
        } catch {
          saved.operations.pop();
          throw new Error(
            "Could not persist operation checkpoint. No request was sent.",
          );
        }
        plans = plans.filter((plan) => plan.id !== p.id);
        options.report?.({
          active: true,
          label: "Operation checkpoint saved. Submitting the reviewed request…",
        });
        let dispatched = false;
        try {
          options.signal?.throwIfAborted();
          options.authorizeManagement();
          dispatched = true;
          await options.provider.execute(
            apiKey,
            p.kind,
            p.resourceId,
            p.retainIp,
          );
          operation.status = "submitted";
          operation.message =
            "Hyperstack accepted the request. Sync to inspect the resulting state; completion is not yet confirmed.";
        } catch (error) {
          const denied =
            error instanceof ProviderError &&
            [400, 401, 403, 404, 422].includes(error.diagnostics.httpStatus);
          if (error instanceof ProviderError)
            operation.diagnostics = error.diagnostics;
          operation.status = dispatched && !denied ? "uncertain" : "failed";
          operation.message =
            denied && error instanceof ProviderError
              ? `${error.message} ${diagnosticText(error.diagnostics)} No successful mutation was confirmed.`
              : dispatched
                ? "Submission could not be confirmed. Verify this resource in Hyperstack before any further action. This operation will not be retried."
                : "Permission was revoked or the backend stopped before dispatch. No request was sent.";
        }
        try {
          await persist();
        } catch {
          operation.status = "uncertain";
          operation.message =
            "Outcome could not be saved. Verify the resource in Hyperstack; the durable checkpoint prevents retry after restart.";
        }
        return state();
      }),
  };
}
