import {
  FDO_SDK,
  PluginRegistry,
  createCapabilityBundle,
  createSecretsCapabilityBundle,
} from "@anikitenko/fdo-sdk";
import type {PluginCapability, PluginMetadata} from "@anikitenko/fdo-sdk";
import {renderView} from "./render";
import {
  AVAILABILITY_HANDLERS,
  createAvailabilityBackend,
} from "./features/availability/backend";
import {createAvailabilityService} from "./features/availability/service";
import type {HyperstackProviderContract} from "./features/availability/service";
import {createAvailabilityActions} from "./features/availability/actions";

interface NormalizedStockItem {
  id: string;
  region: string;
  gpu: string;
  flavor: string;
  availableCount: number | null;
  isAvailable: boolean | null;
}

interface NormalizedStockResponse {
  items: NormalizedStockItem[];
}

const HYPERSTACK_API = {
  stocks: "https://infrahub-api.nexgencloud.com/v1/core/stocks",
  flavors: "https://infrahub-api.nexgencloud.com/v1/core/flavors",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid provider response.");
  }
  return value.trim();
}

function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error("Invalid provider response.");
  }
  return value;
}


function normalizeFlavors(
  response: unknown,
): NormalizedStockResponse {
  if (
    !isRecord(response) ||
    response.status !== true ||
    !Array.isArray(response.data)
  ) {
    throw new Error("Invalid provider response.");
  }

  const items: NormalizedStockItem[] = [];
  const identifiers = new Set<string>();

  for (const group of response.data) {
    if (!isRecord(group) || !Array.isArray(group.flavors)) {
      throw new Error("Invalid provider response.");
    }

    const groupRegion = requiredText(group.region_name);

    for (const entry of group.flavors) {
      if (!isRecord(entry)) {
        throw new Error("Invalid provider response.");
      }

      const region = requiredText(entry.region_name);

      // Prevent inconsistent region mapping.
      if (region !== groupRegion) {
        throw new Error("Invalid provider response.");
      }

      // CPU-only flavors are irrelevant to GPU availability.
      if (entry.gpu === "") {
        continue;
      }

      const gpu = requiredText(entry.gpu);
      const flavor = requiredText(entry.name);

      if (
        typeof entry.gpu_count !== "number" ||
        !Number.isSafeInteger(entry.gpu_count) ||
        entry.gpu_count <= 0
      ) {
        throw new Error("Invalid provider response.");
      }

      // The API exposes availability as a boolean,
      // not an exact VM capacity count.
      const availability = entry.stock_available;

      if (
        availability !== null &&
        availability !== undefined &&
        typeof availability !== "boolean"
      ) {
        throw new Error("Invalid provider response.");
      }

      const id = JSON.stringify([region, gpu, flavor]);

      if (identifiers.has(id)) {
        throw new Error("Invalid provider response.");
      }

      identifiers.add(id);

      items.push({
        id,
        region,
        gpu,
        flavor,
        availableCount: null,
        isAvailable:
          typeof availability === "boolean"
            ? availability
            : null,
      });
    }
  }

  return {items};
}

/**
 * Keep provider parsing in the backend. A catalog entry without explicit
 * capacity evidence remains unknown rather than implying launchable stock.
 */

function normalizeStock(
  response: unknown,
): NormalizedStockResponse {
  if (!isRecord(response) || !Array.isArray(response.stocks)) {
    throw new Error("Invalid provider response.");
  }

  const items: NormalizedStockItem[] = [];
  const identifiers = new Set<string>();

  for (const stock of response.stocks) {
    if (!isRecord(stock) || !Array.isArray(stock.models)) {
      throw new Error("Invalid provider response.");
    }

    const region = requiredText(stock.region);

    for (const model of stock.models) {
      if (!isRecord(model)) {
        throw new Error("Invalid provider response.");
      }

      const gpu = requiredText(model.model);
      const configurations = model.configurations;

      if (!isRecord(configurations)) {
        throw new Error("Invalid provider response.");
      }

      for (const [name, rawCount] of Object.entries(configurations)) {
        const flavor = requiredText(name);
        const availableCount = optionalCount(rawCount);

        // A present configuration must provide a valid count.
        if (availableCount === null) {
          throw new Error("Invalid provider response.");
        }

        const id = JSON.stringify([region, gpu, flavor]);

        if (identifiers.has(id)) {
          throw new Error("Invalid provider response.");
        }

        identifiers.add(id);

        items.push({
          id,
          region,
          gpu,
          flavor,
          availableCount,
          isAvailable: availableCount > 0,
        });
      }
    }
  }

  return {items};
}

const HYPERSTACK_PROVIDER: HyperstackProviderContract = {
  endpoint: HYPERSTACK_API.stocks,
  authenticationHeader: "api_key",
  formatCredential: (apiKey: string): string => apiKey,
  normalizeResponse: normalizeStock,

  catalog: {
    endpoint: HYPERSTACK_API.flavors,
    normalizeResponse: normalizeFlavors,
  },
};

export default class HyperstackAvailabilityPlugin extends FDO_SDK {
  private readonly pluginMetadata: PluginMetadata = {
    name: "Hyperstack availability",
    version: "1.0.0",
    author: "AleXvWaN",
    description: "Check Hyperstack GPU stock by region using a securely stored API key.",
    icon: "server",
  };

  get metadata(): PluginMetadata {
    return this.pluginMetadata;
  }

  declareCapabilities(): PluginCapability[] {
    return createCapabilityBundle([
      ...createSecretsCapabilityBundle(["get", "set", "delete"]),
      "system.network",
      "system.network.https",
      "system.network.scope.public-web-secure",
    ]);
  }

  init(): void {
    const service = createAvailabilityService({
      provider: HYPERSTACK_PROVIDER,
      timeoutMs: 15_000,
    });

    const backend = createAvailabilityBackend({
      secrets: this.secrets,
      service,
    });

    PluginRegistry.registerHandler(
      AVAILABILITY_HANDLERS.configuration,
      () => backend.getConfiguration(),
    );

    PluginRegistry.registerHandler(
      AVAILABILITY_HANDLERS.saveConnection,
      (content: unknown) => backend.saveConnection(content),
    );

    PluginRegistry.registerHandler(
      AVAILABILITY_HANDLERS.removeConnection,
      () => backend.removeConnection(),
    );

    PluginRegistry.registerHandler(
      AVAILABILITY_HANDLERS.refresh,
      () => backend.refresh(),
    );
  }

  render(): string {
    return renderView();
  }

  renderOnLoad(): ReturnType<typeof createAvailabilityActions> {
    return createAvailabilityActions();
  }
}

new HyperstackAvailabilityPlugin();