import type {PluginRegistry} from "@anikitenko/fdo-sdk";
import type {MonitoringRecord} from "./deployment";

export const MONITORING_STORAGE_KEY = "hyperstack.monitoring.v1";
export interface MonitoringPersistence {
  load(): Promise<unknown>;
  save(value: MonitoringRecord): Promise<void>;
}

/** Host-scoped JSON storage only; never silently downgrade to memory storage. */
export function createMonitoringPersistence(getStore: () => ReturnType<typeof PluginRegistry.useStore>): MonitoringPersistence {
  const storage = () => {
    const store = getStore();
    if (store.capabilities?.persistent !== true || typeof store.flush !== "function") throw new Error("Persistent storage unavailable");
    return store;
  };
  return {
    async load() { return storage().get(MONITORING_STORAGE_KEY); },
    async save(value) {
      const store = storage();
      store.set(MONITORING_STORAGE_KEY, value);
      await store.flush!();
    },
  };
}


/** Separate key: VM state transitions must never overwrite the refresh preference. */
export function createRefreshPreferences(getStore: () => ReturnType<typeof PluginRegistry.useStore>) {
  const key = "hyperstack.automatic-refresh.v1";
  const storage = () => {
    const store = getStore();
    if (store.capabilities?.persistent !== true || typeof store.flush !== "function") throw new Error("Persistent storage unavailable");
    return store;
  };
  return {
    async load(): Promise<unknown> { return storage().get(key); },
    async save(seconds: number): Promise<void> {
      if (![0, 60, 300, 600].includes(seconds)) throw new Error("Invalid refresh interval");
      const store = storage();
      store.set(key, seconds);
      await store.flush!();
    },
  };
}
