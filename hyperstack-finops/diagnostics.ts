export interface RequestDiagnostics {
  method: string;
  path: string;
  httpStatus: number;
  providerCode: string | null;
  providerMessage: string | null;
  requestId: string | null;
  observedAt: string;
  guidance: string;
}
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly diagnostics: RequestDiagnostics,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
export function diagnosticText(d: RequestDiagnostics): string {
  return `${d.method} ${d.path} · HTTP ${d.httpStatus}${d.providerCode ? ` · ${d.providerCode}` : ""}${d.requestId ? ` · Request ID ${d.requestId}` : ""}. ${d.providerMessage ?? "The provider returned no additional reason."} ${d.guidance}`;
}
export function redactMessage(value: unknown, key: string): string | null {
  if (typeof value !== "string") return null;
  const safe = value
    .split(key)
    .join("[redacted]")
    .replace(
      /(?:api[_ -]?key|authorization|bearer|token|password|secret)\s*[:=]?\s*["']?[^\s,;"']+/gi,
      "[credential redacted]",
    )
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim();
  return safe ? safe.slice(0, 500) : null;
}
