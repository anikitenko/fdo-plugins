import type {RestorationQueueEntry} from "./restoration-queue";
import {restoreHibernatedVm} from "./restoration";
import type {AvailabilityItem, AvailabilitySnapshot} from "./logic";
import {withRequestLifetime} from "./request-lifetime";

export interface CreationPlan {
  readonly itemId: string;
  readonly name: string;
  readonly environment: string;
  readonly image: string;
  readonly keypair: string;
  readonly publicIp: boolean;
  readonly sshSource?: string;
  readonly userData?: string;
}

export interface RestorationPlan {
  readonly itemId: string;
  readonly name: string;
  readonly restoreVmId: number;
  readonly region: string;
  readonly flavor: string;
}
export type DeploymentPlan = CreationPlan | RestorationPlan;

export interface DeploymentState {
  readonly status: "idle" | "waiting" | "creating" | "submitted" | "failed" | "uncertain" | "cancelled";
  readonly launchId?: string;
  readonly message: string;
  readonly vmId?: number;
}

export interface MonitoringRecord {
  readonly version: 1;
  readonly restorations?: readonly RestorationQueueEntry[];
  readonly plan: DeploymentPlan | null;
  readonly state: DeploymentState;
  readonly lastCheckedAt?: string;
}

export type DeploymentResult = {
  readonly status: "submitted" | "failed" | "uncertain";
  readonly message: string;
  readonly vmId?: number;
};

export interface DeploymentService {
  create(apiKey: string, plan: DeploymentPlan, item: AvailabilityItem, options?: {signal?: AbortSignal}): Promise<DeploymentResult>;
}

type DeploymentFetch = (url: string, init: RequestInit) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

const API = "https://infrahub-api.nexgencloud.com/v1/core";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validIpv4Cidr(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && /^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1])
    && parts[0].split(".").length === 4
    && parts[0].split(".").every(o => /^(0|[1-9][0-9]{0,2})$/.test(o) && Number(o) <= 255);
}

function readPlan(input: unknown): DeploymentPlan | null {
  if (!record(input) || input.confirmCharges !== true) return null;
  if ("restoreVmId" in input) {
    if (!Number.isSafeInteger(input.restoreVmId) || Number(input.restoreVmId) <= 0
      || !["itemId", "name", "region", "flavor"].every(k => typeof input[k] === "string" && input[k].trim() && input[k].length <= 2048)) return null;
    return {itemId: input.itemId as string, name: input.name as string, restoreVmId: input.restoreVmId as number, region: input.region as string, flavor: input.flavor as string};
  }
  if (typeof input.publicIp !== "boolean") return null;
  const fields = ["itemId", "name", "environment", "image", "keypair"] as const;
  for (const field of fields) {
    const value = input[field];
    const max = field === "itemId" ? 2048 : field === "image" ? 255 : 50;
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return null;
  }
  if (input.sshSource !== undefined && (typeof input.sshSource !== "string" || !validIpv4Cidr(input.sshSource))) return null;
  if (input.userData !== undefined && (typeof input.userData !== "string" || new TextEncoder().encode(input.userData).length > 65535)) return null;
  return {
    ...(typeof input.sshSource === "string" ? {sshSource: input.sshSource} : {}),
    ...(typeof input.userData === "string" ? {userData: input.userData} : {}),
    itemId: input.itemId as string,
    name: (input.name as string).trim(),
    environment: (input.environment as string).trim(),
    image: (input.image as string).trim(),
    keypair: (input.keypair as string).trim(),
    publicIp: input.publicIp,
  };
}

/** Backend-only HTTPS. No automatic retries of a possibly accepted POST. */
export function createDeploymentService(options: {fetch?: DeploymentFetch; timeoutMs?: number} = {}): DeploymentService {
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error("Invalid deployment deadline");
  return {
    async create(apiKey, plan, item, requestOptions = {}) {
      if ("restoreVmId" in plan) return restoreHibernatedVm(request, apiKey, plan, requestOptions.signal, timeoutMs);
      let dispatched = false;
      const uncertain = (): DeploymentResult => ({
        status: "uncertain",
        message: "Creation outcome is unknown. Check Hyperstack for this VM before arming another request. Creation will not be retried automatically.",
      });
      const operation = async (signal: AbortSignal): Promise<DeploymentResult> => {
        const init = {
          headers: {api_key: apiKey, "Content-Type": "application/json"},
          signal,
          redirect: "error" as const,
          credentials: "omit" as const,
          cache: "no-store" as const,
        };
        try {
          // The environment determines the deployment region. Never silently
          // launch the selected flavor in another region with different stock.
          const response = await request(`${API}/environments`, {...init, method: "GET"});
          if (!response.ok) return {status: "failed", message: "Could not verify the environment. Check account permissions and the environment name. No VM creation request was sent."};
          const data = await response.json();
          if (signal.aborted) return {status: "failed", message: "Environment verification stopped. No VM creation request was sent."};
          if (!record(data) || data.status !== true || !Array.isArray(data.environments)) {
            return {status: "failed", message: "Hyperstack returned an unsupported environment response. No VM creation request was sent."};
          }
          const environment = data.environments.find(entry => record(entry) && entry.name === plan.environment);
          if (!record(environment) || environment.region !== item.region) {
            return {status: "failed", message: "Choose an existing environment in the selected flavor's region. No VM creation request was sent."};
          }
          if (signal.aborted) return {status: "failed", message: "Environment verification stopped. No VM creation request was sent."};
          dispatched = true;
          const created = await request(`${API}/virtual-machines`, {
            ...init,
            method: "POST",
            body: JSON.stringify({
              name: plan.name,
              environment_name: plan.environment,
              image_name: plan.image,
              flavor_name: item.flavor,
              key_name: plan.keypair,
              count: 1,
              assign_floating_ip: plan.publicIp,
              security_rules: plan.sshSource ? [{direction: "ingress", protocol: "tcp", ethertype: "IPv4", remote_ip_prefix: plan.sshSource, port_range_min: 22, port_range_max: 22}] : [],
              ...(plan.userData ? {user_data: plan.userData} : {}),
            }),
          });
          if (!created.ok) {
            // Server errors/timeouts can occur after an accepted mutation.
            if (created.status >= 500 || created.status === 408) return uncertain();
            return {status: "failed", message: "Hyperstack rejected VM creation. Check stock, quota, balance, image and SSH key in the console before arming again."};
          }
          const body = await created.json();
          if (!record(body) || body.status !== true || !Array.isArray(body.instances) || body.instances.length !== 1) return uncertain();
          const vm = body.instances[0];
          if (!record(vm) || typeof vm.id !== "number" || !Number.isSafeInteger(vm.id) || vm.id <= 0) return uncertain();
          return {status: "submitted", vmId: vm.id, message: `VM #${vm.id} was scheduled for creation. Check provisioning and connection details in Hyperstack.`};
        } catch {
          return dispatched ? uncertain() : {status: "failed", message: "Could not verify the environment. Check connectivity and permissions. No VM creation request was sent."};
        }
      };
      try {
        return await withRequestLifetime(requestOptions.signal, timeoutMs, operation);
      } catch {
        return dispatched ? uncertain() : {status: "failed", message: "Environment verification stopped or timed out. No VM creation request was sent."};
      }
    },
  };
}

/** Called under the backend queue. Durable checkpoints precede VM mutations. */
export function createDeploymentController(service: DeploymentService) {
  let sequence = 0;
  let plan: DeploymentPlan | null = null;
  let draft: DeploymentPlan | null = null;
  let lastCheckedAt: string | undefined;
  let state: DeploymentState = {status: "idle", message: "No VM operation is armed."};
  return {
    state: (): DeploymentState => ({...state}),
    record: (): MonitoringRecord => ({version: 1, plan: draft ? {...draft} : null, state: {...state}, ...(lastCheckedAt ? {lastCheckedAt} : {})}),
    restore(input: unknown): void {
      if (input === undefined || input === null) return;
      if (!record(input) || input.version !== 1 || !record(input.state)) throw new Error("Invalid monitoring state");
      const saved = input.state;
      const status = saved.status;
      if (!["idle", "waiting", "creating", "submitted", "failed", "uncertain", "cancelled"].includes(String(status))) throw new Error("Invalid monitoring status");
      const restored = input.plan === null ? null : readPlan({... (record(input.plan) ? input.plan : {}), confirmCharges: true});
      if (input.plan !== null && !restored) throw new Error("Invalid saved VM configuration");
      if (status === "waiting" && (!restored || typeof saved.launchId !== "string" || !saved.launchId || saved.launchId.length > 100)) throw new Error("Invalid waiting state");
      if (status === "submitted" && (typeof saved.vmId !== "number" || !Number.isSafeInteger(saved.vmId) || saved.vmId <= 0)) throw new Error("Invalid VM ID");
      draft = restored;
      plan = status === "waiting" ? restored : null;
      lastCheckedAt = typeof input.lastCheckedAt === "string" && Number.isFinite(Date.parse(input.lastCheckedAt)) ? input.lastCheckedAt : undefined;
      // Stored messages are never trusted or replayed. A crash after the durable
      // creating marker may have happened after Hyperstack accepted the POST.
      state = status === "waiting"
        ? {status: "waiting", launchId: saved.launchId as string, message: `Monitoring restored for ${restored!.name} (${restored && "restoreVmId" in restored ? "restore existing VM" : "create VM"}). Waiting for fresh stock; checks run while the plugin backend is running.`}
        : status === "creating" || status === "uncertain"
          ? {status: "uncertain", message: "Previous VM operation outcome is unknown. Check Hyperstack for the VM before arming again. No automatic retry will be made."}
          : status === "submitted"
            ? {status: "submitted", vmId: saved.vmId as number, message: `VM #${saved.vmId} was submitted. Monitoring has stopped.`}
            : {status: status as DeploymentState["status"], message: status === "cancelled" ? "Waiting cancelled. Monitoring has stopped." : status === "failed" ? "Previous monitoring attempt stopped. Review the configuration before arming again." : "No VM operation is armed."};
    },
    arm(input: unknown, snapshot: AvailabilitySnapshot | null): DeploymentState {
      if (state.status === "waiting" || state.status === "creating") return {status: "failed", message: "A deployment is already armed. Cancel waiting before arming a new plan."};
      const next = readPlan(input);
      if (!next || !snapshot?.items.some(item => item.id === next.itemId)) {
        return {status: "failed", message: "Select a checked VM type, complete all deployment fields and acknowledge charges."};
      }
      plan = next;
      draft = next;
      const item = snapshot!.items.find(item => item.id === next.itemId)!;
      state = {status: "waiting", launchId: `${Date.now()}-${++sequence}`, message: `Armed to ${"restoreVmId" in next ? `restore VM #${next.restoreVmId}` : "create one VM"}: ${item.flavor} in ${item.region}, named ${next.name}, ${"restoreVmId" in next ? "with its existing configuration" : `using environment ${next.environment}`}. Waiting for fresh stock; checks run while the plugin backend is running. Monitoring resumes after restart. Cancel to stop waiting.`};
      return this.state();
    },
    cancel(): DeploymentState {
      if (state.status === "uncertain") {
        plan = null;
        state = {status: "cancelled", message: "Monitoring stopped. Verify the previous VM outcome in Hyperstack before arming another request."};
      }
      if (state.status === "waiting") {
        plan = null;
        state = {status: "cancelled", message: "Waiting cancelled. No VM request was sent."};
      }
      return this.state();
    },
    async onSnapshot(apiKey: string, snapshot: AvailabilitySnapshot, launchId: unknown, checkpoint?: () => Promise<void>, signal?: AbortSignal): Promise<DeploymentState> {
      if (signal?.aborted) return this.state();
      lastCheckedAt = snapshot.checkedAt;
      if (!plan || state.status !== "waiting" || launchId !== state.launchId) return this.state();
      const item = snapshot.items.find(entry => entry.id === plan!.itemId);
      if (!item || item.status !== "available") return this.state();
      const selected = plan;
      plan = null; // Consume BEFORE any network mutation, even on timeout.
      state = {status: "creating", message: "Submitting one VM request…"};
      try {
        // Flush the consumed marker BEFORE any request can reach Hyperstack.
        await checkpoint?.();
      } catch {
        state = {status: "failed", message: "Monitoring storage could not be saved. No VM request was sent. Restore storage access before arming again."};
        return this.state();
      }
      try {
        if (signal?.aborted) return this.state();
        state = {...await service.create(apiKey, selected, item, {signal})};
      } catch {
        state = {status: "uncertain", message: "VM operation outcome is unknown. Check Hyperstack before arming another request."};
      }
      return this.state();
    },
  };
}
