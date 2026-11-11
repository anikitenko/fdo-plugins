import type {AvailabilityItem} from "./logic";
import type {DeploymentResult, RestorationPlan} from "./deployment";
import {withRequestLifetime} from "./request-lifetime";

const API = "https://infrahub-api.nexgencloud.com/v1/core/virtual-machines";
type VmFetch = (url: string, init: RequestInit) => Promise<{ok: boolean; status: number; json(): Promise<unknown>}>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export interface HibernatedVm {
  id: number;
  name: string;
  region: string;
  flavor: string;
  gpu: string;
  gpuCount: number;
}
export type HibernatedResult = {ok: true; vms: HibernatedVm[]} | {ok: false; message: string};

/** Only public identity and hardware metadata cross the UI bridge. */
export function readHibernatedVm(v: unknown): HibernatedVm {
  if (!record(v) || v.status !== "HIBERNATED" || !Number.isSafeInteger(v.id) || Number(v.id) <= 0
    || !record(v.environment) || !record(v.flavor)) throw new Error("Invalid hibernated VM");
  const {name, gpu, gpu_count: gpuCount} = v.flavor;
  const region = v.environment.region;
  if (![v.name, name, gpu, region].every(s => typeof s === "string" && s.trim() && s.length <= 255)
    || !Number.isSafeInteger(gpuCount) || Number(gpuCount) <= 0) throw new Error("Invalid VM configuration");
  return {id: v.id as number, name: v.name as string, region: region as string, flavor: name as string, gpu: gpu as string, gpuCount: gpuCount as number};
}

export function matchingVmStock(vm: HibernatedVm, items: readonly AvailabilityItem[]): AvailabilityItem | undefined {
  // Allocation-only stock (e.g. 1x) cannot distinguish flavors with different
  // RAM, disks or spot contracts. Require the exact regional flavor instead.
  const matches = items.filter(i => i.region === vm.region && i.gpu === vm.gpu && i.flavor === vm.flavor);
  return matches.length === 1 ? matches[0] : undefined;
}

export function createRestorationCatalogService(options: {fetch?: VmFetch; timeoutMs?: number} = {}) {
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async load(apiKey: string, optionsForRequest: {signal?: AbortSignal} = {}): Promise<HibernatedResult> {
      try {
        return await withRequestLifetime(optionsForRequest.signal, options.timeoutMs ?? 15000, async signal => {
          const vms: HibernatedVm[] = [];
          let loaded = 0;
          for (let page = 1; page <= 100; page++) {
            signal.throwIfAborted();
            const response = await request(`${API}?page=${page}&page_size=100`, {method: "GET", headers: {api_key: apiKey}, signal, redirect: "error", credentials: "omit", cache: "no-store"});
            const body = await response.json();
            signal.throwIfAborted();
            if (!response.ok || !record(body) || body.status !== true || !Array.isArray(body.instances)) throw new Error("Invalid VMs");
            loaded += body.instances.length;
            for (const vm of body.instances) if (record(vm) && vm.status === "HIBERNATED" && !(record(vm.flavor) && vm.flavor.gpu === "")) vms.push(readHibernatedVm(vm));
            if (typeof body.count === "number" ? loaded >= body.count : body.instances.length < 100) return {ok: true as const, vms};
            if (!body.instances.length) break;
          }
          throw new Error("Incomplete VM list");
        });
      } catch { return {ok: false, message: "Could not load hibernated GPU VMs. Check VM read permissions and reload."}; }
    },
  };
}

/** A restore is a mutation even though Hyperstack specifies GET. Never retry an ambiguous outcome. */
export async function restoreHibernatedVm(request: VmFetch, apiKey: string, plan: RestorationPlan, parentSignal?: AbortSignal, timeoutMs = 15000): Promise<DeploymentResult> {
  let dispatched = false;
  const failed = (): DeploymentResult => ({status: "failed", message: "Could not verify the hibernated VM and its original region/flavor, or Hyperstack rejected restoration. Reload VMs and review the configuration before arming again."});
  const uncertain = (): DeploymentResult => ({status: "uncertain", message: "Restore outcome is unknown. Check this VM in Hyperstack before arming again. Restoration will not be retried automatically."});
  try {
    return await withRequestLifetime(parentSignal, timeoutMs, async signal => {
      const init: RequestInit = {method: "GET", headers: {api_key: apiKey}, signal, redirect: "error", credentials: "omit", cache: "no-store"};
      const details = await request(`${API}/${plan.restoreVmId}`, init);
      const body = await details.json();
      signal.throwIfAborted();
      if (!details.ok || !record(body) || body.status !== true) return failed();
      const vm = readHibernatedVm(body.instance);
      if (vm.id !== plan.restoreVmId || vm.region !== plan.region || vm.flavor !== plan.flavor) return failed();
      dispatched = true;
      const response = await request(`${API}/${vm.id}/hibernate-restore`, init);
      if (!response.ok) return response.status >= 500 || response.status === 408 ? uncertain() : failed();
      const result = await response.json();
      if (!record(result) || result.status !== true) return uncertain();
      return {status: "submitted", vmId: vm.id, message: `VM #${vm.id} was scheduled to restore with its existing configuration. Monitoring has stopped.`};
    });
  } catch { return dispatched ? uncertain() : failed(); }
}
