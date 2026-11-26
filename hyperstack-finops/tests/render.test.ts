import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContent, renderShell, readView } from "../render";
import { demoSnapshot } from "../demo";
import type { ViewState } from "../types";
const state = (): ViewState => ({
  configured: true,
  managementAllowed: true,
  budget: 1500,
  snapshot: demoSnapshot(),
  plans: [],
  operations: [],
  demo: false,
});
test("SDK shell emits the dark responsive layout, accessible controls and no executable markup", () => {
  const shell = renderShell();
  assert.match(shell, /<style/);
  assert.match(shell, /Hyperstack FinOps/);
  assert.match(shell, /hf-environment/);
  assert.match(shell, /hf-period/);
  assert.match(shell, /hf-content/);
  assert.doesNotMatch(shell, /<script/);
  assert.match(shell, /minmax/);
  assert.match(shell, /#1bd0ef/);
});
test("all investigation views render evidence, history and matching cost driver links", () => {
  for (const page of [
    "overview",
    "resources",
    "optimization",
    "changes",
    "plan",
    "operations",
  ])
    assert.ok(renderContent(state(), readView({ page })).length > 100);
  assert.match(renderContent(state()), /data-driver="vm"/);
  assert.match(renderContent(state()), /Largest cost drivers/);
  assert.match(renderContent(state()), /Organization reported total/);
  assert.match(
    renderContent(state(), readView({ page: "resources", selected: "vm:102" })),
    /Stopped GPU VM still billing/,
  );
  const origin = renderContent(
    state(),
    readView({ page: "resources", selected: "vm:102", tab: "origin" }),
  );
  assert.match(origin, /Unknown/);
  assert.match(origin, /data-local-date/);
  assert.match(
    renderContent(state(), readView({ page: "resources", query: "completed" })),
    /DELETED/,
  );
});
test("provider names and values are escaped before dynamic HTML is returned", () => {
  const s = state();
  s.snapshot!.resources[0].name = '<img src=x onerror="alert(1)">';
  const html = renderContent(s, readView({ page: "resources" }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("action plan includes target identity, retained dependencies, capacity and explicit impact confirmation", () => {
  const s = state();
  s.plans = [
    {
      id: "plan-1",
      organizationId: 999,
      resourceKey: "vm:102",
      resourceId: 102,
      name: "eval-h100-01",
      kind: "hibernate",
      hours: 12,
      retainIp: true,
      stagedAt: new Date().toISOString(),
      dependencies: ["volume:201", "public-ip:102"],
      hourlySavings: 4,
      capacity: "Currently unavailable; resume capacity is not guaranteed",
      capacityAt: new Date().toISOString(),
      blocked: "Hyperstack requires an ACTIVE VM to hibernate.",
    },
  ];
  const html = renderContent(s, readView({ page: "plan" }));
  for (const expected of [
    "vm:102",
    "volume:201",
    "public-ip:102",
    "Estimated avoided charges",
    "48",
    "Currently unavailable",
    "confirm-plan-1",
    "data-execute",
    "disabled",
  ])
    assert.ok(html.includes(expected), expected);
  s.plans[0].kind = "delete-volume";
  assert.match(
    renderContent(s, readView({ page: "plan" })),
    /Type volume ID to confirm deletion/,
  );
});

test("resource activity excludes a different organization's operation with the same resource ID", () => {
  const s = state();
  s.operations = [
    {
      id: "other-org-op",
      plan: {
        id: "old-plan",
        organizationId: 1000,
        resourceKey: "vm:102",
        resourceId: 102,
        name: "different-account",
        kind: "hibernate",
        hours: 12,
        retainIp: true,
        stagedAt: new Date().toISOString(),
        dependencies: [],
        hourlySavings: null,
        capacity: "Unknown",
        capacityAt: null,
        blocked: null,
      },
      at: new Date().toISOString(),
      status: "submitted",
      message: "Other-account-only-message",
    },
  ];
  assert.doesNotMatch(
    renderContent(
      s,
      readView({ page: "resources", selected: "vm:102", tab: "activity" }),
    ),
    /Other-account-only-message/,
  );
  assert.match(
    renderContent(s, readView({ page: "operations" })),
    /Organization 1000/,
  );
});

test("overview and unselected resource views never highlight or automatically inspect the first VM", () => {
  assert.doesNotMatch(renderContent(state()), /class="selected"/);
  const html = renderContent(state(), readView({ page: "resources" }));
  assert.doesNotMatch(html, /class="selected"|aria-label="Resource inspector"/);
  assert.match(html, /Nothing is selected automatically/);
  assert.match(
    renderContent(state(), readView({ page: "resources", selected: "vm:102" })),
    /class="selected"/,
  );
});

test("resource costs are tied to loaded dates and IP usage is explained without fake hourly values", () => {
  const html = renderContent(
    state(),
    readView({ page: "resources", selected: "public-ip:102" }),
  );
  assert.match(html, /Cost \(selected dates\)/);
  assert.match(html, /reported total for this loaded range/);
  assert.match(html, /does not report independent IP usage hours/);
  assert.match(html, /Open parent VM/);
  const metrics = html.slice(
    html.indexOf('class="inspector-metrics"'),
    html.indexOf('class="tabs"', html.indexOf('class="inspector-metrics"')) > 0
      ? html.indexOf('class="tabs"', html.indexOf('class="inspector-metrics"'))
      : html.indexOf("</aside>"),
  );
  assert.doesNotMatch(metrics, /Unknown\/h|Not reported\/h/);
});

test("volume estimate guidance explains future avoided costs before the estimate input", () => {
  const html = renderContent(
    state(),
    readView({ page: "resources", selected: "volume:202" }),
  );
  assert.ok(
    html.indexOf("not a delay, schedule, or refund") <
      html.indexOf('id="hf-pause"'),
  );
  assert.match(html, /Savings estimate window \(hours after deletion\)/);
  assert.match(html, /value="24"/);
});

test("summary keeps reported VM totals usable when public-IP detail is missing and explains accounting", () => {
  const s = state(),
    vm = s.snapshot!.resources.find((r) => r.key === "vm:102")!,
    ip = s.snapshot!.resources.find((r) => r.key === "public-ip:102")!;
  vm.current!.cost! += ip.current!.cost!;
  vm.previous!.cost! += ip.previous!.cost!;
  vm.current!.includesPublicIp = true;
  vm.previous!.includesPublicIp = true;
  ip.current = null;
  ip.previous = null;
  const html = renderContent(s);
  assert.match(html, /900/);
  assert.doesNotMatch(html, /Comparison incomplete/);
  assert.match(html, /already included in VM bills/);
  const ipHtml = renderContent(
    s,
    readView({ page: "resources", selected: ip.key }),
  );
  assert.match(ipHtml, /Included in VM bill/);
  assert.match(ipHtml, /not added a second time/);
});

test("cost changes expose numeric evidence and preserve rows with missing comparison data", () => {
  const s = state();
  s.snapshot!.resources[0].previous = null;
  const html = renderContent(s, readView({ page: "changes" }));
  assert.match(html, /Billing coverage incomplete/);
  assert.match(html, /Needs both bills/);
  assert.match(html, /Evidence &amp; calculation/);
  assert.match(html, /Arithmetic attribution/);
  assert.match(html, /Previous:/);
  assert.match(html, /Selected:/);
  const shell = renderShell();
  assert.match(shell, /Custom date range/);
  assert.match(shell, /hf-range-start/);
  assert.match(shell, /hf-range-end/);
});
