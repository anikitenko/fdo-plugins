import {test} from "node:test";
import assert from "node:assert/strict";
import {
  AVAILABILITY_SECRET_KEY,
  createAvailabilityBackend,
} from "./backend";
import type {AvailabilitySecretStore} from "./backend";
import {createAvailabilityService} from "./service";
import type {
  AvailabilityFetch,
  AvailabilityHttpResponse,
  AvailabilityServiceResult,
  HyperstackProviderContract,
} from "./service";

const API_KEY = "test-only-hyperstack-secret-9b73";
const PROVIDER_DETAIL = "private-provider-response-2d81";
const CHECKED_AT = "2026-10-30T12:00:00.000Z";

/**
 * This injected contract is a test fixture, not a claim about Hyperstack's
 * production endpoint or response schema. Production contract selection belongs
 * to the backend composition entry.
 */
const provider: HyperstackProviderContract = {
  endpoint: "https://hyperstack.example.test/availability",
  authenticationHeader: "X-Test-API-Key",
  formatCredential: (apiKey) => apiKey,
  normalizeResponse: (response) => response,
};

function availabilityFixture() {
  return {
    items: [
      {
        id: "region-a/gpu-ready",
        region: "region-a",
        gpu: "GPU A",
        flavor: "gpu-ready",
        availableCount: 3,
        isAvailable: true,
        status: "available",
      },
      {
        id: "region-a/gpu-empty",
        region: "region-a",
        gpu: "GPU B",
        flavor: "gpu-empty",
        availableCount: 0,
        isAvailable: false,
        status: "unavailable",
      },
      {
        id: "region-b/gpu-unknown",
        region: "region-b",
        gpu: "GPU C",
        flavor: "gpu-unknown",
        availableCount: null,
        isAvailable: null,
        status: "unknown",
      },
    ],
  };
}

function response(
  body: unknown = availabilityFixture(),
  status = 200,
): AvailabilityHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function codedError(code: string): Error & {code: string} {
  return Object.assign(
    new Error(`${API_KEY}: ${PROVIDER_DETAIL}`),
    {code},
  );
}

class MemorySecrets implements AvailabilitySecretStore {
  readonly values = new Map<string, string>();
  readonly calls: Array<{operation: "get" | "set" | "delete"; key: string}> = [];
  failure: Error | null = null;

  private record(operation: "get" | "set" | "delete", key: string): void {
    this.calls.push({operation, key});
    if (this.failure) {
      throw this.failure;
    }
  }

  async get(key: string): Promise<string | null> {
    this.record("get", key);
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.record("set", key);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    this.record("delete", key);
    return this.values.delete(key);
  }
}

function assertRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, "string");
  assert.ok(!serialized.includes(API_KEY), "Results must not contain the API key");
  assert.ok(
    !serialized.includes(PROVIDER_DETAIL),
    "Results must not contain raw provider or storage failure details",
  );
}

function assertServiceFailure(
  result: AvailabilityServiceResult,
  code: string,
): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail(`Expected ${code}, received a successful snapshot`);
  }
  assert.equal(result.error.code, code);
  assert.ok(result.error.message.trim().length > 0);
  assert.equal(typeof result.error.retryable, "boolean");
  assertRedacted(result);
}

function successfulService(fetch: AvailabilityFetch = async () => response()) {
  return createAvailabilityService({
    provider,
    fetch,
    now: () => new Date(CHECKED_AT),
  });
}

test("SDK secret storage supports credential setup and removal without exposing keys", async () => {
  const secrets = new MemorySecrets();
  let requests = 0;
  const backend = createAvailabilityBackend({
    secrets,
    service: successfulService(async (_url, options) => {
      requests += 1;
      assert.equal(options.headers[provider.authenticationHeader], API_KEY);
      return response();
    }),
  });

  const initial = await backend.getConfiguration();
  assert.equal(initial.ok, true);
  assert.equal(initial.configuration.status, "credential_required");
  assert.equal(initial.configuration.configured, false);
  assert.equal(initial.configuration.ready, false);
  assert.equal(initial.configuration.credentialStorageAvailable, true);
  assertRedacted(initial);

  const missing = await backend.refresh();
  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("A missing credential must prevent retrieval");
  }
  assert.equal(missing.error.code, "credential_required");
  assert.equal(requests, 0);
  assertRedacted(missing);

  const saved = await backend.saveConnection({apiKey: API_KEY});
  assert.equal(saved.ok, true);
  assert.equal(secrets.values.get(AVAILABILITY_SECRET_KEY), API_KEY);
  assert.equal(saved.configuration.status, "ready");
  assert.equal(saved.configuration.configured, true);
  assert.equal(saved.configuration.ready, true);
  assert.equal(saved.configuration.providerContractAvailable, true);
  assertRedacted(saved);

  const reread = await backend.getConfiguration();
  assert.equal(reread.ok, true);
  assert.equal(reread.configuration.status, "ready");
  assert.equal(reread.configuration.configured, true);
  assert.equal(reread.configuration.ready, true);
  assertRedacted(reread);

  const checked = await backend.refresh();
  assert.equal(checked.ok, true);
  assert.equal(requests, 1);
  assertRedacted(checked);

  const removed = await backend.removeConnection();
  assert.equal(removed.ok, true);
  assert.equal(secrets.values.has(AVAILABILITY_SECRET_KEY), false);
  assert.equal(removed.configuration.status, "credential_required");
  assert.equal(removed.configuration.configured, false);
  assert.equal(removed.configuration.ready, false);
  assertRedacted(removed);

  const afterRemoval = await backend.getConfiguration();
  assert.equal(afterRemoval.configuration.status, "credential_required");
  const blocked = await backend.refresh();
  assert.equal(blocked.ok, false);
  assert.equal(requests, 1);
  assertRedacted(blocked);

  assert.ok(secrets.calls.some((call) => call.operation === "set"));
  assert.ok(secrets.calls.some((call) => call.operation === "delete"));
  assert.ok(secrets.calls.some((call) => call.operation === "get"));
  assert.ok(secrets.calls.every((call) => call.key === AVAILABILITY_SECRET_KEY));
});

test("SDK network retrieval returns validated availability and redacted failures", async () => {
  const secrets = new MemorySecrets();
  secrets.values.set(AVAILABILITY_SECRET_KEY, API_KEY);
  let requests = 0;
  const backend = createAvailabilityBackend({
    secrets,
    service: successfulService(async (url, options) => {
      requests += 1;
      assert.equal(url, provider.endpoint);
      assert.equal(options.method, "GET");
      assert.equal(options.headers[provider.authenticationHeader], API_KEY);
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return response();
    }),
  });

  const result = await backend.refresh();
  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("Expected a successful availability snapshot");
  }
  assert.equal(requests, 1);
  assert.equal(result.snapshot.checkedAt, CHECKED_AT);
  assert.deepEqual(result.snapshot.items, availabilityFixture().items);
  assert.equal(result.configuration.ready, true);
  assertRedacted(result);

  const cases = [
    {status: 401, code: "authentication_failed"},
    {status: 429, code: "rate_limited"},
    {status: 503, code: "provider_error"},
  ] as const;

  for (const entry of cases) {
    const failingBackend = createAvailabilityBackend({
      secrets,
      service: successfulService(async () =>
        response({message: `${API_KEY} ${PROVIDER_DETAIL}`}, entry.status),
      ),
    });
    const failure = await failingBackend.refresh();
    assert.equal(failure.ok, false);
    if (failure.ok) {
      assert.fail(`HTTP ${entry.status} must not produce a snapshot`);
    }
    assert.equal(failure.error.code, entry.code);
    assert.ok(failure.error.message.length > 0);
    assertRedacted(failure);
  }

  const networkFailure = await successfulService(async () => {
    throw new Error(`${API_KEY} ${PROVIDER_DETAIL}`);
  }).check(API_KEY);
  assertServiceFailure(networkFailure, "network_error");

  let requestSignal: AbortSignal | undefined;
  const timedService = createAvailabilityService({
    provider,
    timeoutMs: 15,
    fetch: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise<AvailabilityHttpResponse>((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error(`${API_KEY} ${PROVIDER_DETAIL}`)),
          {once: true},
        );
      });
    },
  });
  const timed = await timedService.check(API_KEY);
  assertServiceFailure(timed, "timeout");
  assert.equal(requestSignal?.aborted, true);
});

test("credential and access failures permit recovery to ready availability checks", async () => {
  const secrets = new MemorySecrets();
  let requests = 0;
  const backend = createAvailabilityBackend({
    secrets,
    service: successfulService(async () => {
      requests += 1;
      return response();
    }),
  });

  const absent = await backend.getConfiguration();
  assert.equal(absent.configuration.status, "credential_required");
  assert.equal(absent.configuration.ready, false);
  assert.equal(absent.configuration.credentialStorageAvailable, true);

  const failureCases = [
    {code: "permission_denied", status: "permission_denied"},
    {code: "storage_locked", status: "storage_locked"},
    {code: "storage_unavailable", status: "storage_unavailable"},
  ] as const;

  for (const entry of failureCases) {
    secrets.failure = codedError(entry.code);

    const configuration = await backend.getConfiguration();
    assert.equal(configuration.ok, false);
    assert.equal(configuration.configuration.status, entry.status);
    assert.equal(configuration.configuration.ready, false);
    assert.ok(configuration.configuration.message.trim().length > 0);
    assertRedacted(configuration);

    const saved = await backend.saveConnection({apiKey: API_KEY});
    assert.equal(saved.ok, false);
    if (saved.ok) {
      assert.fail("Denied or unavailable storage must not report a saved key");
    }
    assert.equal(saved.error.code, entry.code);
    assertRedacted(saved);

    const refreshed = await backend.refresh();
    assert.equal(refreshed.ok, false);
    if (refreshed.ok) {
      assert.fail("Storage failure must prevent checking availability");
    }
    assert.equal(refreshed.error.code, entry.code);
    assert.equal(requests, 0);
    assertRedacted(refreshed);

    const removed = await backend.removeConnection();
    assert.equal(removed.ok, false);
    assertRedacted(removed);
  }

  secrets.failure = null;
  const recoveredSave = await backend.saveConnection({apiKey: API_KEY});
  assert.equal(recoveredSave.ok, true);
  const recoveredConfiguration = await backend.getConfiguration();
  assert.equal(recoveredConfiguration.configuration.status, "ready");
  assert.equal(recoveredConfiguration.configuration.ready, true);
  const recoveredRefresh = await backend.refresh();
  assert.equal(recoveredRefresh.ok, true);
  assert.equal(requests, 1);
  assertRedacted(recoveredSave);
  assertRedacted(recoveredConfiguration);
  assertRedacted(recoveredRefresh);

  let denyNetwork = true;
  const networkBackend = createAvailabilityBackend({
    secrets,
    service: successfulService(async () => {
      if (denyNetwork) {
        throw codedError("permission_denied");
      }
      return response();
    }),
  });
  const denied = await networkBackend.refresh();
  assert.equal(denied.ok, false);
  if (denied.ok) {
    assert.fail("A denied network grant must be reported as a failure");
  }
  assert.equal(denied.error.code, "permission_denied");
  assertRedacted(denied);

  denyNetwork = false;
  const recoveredNetwork = await networkBackend.refresh();
  assert.equal(recoveredNetwork.ok, true);
  assert.equal(recoveredNetwork.configuration.ready, true);
  assertRedacted(recoveredNetwork);
});

test("invalid credential inputs do not mutate secure storage", async () => {
  const secrets = new MemorySecrets();
  const backend = createAvailabilityBackend({
    secrets,
    service: successfulService(),
  });

  for (const input of [
    undefined,
    null,
    "",
    {},
    {apiKey: 42},
    {apiKey: ""},
    {apiKey: " \n\t "},
    {content: {apiKey: API_KEY}},
  ]) {
    const result = await backend.saveConnection(input);
    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail("Invalid bridge content must produce application result data");
    }
    assert.equal(result.error.code, "invalid_input");
    assertRedacted(result);
  }
  assert.equal(secrets.values.size, 0);
  assert.equal(
    secrets.calls.filter((call) => call.operation === "set").length,
    0,
  );
});

test("service rejects malformed provider responses and JSON failures without leaking values", async () => {
  const malformed = [
    null,
    {items: "not-an-array"},
    {
      items: [{
        ...availabilityFixture().items[0],
        availableCount: -1,
        flavor: PROVIDER_DETAIL,
      }],
    },
  ];

  for (const body of malformed) {
    const result = await successfulService(async () => response(body)).check(API_KEY);
    assertServiceFailure(result, "invalid_response");
  }

  const invalidJson = await successfulService(async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError(`${API_KEY} ${PROVIDER_DETAIL}`);
    },
  })).check(API_KEY);
  assertServiceFailure(invalidJson, "invalid_response");
});

test("service deadline includes response body reading", async () => {
  let bodyStarted = false;
  let requestSignal: AbortSignal | undefined;
  let finishBody: ((value: unknown) => void) | undefined;

  const service = createAvailabilityService({
    provider,
    timeoutMs: 15,
    fetch: async (_url, options) => {
      requestSignal = options.signal;
      return {
        ok: true,
        status: 200,
        json() {
          bodyStarted = true;
          return new Promise<unknown>((resolve) => {
            finishBody = resolve;
          });
        },
      };
    },
  });

  try {
    const result = await service.check(API_KEY);
    assert.equal(bodyStarted, true);
    assertServiceFailure(result, "timeout");
    assert.equal(requestSignal?.aborted, true);
  } finally {
    finishBody?.(availabilityFixture());
  }
});

test("service cancellation aborts an in-flight request and returns safe result data", async () => {
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let requestSignal: AbortSignal | undefined;

  const service = createAvailabilityService({
    provider,
    fetch: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise<AvailabilityHttpResponse>((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error(`${API_KEY} ${PROVIDER_DETAIL}`)),
          {once: true},
        );
        markStarted?.();
      });
    },
  });

  const pending = service.check(API_KEY, {signal: controller.signal});
  await started;
  controller.abort();
  const result = await pending;
  assertServiceFailure(result, "cancelled");
  assert.equal(requestSignal?.aborted, true);
});

test("service rejects missing credentials before making a network request", async () => {
  let requests = 0;
  const service = successfulService(async () => {
    requests += 1;
    return response();
  });

  for (const key of ["", " \n\t "]) {
    assertServiceFailure(await service.check(key), "credential_required");
  }
  assert.equal(requests, 0);
});