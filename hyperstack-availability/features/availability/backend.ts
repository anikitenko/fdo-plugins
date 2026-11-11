import {createRestorationQueue} from "./restoration-queue";
import type {RestorationPlan} from "./deployment";
import {matchingVmStock} from "./restoration";
import type {createRestorationCatalogService, HibernatedResult} from "./restoration";
import type {MonitoringPersistence} from "./monitoring";
import type {CatalogResult, DeploymentCatalog, DeploymentCatalogService} from "./catalog";
import type {FDO_SDK} from "@anikitenko/fdo-sdk";
import type {AvailabilitySnapshot} from "./logic";
import {createDeploymentController} from "./deployment";
import type {DeploymentService, DeploymentState, MonitoringRecord} from "./deployment";
import type {
  AvailabilityService,
  AvailabilityServiceDiagnostics,
  AvailabilityServiceErrorCode,
  AvailabilityServiceFailure,
} from "./service";

export const AVAILABILITY_HANDLERS = {
  state: "hyperstack.availability.state",
  setPolling: "hyperstack.availability.setPolling",
  deploymentOptions: "hyperstack.availability.deploymentOptions",
  configuration: "hyperstack.availability.configuration",
  saveConnection: "hyperstack.availability.saveConnection",
  removeConnection: "hyperstack.availability.removeConnection",
  refresh: "hyperstack.availability.refresh",
  armDeployment: "hyperstack.availability.armDeployment",
  enqueueRestorations: "hyperstack.availability.enqueueRestorations",
  cancelRestorations: "hyperstack.availability.cancelRestorations",
  hibernatedOptions: "hyperstack.availability.hibernatedOptions",
  cancelDeployment: "hyperstack.availability.cancelDeployment",
} as const;

/** One plugin-scoped key; never accept a storage key from iframe input. */
export const AVAILABILITY_SECRET_KEY = "hyperstack.api-key";

export type AvailabilitySecretStore = Pick<
  FDO_SDK["secrets"],
  "get" | "set" | "delete"
>;

export type AvailabilityConfigurationStatus =
  | "ready"
  | "credential_required"
  | "permission_denied"
  | "storage_locked"
  | "storage_unavailable";

export interface AvailabilityConfiguration {
  /** True only when a nonempty key has been confirmed in secure storage. */
  readonly configured: boolean;
  /** Reflects the most recent storage operation, not a permanent SDK limit. */
  readonly credentialStorageAvailable: boolean;
  /** The injected service owns the verified provider contract. */
  readonly providerContractAvailable: boolean;
  /** Ready to attempt a check; does not assert network grants or valid auth. */
  readonly ready: boolean;
  readonly status: AvailabilityConfigurationStatus;
  readonly message: string;
}

export type AvailabilityBackendErrorCode =
  | AvailabilityServiceErrorCode
  | "invalid_input"
  | "storage_locked"
  | "storage_unavailable"
  | "refresh_settings_unavailable";

export interface AvailabilityBackendError {
  readonly code: AvailabilityBackendErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Selected public request facts; never headers or provider response bodies. */
  readonly diagnostics?: AvailabilityServiceDiagnostics;
}

export interface AvailabilityBackendFailure {
  readonly monitoring?: MonitoringRecord;
  readonly ok: false;
  readonly error: AvailabilityBackendError;
  readonly configuration: AvailabilityConfiguration;
}

export type AvailabilityConfigurationResult =
  | {
      readonly ok: true;
      readonly configuration: AvailabilityConfiguration;
      readonly monitoring?: MonitoringRecord;
    }
  | AvailabilityBackendFailure;

export type AvailabilityRefreshResult =
  | {
      readonly ok: true;
      readonly configuration: AvailabilityConfiguration;
      readonly snapshot: AvailabilitySnapshot;
      readonly deployment?: DeploymentState;
      readonly monitoring?: MonitoringRecord;
    }
  | AvailabilityBackendFailure;

export interface AvailabilityBackendOptions {
  readonly signal?: AbortSignal;
  /** Pass the plugin instance's this.secrets from init(). */
  readonly secrets: AvailabilitySecretStore;
  /** Construct the service in backend code, never from iframe options. */
  readonly service: AvailabilityService;
  readonly deploymentService?: DeploymentService;
  readonly catalogService?: DeploymentCatalogService;
  readonly restorationCatalogService?: ReturnType<typeof createRestorationCatalogService>;
  readonly monitoring?: MonitoringPersistence;
}

export interface AvailabilityBackend {
  deploymentOptions(): Promise<CatalogResult>;
  hibernatedOptions(): Promise<HibernatedResult>;
  enqueueRestorations(content: unknown): Promise<AvailabilityConfigurationResult>;
  cancelRestorations(content?: unknown): Promise<AvailabilityConfigurationResult>;
  getConfiguration(): Promise<AvailabilityConfigurationResult>;
  /** UI_MESSAGE content is passed directly: {apiKey: string}. */
  saveConnection(content: unknown): Promise<AvailabilityConfigurationResult>;
  removeConnection(): Promise<AvailabilityConfigurationResult>;
  refresh(content?: unknown): Promise<AvailabilityRefreshResult>;
  armDeployment(content: unknown): Promise<AvailabilityConfigurationResult & {deployment?: DeploymentState}>;
  cancelDeployment(): Promise<AvailabilityConfigurationResult & {deployment?: DeploymentState}>;
}

const CONFIGURATION_MESSAGES: Readonly<
  Record<AvailabilityConfigurationStatus, string>
> = {
  ready: "An API key is saved. Check availability to verify access and stock.",
  credential_required: "Save your Hyperstack API key to check availability.",
  permission_denied:
    "Grant the required secret-storage capabilities, then retry the connection check.",
  storage_locked:
    "Unlock secure credential storage, then retry the connection check.",
  storage_unavailable:
    "Secure credential storage is currently unavailable. Restore access, then retry.",
};

function configuration(
  status: AvailabilityConfigurationStatus,
): AvailabilityConfiguration {
  const ready = status === "ready";
  return {
    configured: ready,
    credentialStorageAvailable:
      ready || status === "credential_required",
    providerContractAvailable: true,
    ready,
    status,
    message: CONFIGURATION_MESSAGES[status],
  };
}

function failure(
  current: AvailabilityConfiguration,
  code: AvailabilityBackendErrorCode,
  message: string,
  retryable: boolean,
  diagnostics?: AvailabilityServiceDiagnostics,
): AvailabilityBackendFailure {
  return {
    ok: false,
    configuration: current,
    error: {
      code,
      message,
      retryable,
      ...(diagnostics ? {diagnostics} : {}),
    },
  };
}

/**
 * Inspect only a machine-readable error code. Never relay exception messages,
 * provider bodies, rejected inputs or storage errors across the bridge.
 */
function storageFailure(error: unknown): AvailabilityBackendFailure {
  let code = "";
  try {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
    ) {
      code = error.code.toLowerCase().replace(/[-.\s]+/g, "_");
    }
  } catch {
    // An unreadable error code is treated as unavailable storage.
  }

  if (
    /(?:^|_)(?:permission|capability|grant|access)(?:_|$)/.test(code)
    || /(?:^|_)(?:denied|forbidden|unauthorized)(?:_|$)/.test(code)
  ) {
    const current = configuration("permission_denied");
    return failure(current, "permission_denied", current.message, true);
  }

  if (/(?:^|_)locked(?:_|$)/.test(code)) {
    const current = configuration("storage_locked");
    return failure(current, "storage_locked", current.message, true);
  }

  const current = configuration("storage_unavailable");
  return failure(current, "storage_unavailable", current.message, true);
}

function validCredential(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 8192
    && value.trim() === value
    && !/[\u0000-\u0020\u007f]/.test(value);
}

function readCredentialInput(content: unknown): string | null {
  if (
    typeof content !== "object"
    || content === null
    || Array.isArray(content)
    || !("apiKey" in content)
  ) {
    return null;
  }

  const value = content.apiKey;
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return validCredential(trimmed) ? trimmed : null;
}

function serviceFailure(
  current: AvailabilityConfiguration,
  error: AvailabilityServiceFailure["error"],
): AvailabilityBackendFailure {
  const {code, retryable} = error;
  let diagnostics: AvailabilityServiceDiagnostics | undefined;

  // Copy only declared public fields. Never spread service errors or relay
  // free-form messages, response bodies, headers or exception properties.
  try {
    const candidate = error.diagnostics;
    if (
      candidate
      && candidate.stage === "http_response"
      && Number.isInteger(candidate.httpStatus)
      && candidate.httpStatus >= 100
      && candidate.httpStatus <= 599
      && typeof candidate.endpoint === "string"
    ) {
      const endpoint = new URL(candidate.endpoint);
      if (
        endpoint.protocol === "https:"
        && endpoint.username === ""
        && endpoint.password === ""
        && endpoint.search === ""
        && endpoint.hash === ""
      ) {
        diagnostics = {
          httpStatus: candidate.httpStatus,
          stage: "http_response",
          endpoint: endpoint.href,
        };
      }
    }
  } catch {
    // Invalid diagnostics must not replace the original application failure.
  }

  let message: string;
  switch (code) {
    case "credential_required":
      current = configuration("credential_required");
      message = "Save your Hyperstack API key to check availability.";
      break;
    case "invalid_configuration":
      message =
        "The Hyperstack provider configuration is invalid. Review the plugin configuration before retrying.";
      break;
    case "permission_denied":
      message = diagnostics?.httpStatus === 403
        ? "Hyperstack denied access to availability data. Check the saved API key's account permissions before retrying."
        : "Grant the required HTTPS network capabilities and destination scope, then retry.";
      break;
    case "authentication_failed":
      message =
        "Hyperstack rejected this API key. Save a valid key with access to availability data, then retry.";
      break;
    case "rate_limited":
      message =
        "Hyperstack is limiting requests. Wait before retrying or increase the refresh interval.";
      break;
    case "timeout":
      message =
        "The availability check timed out. Retry when the connection is available.";
      break;
    case "cancelled":
      message = "The availability check was cancelled. Retry when ready.";
      break;
    case "network_error":
      message = "Hyperstack could not be reached. Check connectivity and retry.";
      break;
    case "provider_error": {
      const status = diagnostics?.httpStatus;
      if (retryable) {
        message = status === 408
          ? "Hyperstack timed out while handling the availability request. Wait briefly, then retry."
          : "Hyperstack could not complete the availability request. Wait briefly, then retry. If it persists, contact Hyperstack support with the technical details.";
      } else if (status === 404) {
        message =
          "Hyperstack returned HTTP 404 for the configured availability endpoint. Review the plugin's API endpoint against current provider documentation before retrying.";
      } else if (status === 405) {
        message =
          "Hyperstack rejected the GET method for the configured availability endpoint. Review the plugin's endpoint and request method before retrying.";
      } else {
        message = status === undefined
          ? "Hyperstack rejected the availability request. Review the configured API endpoint and request requirements before retrying."
          : `Hyperstack rejected the availability request (HTTP ${status}). Review the configured API endpoint and request requirements before retrying.`;
      }
      break;
    }
    case "invalid_response":
      message = retryable
        ? "Hyperstack returned an unsupported availability response. Existing results do not confirm current stock. Retry later; if it persists, review the provider integration."
        : "Hyperstack returned an unsupported availability response. Review the provider integration before retrying. Existing results do not confirm current stock.";
      break;
  }

  return failure(current, code, message, retryable, diagnostics);
}

/**
 * All credential operations and checks run in order. A removal cannot race an
 * earlier save, and a check cannot use a key read during a concurrent mutation.
 * Failures never poison the queue; the next operation retries real SDK access.
 */
export function createAvailabilityBackend(
  options: AvailabilityBackendOptions,
): AvailabilityBackend {
  const {secrets, service} = options;
  const deployment = options.deploymentService ? createDeploymentController(options.deploymentService) : null;
  const restorations = options.deploymentService ? createRestorationQueue(options.deploymentService) : null;
  const monitoringRecord = (): MonitoringRecord | undefined => {
    const current = deployment?.record();
    const entries = restorations?.entries();
    return current && {...current, ...(entries?.length ? {restorations: entries} : {})};
  };
  let catalog: DeploymentCatalog | null = null;
  let latestSnapshot: AvailabilitySnapshot | null = null;
  let queue: Promise<void> = Promise.resolve();
  let monitoringLoaded = !options.monitoring;
  let monitoringError = false;

  async function restoreMonitoring(): Promise<boolean> {
    if (monitoringLoaded && !monitoringError) return true;
    try {
      const saved = await options.monitoring?.load();
      deployment?.restore(saved);
      restorations?.restore(typeof saved === "object" && saved !== null && "restorations" in saved ? saved.restorations : undefined);
      monitoringLoaded = true;
      monitoringError = false;
      return true;
    } catch { monitoringError = true; return false; }
  }

  function monitoringView(): MonitoringRecord | undefined {
    if (!deployment || !options.monitoring) return undefined;
    const current = monitoringRecord()!;
    if (!monitoringError) return current;
    if (current.state.status === "submitted" || current.state.status === "uncertain") {
      return {...current, state: {...current.state, message: `${current.state.message} The latest status could not be saved; verify the VM in Hyperstack after restart.`}};
    }
    return {version: 1, plan: null, restorations: current.restorations?.map(entry => ({...entry, state: entry.state.status === "waiting" ? {status: "failed", vmId: entry.plan.restoreVmId, message: "Monitoring paused because persistent storage is unavailable. Restore storage access and reload status."} : entry.state})), state: {status: "failed", message: "Persistent monitoring storage is unavailable or invalid. Monitoring is stopped. Allow persistent storage in plugin permissions and reload, or use Cancel waiting to clear invalid saved monitoring."}};
  }

  async function persistMonitoring(): Promise<void> {
    options.signal?.throwIfAborted();
    if (!options.monitoring || !deployment) return;
    try {
      if (!monitoringLoaded || monitoringError) throw new Error("Monitoring storage unavailable");
      await options.monitoring.save(monitoringRecord()!);
    } catch { monitoringError = true; throw new Error("Monitoring storage unavailable"); }
  }

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(() => {
      options.signal?.throwIfAborted();
      return operation();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function inspectConfiguration(): Promise<AvailabilityConfigurationResult> {
    try {
      const apiKey = await secrets.get(AVAILABILITY_SECRET_KEY);
      return {
        ok: true,
        configuration: configuration(
          validCredential(apiKey) ? "ready" : "credential_required",
        ),
      };
    } catch (error: unknown) {
      return storageFailure(error);
    }
  }

  return {
    enqueueRestorations(content: unknown) {
      return exclusive(async () => {
        const inspected = await inspectConfiguration();
        const invalid = () => ({...failure(inspected.configuration, "invalid_input", "Select up to 100 hibernated VMs with matching regional flavors and acknowledge charges. Submitted or uncertain VMs cannot be queued again.", false), monitoring: monitoringView()});
        if (!await restoreMonitoring()) return {...storageFailure({code: "storage_unavailable"}), monitoring: monitoringView()};
        if (!inspected.ok || !inspected.configuration.ready || !restorations || !options.restorationCatalogService || !options.monitoring) return invalid();
        const input = typeof content === "object" && content !== null ? content as Record<string, unknown> : {};
        if (input.confirmCharges !== true || !Array.isArray(input.vmIds) || !input.vmIds.length || input.vmIds.length > 100
          || !input.vmIds.every(id => Number.isSafeInteger(id) && id > 0)) return invalid();
        const ids = [...new Set(input.vmIds as number[])];
        try {
          const key = await secrets.get(AVAILABILITY_SECRET_KEY);
          if (!validCredential(key)) return invalid();
          const result = await options.restorationCatalogService.load(key, {signal: options.signal});
          if (!result.ok || !latestSnapshot) return invalid();
          const plans: RestorationPlan[] = [];
          const legacy = deployment?.record();
          for (const id of ids) {
            if (legacy?.plan && "restoreVmId" in legacy.plan && legacy.plan.restoreVmId === id && ["waiting", "creating", "submitted", "uncertain"].includes(legacy.state.status)) return invalid();
            const previous = restorations.entries().find(e => e.plan.restoreVmId === id);
            if (previous && ["submitted", "uncertain"].includes(previous.state.status)) return invalid();
            const vm = result.vms.find(v => v.id === id);
            const item = vm && matchingVmStock(vm, latestSnapshot.items);
            if (!vm || !item) return invalid();
            plans.push({restoreVmId: vm.id, name: vm.name, region: vm.region, flavor: vm.flavor, itemId: item.id});
          }
          restorations.add(plans);
        } catch { return invalid(); }
        try { await persistMonitoring(); }
        catch { restorations.cancel(ids); return {...storageFailure({code: "storage_unavailable"}), monitoring: monitoringView()}; }
        return {...inspected, monitoring: monitoringView()};
      });
    },
    cancelRestorations(content?: unknown) {
      return exclusive(async () => {
        const inspected = await inspectConfiguration();
        if (!await restoreMonitoring()) return {...storageFailure({code: "storage_unavailable"}), monitoring: monitoringView()};
        const input = typeof content === "object" && content !== null ? content as Record<string, unknown> : {};
        if (input.vmIds !== undefined && (!Array.isArray(input.vmIds) || !input.vmIds.length || input.vmIds.length > 200 || !input.vmIds.every(id => Number.isSafeInteger(id) && id > 0))) {
          return {...failure(inspected.configuration, "invalid_input", "Choose valid VM IDs to cancel.", false), monitoring: monitoringView()};
        }
        restorations?.cancel(input.vmIds as number[] | undefined);
        try { await persistMonitoring(); }
        catch { return {...storageFailure({code: "storage_unavailable"}), monitoring: monitoringView()}; }
        return {...inspected, monitoring: monitoringView()};
      });
    },
    hibernatedOptions() {
      return exclusive(async () => {
        try {
          const key = await secrets.get(AVAILABILITY_SECRET_KEY);
          if (!validCredential(key) || !options.restorationCatalogService) throw new Error("Unavailable");
          return await options.restorationCatalogService.load(key, {signal: options.signal});
        } catch { return {ok: false as const, message: "Could not load hibernated VMs. Check connection and VM read permissions."}; }
      });
    },
    deploymentOptions() {
      return exclusive(async () => {
        try {
          const apiKey = await secrets.get(AVAILABILITY_SECRET_KEY);
          if (!validCredential(apiKey) || !options.catalogService) return {ok: false as const, message: "Save an API key to load VM options."};
          catalog = null;
          const result = await options.catalogService.load(apiKey, {signal: options.signal});
          if (result.ok) catalog = result.catalog;
          return result;
        } catch { return {ok: false as const, message: "Could not access credentials to load VM options."}; }
      });
    },
    getConfiguration(): Promise<AvailabilityConfigurationResult> {
      return exclusive(async () => {
        await restoreMonitoring();
        return {...await inspectConfiguration(), monitoring: monitoringView()};
      });
    },

    saveConnection(content: unknown): Promise<AvailabilityConfigurationResult> {
      return exclusive(async () => {
        if (!await restoreMonitoring()) return storageFailure({code: "storage_unavailable"});
        deployment?.cancel();
        restorations?.cancel();
        try { await persistMonitoring(); } catch { return storageFailure({code: "storage_unavailable"}); }
        latestSnapshot = null;
        catalog = null;
        let apiKey: string | null;
        try {
          apiKey = readCredentialInput(content);
        } catch {
          apiKey = null;
        }

        if (apiKey === null) {
          const inspected = await inspectConfiguration();
          return failure(
            inspected.configuration,
            "invalid_input",
            "Provide a nonempty Hyperstack API key without whitespace or control characters.",
            false,
          );
        }

        try {
          options.signal?.throwIfAborted();
          await secrets.set(AVAILABILITY_SECRET_KEY, apiKey);
        } catch (error: unknown) {
          return storageFailure(error);
        }

        // Reading back verifies the read grant needed by refresh as well as
        // persistence. No credential value is included in the result.
        return {...await inspectConfiguration(), monitoring: monitoringView()};
      });
    },

    removeConnection(): Promise<AvailabilityConfigurationResult> {
      return exclusive(async () => {
        if (!await restoreMonitoring()) return storageFailure({code: "storage_unavailable"});
        deployment?.cancel();
        restorations?.cancel();
        try { await persistMonitoring(); } catch { return storageFailure({code: "storage_unavailable"}); }
        latestSnapshot = null;
        catalog = null;
        try {
          // A missing key is already the requested state.
          options.signal?.throwIfAborted();
          await secrets.delete(AVAILABILITY_SECRET_KEY);
          return {
            ok: true,
            configuration: configuration("credential_required"),
            monitoring: monitoringView(),
          };
        } catch (error: unknown) {
          return storageFailure(error);
        }
      });
    },

    armDeployment(content: unknown) {
      return exclusive(async () => {
        const inspected = await inspectConfiguration();
        if (!await restoreMonitoring()) return {...inspected, monitoring: monitoringView(), deployment: monitoringView()?.state};
        if (!inspected.ok || !inspected.configuration.ready || !deployment) return inspected;
        const restoreInput = typeof content === "object" && content !== null && "restoreVmId" in content ? content as Record<string, unknown> : null;
        if (restoreInput) {
          // Resolve every configuration field server-side from a fresh account read.
          // The client only chooses a VM ID and acknowledges charges.
          try {
            if (restoreInput.confirmCharges !== true || !Number.isSafeInteger(restoreInput.restoreVmId) || !options.restorationCatalogService) throw new Error("Invalid selection");
            if (restorations?.entries().some(e => e.plan.restoreVmId === restoreInput.restoreVmId && ["waiting", "creating", "submitted", "uncertain"].includes(e.state.status))) throw new Error("Already queued");
            const key = await secrets.get(AVAILABILITY_SECRET_KEY);
            if (!validCredential(key)) throw new Error("Missing credential");
            const result = await options.restorationCatalogService.load(key, {signal: options.signal});
            const vm = result.ok ? result.vms.find(v => v.id === restoreInput.restoreVmId) : undefined;
            const item = vm && latestSnapshot ? matchingVmStock(vm, latestSnapshot.items) : undefined;
            if (!vm || !item) throw new Error("No matching configuration");
            content = {restoreVmId: vm.id, name: vm.name, region: vm.region, flavor: vm.flavor, itemId: item.id, confirmCharges: true};
          } catch { return {...inspected, deployment: {status: "failed" as const, message: "Reload hibernated VMs and availability. Select a hibernated GPU VM with an exact matching region and configuration, and acknowledge restore charges."}}; }
        } else if (options.catalogService) {
          const input = typeof content === "object" && content !== null ? content as Record<string, unknown> : {};
          const item = latestSnapshot?.items.find(i => i.id === input.itemId);
          if (!catalog || !item
            || !catalog.environments.some(e => e.name === input.environment && e.region === item.region)
            || !catalog.images.some(i => i.name === input.image && i.region === item.region)
            || !catalog.keypairs.some(k => k.name === input.keypair && k.environment === input.environment)) {
            return {...inspected, deployment: {status: "failed" as const, message: "Reload VM options and choose an environment, image and SSH key matching the selected region."}};
          }
        }
        const state = deployment.arm(content, latestSnapshot);
        try { await persistMonitoring(); }
        catch { deployment.cancel(); return {...inspected, monitoring: monitoringView(), deployment: monitoringView()?.state}; }
        return {...inspected, deployment: state, monitoring: monitoringView()};
      });
    },

    cancelDeployment() {
      return exclusive(async () => {
        const inspected = await inspectConfiguration();
        if (!await restoreMonitoring()) {
          // Explicit cancellation may discard an invalid saved plan. The new
          // cancelled marker must still flush successfully before we report it.
          deployment?.restore({version: 1, plan: null, state: {status: "cancelled"}});
          restorations?.restore(undefined);
          monitoringLoaded = true;
          monitoringError = false;
        }
        const state = deployment?.cancel();
        try { await persistMonitoring(); }
        catch { return {...inspected, monitoring: monitoringView(), deployment: monitoringView()?.state}; }
        return {...inspected, deployment: state, monitoring: monitoringView()};
      });
    },

    refresh(content?: unknown): Promise<AvailabilityRefreshResult> {
      return exclusive(async () => {
        const monitoringReady = await restoreMonitoring();
        let apiKey: string | null;
        try {
          apiKey = await secrets.get(AVAILABILITY_SECRET_KEY);
        } catch (error: unknown) {
          return storageFailure(error);
        }

        if (!validCredential(apiKey)) {
          return failure(
            configuration("credential_required"),
            "credential_required",
            "Save your Hyperstack API key to check availability.",
            false,
          );
        }

        const current = configuration("ready");
        try {
          const result = await service.check(apiKey, {signal: options.signal});
          // A late response must never launch a VM after the plugin was unloaded.
          if (options.signal?.aborted) return failure(current, "cancelled", "Backend monitoring has stopped.", false);
          if (!result.ok) {
            return serviceFailure(current, result.error);
          }

          latestSnapshot = result.snapshot;
          const launchId = typeof content === "object" && content !== null && "launchId" in content ? content.launchId : undefined;
          const previousDeployment = deployment?.record();
          const deploymentState = deployment && monitoringReady
            ? await deployment.onSnapshot(apiKey, result.snapshot, launchId, persistMonitoring, options.signal)
            : monitoringView()?.state;
          if (monitoringReady) {
            const used = new Set<string>();
            if (previousDeployment?.state.status === "waiting" && previousDeployment.plan && deploymentState?.status !== "waiting") used.add(previousDeployment.plan.itemId);
            await restorations?.onSnapshot(apiKey, result.snapshot, persistMonitoring, options.signal, used);
            try { await persistMonitoring(); } catch { /* Creating marker remains durable; never retry the POST. */ }
          }
          return {
            ok: true,
            configuration: current,
            snapshot: result.snapshot,
            ...(deploymentState ? {deployment: deploymentState} : {}),
            monitoring: monitoringView(),
          };
        } catch {
          // The service normally returns failures as data. Unexpected thrown
          // errors are also redacted, including errors containing credentials.
          return failure(
            current,
            "network_error",
            "Hyperstack could not be reached. Check connectivity and retry.",
            true,
          );
        }
      });
    },
  };
}
