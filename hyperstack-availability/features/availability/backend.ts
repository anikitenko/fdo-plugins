import type {FDO_SDK} from "@anikitenko/fdo-sdk";
import type {AvailabilitySnapshot} from "./logic";
import type {
  AvailabilityService,
  AvailabilityServiceDiagnostics,
  AvailabilityServiceErrorCode,
  AvailabilityServiceFailure,
} from "./service";

export const AVAILABILITY_HANDLERS = {
  configuration: "hyperstack.availability.configuration",
  saveConnection: "hyperstack.availability.saveConnection",
  removeConnection: "hyperstack.availability.removeConnection",
  refresh: "hyperstack.availability.refresh",
} as const;

/** One plugin-scoped key; never accept a storage key from iframe input. */
export const AVAILABILITY_SECRET_KEY = "hyperstack.api-key";

export type AvailabilitySecretStore = Pick<
  FDO_SDK["secrets"],
  "get" | "set" | "delete"
>;

export type AvailabilityConfigurationStatus =
  | "ready"
  | "credential_required"
  | "permission_denied"
  | "storage_locked"
  | "storage_unavailable";

export interface AvailabilityConfiguration {
  /** True only when a nonempty key has been confirmed in secure storage. */
  readonly configured: boolean;
  /** Reflects the most recent storage operation, not a permanent SDK limit. */
  readonly credentialStorageAvailable: boolean;
  /** The injected service owns the verified provider contract. */
  readonly providerContractAvailable: boolean;
  /** Ready to attempt a check; does not assert network grants or valid auth. */
  readonly ready: boolean;
  readonly status: AvailabilityConfigurationStatus;
  readonly message: string;
}

export type AvailabilityBackendErrorCode =
  | AvailabilityServiceErrorCode
  | "invalid_input"
  | "storage_locked"
  | "storage_unavailable";

export interface AvailabilityBackendError {
  readonly code: AvailabilityBackendErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Selected public request facts; never headers or provider response bodies. */
  readonly diagnostics?: AvailabilityServiceDiagnostics;
}

export interface AvailabilityBackendFailure {
  readonly ok: false;
  readonly error: AvailabilityBackendError;
  readonly configuration: AvailabilityConfiguration;
}

export type AvailabilityConfigurationResult =
  | {
      readonly ok: true;
      readonly configuration: AvailabilityConfiguration;
    }
  | AvailabilityBackendFailure;

export type AvailabilityRefreshResult =
  | {
      readonly ok: true;
      readonly configuration: AvailabilityConfiguration;
      readonly snapshot: AvailabilitySnapshot;
    }
  | AvailabilityBackendFailure;

export interface AvailabilityBackendOptions {
  /** Pass the plugin instance's this.secrets from init(). */
  readonly secrets: AvailabilitySecretStore;
  /** Construct the service in backend code, never from iframe options. */
  readonly service: AvailabilityService;
}

export interface AvailabilityBackend {
  getConfiguration(): Promise<AvailabilityConfigurationResult>;
  /** UI_MESSAGE content is passed directly: {apiKey: string}. */
  saveConnection(content: unknown): Promise<AvailabilityConfigurationResult>;
  removeConnection(): Promise<AvailabilityConfigurationResult>;
  refresh(): Promise<AvailabilityRefreshResult>;
}

const CONFIGURATION_MESSAGES: Readonly<
  Record<AvailabilityConfigurationStatus, string>
> = {
  ready: "An API key is saved. Check availability to verify access and stock.",
  credential_required: "Save your Hyperstack API key to check availability.",
  permission_denied:
    "Grant the required secret-storage capabilities, then retry the connection check.",
  storage_locked:
    "Unlock secure credential storage, then retry the connection check.",
  storage_unavailable:
    "Secure credential storage is currently unavailable. Restore access, then retry.",
};

function configuration(
  status: AvailabilityConfigurationStatus,
): AvailabilityConfiguration {
  const ready = status === "ready";
  return {
    configured: ready,
    credentialStorageAvailable:
      ready || status === "credential_required",
    providerContractAvailable: true,
    ready,
    status,
    message: CONFIGURATION_MESSAGES[status],
  };
}

function failure(
  current: AvailabilityConfiguration,
  code: AvailabilityBackendErrorCode,
  message: string,
  retryable: boolean,
  diagnostics?: AvailabilityServiceDiagnostics,
): AvailabilityBackendFailure {
  return {
    ok: false,
    configuration: current,
    error: {
      code,
      message,
      retryable,
      ...(diagnostics ? {diagnostics} : {}),
    },
  };
}

/**
 * Inspect only a machine-readable error code. Never relay exception messages,
 * provider bodies, rejected inputs or storage errors across the bridge.
 */
function storageFailure(error: unknown): AvailabilityBackendFailure {
  let code = "";
  try {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
    ) {
      code = error.code.toLowerCase().replace(/[-.\s]+/g, "_");
    }
  } catch {
    // An unreadable error code is treated as unavailable storage.
  }

  if (
    /(?:^|_)(?:permission|capability|grant|access)(?:_|$)/.test(code)
    || /(?:^|_)(?:denied|forbidden|unauthorized)(?:_|$)/.test(code)
  ) {
    const current = configuration("permission_denied");
    return failure(current, "permission_denied", current.message, true);
  }

  if (/(?:^|_)locked(?:_|$)/.test(code)) {
    const current = configuration("storage_locked");
    return failure(current, "storage_locked", current.message, true);
  }

  const current = configuration("storage_unavailable");
  return failure(current, "storage_unavailable", current.message, true);
}

function validCredential(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 8192
    && value.trim() === value
    && !/[\u0000-\u0020\u007f]/.test(value);
}

function readCredentialInput(content: unknown): string | null {
  if (
    typeof content !== "object"
    || content === null
    || Array.isArray(content)
    || !("apiKey" in content)
  ) {
    return null;
  }

  const value = content.apiKey;
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return validCredential(trimmed) ? trimmed : null;
}

function serviceFailure(
  current: AvailabilityConfiguration,
  error: AvailabilityServiceFailure["error"],
): AvailabilityBackendFailure {
  const {code, retryable} = error;
  let diagnostics: AvailabilityServiceDiagnostics | undefined;

  // Copy only declared public fields. Never spread service errors or relay
  // free-form messages, response bodies, headers or exception properties.
  try {
    const candidate = error.diagnostics;
    if (
      candidate
      && candidate.stage === "http_response"
      && Number.isInteger(candidate.httpStatus)
      && candidate.httpStatus >= 100
      && candidate.httpStatus <= 599
      && typeof candidate.endpoint === "string"
    ) {
      const endpoint = new URL(candidate.endpoint);
      if (
        endpoint.protocol === "https:"
        && endpoint.username === ""
        && endpoint.password === ""
        && endpoint.search === ""
        && endpoint.hash === ""
      ) {
        diagnostics = {
          httpStatus: candidate.httpStatus,
          stage: "http_response",
          endpoint: endpoint.href,
        };
      }
    }
  } catch {
    // Invalid diagnostics must not replace the original application failure.
  }

  let message: string;
  switch (code) {
    case "credential_required":
      current = configuration("credential_required");
      message = "Save your Hyperstack API key to check availability.";
      break;
    case "invalid_configuration":
      message =
        "The Hyperstack provider configuration is invalid. Review the plugin configuration before retrying.";
      break;
    case "permission_denied":
      message = diagnostics?.httpStatus === 403
        ? "Hyperstack denied access to availability data. Check the saved API key's account permissions before retrying."
        : "Grant the required HTTPS network capabilities and destination scope, then retry.";
      break;
    case "authentication_failed":
      message =
        "Hyperstack rejected this API key. Save a valid key with access to availability data, then retry.";
      break;
    case "rate_limited":
      message =
        "Hyperstack is limiting requests. Wait before retrying or increase the refresh interval.";
      break;
    case "timeout":
      message =
        "The availability check timed out. Retry when the connection is available.";
      break;
    case "cancelled":
      message = "The availability check was cancelled. Retry when ready.";
      break;
    case "network_error":
      message = "Hyperstack could not be reached. Check connectivity and retry.";
      break;
    case "provider_error": {
      const status = diagnostics?.httpStatus;
      if (retryable) {
        message = status === 408
          ? "Hyperstack timed out while handling the availability request. Wait briefly, then retry."
          : "Hyperstack could not complete the availability request. Wait briefly, then retry. If it persists, contact Hyperstack support with the technical details.";
      } else if (status === 404) {
        message =
          "Hyperstack returned HTTP 404 for the configured availability endpoint. Review the plugin's API endpoint against current provider documentation before retrying.";
      } else if (status === 405) {
        message =
          "Hyperstack rejected the GET method for the configured availability endpoint. Review the plugin's endpoint and request method before retrying.";
      } else {
        message = status === undefined
          ? "Hyperstack rejected the availability request. Review the configured API endpoint and request requirements before retrying."
          : `Hyperstack rejected the availability request (HTTP ${status}). Review the configured API endpoint and request requirements before retrying.`;
      }
      break;
    }
    case "invalid_response":
      message = retryable
        ? "Hyperstack returned an unsupported availability response. Existing results do not confirm current stock. Retry later; if it persists, review the provider integration."
        : "Hyperstack returned an unsupported availability response. Review the provider integration before retrying. Existing results do not confirm current stock.";
      break;
  }

  return failure(current, code, message, retryable, diagnostics);
}

/**
 * All credential operations and checks run in order. A removal cannot race an
 * earlier save, and a check cannot use a key read during a concurrent mutation.
 * Failures never poison the queue; the next operation retries real SDK access.
 */
export function createAvailabilityBackend(
  options: AvailabilityBackendOptions,
): AvailabilityBackend {
  const {secrets, service} = options;
  let queue: Promise<void> = Promise.resolve();

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function inspectConfiguration(): Promise<AvailabilityConfigurationResult> {
    try {
      const apiKey = await secrets.get(AVAILABILITY_SECRET_KEY);
      return {
        ok: true,
        configuration: configuration(
          validCredential(apiKey) ? "ready" : "credential_required",
        ),
      };
    } catch (error: unknown) {
      return storageFailure(error);
    }
  }

  return {
    getConfiguration(): Promise<AvailabilityConfigurationResult> {
      return exclusive(inspectConfiguration);
    },

    saveConnection(content: unknown): Promise<AvailabilityConfigurationResult> {
      return exclusive(async () => {
        let apiKey: string | null;
        try {
          apiKey = readCredentialInput(content);
        } catch {
          apiKey = null;
        }

        if (apiKey === null) {
          const inspected = await inspectConfiguration();
          return failure(
            inspected.configuration,
            "invalid_input",
            "Provide a nonempty Hyperstack API key without whitespace or control characters.",
            false,
          );
        }

        try {
          await secrets.set(AVAILABILITY_SECRET_KEY, apiKey);
        } catch (error: unknown) {
          return storageFailure(error);
        }

        // Reading back verifies the read grant needed by refresh as well as
        // persistence. No credential value is included in the result.
        return inspectConfiguration();
      });
    },

    removeConnection(): Promise<AvailabilityConfigurationResult> {
      return exclusive(async () => {
        try {
          // A missing key is already the requested state.
          await secrets.delete(AVAILABILITY_SECRET_KEY);
          return {
            ok: true,
            configuration: configuration("credential_required"),
          };
        } catch (error: unknown) {
          return storageFailure(error);
        }
      });
    },

    refresh(): Promise<AvailabilityRefreshResult> {
      return exclusive(async () => {
        let apiKey: string | null;
        try {
          apiKey = await secrets.get(AVAILABILITY_SECRET_KEY);
        } catch (error: unknown) {
          return storageFailure(error);
        }

        if (!validCredential(apiKey)) {
          return failure(
            configuration("credential_required"),
            "credential_required",
            "Save your Hyperstack API key to check availability.",
            false,
          );
        }

        const current = configuration("ready");
        try {
          const result = await service.check(apiKey);
          if (!result.ok) {
            return serviceFailure(current, result.error);
          }

          return {
            ok: true,
            configuration: current,
            snapshot: result.snapshot,
          };
        } catch {
          // The service normally returns failures as data. Unexpected thrown
          // errors are also redacted, including errors containing credentials.
          return failure(
            current,
            "network_error",
            "Hyperstack could not be reached. Check connectivity and retry.",
            true,
          );
        }
      });
    },
  };
}