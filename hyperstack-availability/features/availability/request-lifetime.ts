/** Bound request work to both its deadline and the owning backend's lifetime. */
export async function withRequestLifetime<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => {
      controller.abort();
      reject(new Error("Request stopped."));
    };
  });
  const timer = setTimeout(interrupt, timeoutMs);
  parent?.addEventListener("abort", interrupt, {once: true});
  try {
    if (parent?.aborted) interrupt();
    // Do not dispatch when shutdown already started. Race also observes late
    // rejections from transports that ignore cancellation.
    return await Promise.race([
      interrupted,
      controller.signal.aborted ? interrupted : operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", interrupt);
    controller.abort();
  }
}
