import {test} from "node:test";
import assert from "node:assert/strict";
import {createAvailabilityActions} from "./actions";
import {AVAILABILITY_HANDLERS} from "./backend";
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
      "manage-connection": "button",
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
      "deploy-reload": "button",
      "deploy-options-status": "p",
      "deploy-ssh": "input",
      "deploy-ssh-source": "input",
      "deploy-user-data": "textarea",
      "deploy-type": "select",
      "deploy-name": "input",
      "deploy-environment": "select",
      "deploy-image": "select",
      "deploy-keypair": "select",
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

type Reply = AvailabilityConfigurationResult | AvailabilityRefreshResult | import("./catalog").CatalogResult | import("./runtime").BackendViewState;
type Responder = (call: BridgeCall) => Promise<Reply>;

function harness(respond: Responder, optionsReply?: import("./catalog").CatalogResult) {
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
      if (call.handler === AVAILABILITY_HANDLERS.deploymentOptions) {
        return {success: true, data: optionsReply ?? {ok: true, catalog: {
          environments: [{name: "env", region: "Region A"}],
          images: [{name: "Ubuntu", region: "Region A"}],
          keypairs: [{name: "key", environment: "env"}],
        }}};
      }
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

const cached = (data: AvailabilitySnapshot | null = snapshot("Cached VM", 2), seconds = 300): import("./runtime").BackendViewState => ({ok: true, configuration: ready, snapshot: data, error: null, refreshing: false, pollingSeconds: seconds});

test("page loads use cached backend state, restore automatic refresh, and never force a stock request", async t => {
  const view = harness(async call => {
    assert.equal(call.handler, AVAILABILITY_HANDLERS.state);
    assert.deepEqual(call.content, {});
    return cached();
  });
  t.after(() => view.dispose());
  await settle();
  assert.match(view.document.get("results-body").textContent, /Cached VM/);
  assert.equal(view.document.get("polling").value, "300");
  assert.equal(view.document.get("connection").hidden, true);
  assert.equal(view.document.get("manage-connection").hidden, false);
  assert.equal(view.document.get("loading").hidden, true);
  view.click("manage-connection");
  assert.equal(view.document.get("connection").hidden, false);
  assert.equal(view.document.get("manage-connection").getAttribute("aria-expanded"), "true");
  view.click("manage-connection");
  assert.equal(view.document.get("connection").hidden, true);
  const row = view.document.get("results-body").children[0];
  view.fireTimer();
  await settle();
  assert.equal(view.document.get("results-body").children[0], row, "Unchanged cached data must not rebuild rows");
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.refresh).length, 0);
});

test("save/remove connection and explicit refresh remain available with duplicate-click protection", async t => {
  const save = deferred<Reply>();
  const refresh = deferred<Reply>();
  const key = "test-only-secret";
  const view = harness(async call => {
    switch (call.handler) {
      case AVAILABILITY_HANDLERS.state: return { ...cached(null), configuration: missing };
      case AVAILABILITY_HANDLERS.saveConnection: assert.deepEqual(call.content, {apiKey: key}); return save.promise;
      case AVAILABILITY_HANDLERS.refresh: assert.deepEqual(call.content, {}); return refresh.promise;
      case AVAILABILITY_HANDLERS.removeConnection: return {ok: true, configuration: missing};
      default: throw new Error("Unexpected operation");
    }
  });
  t.after(() => view.dispose());
  await settle();
  assert.equal(view.document.get("connection").hidden, false);
  view.document.get("api-key").value = " ";
  view.click("save-connection");
  await settle();
  assert.equal(view.calls.length, 1);
  view.document.get("api-key").value = key;
  view.click("save-connection");
  view.document.get("save-connection").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.saveConnection).length, 1);
  assert.equal(view.document.get("api-key").value, "");
  save.resolve({ok: true, configuration: ready});
  await settle();
  assert.equal(view.document.get("connection").hidden, true);
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.refresh).length, 0);
  view.click("refresh");
  view.document.get("refresh").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.refresh).length, 1);
  refresh.resolve(success(snapshot("VM <large> & fast", 3)));
  await settle();
  const cells = view.document.get("results-body").querySelector("tr")!.children;
  assert.equal(cells[0].textContent, "VM <large> & fast");
  assert.equal(cells[0].children.length, 0);
  assert.equal(cells[3].textContent, "Available");
  view.click("manage-connection");
  view.click("clear-connection");
  await settle();
  assert.equal(view.document.get("connection").hidden, false);
  assert.equal(view.document.get("manage-connection").hidden, true);
  assert.equal(view.document.get("refresh").hasAttribute("disabled"), true);
  for (const node of view.document.nodes.values()) assert.equal(node.textContent.includes(key), false);
});

test("automatic refresh changes are saved by the backend and other clients' settings update the dropdown", async t => {
  let seconds = 300;
  const view = harness(async call => {
    if (call.handler === AVAILABILITY_HANDLERS.setPolling) seconds = Number(record(call.content).seconds);
    else assert.equal(call.handler, AVAILABILITY_HANDLERS.state);
    return cached(snapshot("VM", 0), seconds);
  });
  t.after(() => view.dispose());
  await settle();
  view.change("polling", "600");
  await settle();
  assert.equal(seconds, 600);
  assert.equal(view.document.get("polling").value, "600");
  seconds = 0;
  view.fireTimer();
  await settle();
  assert.equal(view.document.get("polling").value, "0");
  assert.equal([...view.timers.values()][0].delay, 5000, "UI reads cache independently of the provider interval");
});

test("background refresh preserves results and fields; stale errors are redacted and recover", async t => {
  let state = cached();
  const view = harness(async () => state);
  t.after(() => view.dispose());
  await settle();
  const row = view.document.get("results-body").children[0];
  view.document.get("deploy-name").value = "unfinished-name";
  state = {...state, refreshing: true};
  view.fireTimer();
  await settle();
  assert.equal(view.document.get("results-body").children[0], row);
  assert.equal(view.document.get("deploy-name").value, "unfinished-name");
  assert.equal(view.document.get("deploy-name").hasAttribute("disabled"), false);
  state = {...state, refreshing: false, error: {code: "network_error", message: "private-token", retryable: true}};
  view.fireTimer();
  await settle();
  assert.equal(view.document.get("stale").hidden, false);
  assert.doesNotMatch(view.document.get("error").textContent, /private-token/);
  state = {...cached(snapshot("Recovered", 0)), error: null};
  view.fireTimer();
  await settle();
  assert.equal(view.document.get("stale").hidden, true);
  assert.equal(view.document.get("error").hidden, true);
  assert.match(view.document.get("results-body").textContent, /Recovered/);
});

test("restored monitoring displays saved fields and server submission without sending launch IDs or refreshes", async t => {
  const monitoring = {version: 1 as const, plan: {itemId: "region-a:gpu-a:flavor-a", name: "saved-vm", environment: "env", image: "Ubuntu", keypair: "key", publicIp: true, sshSource: "203.0.113.4/32", userData: "#cloud-config"}, state: {status: "waiting" as const, launchId: "saved-launch", message: "Monitoring restored"}};
  let state: import("./runtime").BackendViewState = {...cached(snapshot("VM", 0)), monitoring};
  const view = harness(async call => {assert.equal(call.handler, AVAILABILITY_HANDLERS.state); assert.deepEqual(call.content, {}); return state;});
  t.after(() => view.dispose());
  await settle();
  assert.equal(view.document.get("deploy-name").value, "saved-vm");
  assert.equal(view.document.get("deploy-type").value, monitoring.plan.itemId);
  assert.equal(view.document.get("deploy-keypair").value, "key");
  assert.equal(view.document.get("deploy-public-ip").checked, true);
  assert.equal(view.document.get("deploy-user-data").value, "#cloud-config");
  assert.equal(view.document.get("deploy-name").hasAttribute("disabled"), true);
  state = {...state, monitoring: {...monitoring, state: {status: "submitted", vmId: 42, message: "VM #42 scheduled"}}};
  view.fireTimer();
  await settle();
  assert.match(view.document.get("deploy-status").textContent, /#42/);
  assert.equal(view.document.get("deploy-charges").checked, false);
  const queued = [...view.timers.values()][0].callback;
  view.dispose();
  const count = view.calls.length;
  queued();
  await settle();
  assert.equal(view.calls.length, count);
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.cancelDeployment).length, 0);
});

test("regional selectors still clear incompatible images and keys; catalog failures block arming", async t => {
  const stock = snapshot("VM", 0);
  const other = {...stock.items[0], id: "other", region: "Region B"};
  const view = harness(async () => cached({...stock, items: [...stock.items, other]}), {ok: true, catalog: {
    environments: [{name: "env-a", region: "Region A"}, {name: "env-b", region: "Region B"}],
    images: [{name: "Ubuntu A", region: "Region A"}, {name: "Ubuntu B", region: "Region B"}],
    keypairs: [{name: "key-a", environment: "env-a"}, {name: "key-b", environment: "env-b"}],
  }});
  t.after(() => view.dispose());
  await settle();
  view.change("deploy-type", stock.items[0].id);
  assert.equal(view.document.get("deploy-keypair").value, "key-a");
  view.change("deploy-type", "other");
  assert.equal(view.document.get("deploy-environment").value, "env-b");
  assert.equal(view.document.get("deploy-keypair").value, "key-b");
  assert.doesNotMatch(view.document.get("deploy-image").textContent, /Ubuntu A/);
  const failed = harness(async () => cached(), {ok: false, message: "private-provider-error"});
  t.after(() => failed.dispose());
  await settle();
  assert.match(failed.document.get("results-body").textContent, /Cached VM/);
  assert.equal(failed.document.get("deploy-arm").hasAttribute("disabled"), true);
  assert.doesNotMatch(failed.document.get("deploy-options-status").textContent, /private-provider/);
});


test("arming sends a plan once and subsequent UI ticks only read cached server state", async t => {
  let deployment: import("./deployment").DeploymentState = {status: "idle", message: "No plan"};
  const view = harness(async call => {
    if (call.handler === AVAILABILITY_HANDLERS.state) return {...cached(), deployment};
    if (call.handler === AVAILABILITY_HANDLERS.armDeployment) {
      assert.deepEqual(call.content, {itemId: "region-a:gpu-a:flavor-a", name: "new-vm", environment: "env", image: "Ubuntu", keypair: "key", publicIp: false, confirmCharges: true});
      deployment = {status: "waiting", launchId: "backend-id", message: "Waiting on backend"};
    } else if (call.handler === AVAILABILITY_HANDLERS.cancelDeployment) deployment = {status: "cancelled", message: "Cancelled"};
    else throw new Error("Unexpected frontend request");
    return {ok: true, configuration: ready, deployment};
  });
  t.after(() => view.dispose());
  await settle();
  view.click("deploy-arm");
  await settle();
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.armDeployment).length, 0);
  view.change("deploy-type", "region-a:gpu-a:flavor-a");
  view.document.get("deploy-name").value = "new-vm";
  view.document.get("deploy-charges").checked = true;
  view.click("deploy-arm");
  view.document.get("deploy-arm").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.armDeployment).length, 1);
  assert.equal(view.document.get("deploy-name").hasAttribute("disabled"), true);
  view.fireTimer();
  await settle();
  assert.equal(view.calls.at(-1)?.handler, AVAILABILITY_HANDLERS.state);
  assert.equal(view.calls.filter(c => c.handler === AVAILABILITY_HANDLERS.refresh).length, 0);
  view.click("deploy-cancel");
  await settle();
  assert.match(view.document.get("deploy-status").textContent, /Cancelled/);
  assert.equal(view.document.get("deploy-name").hasAttribute("disabled"), false);
});


test("a slow cache read does not swallow commands or overwrite a newer refresh preference", async t => {
  const late = deferred<Reply>();
  let reads = 0;
  const view = harness(async call => {
    if (call.handler === AVAILABILITY_HANDLERS.state) return ++reads === 1 ? cached() : late.promise;
    assert.equal(call.handler, AVAILABILITY_HANDLERS.setPolling);
    return cached(snapshot("VM", 0), 600);
  });
  t.after(() => view.dispose());
  await settle();
  view.fireTimer();
  await settle();
  view.change("polling", "600");
  await settle();
  assert.equal(view.calls.at(-1)?.handler, AVAILABILITY_HANDLERS.setPolling);
  late.resolve(cached());
  await settle();
  assert.equal(view.document.get("polling").value, "600");
});
