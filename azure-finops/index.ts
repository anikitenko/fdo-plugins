import {
  FDO_SDK,
  PluginRegistry,
  createProcessCapabilityBundle,
} from "@anikitenko/fdo-sdk";
import { createBackend } from "./backend.ts";
import { render, onLoad } from "./render.ts";
export default class AzureFinOpsPlugin extends FDO_SDK {
  private backend?: ReturnType<typeof createBackend>;
  private unregisterBackend?: () => void;
  get metadata() {
    return {
      id: "azure-finops",
      name: "Azure FinOps & Resource Manager",
      version: "0.1.0",
      author: "AleXvWaN",
      description:
        "Azure spending, evidence-driven resource investigation and reviewed management via Azure CLI.",
      icon: "cloud",
    };
  }
  declareCapabilities() {
    return [
      ...createProcessCapabilityBundle("azure-finops"),
      "storage",
      "storage.json",
    ];
  }
  init() {
    this.backend?.dispose();
    this.unregisterBackend?.();
    const backend = createBackend(() => PluginRegistry.useStore("json"));
    this.backend = backend;
    this.unregisterBackend = this.onDispose(() => backend.dispose());
    for (const name of [
      "bootstrap",
      "configure",
      "saveView",
      "saveExploration",
      "getExploration",
      "addAction",
      "removeAction",
      "start",
      "execute",
      "poll",
      "accept",
      "stop",
      "state",
    ] as const)
      PluginRegistry.registerHandler(
        `azure-finops.${name}`,
        async (input: unknown) => {
          try {
            return { ok: true, data: await backend[name](input as any) };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : "Request failed.",
            };
          }
        },
      );
  }
  render() {
    return render();
  }
  renderOnLoad() {
    return onLoad();
  }
}
PluginRegistry.registerPlugin(new AzureFinOpsPlugin());
