/** Cost Management read policy only. Never wrap resource mutations with this coordinator. */
export function retryAfterMs(
  message: string,
  now = Date.now(),
): number | undefined {
  let delay: number | undefined;
  const pattern =
    /(?:["']?)(retry-after|x-ms-ratelimit-microsoft\.(?:costmanagement-(?:qpu|entity|tenant|clienttype)|consumption)-retry-after)(?:["']?)\s*[:=]\s*["']?([^\r\n"'}]+)/gi;
  for (const match of message.slice(0, 65536).matchAll(pattern)) {
    const raw = match[2].trim();
    const seconds = /^(?:\d+\.?\d*)$/.test(raw) ? Number(raw) : null;
    const parsed = seconds == null ? Date.parse(raw) - now : seconds * 1000;
    if (Number.isFinite(parsed) && parsed >= 0)
      delay = Math.max(delay ?? 0, parsed);
  }
  return delay;
}
export function isBillingThrottle(error: unknown): error is Error & {
  throttled: true;
  retryAfterMs?: number;
  retryAt?: number;
} {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { throttled?: boolean }).throttled === true
  );
}
export class BillingCooldownError extends Error {
  readonly throttled = true;
  constructor(
    readonly retryAt: number,
    now: number,
  ) {
    super(
      `Azure billing reads are cooling down. Retry in at least ${Math.max(1, Math.ceil((retryAt - now) / 1000))} seconds; remaining billing requests were deferred. Non-billing reads are unaffected.`,
    );
  }
}
export type ReadContext = {
  active?: () => boolean;
  progress?: (message: string) => void;
};
type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
type Gate = { tail: Promise<void>; nextStart: number; blockedUntil: number };
type Cached = { value: unknown; at: number; chars: number };
export class CostReadCoordinator {
  private readonly clock: Clock;
  private readonly spacing: number;
  private readonly retries: number;
  private readonly waitLimit: number;
  private readonly jitter: () => number;
  private readonly gates = new Map<string, Gate>();
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<
    string,
    Promise<{ value: unknown; at: number; cached: boolean }>
  >();
  constructor(
    options: {
      clock?: Clock;
      spacingMs?: number;
      retries?: number;
      maxWaitMs?: number;
      jitter?: () => number;
    } = {},
  ) {
    this.clock = options.clock ?? {
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    this.spacing = options.spacingMs ?? 20000;
    this.retries = options.retries ?? 2;
    this.waitLimit = options.maxWaitMs ?? 90000;
    this.jitter = options.jitter ?? (() => Math.floor(Math.random() * 1000));
  }
  clear() {
    this.cache.clear();
    this.pending.clear();
    this.gates.clear();
  }
  private check(context: ReadContext) {
    if (context.active && !context.active())
      throw new Error(
        "Local billing read stopped; no additional Azure request was sent.",
      );
  }
  private async wait(until: number, context: ReadContext, reason: string) {
    while (this.clock.now() < until) {
      this.check(context);
      const remaining = until - this.clock.now();
      context.progress?.(
        `${reason} · ${Math.ceil(remaining / 1000)} seconds · Stop local loading is available`,
      );
      await this.clock.sleep(Math.min(1000, remaining));
    }
    this.check(context);
  }
  async request<T>(
    partition: string,
    work: () => Promise<T>,
    context: ReadContext = {},
  ): Promise<T> {
    let gate = this.gates.get(partition);
    if (!gate) {
      gate = { tail: Promise.resolve(), nextStart: 0, blockedUntil: 0 };
      this.gates.set(partition, gate);
    }
    const previous = gate.tail;
    let release!: () => void;
    gate.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.progress?.(
      "Queued billing read; Cost Management requests are serialized for this CLI identity and tenant",
    );
    try {
      await previous;
      this.check(context);
      if (gate.blockedUntil > this.clock.now())
        throw new BillingCooldownError(gate.blockedUntil, this.clock.now());
      const started = this.clock.now();
      for (let attempt = 0; ; attempt++) {
        await this.wait(gate.nextStart, context, "Pacing Azure billing reads");
        gate.nextStart = this.clock.now() + this.spacing;
        try {
          return await work();
        } catch (error) {
          if (!isBillingThrottle(error)) throw error;
          const delay =
            Math.max(
              error.retryAfterMs ?? 0,
              error.retryAfterMs == null ? 60000 * 2 ** attempt : 1000,
            ) + this.jitter();
          const retryAt = Math.min(
            Number.MAX_SAFE_INTEGER,
            this.clock.now() + delay,
          );
          gate.nextStart = Math.max(gate.nextStart, retryAt);
          if (
            attempt >= this.retries ||
            gate.nextStart - started > this.waitLimit
          ) {
            gate.blockedUntil = gate.nextStart;
            throw new BillingCooldownError(gate.blockedUntil, this.clock.now());
          }
          await this.wait(
            gate.nextStart,
            context,
            `Azure throttled billing; retry ${attempt + 1}/${this.retries}`,
          );
        }
      }
    } finally {
      release();
    }
  }
  async cached<T>(
    key: string,
    work: () => Promise<T>,
    context: ReadContext = {},
  ): Promise<{ value: T; at: number; cached: boolean }> {
    this.check(context);
    const hit = this.cache.get(key);
    if (hit && this.clock.now() - hit.at < 600000) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return {
        value: structuredClone(hit.value) as T,
        at: hit.at,
        cached: true,
      };
    }
    if (hit) this.cache.delete(key);
    const existing = this.pending.get(key);
    if (existing) {
      context.progress?.(
        "Waiting for an identical billing query already in progress",
      );
      const result = await existing;
      this.check(context);
      return {
        value: structuredClone(result.value) as T,
        at: result.at,
        cached: true,
      };
    }
    const pending = (async () => {
      const at = this.clock.now();
      const value = await work();
      this.check(context);
      const chars = JSON.stringify(value)?.length ?? 0;
      // Cache only complete successful datasets, with bounded memory. No tokens or failures are stored.
      if (chars <= 2000000 && this.clock.now() - at < 600000) {
        let total = [...this.cache.values()].reduce((n, c) => n + c.chars, 0);
        while (this.cache.size >= 20 || total + chars > 8000000) {
          const oldest = this.cache.keys().next().value;
          if (oldest == null) break;
          total -= this.cache.get(oldest)!.chars;
          this.cache.delete(oldest);
        }
        this.cache.set(key, { value: structuredClone(value), at, chars });
      }
      return { value, at, cached: false };
    })();
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
}
