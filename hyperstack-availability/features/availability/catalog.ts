import {withRequestLifetime} from "./request-lifetime";

/** Hyperstack core resource catalog. Only public selection metadata crosses the bridge. */
export interface DeploymentCatalog {
  environments: {name: string; region: string}[];
  images: {name: string; region: string}[];
  keypairs: {name: string; environment: string}[];
}
export type CatalogResult = {ok: true; catalog: DeploymentCatalog} | {ok: false; message: string};
type CatalogFetch = (url: string, init: RequestInit) => Promise<{ok: boolean; json(): Promise<unknown>}>;
const API = "https://infrahub-api.nexgencloud.com/v1/core";
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => {
  if (typeof v !== "string" || !v.trim() || v.length > 255) throw new Error("Invalid catalog");
  return v;
};

// Images are grouped by region and OS type. Retain only actual image leaves.
function imageLeaves(value: unknown, region = ""): DeploymentCatalog["images"] {
  if (Array.isArray(value)) return value.flatMap(v => imageLeaves(v, region));
  if (!record(value)) throw new Error("Invalid images");
  const currentRegion = typeof value.region_name === "string" ? value.region_name : region;
  if (typeof value.name === "string" && !Array.isArray(value.images)) {
    return [{name: text(value.name), region: text(currentRegion)}];
  }
  const children = value.images ?? value.data;
  if (Array.isArray(children)) return imageLeaves(children, currentRegion);
  // Some responses group images under OS names (Ubuntu, Windows, ...).
  if (record(children)) return Object.values(children).flatMap(v => imageLeaves(v, currentRegion));
  throw new Error("Invalid image group");
}

export function createDeploymentCatalogService(options: {fetch?: CatalogFetch; timeoutMs?: number} = {}) {
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async load(apiKey: string, optionsForRequest: {signal?: AbortSignal} = {}): Promise<CatalogResult> {
      const operation = async (signal: AbortSignal): Promise<CatalogResult> => {
        const init: RequestInit = {method: "GET", headers: {api_key: apiKey}, signal, redirect: "error", credentials: "omit", cache: "no-store"};
        async function pages(resource: "environments" | "images" | "keypairs"): Promise<unknown[]> {
          const result: unknown[] = [];
          for (let page = 1; page <= 100; page++) {
            if (signal.aborted) throw new Error("Catalog expired");
            const size = resource === "images" ? "per_page" : "page_size";
            const response = await request(`${API}/${resource}?page=${page}&${size}=100`, init);
            if (!response.ok) throw new Error("Catalog unavailable");
            const body = await response.json();
            if (signal.aborted) throw new Error("Catalog expired");
            if (!record(body) || body.status !== true) throw new Error("Invalid catalog");
            const entries = resource === "images" ? body.images ?? body.data : body[resource];
            if (!Array.isArray(entries)) throw new Error("Invalid catalog");
            result.push(...entries);
            // count describes total resources in paginated Hyperstack responses.
            const loaded = resource === "images" ? imageLeaves(result).length : result.length;
            if (typeof body.count === "number" ? loaded >= body.count : (resource === "images" ? imageLeaves(entries).length : entries.length) < 100) return result;
            if (entries.length === 0) throw new Error("Incomplete catalog");
          }
          throw new Error("Catalog too large");
        }
        const [environments, images, keypairs] = await Promise.all([pages("environments"), pages("images"), pages("keypairs")]);
        return {ok: true, catalog: {
          environments: environments.map(v => {
            if (!record(v)) throw new Error("Invalid environment");
            return {name: text(v.name), region: text(v.region)};
          }),
          images: imageLeaves(images),
          keypairs: keypairs.map(v => {
            if (!record(v) || !record(v.environment)) throw new Error("Invalid keypair");
            return {name: text(v.name), environment: text(v.environment.name)};
          }),
        }};
      };
      const failed: CatalogResult = {ok: false, message: "Could not load VM options. Check API permissions for environments, images and keypairs, then reload options."};
      try {
        return await withRequestLifetime(optionsForRequest.signal, options.timeoutMs ?? 15000, operation);
      } catch { return failed; }
    },
  };
}
export type DeploymentCatalogService = ReturnType<typeof createDeploymentCatalogService>;
