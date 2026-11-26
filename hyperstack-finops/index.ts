import { ProviderError } from "./diagnostics";
import { chartSpecs } from "./charts";
import type { WorkProgress, ProgressUpdate } from "./types";
import {
  FDO_SDK,
  PluginRegistry,
  createCapabilityBundle,
  createSecretsCapabilityBundle,
  requireCapability,
} from "@anikitenko/fdo-sdk";
import { createBackend } from "./backend";
import { createProvider } from "./provider";
import { readView, renderContent, renderShell } from "./render";
import { onLoad } from "./frontend";
import type { Saved } from "./types";
import { record } from "./types";
export default class HyperstackFinOpsPlugin extends FDO_SDK {
  private lifetime?: AbortController;
  private unregisterLifetime?: () => void;
  get metadata() {
    return {
      id: "hyperstack-finops",
      name: "Hyperstack FinOps",
      version: "0.1.0",
      author: "AleXvWaN",
      description:
        "Investigate GPU spend, verify cost savings opportunities, and execute reviewed hibernation or storage cleanup plans.",
      icon: "chart",
    };
  }
  declareCapabilities() {
    return createCapabilityBundle([
      ...createSecretsCapabilityBundle(["get", "set", "delete"]),
      "storage",
      "storage.json",
      "system.network",
      "system.network.https",
      "system.network.scope.public-web-secure",
    ]);
  }
  init() {
    this.lifetime?.abort();
    this.unregisterLifetime?.();
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    const signal = AbortSignal.any([this.signal, lifetime.signal]);
    this.unregisterLifetime = this.onDispose(() => lifetime.abort());
    const store = () => {
      const s = PluginRegistry.useStore("json");
      if (s.capabilities?.persistent !== true || typeof s.flush !== "function")
        throw new Error(
          "Persistent plugin storage is unavailable. Grant storage access and retry.",
        );
      return s;
    };
    let progress: WorkProgress = {
      active: false,
      label: "Ready",
      updatedAt: new Date().toISOString(),
    };
    const report = (update: ProgressUpdate) => {
      progress = { ...update, updatedAt: new Date().toISOString() };
    };
    PluginRegistry.registerHandler("hyperstack-finops.progress", () => ({
      ok: true,
      progress,
    }));
    const backend = createBackend({
      provider: createProvider(undefined, signal, report),
      report,
      secrets: this.secrets,
      signal,
      persistence: {
        load: async () => store().get("hyperstack-finops.v1"),
        save: async (data: Saved) => {
          const s = store();
          s.set("hyperstack-finops.v1", data);
          await s.flush!();
        },
      },
      authorizeManagement: () => {
        for (const cap of [
          "system.network",
          "system.network.https",
          "system.network.scope.public-web-secure",
        ] as const)
          requireCapability(
            cap,
            "execute reviewed Hyperstack management operations",
          );
      },
    });
    for (const operation of [
      "state",
      "configure",
      "budget",
      "sync",
      "retryBilling",
      "demo",
      "stage",
      "unstage",
      "capacity",
      "execute",
    ] as const)
      PluginRegistry.registerHandler(
        `hyperstack-finops.${operation}`,
        async (content: unknown) => {
          try {
            if (!record(content)) throw new Error("Invalid request.");
            const state = await backend[operation](content.data);
            const view = readView(content.view);
            if (state.snapshot) {
              if (
                !state.snapshot.resources.some(
                  (r) => r.environment === view.environment,
                )
              )
                view.environment = "";
              if (
                !state.snapshot.resources.some((r) => r.region === view.region)
              )
                view.region = "";
            }
            return {
              ok: true,
              html: renderContent(state, view),
              charts: chartSpecs(state, view),
              configured: state.configured,
              demo: state.demo,
              billingRetry: state.billingRetry,
              period: state.snapshot?.windows.period,
              rangeStart: state.snapshot?.windows.current.start.slice(0, 10),
              rangeEnd: state.snapshot
                ? new Date(Date.parse(state.snapshot.windows.current.end) - 1)
                    .toISOString()
                    .slice(0, 10)
                : undefined,
              environments: [
                ...new Set(
                  state.snapshot?.resources.map((r) => r.environment) ?? [],
                ),
              ].sort(),
              regions: [
                ...new Set(
                  state.snapshot?.resources.map((r) => r.region) ?? [],
                ),
              ].sort(),
            };
          } catch (error) {
            // SDK/transport exceptions can contain private request details. Only our
            // controlled application messages cross the iframe bridge.
            const message = error instanceof Error ? error.message : "";
            const safe =
              /^(Invalid |Saved |Persistent |Provider |Hyperstack |Billing |Resource |Select |Save a |Enter a |Budget |Example |Planned |Choose |Historical |Dependencies |This flavor |Only |Contract |Stage |Review |Plan |A previous |Type the exact |Could not persist |Operation audit)/.test(
                message,
              );
            return {
              ok: false,
              ...(error instanceof ProviderError
                ? { diagnostics: error.diagnostics }
                : {}),
              error: safe
                ? message
                : "Connection, permission or storage access failed. Check FDO grants and the saved API key, then retry.",
            };
          }
        },
      );
  }
  render() {
    return renderShell();
  }
  renderOnLoad() {
    return onLoad();
  }
}
PluginRegistry.registerPlugin(new HyperstackFinOpsPlugin());
