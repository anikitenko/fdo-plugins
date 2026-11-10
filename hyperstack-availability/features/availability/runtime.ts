import {createAvailabilityBackend} from "./backend";
import type {AvailabilityBackendOptions, AvailabilityConfiguration, AvailabilityConfigurationResult, AvailabilityRefreshResult, AvailabilityBackendError} from "./backend";
import type {AvailabilitySnapshot} from "./logic";
import type {DeploymentState, MonitoringRecord} from "./deployment";
import type {CatalogResult} from "./catalog";

export interface RefreshPreferences {
  load(): Promise<unknown>;
  save(seconds: number): Promise<void>;
}
export interface BackendViewState {
  ok: true;
  configuration: AvailabilityConfiguration;
  snapshot: AvailabilitySnapshot | null;
  monitoring?: MonitoringRecord;
  deployment?: DeploymentState;
  error: AvailabilityBackendError | null;
  refreshing: boolean;
  pollingSeconds: number;
}
export interface RuntimeClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  now(): number;
}
const intervals = [0, 60, 300, 600];

/** One scheduler per plugin backend process. Browser reads never refresh Hyperstack. */
export function createAvailabilityRuntime(options: AvailabilityBackendOptions & {
  preferences: RefreshPreferences;
  clock?: RuntimeClock;
}) {
  const controller = new AbortController();
  const backend = createAvailabilityBackend({...options, signal: controller.signal});
  const clock: RuntimeClock = options.clock ?? {
    setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
    clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
  let configuration: AvailabilityConfiguration = {configured: false, ready: false, credentialStorageAvailable: true, providerContractAvailable: true, status: "credential_required", message: "Checking the saved connection…"};
  let snapshot: AvailabilitySnapshot | null = null;
  let monitoring: MonitoringRecord | undefined;
  let deployment: DeploymentState | undefined;
  let error: AvailabilityBackendError | null = null;
  let pollingSeconds = 0;
  let preferenceError: AvailabilityBackendError | null = null;
  let refreshing = false;
  let running = false;
  let disposed = false;
  let timer: unknown;
  let startPromise: Promise<void> | undefined;
  let refreshPromise: Promise<AvailabilityRefreshResult> | undefined;
  let catalog: {result: CatalogResult; expires: number} | undefined;
  let catalogPromise: Promise<CatalogResult> | undefined;
  let queue: Promise<void> = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(() => {
      controller.signal.throwIfAborted();
      return operation();
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  const stopTimer = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; };
  const remember = (result: AvailabilityConfigurationResult & {deployment?: DeploymentState}) => {
    configuration = result.configuration;
    if (result.monitoring) monitoring = result.monitoring;
    deployment = result.monitoring?.state ?? result.deployment ?? deployment;
  };
  const state = (): BackendViewState => ({ok: true, configuration, snapshot, monitoring, deployment, error: error ?? preferenceError, refreshing, pollingSeconds});
  const schedule = () => {
    stopTimer();
    const seconds = deployment?.status === "waiting" ? 60 : pollingSeconds;
    if (!running || disposed || seconds === 0) return;
    timer = clock.setTimeout(() => {timer = undefined; if (!disposed && running) void refresh().catch(() => {});}, seconds * 1000);
  };
  function refresh(): Promise<AvailabilityRefreshResult> {
    if (refreshPromise) return refreshPromise;
    if (disposed) return Promise.resolve(snapshot ? {ok: true, configuration, snapshot, monitoring, deployment} : {ok: false, configuration, error: {code: "cancelled", retryable: false, message: "Backend monitoring has stopped."}});
    stopTimer();
    refreshPromise = exclusive(async () => {
      refreshing = true;
      try {
        // The backend owns the durable launch ID; clients cannot gate or resume it.
        const result = await backend.refresh({launchId: deployment?.launchId});
        remember(result);
        if (result.ok) {snapshot = result.snapshot; error = null;}
        else error = result.error;
        return result;
      } finally {refreshing = false;}
    }).finally(() => {refreshPromise = undefined; schedule();});
    return refreshPromise;
  }
  const start = (): Promise<void> => {
    if (startPromise) return startPromise;
    if (disposed) return Promise.resolve();
    running = true;
    startPromise = exclusive(async () => {
      try {
        const saved = await options.preferences.load();
        if (saved !== undefined && saved !== null && (typeof saved !== "number" || !intervals.includes(saved))) throw new Error("Invalid saved interval");
        pollingSeconds = typeof saved === "number" ? saved : 0;
      } catch {
        preferenceError = {code: "refresh_settings_unavailable", retryable: true, message: "Could not restore the automatic refresh setting. Restore storage access and save the interval again."};
      }
      remember(await backend.getConfiguration());
    }).then(async () => {
      if (!disposed && configuration.ready) await refresh();
      else schedule();
    }).catch(error => {
      if (!disposed) throw error;
    });
    return startPromise;
  };
  function dispose() {
    disposed = true;
    running = false;
    stopTimer();
    controller.abort();
    options.signal?.removeEventListener("abort", dispose);
  }
  options.signal?.addEventListener("abort", dispose, {once: true});
  if (options.signal?.aborted) dispose();
  return {
    start,
    dispose,
    getState: state,
    getConfiguration: async () => state(),
    refresh,
    async deploymentOptions(content?: unknown): Promise<CatalogResult> {
      const force = typeof content === "object" && content !== null && "force" in content && content.force === true;
      if (!force && catalog && catalog.expires > clock.now()) return catalog.result;
      if (catalogPromise) return catalogPromise;
      catalogPromise = exclusive(async () => {
        const result = await backend.deploymentOptions();
        if (result.ok) catalog = {result, expires: clock.now() + 300_000};
        else catalog = undefined;
        return result;
      }).finally(() => {catalogPromise = undefined;});
      return catalogPromise;
    },
    async setPolling(content: unknown) {
      return exclusive(async () => {
        const seconds = typeof content === "object" && content !== null && "seconds" in content ? content.seconds : undefined;
        if (typeof seconds !== "number" || !intervals.includes(seconds)) return {ok: false as const, configuration, error: {code: "invalid_input" as const, retryable: false, message: "Choose a supported automatic refresh interval."}, pollingSeconds};
        try {
          await options.preferences.save(seconds);
          pollingSeconds = seconds;
            preferenceError = null;
          schedule();
          return state();
        } catch {
          preferenceError = {code: "refresh_settings_unavailable", retryable: true, message: "Could not save the automatic refresh interval."};
          return {ok: false as const, configuration, error: preferenceError, pollingSeconds};
        }
      });
    },
    async saveConnection(content: unknown) {
      const result = await exclusive(async () => {
        const result = await backend.saveConnection(content);
        remember(result);
        if (result.ok) {snapshot = null; catalog = undefined; error = null;}
        return result;
      });
      if (result.ok && result.configuration.ready && !disposed) void refresh().catch(() => {});
      return result;
    },
    async removeConnection() {
      return exclusive(async () => {
        const result = await backend.removeConnection();
        remember(result);
        if (result.ok) {snapshot = null; catalog = undefined; error = null; deployment = undefined; monitoring = undefined;}
        schedule();
        return result;
      });
    },
    async armDeployment(content: unknown) {
      const result = await exclusive(async () => {
        const result = await backend.armDeployment(content);
        remember(result);
        return result;
      });
      if (result.deployment?.status === "waiting" && !disposed) void refresh().catch(() => {});
      else schedule();
      return result;
    },
    async cancelDeployment() {
      return exclusive(async () => {
        const result = await backend.cancelDeployment();
        remember(result);
        schedule();
        return result;
      });
    },
  };
}
