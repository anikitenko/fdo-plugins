import {validateAvailabilityResponse} from "./logic";
import type {AvailabilitySnapshot} from "./logic";

/**
 * Provider-specific URLs, authentication and response mappings belong in an
 * explicit backend contract. SDK network availability does not establish a
 * Hyperstack endpoint or response schema.
 *
 * Credentials and authentication configuration must remain in backend code.
 * Only the validated public endpoint may appear in failure diagnostics.
 */
export interface HyperstackProviderContract {
  endpoint: string;
  authenticationHeader: string;
  formatCredential: (apiKey: string) => string;
  normalizeResponse: (response: unknown) => unknown;

  catalog?: {
    endpoint: string;
    normalizeResponse: (response: unknown) => unknown;
  };
}

export interface AvailabilityHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** Uses the standard backend fetch contract, with a narrow seam for tests. */
export type AvailabilityFetch = (
  url: string,
  options: {
    readonly method: "GET";
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly redirect: "error";
    readonly credentials: "omit";
    readonly cache: "no-store";
  },
) => Promise<AvailabilityHttpResponse>;

export type AvailabilityServiceErrorCode =
  | "credential_required"
  | "invalid_configuration"
  | "permission_denied"
  | "authentication_failed"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "network_error"
  | "provider_error"
  | "invalid_response";

/**
 * Deliberately selected public HTTP diagnostics. The endpoint is the validated
 * configured request target, not a response URL or evidence of its correctness.
 * Headers, credentials, exception messages and response bodies are excluded.
 */
export interface AvailabilityServiceDiagnostics {
  readonly httpStatus: number;
  readonly stage: "http_response";
  readonly endpoint: string;
}

export interface AvailabilityServiceFailure {
  readonly ok: false;
  readonly error: {
    readonly code: AvailabilityServiceErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly diagnostics?: AvailabilityServiceDiagnostics;
  };
}

export type AvailabilityServiceResult =
  | {
      readonly ok: true;
      readonly snapshot: AvailabilitySnapshot;
    }
  | AvailabilityServiceFailure;

export interface AvailabilityServiceOptions {
  readonly provider: HyperstackProviderContract;
  readonly fetch?: AvailabilityFetch;
  /** Includes response-body reading and response validation. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface AvailabilityService {
  check(
    apiKey: string,
    options?: {readonly signal?: AbortSignal},
  ): Promise<AvailabilityServiceResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

function failure(
  code: AvailabilityServiceErrorCode,
  message: string,
  retryable: boolean,
  diagnostics?: AvailabilityServiceDiagnostics,
): AvailabilityServiceFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(diagnostics ? {diagnostics} : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface NormalizedStockItem {
  id: string;
  region: string;
  gpu: string;
  flavor: string;
  availableCount: number | null;
  isAvailable: boolean | null;
}

function mergeInventory(
  catalog: readonly NormalizedStockItem[],
  stock: readonly NormalizedStockItem[],
): NormalizedStockItem[] {
  const stockById = new Map(
    stock.map(item => [item.id, item]),
  );

  const merged = catalog.map(item => {
    const matched = stockById.get(item.id);

    if (!matched) {
      return item;
    }

    return {
  ...item,
  availableCount: matched.availableCount ?? item.availableCount,
  isAvailable:
    matched.availableCount !== null
      ? matched.availableCount > 0
      : matched.isAvailable ?? item.isAvailable,
};
  });

  // Preserve stock entries absent from the flavor catalog.
  const catalogIds = new Set(catalog.map(item => item.id));

  for (const item of stock) {
    if (!catalogIds.has(item.id)) {
      merged.push(item);
    }
  }

  return merged;
}

/**
 * Inspect only stable codes. Never copy arbitrary exception messages, request
 * headers, exception URLs or provider bodies into application results.
 */
function isPermissionFailure(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== "string") {
    return false;
  }

  return [
    "PERMISSION_DENIED",
    "CAPABILITY_DENIED",
    "MISSING_CAPABILITY",
    "NETWORK_SCOPE_DENIED",
    "permission_denied",
    "capability_denied",
    "missing_capability",
    "network_scope_denied",
  ].includes(error.code);
}

function validateContract(
  provider: HyperstackProviderContract,
): string | null {
  try {
    const url = new URL(provider.endpoint);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) {
      return null;
    }

    // Authentication values are added separately, never embedded in a URL.
    if (url.search !== "") {
      return null;
    }

    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(provider.authenticationHeader)
      || /^(host|cookie|content-length|connection|accept)$/i.test(
        provider.authenticationHeader,
      )
      || typeof provider.formatCredential !== "function"
      || typeof provider.normalizeResponse !== "function"
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}


function validateCatalogEndpoint(
  provider: HyperstackProviderContract,
): string | null {
  if (!provider.catalog) {
    return null;
  }

  try {
    const url = new URL(provider.catalog.endpoint);

    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.search !== "" ||
      url.hostname !== "infrahub-api.nexgencloud.com" ||
      url.pathname !== "/v1/core/flavors" ||
      typeof provider.catalog.normalizeResponse !== "function"
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

const backendFetch: AvailabilityFetch = async (url, options) => {
  return fetch(url, options);
};

function httpFailure(
  status: number,
  endpoint: string,
): AvailabilityServiceFailure {
  // Validate even the injected transport's status before exposing diagnostics.
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return failure(
      "invalid_response",
      "Hyperstack returned an invalid HTTP status. Review the provider integration before retrying.",
      false,
    );
  }

  const diagnostics: AvailabilityServiceDiagnostics = {
    httpStatus: status,
    stage: "http_response",
    endpoint,
  };

  if (status === 401) {
    return failure(
      "authentication_failed",
      "Hyperstack rejected the API key. Save a valid key and retry.",
      false,
      diagnostics,
    );
  }

  if (status === 403) {
    return failure(
      "permission_denied",
      "Hyperstack denied access. Check the API key's account permissions.",
      false,
      diagnostics,
    );
  }

  if (status === 429) {
    return failure(
      "rate_limited",
      "Hyperstack is limiting requests. Wait before checking again.",
      true,
      diagnostics,
    );
  }

  const retryable = status === 408 || status >= 500;
  const message = status === 408
    ? "Hyperstack timed out while handling the availability request. Wait briefly, then retry."
    : status >= 500
      ? "Hyperstack returned a server error. Wait briefly, then retry. If it persists, contact Hyperstack support with the technical details."
      : status === 404
        ? "Hyperstack returned HTTP 404 for the configured availability endpoint. Review the plugin's API endpoint against current provider documentation before retrying."
        : status === 405
          ? "Hyperstack rejected the GET method for the configured availability endpoint. Review the plugin's endpoint and request method before retrying."
          : `Hyperstack could not complete the availability request (HTTP ${status}). Review the configured API endpoint and request requirements before retrying.`;

  return failure(
    "provider_error",
    message,
    retryable,
    diagnostics,
  );
}

/**
 * Instantiate only in backend code. Pass this service a key obtained through
 * SDK SecretStore.get; the service neither stores nor returns the credential.
 *
 * Fetch is already host-mediated. No host adapter configuration, SSH access
 * or separate SDK network facade is required.
 */
export function createAvailabilityService(
  options: AvailabilityServiceOptions,
): AvailabilityService {
  const fetchAvailability = options.fetch ?? backendFetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const provider = options.provider;
  const endpoint = validateContract(provider);
  const catalogEndpoint = provider.catalog
  ? validateCatalogEndpoint(provider)
  : null;
  const validTimeout = Number.isInteger(timeoutMs)
    && timeoutMs > 0
    && timeoutMs <= MAX_TIMEOUT_MS;

  return {
    async check(apiKey, requestOptions = {}): Promise<AvailabilityServiceResult> {
      if (
        typeof apiKey !== "string"
        || apiKey.trim() === ""
        || /[\r\n\u0000]/.test(apiKey)
      ) {
        return failure(
          "credential_required",
          "Save a valid Hyperstack API key before checking availability.",
          false,
        );
      }

      if (
  !endpoint ||
  !validTimeout ||
  (provider.catalog && !catalogEndpoint)
) {
        return failure(
          "invalid_configuration",
          "The backend availability request configuration is invalid.",
          false,
        );
      }

      const externalSignal = requestOptions.signal;
      if (externalSignal?.aborted) {
        return failure("cancelled", "The availability check was cancelled.", true);
      }

      let authentication: string;
      try {
        authentication = provider.formatCredential(apiKey.trim());
        if (
          typeof authentication !== "string"
          || authentication.trim() === ""
          || /[\r\n\u0000]/.test(authentication)
        ) {
          return failure(
            "invalid_configuration",
            "The backend authentication configuration is invalid.",
            false,
          );
        }
      } catch {
        return failure(
          "invalid_configuration",
          "The backend authentication configuration is invalid.",
          false,
        );
      }

      const controller = new AbortController();
      let interruption: "timeout" | "cancelled" | null = null;
      let settleInterruption:
        ((result: AvailabilityServiceFailure) => void) | undefined;

      // Racing the operation also enforces the deadline when a mocked or
      // noncompliant transport ignores AbortSignal.
      const interrupted = new Promise<AvailabilityServiceFailure>((resolve) => {
        settleInterruption = resolve;
      });

      const interrupt = (reason: "timeout" | "cancelled"): void => {
        if (interruption !== null) {
          return;
        }
        interruption = reason;
        settleInterruption?.(
          reason === "timeout"
            ? failure(
                "timeout",
                "The availability check timed out. Retry when Hyperstack is reachable.",
                true,
              )
            : failure(
                "cancelled",
                "The availability check was cancelled.",
                true,
              ),
        );
        controller.abort();
      };

      const onAbort = (): void => interrupt("cancelled");
      externalSignal?.addEventListener("abort", onAbort, {once: true});
      const timer = setTimeout(() => interrupt("timeout"), timeoutMs);

      
const retrieve = async (): Promise<AvailabilityServiceResult> => {
  try {
    const requestOptions = {
      method: "GET" as const,
      headers: {
        Accept: "application/json",
        [provider.authenticationHeader]: authentication,
      },
      signal: controller.signal,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
    };

    // Fetch both sources using the same timeout and abort signal.
    const stockPromise = fetchAvailability(
      endpoint,
      requestOptions,
    );

    const catalogPromise =
      provider.catalog && catalogEndpoint
        ? fetchAvailability(catalogEndpoint, requestOptions)
        : null;

    const [stockResponse, catalogResponse] = await Promise.all([
      stockPromise,
      catalogPromise,
    ]);

    if (!stockResponse.ok) {
      return httpFailure(stockResponse.status, endpoint);
    }

    if (catalogResponse && !catalogResponse.ok) {
      return httpFailure(
        catalogResponse.status,
        catalogEndpoint!,
      );
    }

    let normalized: unknown;

    try {
      const [stockBody, catalogBody] = await Promise.all([
        stockResponse.json(),
        catalogResponse ? catalogResponse.json() : null,
      ]);

      if (controller.signal.aborted) {
        return failure(
          "cancelled",
          "The availability check was cancelled.",
          true,
        );
      }

      const normalizedStock = provider.normalizeResponse(stockBody);

      // Validate the stock response before merging.
      const validatedStock =
        validateAvailabilityResponse(normalizedStock);

      if (!validatedStock.valid) {
        throw new Error("Invalid stock response");
      }

      if (provider.catalog && catalogResponse) {
        const normalizedCatalog =
          provider.catalog.normalizeResponse(catalogBody);

        const validatedCatalog =
          validateAvailabilityResponse(normalizedCatalog);

        if (!validatedCatalog.valid) {
          throw new Error("Invalid catalog response");
        }

        normalized = {
          items: mergeInventory(
            validatedCatalog.data.items,
            validatedStock.data.items,
          ),
        };
      } else {
        normalized = normalizedStock;
      }
    } catch {
      return failure(
        "invalid_response",
        "Hyperstack returned an unreadable or invalid inventory response.",
        true,
      );
    }

    // Validate the final merged inventory.
    const validated = validateAvailabilityResponse(normalized);

    if (!validated.valid) {
      return failure(
        "invalid_response",
        "Hyperstack returned unexpected inventory data.",
        true,
      );
    }

    return {
      ok: true,
      snapshot: {
        items: validated.data.items,
        checkedAt: now().toISOString(),
      },
    };
  } catch (error: unknown) {
    if (isPermissionFailure(error)) {
      return failure(
        "permission_denied",
        "Grant system.network, system.network.https and a matching HTTPS network scope, then retry.",
        false,
      );
    }

    return failure(
      "network_error",
      "The availability request failed. Check network access and retry.",
      true,
    );
  }
};

      try {
        if (externalSignal?.aborted) {
          onAbort();
        }
        if (interruption !== null) {
          return await interrupted;
        }
        return await Promise.race([retrieve(), interrupted]);
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onAbort);
        controller.abort();
      }
    },
  };
}
