import type {AvailabilitySnapshot} from "./logic";
import type {DeploymentService, DeploymentState, RestorationPlan} from "./deployment";

export interface RestorationQueueEntry {
  readonly plan: RestorationPlan;
  readonly state: DeploymentState;
}
const statuses = ["waiting", "creating", "submitted", "failed", "uncertain", "cancelled"];
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (status: string): string => status === "waiting" ? "Waiting for this VM's configuration."
  : status === "submitted" ? "Restore submitted. Check provisioning in Hyperstack."
  : status === "cancelled" ? "Waiting cancelled."
  : status === "failed" ? "Restoration stopped. Review this VM before adding it again."
  : "Restore outcome is unknown. Check this VM in Hyperstack; it will not be retried automatically.";

/** Independent durable entries: unavailable VMs never block other configurations. */
export function createRestorationQueue(service: DeploymentService) {
  let entries: RestorationQueueEntry[] = [];
  return {
    entries: (): RestorationQueueEntry[] => entries.map(e => ({plan: {...e.plan}, state: {...e.state}})),
    restore(input: unknown) {
      if (input === undefined) {entries = []; return;}
      if (!Array.isArray(input) || input.length > 200) throw new Error("Invalid restore queue");
      const ids = new Set<number>();
      const restored = input.map(e => {
        if (!record(e) || !record(e.plan) || !record(e.state)) throw new Error("Invalid restore entry");
        const p = e.plan;
        if (!Number.isSafeInteger(p.restoreVmId) || Number(p.restoreVmId) <= 0 || ids.has(Number(p.restoreVmId))
          || !["itemId", "name", "region", "flavor"].every(k => typeof p[k] === "string" && p[k].trim() && p[k].length <= 2048)
          || !statuses.includes(String(e.state.status))) throw new Error("Invalid restore configuration");
        ids.add(p.restoreVmId as number);
        const status = e.state.status === "creating" ? "uncertain" : e.state.status as DeploymentState["status"];
        return {plan: {restoreVmId: p.restoreVmId, itemId: p.itemId, name: p.name, region: p.region, flavor: p.flavor} as RestorationPlan,
          state: {status, vmId: p.restoreVmId as number, message: message(status)}};
      });
      entries = restored;
    },
    add(plans: RestorationPlan[]) {
      const newIds = plans.filter(p => !entries.some(e => e.plan.restoreVmId === p.restoreVmId));
      if (entries.length + newIds.length > 200) throw new Error("Restore queue full");
      for (const plan of plans) {
        const existing = entries.find(e => e.plan.restoreVmId === plan.restoreVmId);
        // Repeated clicks never rearm submitted, uncertain or already waiting VMs.
        if (existing && !["cancelled", "failed"].includes(existing.state.status)) continue;
        const next: RestorationQueueEntry = {plan: {...plan}, state: {status: "waiting", vmId: plan.restoreVmId, message: message("waiting")}};
        if (existing) entries[entries.indexOf(existing)] = next;
        else entries.push(next);
      }
    },
    cancel(vmIds?: readonly number[]) {
      entries = entries.map(e => e.state.status === "waiting" && (!vmIds || vmIds.includes(e.plan.restoreVmId))
        ? {...e, state: {status: "cancelled", vmId: e.plan.restoreVmId, message: message("cancelled")}} : e);
    },
    async onSnapshot(apiKey: string, snapshot: AvailabilitySnapshot, checkpoint: () => Promise<void>, signal?: AbortSignal, used = new Set<string>()) {
      for (let index = 0; index < entries.length; index++) {
        if (signal?.aborted) return;
        const entry = entries[index];
        if (entry.state.status !== "waiting") continue;
        const item = snapshot.items.find(i => i.id === entry.plan.itemId && i.region === entry.plan.region && i.flavor === entry.plan.flavor);
        if (!item || item.status !== "available" || used.has(item.id)) continue;
        // A boolean stock signal cannot promise capacity for several VMs. Each
        // configuration gets one attempt per fresh snapshot; others keep waiting.
        used.add(item.id);
        entries[index] = {...entry, state: {status: "creating", vmId: entry.plan.restoreVmId, message: "Submitting restore request…"}};
        try { await checkpoint(); } catch {
          entries[index] = {...entry, state: {status: "failed", vmId: entry.plan.restoreVmId, message: "Could not save the restore checkpoint. No request was sent."}};
          return;
        }
        if (signal?.aborted) return;
        try {
          entries[index] = {...entry, state: await service.create(apiKey, entry.plan, item, {signal})};
        } catch {
          entries[index] = {...entry, state: {status: "uncertain", vmId: entry.plan.restoreVmId, message: message("uncertain")}};
        }
        // Save each outcome before processing the next VM. A failed save leaves
        // a durable creating marker which becomes uncertain after restart.
        try { await checkpoint(); } catch { return; }
      }
    },
  };
}
