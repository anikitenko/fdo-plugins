import type {AvailabilityService} from "./service";
import type {AvailabilityItem} from "./logic";

const ENDPOINT = "https://infrahub-api.nexgencloud.com/v1/pricebook";
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const amount = (v: unknown): number | null => {
  if (typeof v !== "number" && !(typeof v === "string" && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v))) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
type Rate = {value: number; original: number | null; start: number | null; end: number | null};
type PriceFetch = (url: string, init: RequestInit) => Promise<{ok: boolean; json(): Promise<unknown>}>;

/** Pricebook failures never change availability or prevent an armed stock check. */
export function withHyperstackPricing(service: AvailabilityService, options: {fetch?: PriceFetch; now?: () => number; timeoutMs?: number} = {}): AvailabilityService {
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  let cached: {key: string; expires: number; rates: Map<string, Rate> | null} | undefined;
  let pending: {key: string; promise: Promise<Map<string, Rate> | null>} | undefined;
  const load = (key: string): Promise<Map<string, Rate> | null> => {
    if (cached?.key === key && cached.expires > now()) return Promise.resolve(cached.rates);
    if (pending?.key === key) return pending.promise;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async () => {
      const response = await request(ENDPOINT, {method: "GET", headers: {api_key: key, Accept: "application/json"}, signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store"});
      if (!response.ok) throw new Error("Pricebook unavailable");
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("Invalid pricebook");
      const rates = new Map<string, Rate>();
      const seen = new Set<string>();
      for (const entry of body) {
        if (!record(entry) || typeof entry.name !== "string") continue;
        const name = entry.name.trim().toLowerCase();
        if (seen.has(name)) {rates.delete(name); continue;} // Ambiguous resources cannot be quoted.
        seen.add(name);
        const value = amount(entry.value);
        const start = entry.start_time == null ? null : typeof entry.start_time === "string" ? Date.parse(entry.start_time) : NaN;
        const end = entry.end_time == null ? null : typeof entry.end_time === "string" ? Date.parse(entry.end_time) : NaN;
        if (value === null || (start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end)) || (start !== null && end !== null && start >= end)) continue;
        rates.set(name, {value, original: amount(entry.original_value), start, end});
      }
      return rates;
    };
    const promise = Promise.race([operation(), new Promise<null>(resolve => {
      timer = setTimeout(() => {controller.abort(); resolve(null);}, options.timeoutMs ?? 5000);
    })]).catch(() => null).then(rates => {
      cached = {key, rates, expires: now() + (rates ? 300_000 : 15_000)};
      return rates;
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (pending?.promise === promise) pending = undefined;
    });
    pending = {key, promise};
    return promise;
  };
  return {
    async check(key, checkOptions) {
      const [result, rates] = await Promise.all([service.check(key, checkOptions), load(key)]);
      if (!result.ok) return result;
      const items = result.snapshot.items.map((item): AvailabilityItem => {
        const gpu = item.gpu.trim().toLowerCase();
        const resource = /(?:^|-)spot(?:-|$)/i.test(item.flavor) && !gpu.endsWith("-spot") ? `${gpu}-spot` : gpu;
        const rate = rates?.get(resource);
        const time = now();
        const active = rate && (rate.start === null || time >= rate.start) && (rate.end === null || time < rate.end);
        const perGpu = rate ? active ? rate.value : rate.original : null;
        const count = item.gpuCount;
        const total = perGpu != null && typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? perGpu * count : null;
        return {...item, hourlyPrice: total !== null && Number.isFinite(total) && total >= 0 ? total : null};
      });
      return {...result, snapshot: {...result.snapshot, items}};
    },
  };
}
