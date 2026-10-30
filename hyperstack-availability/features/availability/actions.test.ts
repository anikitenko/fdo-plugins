import {test} from "node:test";
import assert from "node:assert/strict";
import {createAvailabilityActions} from "./actions";
import {AVAILABILITY_HANDLERS, createAvailabilityBackend} from "./backend";
import type {
  AvailabilityConfiguration,
  AvailabilityConfigurationResult,
  AvailabilityRefreshResult,
} from "./backend";
import type {AvailabilitySnapshot} from "./logic";

class ViewEvent extends Event {
  detail: unknown;

  initCustomEvent(
    type: string,
    _bubbles: boolean,
    _cancelable: boolean,
    detail: unknown,
  ): void {
    assert.equal(type, this.type);
    this.detail = detail;
  }
}

class ViewElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: ViewElement[] = [];
  parentElement: ViewElement | null = null;
  hidden = false;
  value = "";
  selected = false;
  checked = false;
  private ownText = "";

  constructor(
    readonly tagName: string,
    readonly id = "",
  ) {
    super();
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: ViewElement): ViewElement {
    if (child.tagName === "#fragment") {
      for (const entry of [...child.children]) this.appendChild(entry);
      child.children.length = 0;
    } else {
      if (child.parentElement) {
        const siblings = child.parentElement.children;
        const index = siblings.indexOf(child);
        if (index >= 0) siblings.splice(index, 1);
      }
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }

  replaceChildren(...children: ViewElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.ownText = "";
    for (const child of children) this.appendChild(child);
  }

  querySelectorAll(selector: string): ViewElement[] {
    const matches: ViewElement[] = [];
    for (const child of this.children) {
      if (
        (selector === "tr" && child.tagName.toLowerCase() === "tr")
        || (
          selector === "[data-stock-status]"
          && child.hasAttribute("data-stock-status")
        )
      ) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  querySelector(selector: string): ViewElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): ViewElement | null {
    if (this.tagName.toLowerCase() === selector) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  click(): void {
    if (!this.hasAttribute("disabled")) this.dispatchEvent(new Event("click"));
  }
}

class ViewDocument {
  hidden = false;
  readonly nodes = new Map<string, ViewElement>();

  constructor() {
    const tags: Record<string, string> = {
      availability: "div",
      connection: "section",
      "connection-status": "p",
      "connection-help": "p",
      "api-key": "input",
      "save-connection": "button",
      "clear-connection": "button",
      refresh: "button",
      region: "select",
      gpu: "select",
      "stock-status": "select",
      query: "input",
      polling: "select",
      loading: "p",
      error: "p",
      stale: "p",
      "last-check": "p",
      summary: "p",
      results: "section",
      "results-body": "tbody",
      empty: "p",
      "deploy-type": "select",
      "deploy-name": "input",
      "deploy-environment": "input",
      "deploy-image": "input",
      "deploy-keypair": "input",
      "deploy-public-ip": "input",
      "deploy-charges": "input",
      "deploy-arm": "button",
      "deploy-cancel": "button",
      "deploy-status": "p",
    };
    for (const [name, tag] of Object.entries(tags)) {
      const id = `hyperstack-${name}`;
      this.nodes.set(id, new ViewElement(tag, id));
    }
    this.get("stock-status").value = "all";
    this.get("polling").value = "0";
    for (const name of ["loading", "error", "stale"]) {
      this.get(name).hidden = true;
    }
    const tableWrap = new ViewElement("div");
    const table = new ViewElement("table");
    tableWrap.appendChild(table);
    table.appendChild(this.get("results-body"));
    this.get("results").appendChild(tableWrap);
  }

  get(name: string): ViewElement {
    const node = this.getElementById(`hyperstack-${name}`);
    assert.ok(node, `Missing fixture element: ${name}`);
    return node;
  }

  getElementById(id: string): ViewElement | null {
    return this.nodes.get(id) ?? null;
  }

  querySelector(selector: string): ViewElement | null {
    return selector.startsWith("#")
      ? this.getElementById(selector.slice(1))
      : null;
  }

  querySelectorAll(selector: string): ViewElement[] {
    const node = this.querySelector(selector);
    return node ? [node] : [];
  }

  createElement(tag: string): ViewElement {
    return new ViewElement(tag);
  }

  createDocumentFragment(): ViewElement {
    return new ViewElement("#fragment");
  }

  createTextNode(text: string): ViewElement {
    const node = new ViewElement("#text");
    node.textContent = text;
    return node;
  }

  createEvent(type: string): ViewEvent {
    assert.equal(type, "CustomEvent");
    return new ViewEvent("hyperstack-availability-command");
  }
}

interface BridgeCall {
  readonly type: string;
  readonly handler: string;
  readonly content: unknown;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) result[key] = Reflect.get(value, key);
  return result;
}

function callable(value: unknown): (...args: unknown[]) => unknown {
  assert.ok(typeof value === "function");
  return (...args) => Reflect.apply(value, undefined, args);
}

/**
 * Revive serialized callbacks without imported closures. Browser globals are
 * explicit parameters; declarative handlers receive their dispatch context.
 */
function frontendCallback(
  value: unknown,
  document: ViewDocument,
  window: object,
): (...args: unknown[]) => unknown {
  assert.ok(typeof value === "function");
  const source = Function.prototype.toString.call(value);
  const revived: unknown = Function(
    "document",
    "window",
    `"use strict"; return (${source});`,
  )(document, window);
  return callable(revived);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise has not been initialized.");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return {promise, resolve};
}

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

const ready: AvailabilityConfiguration = {
  configured: true,
  credentialStorageAvailable: true,
  providerContractAvailable: true,
  ready: true,
  status: "ready",
  message: "Your saved key is ready. Check availability.",
};

const missing: AvailabilityConfiguration = {
  configured: false,
  credentialStorageAvailable: true,
  providerContractAvailable: true,
  ready: false,
  status: "credential_required",
  message: "Save a Hyperstack API key to check availability.",
};

function snapshot(flavor: string, count: number): AvailabilitySnapshot {
  return {
    checkedAt: "2026-10-30T10:00:00.000Z",
    items: [{
      id: "region-a:gpu-a:flavor-a",
      flavor,
      region: "Region A",
      gpu: "GPU A",
      availableCount: count,
      isAvailable: count > 0,
      status: count > 0 ? "available" : "unavailable",
    }],
  };
}

function success(data: AvailabilitySnapshot): AvailabilityRefreshResult {
  return {ok: true, configuration: ready, snapshot: data};
}

type Reply = AvailabilityConfigurationResult | AvailabilityRefreshResult;
type Responder = (call: BridgeCall) => Promise<Reply>;

function harness(respond: Responder) {
  const document = new ViewDocument();
  const calls: BridgeCall[] = [];
  const timers = new Map<number, {callback: () => void; delay: number}>();
  let nextTimer = 0;

  const window = {
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    async createBackendReq(type: string, payload: unknown) {
      const input = record(payload);
      assert.equal(typeof input.handler, "string");
      const call: BridgeCall = {
        type,
        handler: String(input.handler),
        content: input.content,
      };
      calls.push(call);
      return {success: true, data: await respond(call)};
    },
  };

  // The public factory preserves both SDK output and the declarative definition.
  // Exercise that definition directly rather than assuming an SDK wrapper shape.
  const actions = record(createAvailabilityActions());
  assert.equal(actions.lifecycleKey, "hyperstack.availability.actions.v2");
  assert.equal(actions.strict, true);
  const handlers = record(actions.handlers);
  assert.ok(Array.isArray(actions.bindings));
  const removeBindings: Array<() => void> = [];

  for (const rawBinding of actions.bindings) {
    const binding = record(rawBinding);
    assert.equal(typeof binding.selector, "string");
    assert.equal(typeof binding.event, "string");
    assert.equal(typeof binding.handler, "string");
    const selector = String(binding.selector);
    const eventName = String(binding.event);
    const handler = frontendCallback(
      handlers[String(binding.handler)],
      document,
      window,
    );
    const elements = document.querySelectorAll(selector);
    assert.ok(elements.length > 0, `Binding must target a fixture: ${selector}`);
    for (const element of elements) {
      const listener = (event: Event) => {
        handler({document, window, element, event});
      };
      element.addEventListener(eventName, listener);
      removeBindings.push(() => element.removeEventListener(eventName, listener));
    }
  }

  const cleanup = frontendCallback(actions.setup, document, window)();
  assert.ok(typeof cleanup === "function");

  let disposed = false;
  return {
    document,
    calls,
    timers,
    click(name: string) {
      document.get(name).click();
    },
    change(name: string, value: string) {
      const node = document.get(name);
      node.value = value;
      node.dispatchEvent(new Event("change"));
    },
    fireTimer() {
      assert.equal(timers.size, 1, "Exactly one polling timer should be owned");
      const entry = timers.entries().next().value;
      assert.ok(entry);
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      callable(cleanup)();
      for (const remove of removeBindings) remove();
    },
  };
}

test("connection and refresh clicks use backend operations and prevent duplicate requests", async (t) => {
  const key = "test-only-secret-do-not-render";
  const save = deferred<Reply>();
  const refresh = deferred<Reply>();
  let configured = false;

  const view = harness(async (call) => {
    assert.equal(call.type, "UI_MESSAGE");
    switch (call.handler) {
      case AVAILABILITY_HANDLERS.configuration:
        assert.deepEqual(call.content, {});
        return {ok: true, configuration: configured ? ready : missing};
      case AVAILABILITY_HANDLERS.saveConnection:
        assert.deepEqual(call.content, {apiKey: key});
        return save.promise;
      case AVAILABILITY_HANDLERS.refresh:
        assert.deepEqual(call.content, {});
        return refresh.promise;
      case AVAILABILITY_HANDLERS.removeConnection:
        assert.deepEqual(call.content, {});
        configured = false;
        return {ok: true, configuration: missing};
      default:
        throw new Error("Unexpected backend operation");
    }
  });
  t.after(() => view.dispose());

  await settle();
  assert.deepEqual(view.calls.map((call) => call.handler), [
    AVAILABILITY_HANDLERS.configuration,
  ]);
  assert.equal(view.document.get("refresh").hasAttribute("disabled"), true);
  assert.equal(view.document.get("save-connection").hasAttribute("disabled"), false);

  // Empty input must fail locally without invoking credential storage.
  view.document.get("api-key").value = "   ";
  view.click("save-connection");
  await settle();
  assert.equal(view.calls.length, 1);
  assert.equal(view.document.get("error").hidden, false);
  assert.match(view.document.get("error").textContent, /API key/i);

  view.document.get("api-key").value = key;
  view.click("save-connection");
  view.click("save-connection");
  // Exercise the busy guard independently of disabled-button behavior.
  view.document.get("save-connection").dispatchEvent(new Event("click"));
  await settle();

  assert.equal(
    view.calls.filter((call) => call.handler === AVAILABILITY_HANDLERS.saveConnection).length,
    1,
  );
  assert.equal(view.document.get("api-key").value, "");
  assert.equal(view.document.get("save-connection").hasAttribute("disabled"), true);
  assert.equal(view.document.get("connection").getAttribute("aria-busy"), "true");

  configured = true;
  save.resolve({ok: true, configuration: ready});
  await settle();
  assert.equal(view.document.get("api-key").value, "");
  assert.equal(view.document.get("refresh").hasAttribute("disabled"), false);
  assert.match(view.document.get("connection-status").textContent, /saved/i);
  assert.equal(view.document.get("connection-help").textContent, ready.message);
  assert.equal(view.document.get("error").hidden, true);

  view.click("refresh");
  view.document.get("refresh").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(
    view.calls.filter((call) => call.handler === AVAILABILITY_HANDLERS.refresh).length,
    1,
  );
  assert.equal(view.document.get("loading").hidden, false);
  assert.equal(view.document.get("refresh").hasAttribute("disabled"), true);
  assert.equal(view.document.get("results").getAttribute("aria-busy"), "true");

  const flavor = "GPU <large> & fast";
  refresh.resolve(success(snapshot(flavor, 3)));
  await settle();

  const rows = view.document.get("results-body").querySelectorAll("tr");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].textContent, flavor);
  assert.equal(rows[0].children[0].children.length, 0);
  assert.equal(rows[0].getAttribute("data-availability-status"), "available");
  assert.equal(rows[0].children[3].textContent, "Available");
  assert.equal(rows[0].children[4].textContent, "3");
  assert.equal(
    view.document.get("summary").textContent,
    "1 matching options · 1 available · 0 out of stock · 0 unknown",
  );
  assert.equal(view.document.get("loading").hidden, true);
  assert.equal(view.document.get("refresh").hasAttribute("disabled"), false);
  assert.equal(view.document.get("results").getAttribute("aria-busy"), "false");

  view.click("clear-connection");
  await settle();
  assert.equal(view.calls.at(-1)?.handler, AVAILABILITY_HANDLERS.removeConnection);
  assert.equal(view.document.get("refresh").hasAttribute("disabled"), true);
  assert.equal(view.document.get("clear-connection").hasAttribute("disabled"), true);
  assert.equal(view.document.get("save-connection").hasAttribute("disabled"), false);
  assert.equal(view.document.get("stale").hidden, false);
  assert.equal(view.document.get("results-body").textContent.includes(flavor), true);

  for (const call of view.calls) {
    if (call.handler !== AVAILABILITY_HANDLERS.saveConnection) {
      assert.equal(JSON.stringify(call).includes(key), false);
    }
  }
  for (const node of view.document.nodes.values()) {
    assert.equal(node.textContent.includes(key), false);
    for (const value of node.attributes.values()) {
      assert.equal(value.includes(key), false);
    }
  }
});

test("refresh failures recover safely and lifecycle cleanup stops updates", async (t) => {
  const leakedDetail = "private-token-and-provider-body";
  const late = deferred<Reply>();
  let checks = 0;

  const view = harness(async (call) => {
    assert.equal(call.type, "UI_MESSAGE");
    assert.deepEqual(call.content, {});
    if (call.handler === AVAILABILITY_HANDLERS.configuration) {
      return {ok: true, configuration: ready};
    }
    assert.equal(call.handler, AVAILABILITY_HANDLERS.refresh);
    checks += 1;
    if (checks === 1) return success(snapshot("Original VM", 2));
    if (checks === 2) {
      return {
        ok: false,
        configuration: ready,
        error: {
          code: "network_error",
          message: leakedDetail,
          retryable: true,
        },
      };
    }
    if (checks === 3) return success(snapshot("Recovered VM", 0));
    return late.promise;
  });
  t.after(() => view.dispose());
  await settle();

  view.click("refresh");
  await settle();
  assert.match(view.document.get("results-body").textContent, /Original VM/);
  assert.equal(view.document.get("stale").hidden, true);

  view.click("refresh");
  await settle();
  assert.match(view.document.get("results-body").textContent, /Original VM/);
  assert.equal(view.document.get("stale").hidden, false);
  assert.equal(view.document.get("results").getAttribute("data-stale"), "true");
  assert.equal(view.document.get("error").hidden, false);
  assert.match(view.document.get("error").textContent, /reached|access|retry/i);
  assert.equal(view.document.get("error").textContent.includes(leakedDetail), false);
  assert.equal(view.document.get("refresh").hasAttribute("disabled"), false);
  assert.equal(view.document.get("loading").hidden, true);

  view.click("refresh");
  await settle();
  assert.match(view.document.get("results-body").textContent, /Recovered VM/);
  assert.doesNotMatch(view.document.get("results-body").textContent, /Original VM/);
  assert.equal(
    view.document.get("results-body").querySelector("tr")
      ?.getAttribute("data-availability-status"),
    "unavailable",
  );
  assert.equal(view.document.get("stale").hidden, true);
  assert.equal(view.document.get("results").getAttribute("data-stale"), "false");
  assert.equal(view.document.get("error").hidden, true);

  view.change("polling", "60");
  assert.equal(view.timers.size, 1);
  assert.equal([...view.timers.values()][0].delay, 60_000);

  view.change("polling", "300");
  assert.equal(view.timers.size, 1);
  assert.equal([...view.timers.values()][0].delay, 300_000);

  view.document.hidden = true;
  view.fireTimer();
  await settle();
  assert.equal(checks, 3);
  assert.equal(view.timers.size, 1);

  view.document.hidden = false;
  view.fireTimer();
  await settle();
  assert.equal(checks, 4);
  assert.equal(view.document.get("loading").hidden, false);
  assert.equal(view.timers.size, 0);

  const retainedBody = view.document.get("results-body").textContent;
  view.document.get("api-key").value = "unsaved-key";
  view.dispose();
  assert.equal(view.timers.size, 0);
  assert.equal(view.document.get("api-key").value, "");

  late.resolve(success(snapshot("Late VM must not appear", 9)));
  await settle();
  assert.equal(view.document.get("results-body").textContent, retainedBody);
  assert.doesNotMatch(view.document.get("results-body").textContent, /Late VM/);
  assert.equal(view.timers.size, 0);

  const callCount = view.calls.length;
  view.click("refresh");
  view.change("polling", "60");
  await settle();
  assert.equal(view.calls.length, callCount);
  assert.equal(view.timers.size, 0);
});

test("disposing an idle lifecycle cancels its scheduled polling callback", async (t) => {
  const view = harness(async (call) => {
    assert.equal(call.handler, AVAILABILITY_HANDLERS.configuration);
    return {ok: true, configuration: ready};
  });
  t.after(() => view.dispose());
  await settle();

  view.change("polling", "60");
  assert.equal(view.timers.size, 1);
  const queuedCallback = [...view.timers.values()][0].callback;
  const callCount = view.calls.length;

  view.dispose();
  assert.equal(view.timers.size, 0);

  // Even a callback already queued by the browser must honor disposal.
  queuedCallback();
  await settle();
  assert.equal(view.calls.length, callCount);
  assert.equal(view.timers.size, 0);
});

test("deployment clicks arm one VM, poll fresh stock and stop after creation", async (t) => {
  let current = snapshot("GPU VM", 0);
  let creations = 0;
  const backend = createAvailabilityBackend({
    secrets: {get: async () => "backend-only-key", set: async () => {}, delete: async () => true},
    service: {check: async () => ({ok: true, snapshot: current})},
    deploymentService: {create: async (_key, plan, item) => {
      creations++;
      assert.equal(plan.name, "new-vm");
      assert.equal(item.flavor, "GPU VM");
      return {status: "submitted", message: "VM #42 was scheduled for creation.", vmId: 42};
    }},
  });
  const view = harness(async call => {
    switch (call.handler) {
      case AVAILABILITY_HANDLERS.configuration: return backend.getConfiguration();
      case AVAILABILITY_HANDLERS.refresh: return backend.refresh(call.content);
      case AVAILABILITY_HANDLERS.armDeployment: return backend.armDeployment(call.content);
      case AVAILABILITY_HANDLERS.cancelDeployment: return backend.cancelDeployment();
      default: throw new Error("Unexpected operation");
    }
  });
  t.after(() => view.dispose());
  await settle();
  view.click("refresh");
  await settle();
  view.click("deploy-arm");
  await settle();
  assert.equal(view.calls.filter(call => call.handler === AVAILABILITY_HANDLERS.armDeployment).length, 0);
  assert.match(view.document.get("deploy-status").textContent, /complete all deployment fields/);
  view.document.get("deploy-type").value = current.items[0].id;
  for (const [name, value] of Object.entries({name: "new-vm", environment: "env", image: "Ubuntu", keypair: "key"})) view.document.get(`deploy-${name}`).value = value;
  view.document.get("deploy-charges").checked = true;
  view.click("deploy-arm");
  view.document.get("deploy-arm").dispatchEvent(new Event("click"));
  await settle();
  await settle();
  assert.equal(view.calls.filter(call => call.handler === AVAILABILITY_HANDLERS.armDeployment).length, 1);
  assert.equal(creations, 0);
  assert.equal(view.document.get("deploy-name").hasAttribute("disabled"), true);
  assert.equal(view.timers.size, 1);
  assert.equal([...view.timers.values()][0].delay, 60_000);
  assert.match(view.document.get("deploy-status").textContent, /Armed for one/);
  current = snapshot("GPU VM", 1);
  view.document.hidden = true; // Explicitly armed automation also checks in a hidden view.
  view.fireTimer();
  await settle();
  await settle();
  assert.equal(creations, 1);
  assert.match(view.document.get("deploy-status").textContent, /#42/);
  assert.equal(view.timers.size, 0);
  assert.equal(view.document.get("deploy-charges").checked, false);
  view.click("refresh");
  await settle();
  assert.equal(creations, 1);
  assert.doesNotMatch(JSON.stringify(view.calls), /backend-only-key/);
});

test("disposing an armed view cancels waiting and never resumes creation", async (t) => {
  const view = harness(async call => {
    if (call.handler === AVAILABILITY_HANDLERS.configuration) return {ok: true, configuration: ready};
    if (call.handler === AVAILABILITY_HANDLERS.armDeployment) return {ok: true, configuration: ready, deployment: {status: "waiting", launchId: "one", message: "Waiting"}};
    if (call.handler === AVAILABILITY_HANDLERS.cancelDeployment) return {ok: true, configuration: ready};
    return success(snapshot("VM", 0));
  });
  t.after(() => view.dispose());
  await settle();
  view.click("refresh");
  await settle();
  view.document.get("deploy-type").value = "region-a:gpu-a:flavor-a";
  for (const name of ["name", "environment", "image", "keypair"]) view.document.get(`deploy-${name}`).value = "configured";
  view.document.get("deploy-charges").checked = true;
  view.click("deploy-arm");
  await settle();
  assert.equal(view.timers.size, 1);
  const queued = [...view.timers.values()][0].callback;
  view.dispose();
  await settle();
  assert.equal(view.calls.at(-1)?.handler, AVAILABILITY_HANDLERS.cancelDeployment);
  assert.equal(view.timers.size, 0);
  const calls = view.calls.length;
  queued();
  await settle();
  assert.equal(view.calls.length, calls);
});
