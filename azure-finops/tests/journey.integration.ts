import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { render, onLoad } from "../render.ts";
import { createBackend } from "../backend.ts";
import { SUB, OTHER_SUB } from "../providers/demo.ts";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
async function fixture() {
  const disk = new Map<string, any>(),
    hostRequests: any[] = [];
  const store = {
    get: (k: string) => disk.get(k),
    set: (k: string, v: any) => disk.set(k, structuredClone(v)),
    flush: async () => {},
  };
  const backend = createBackend(() => store as any),
    dom = new JSDOM(`<!doctype html><html><body>${render()}</body></html>`, {
      runScripts: "outside-only",
      url: "http://localhost/",
    }),
    win = dom.window;
  win.structuredClone = structuredClone;
  win.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  win.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  let tail = Promise.resolve();
  win.createBackendReq = (type: string, payload: any) => {
    const task = tail.then(async () => {
      if (type === "requestPrivilegedAction") {
        hostRequests.push(payload);
        return { ok: false, code: "ACCESS_DENIED" };
      }
      const name = payload.handler.replace("azure-finops.", "");
      try {
        return {
          ok: true,
          data: structuredClone(await (backend as any)[name](payload.content)),
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
    tail = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  win.eval(onLoad());
  const $ = (selector: string) => win.document.querySelector(selector);
  const wait = async (condition: () => any) => {
    for (let i = 0; i < 120; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("UI condition timeout: " + $("#af-message")?.textContent);
  };
  const click = async (selector: string) => {
    $(selector).click();
    await new Promise((r) => setTimeout(r, 10));
  };
  const action = async (label: string) => {
    const button = [...win.document.querySelectorAll("button")].find(
      (b: any) => b.textContent === label,
    ) as any;
    assert.ok(button, label);
    button.click();
    await new Promise((r) => setTimeout(r, 10));
  };
  const input = async (selector: string, value: string, event = "input") => {
    $(selector).value = value;
    $(selector).dispatchEvent(new win.Event(event, { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
  };
  await wait(() => $("#af-resource-table tbody tr"));
  return {
    backend,
    disk,
    hostRequests,
    dom,
    win,
    $,
    wait,
    click,
    action,
    input,
    cleanup: () => {
      win.dispatchEvent(new win.Event("pagehide"));
      dom.window.close();
    },
  };
}
test("demo scope-to-origin-to-dependency-to-deletion journey is durable and makes no Azure calls", async () => {
  const f = await fixture();
  try {
    assert.equal(f.$("#af-mode-badge").textContent, "DEMO");
    assert.match(f.$("#af-context").textContent, /All accessible groups/);
    await f.click("#af-groups-button");
    await f.click("#af-groups-clear");
    assert.equal(f.$("#af-groups-apply").disabled, true);
    await f.input("#af-group-search", "rg-dev");
    f.$("#af-group-list input").click();
    await f.click("#af-groups-cancel");
    assert.equal(f.$("#af-groups-button").textContent, "All accessible groups");
    await f.click("#af-groups-button");
    await f.click("#af-groups-clear");
    await f.input("#af-group-search", "rg-dev");
    const checkbox = f.$("#af-group-list input");
    assert.match(checkbox.value, new RegExp(SUB));
    checkbox.click();
    await f.click("#af-groups-apply");
    await f.wait(() => f.$("#af-resource-table tbody tr"));
    assert.equal(f.$("#af-groups-button").textContent, "rg-dev");
    assert.equal(
      f.$("#af-resource-table").textContent.includes("pip-sandbox"),
      false,
    );
    const row = [
      ...f.win.document.querySelectorAll("#af-resource-table tbody tr"),
    ].find((r: any) => r.textContent.includes("disk-build-old")) as any;
    assert.ok(row);
    row.click();
    await f.wait(
      () =>
        f.$("#af-detail")?.textContent.includes("Provider-reported") ||
        f.$("#af-detail")?.textContent.includes("Origin & ownership"),
    );
    assert.match(f.$("#af-detail").textContent, /systemData.createdAt/);
    const splitter = f.$('[aria-label="Resize resource details"]');
    splitter.focus();
    splitter.dispatchEvent(
      new f.win.KeyboardEvent("keydown", {
        key: "Home",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(splitter.getAttribute("aria-valuenow"), "320");
    const origin = f.$('#af-detail [role="tab"][aria-selected="true"]');
    origin.focus();
    origin.dispatchEvent(
      new f.win.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(f.win.document.activeElement.textContent, "Metrics");
    assert.equal(
      f.$('#af-detail [aria-selected="true"]').textContent,
      "Metrics",
    );
    await f.action("Dependencies");
    assert.match(f.$("#af-detail").textContent, /Discovery gaps/);
    await f.action("Propose deletion…");
    await f.wait(() =>
      f.$("#af-plan-count").textContent.includes("1 proposed"),
    );
    assert.equal(f.backend.state().operations.length, 0);
    await f.click("#af-review");
    await f.wait(() => f.$("#af-review-dialog").open);
    assert.match(f.$("#af-review-content").textContent, /Permanently deletes/);
    const confirm = f.$(
      '[aria-label="I reviewed every exact target and operational impact"]',
    );
    confirm.click();
    const execute = [...f.win.document.querySelectorAll("button")].find(
      (b: any) => b.textContent === "Simulate reviewed actions",
    ) as HTMLButtonElement;
    assert.equal(
      execute.disabled,
      true,
      "Acknowledgement alone cannot execute a dangerous operation",
    );
    assert.equal(f.backend.state().operations.length, 0);
    await f.input(
      '[aria-label="Confirm deletion disk-build-old"]',
      "disk-build-old",
    );
    await f.action("Simulate reviewed actions");
    await f.wait(() => f.$("#af-main").textContent.includes("succeeded"));
    assert.equal(f.backend.state().plan.length, 0);
    assert.equal(f.backend.state().operations[0].state, "succeeded");
    await f.action("Measure observed spending");
    await f.wait(() =>
      f.$("#af-main").textContent.includes("DEMO illustrative"),
    );
    assert.equal(
      f.disk.get("settings").operations[0].measurement.basis,
      "ActualCost",
    );
    assert.equal(f.hostRequests.length, 0);
    assert.equal(
      f.disk.get("settings").operations[0].action.target.subscriptionId,
      SUB,
    );
  } finally {
    f.cleanup();
  }
});
test("subscription switches clear group IDs and saved views restore scope, filters and sorting", async () => {
  const f = await fixture();
  try {
    await f.input('[aria-label="Search resources"]', "vm-dev");
    assert.equal(f.$("#af-resource-table tbody").children.length, 1);
    await f.click("#af-save-view");
    await f.input("#af-view-name", "Runner investigation");
    await f.click("#af-view-confirm");
    await f.wait(() => !f.$("#af-view-dialog").open);
    assert.equal(f.backend.state().views[0].filters.search, "vm-dev");
    await f.input("#af-subscription", OTHER_SUB, "change");
    await f.wait(() => f.$("#af-resource-table tbody tr"));
    assert.equal(f.$("#af-groups-button").textContent, "All accessible groups");
    assert.equal(f.$("#af-subscription").value, OTHER_SUB);
    await f.input("#af-view", f.backend.state().views[0].id, "change");
    await f.wait(() => f.$("#af-resource-table tbody tr"));
    assert.equal(f.$("#af-subscription").value, SUB);
    assert.equal(f.$('[aria-label="Search resources"]').value, "vm-dev");
    assert.equal(f.hostRequests.length, 0);
    await f.click('[data-page="settings"]');
    assert.match(f.$("#af-main").textContent, /Shared Process Scopes/);
    assert.match(
      f.$("#af-main").textContent,
      /system.process.scope.azure-finops/,
    );
    assert.match(f.$("#af-main").textContent, /az login --tenant/);
  } finally {
    f.cleanup();
  }
});

test("late snapshots cannot appear underneath a newer subscription scope", async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  try {
    const original = f.win.createBackendReq;
    f.win.createBackendReq = async (type: string, payload: any) => {
      const response = await original(type, payload);
      if (
        payload.handler === "azure-finops.poll" &&
        response?.data?.result?.scope?.subscriptionId === SUB &&
        response.data.result.resources
      ) {
        waiting = true;
        await held;
      }
      return response;
    };
    await f.click("#af-refresh");
    await f.wait(() => waiting);
    await f.input("#af-subscription", OTHER_SUB, "change");
    await f.wait(() => f.$("#af-resource-table tbody tr"));
    release();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(f.$("#af-subscription").value, OTHER_SUB);
    assert.match(f.$("#af-context").textContent, /Sandbox/);
    const row = f.$("#af-resource-table tbody tr");
    row.click();
    await f.wait(() => f.$("#af-detail"));
    await f.action("Summary");
    assert.match(f.$("#af-detail").textContent, new RegExp(OTHER_SUB));
    assert.equal(f.$("#af-detail").textContent.includes(SUB), false);
  } finally {
    release();
    f.cleanup();
  }
});

test("fleet scan and dangerous VM start review keep demo isolated", async () => {
  const f = await fixture();
  try {
    await f.click('[data-page="optimization"]');
    await f.action("Scan VM utilization");
    await f.wait(() =>
      f.$("#af-message")?.textContent?.includes("scan complete"),
    );
    await f.click('[data-page="changes"]');
    assert.match(f.$("#af-main").textContent, /Plugin statistical anomalies/);
    await f.click('[data-page="resources"]');
    const row = [
      ...f.win.document.querySelectorAll("#af-resource-table tbody tr"),
    ].find((r: any) => r.textContent.includes("vm-dev-runner")) as HTMLElement;
    row.click();
    await f.wait(() =>
      f.$("#af-detail")?.textContent.includes("Origin & ownership"),
    );
    await f.action("Metrics");
    assert.match(f.$("#af-detail").textContent, /Available Memory Bytes/);
    await f.action("Propose start…");
    await f.click("#af-review");
    await f.wait(() => f.$("#af-review-dialog").open);
    assert.equal(f.win.document.activeElement.id, "af-review-close");
    assert.match(f.$("#af-review-content").textContent, /Dangerous operation/);
    const execute = [...f.win.document.querySelectorAll("button")].find(
      (b: any) => b.textContent === "Simulate reviewed actions",
    ) as HTMLButtonElement;
    assert.equal(execute.disabled, true);
    await f.input(
      '[aria-label="Confirm start vm-dev-runner"]',
      "vm-dev-runner",
    );
    assert.equal(execute.disabled, true, "Typed name alone cannot execute");
    f.$(
      '[aria-label="I reviewed every exact target and operational impact"]',
    ).click();
    assert.equal(execute.disabled, false);
    await f.action("Simulate reviewed actions");
    await f.wait(() => f.backend.state().operations[0]?.state === "succeeded");
    assert.equal(f.hostRequests.length, 0);
  } finally {
    f.cleanup();
  }
});

test("Databricks and Foundry inspections show billing layers, cleanup evidence and preserve read-only demo isolation", async () => {
  const f = await fixture();
  try {
    await f.click('[data-page="databricks"]');
    assert.match(f.$("#af-main").textContent, /dbx-analytics/);
    await f.action("Inspect service");
    await f.wait(() =>
      f.$("#af-main").textContent.includes("analytics-interactive"),
    );
    assert.match(f.$("#af-main").textContent, /automatic shutdown disabled/);
    await f.input('[aria-label="Search service inventory"]', "reporting-sql");
    assert.match(
      f.$(".af-service-inventory tbody").textContent,
      /reporting-sql/,
    );
    assert.equal(
      f
        .$(".af-service-inventory tbody")
        .textContent.includes("analytics-interactive"),
      false,
    );
    await f.input('[aria-label="Search service inventory"]', "");
    assert.match(f.$("#af-main").textContent, /Related billing scope/);
    assert.match(f.$("#af-main").textContent, /do not double-count/);
    assert.equal(f.backend.state().plan.length, 0);
    await f.action("Inspect origin, dependencies & reviewed actions");
    await f.wait(() =>
      f.$("#af-detail")?.textContent.includes("Origin & ownership"),
    );
    assert.match(
      f.$("#af-detail").textContent,
      /Last control-plane modification/,
    );
    assert.match(
      f.$("#af-detail").textContent,
      /no observed modifications does not establish safe deletion/i,
    );
    await f.click('[data-page="foundry"]');
    assert.match(f.$("#af-main").textContent, /AIServices/);
    const inspect = [
      ...f.win.document.querySelectorAll("#af-main button"),
    ].find(
      (b: any) => b.textContent === "Inspect service",
    ) as HTMLButtonElement;
    inspect.click();
    await f.wait(() =>
      f.$("#af-main").textContent.includes("ProvisionedManaged"),
    );
    assert.match(
      f.$("#af-main").textContent,
      /no fabricated per-project split/,
    );
    assert.match(f.$("#af-main").textContent, /commitment terms/);
    assert.equal(f.hostRequests.length, 0);
    assert.equal(f.backend.state().operations.length, 0);
    await f.input("#af-subscription", OTHER_SUB, "change");
    await f.wait(() => f.$("#af-context").textContent.includes("Sandbox"));
    assert.equal(
      f.$("#af-main").textContent.includes("observed 2026-10-19"),
      false,
      "Old exact service inspection must clear on scope change",
    );
  } finally {
    f.cleanup();
  }
});

test("late service inspections cannot repopulate after subscription changes", async () => {
  const f = await fixture();
  let release!: () => void,
    waiting = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const original = f.win.createBackendReq;
    f.win.createBackendReq = async (type: string, payload: any) => {
      const response = await original(type, payload);
      if (
        payload.handler === "azure-finops.poll" &&
        response?.data?.result?.kind === "databricks"
      ) {
        waiting = true;
        await held;
      }
      return response;
    };
    await f.click('[data-page="databricks"]');
    await f.action("Inspect service");
    await f.wait(() => waiting);
    await f.input("#af-subscription", OTHER_SUB, "change");
    await f.wait(() => f.$("#af-context").textContent.includes("Sandbox"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.$(".af-service-detail"), null);
    assert.equal(
      f.$("#af-main").textContent.includes("analytics-interactive"),
      false,
    );
    assert.equal(f.hostRequests.length, 0);
  } finally {
    release();
    f.cleanup();
  }
});

test("switching from Demo to a denied Live connection clears the demo identity immediately", async () => {
  const f = await fixture();
  try {
    assert.match(f.$("#af-identity").textContent, /engineering@contoso/);
    await f.click('[data-page="settings"]');
    await f.input('[aria-label="Provider"]', "live", "change");
    await f.action("Save provider settings");
    await f.wait(() => f.$("#af-mode-badge").textContent === "LIVE");
    assert.equal(f.$("#af-identity").textContent, "CLI profile not checked");
    assert.doesNotMatch(
      f.$(".af-sidebar").textContent,
      /engineering@contoso|Demo · no Azure calls/,
    );
    await f.action("Check CLI & sign-in");
    await f.wait(() => f.hostRequests.length > 0 && f.$("#af-progress").hidden);
    assert.equal(f.$("#af-identity").textContent, "CLI profile not checked");
    assert.doesNotMatch(f.$("#af-connection").textContent, /verified/);
  } finally {
    f.cleanup();
  }
});

test("same-scope refresh and host remount retain service exploration without restoring old Azure data", async () => {
  const f = await fixture();
  try {
    await f.click('[data-page="databricks"]');
    await f.action("Inspect service");
    await f.wait(() => f.$(".af-service-detail"));
    await f.input('[aria-label="Search databricks resources"]', "analytics");
    await f.input('[aria-label="Search service inventory"]', "reporting-sql");
    await f.click("#af-refresh");
    await f.wait(() => f.$("#af-progress").hidden);
    assert.equal(f.$("#af-title").textContent, "Azure Databricks inspection");
    assert.ok(f.$(".af-service-detail"));
    assert.equal(
      f.$('[aria-label="Search service inventory"]').value,
      "reporting-sql",
    );
    assert.equal(
      f.$('[aria-label="Search databricks resources"]').value,
      "analytics",
    );
    await f.wait(() => f.disk.get("exploration")?.serviceId);
    const saved = f.disk.get("exploration");
    assert.ok(saved.serviceId);
    assert.equal(saved.snapshot, undefined);
    assert.equal(saved.serviceData, undefined);
    f.win.__afFinOpsCleanup();
    delete f.win.__afFinOpsView;
    f.win.document.body.innerHTML = render();
    const cleanup = f.win.eval(onLoad());
    assert.equal(
      typeof cleanup,
      "function",
      "FDO receives the cleanup for its view lifecycle",
    );
    await f.wait(() => f.$(".af-service-detail"));
    assert.equal(f.$("#af-title").textContent, "Azure Databricks inspection");
    assert.equal(
      f.$('[aria-label="Search service inventory"]').value,
      "reporting-sql",
    );
    assert.equal(
      f.$('[aria-label="Search databricks resources"]').value,
      "analytics",
    );
    assert.equal(f.hostRequests.length, 0);
  } finally {
    f.cleanup();
  }
});
test("repeated on-load initialization keeps the current view and makes no new backend requests", async () => {
  const f = await fixture();
  try {
    await f.click('[data-page="foundry"]');
    const original = f.win.createBackendReq;
    let calls = 0;
    f.win.createBackendReq = (...args: any[]) => {
      calls++;
      return original(...args);
    };
    const first = f.win.eval(onLoad()),
      second = f.win.eval(onLoad());
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(first, second);
    assert.equal(calls, 0);
    assert.equal(f.$("#af-title").textContent, "Foundry & AI inspection");
  } finally {
    f.cleanup();
  }
});
test("charts await the connected host API, dispose late controllers and expose retryable renderer errors", async () => {
  const f = await fixture();
  try {
    let resolve!: (controller: any) => void,
      disposed = 0,
      calls = 0;
    f.win.FDOCharts = {
      create: async (node: HTMLElement, config: any) => {
        calls++;
        assert.equal(node.isConnected, true);
        assert.equal(config.type, "area");
        return new Promise((r) => {
          resolve = r;
        });
      },
    };
    await f.click('[data-page="overview"]');
    await f.wait(() => calls === 1);
    await f.click('[data-page="resources"]');
    resolve({
      dispose() {
        disposed++;
      },
    });
    await f.wait(() => disposed === 1);
    f.win.FDOCharts = {
      create: async () => {
        throw new Error("Renderer chunk failed to load");
      },
    };
    await f.click('[data-page="overview"]');
    await f.wait(() =>
      f.$("#af-main").textContent.includes("Renderer chunk failed to load"),
    );
    f.win.FDOCharts = {
      create: async (node: HTMLElement) => {
        node.appendChild(f.win.document.createElement("svg"));
        return { dispose() {} };
      },
    };
    await f.action("Retry chart");
    await f.wait(() => f.$(".af-chart svg"));
    assert.equal(
      f.$("#af-main").textContent.includes("Renderer chunk failed to load"),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("typing and focus survive a snapshot completing during service exploration", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await f.click('[data-page="databricks"]');
    await f.action("Inspect service");
    await f.wait(() => f.$(".af-service-detail"));
    const original = f.win.createBackendReq;
    let waiting = false;
    const held = new Promise<void>((r) => {
      release = r;
    });
    f.win.createBackendReq = async (type: string, payload: any) => {
      const response = await original(type, payload);
      if (
        payload.handler === "azure-finops.poll" &&
        response?.data?.result?.resources
      ) {
        waiting = true;
        await held;
      }
      return response;
    };
    await f.click("#af-refresh");
    await f.wait(() => waiting);
    const search = f.$('[aria-label="Search service inventory"]');
    search.focus();
    await f.input('[aria-label="Search service inventory"]', "reporting-sql");
    search.setSelectionRange(4, 4);
    release();
    await f.wait(() => !f.$("#af-refresh").disabled);
    const updated = f.$('[aria-label="Search service inventory"]');
    assert.equal(updated.value, "reporting-sql");
    assert.equal(f.win.document.activeElement, updated);
    assert.equal(updated.selectionStart, 4);
  } finally {
    release?.();
    f.cleanup();
  }
});
