import { test } from "node:test";
import assert from "node:assert/strict";
import { usd } from "../format";
import { chartSpecs } from "../charts";
import { missingBills, projectionCoverage } from "../domain";
import { renderContent, renderShell, readView } from "../render";
import { demoSnapshot } from "../demo";
import { createProvider } from "../provider";
import { ProviderError, diagnosticText } from "../diagnostics";
import type { ViewState } from "../types";
const state = (): ViewState => ({
  configured: true,
  managementAllowed: true,
  budget: 2000,
  snapshot: demoSnapshot(new Date("2026-11-16T00:00:00Z")),
  plans: [],
  operations: [],
  demo: false,
});
test("USD formatting is unambiguous across locales and rounds charges to cents while preserving subcent rates", () => {
  assert.equal(usd(81.0017), "USD 81.00");
  assert.equal(usd(450.8275), "USD 450.83");
  assert.equal(usd(81001.7), "USD 81001.70");
  assert.equal(usd(0.0038, true), "USD 0.0038");
  assert.equal(usd(-4.523), "USD -4.52");
});
test("missing-bill coverage identifies the exact resource and interval and offers a targeted retry", () => {
  const s = state();
  s.snapshot!.resources[0].current = null;
  const missing = missingBills(s.snapshot!.resources);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].field, "current");
  const html = renderContent(s);
  assert.match(html, /Billing coverage · what is missing/);
  assert.match(html, /train-a100-04 · vm:101/);
  assert.match(html, /Selected-date cost is missing/);
  assert.match(html, /data-retry-bill="vm:101"/);
  assert.match(html, /data-field="current"/);
  assert.match(html, /Comparable-resource change/);
  assert.doesNotMatch(html, /1 selected \/ 0 previous/);
});
test("partial projection is computed only from known charges and never claims complete budget headroom", () => {
  const s = state();
  s.snapshot!.resources[0].current = null;
  const forecast = projectionCoverage(s.snapshot!, s.snapshot!.resources);
  assert.equal(forecast.value, 840);
  assert.equal(forecast.complete, false);
  assert.equal(forecast.missing, 1);
  const html = renderContent(s);
  assert.match(html, /Known-spend month-end run rate/);
  assert.match(html, /USD 840.00/);
  assert.match(html, /Partial estimate: excludes 1/);
  assert.match(html, /Missing bills prevent a complete budget comparison/);
  assert.doesNotMatch(html, /1 selected \/ 0 previous|Incomplete billing/);
});
test("graphs use scoped reported costs without double-counting grouped IPs and keep gaps for missing bills", () => {
  const s = state(),
    vm = s.snapshot!.resources.find((r) => r.key === "vm:102")!,
    ip = s.snapshot!.resources.find((r) => r.key === "public-ip:102")!;
  vm.current!.cost! += ip.current!.cost!;
  vm.current!.includesPublicIp = true;
  const specs = chartSpecs(s, readView({}));
  assert.ok(specs.length >= 3);
  const breakdown = specs.find((c) => c.id === "hf-chart-breakdown")!;
  assert.equal(
    breakdown.config.data.reduce<number>((n, r) => n + Number(r.spend ?? 0), 0),
    900,
  );
  s.snapshot!.resources[0].current = null;
  assert.equal(
    chartSpecs(s, readView({}))[0].config.data.find(
      (r) => r.resource === "train-a100-04",
    )!.current,
    null,
  );
  assert.ok(
    chartSpecs(s, readView({ page: "changes" })).some(
      (c) => c.id === "hf-chart-change",
    ),
  );
  const shell = renderShell();
  assert.match(shell, /fdo.progress-bar/);
  assert.match(shell, /hf-progress-detail/);
  assert.match(renderContent(s), /View graph data \(USD\)/);
});
test("permission diagnostics identify the request and safely expose provider reasons without credentials", async () => {
  const provider = createProvider(async () => ({
    ok: false,
    status: 403,
    headers: { get: () => "req-123" },
    json: async () => ({
      error_reason: "permission_denied",
      message: "Volume read access missing. api_key=ultra-private-token",
      authorization: "must-not-leak",
      body: "must-not-leak",
    }),
  }));
  await assert.rejects(
    provider.inspect("ultra-private-token", {
      ...state().snapshot!.resources[3],
    }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.diagnostics.method, "GET");
      assert.equal(error.diagnostics.path, "/core/volumes/202");
      assert.equal(error.diagnostics.httpStatus, 403);
      assert.equal(error.diagnostics.requestId, "req-123");
      assert.match(diagnosticText(error.diagnostics), /volume read permission/);
      assert.match(
        diagnosticText(error.diagnostics),
        /Volume read access missing/,
      );
      assert.doesNotMatch(
        JSON.stringify(error.diagnostics),
        /ultra-private-token|must-not-leak/,
      );
      return true;
    },
  );
});

test("nested provider error messages remain available in diagnostics", async () => {
  const provider = createProvider(async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      error: {
        code: "permission_denied",
        message: "Volume read scope missing",
      },
    }),
  }));
  await assert.rejects(
    provider.inspect("fixture-credential", {
      ...state().snapshot!.resources[3],
    }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.diagnostics.providerCode, "permission_denied");
      assert.equal(
        error.diagnostics.providerMessage,
        "Volume read scope missing",
      );
      assert.match(error.message, /Volume read scope missing/);
      return true;
    },
  );
});

test("unitemized IP charges link to the parent bill rather than offering an ineffective retry", () => {
  const s = state(),
    vm = s.snapshot!.resources.find((r) => r.key === "vm:102")!,
    ip = s.snapshot!.resources.find((r) => r.key === "public-ip:102")!;
  vm.current!.includesPublicIp = true;
  ip.current = null;
  const html = renderContent(s, readView({ kind: "public-ip" }));
  assert.match(html, /Not separately itemized/);
  assert.match(html, /Open parent VM bill/);
  assert.doesNotMatch(html, /data-retry-bill="public-ip:102"/);
});

test("denied target retries show the latest outcome and access requirement in the affected row", () => {
  const s = state();
  s.snapshot!.resources[0].current = null;
  s.snapshot!.billingIssues = [
    {
      resourceKey: "vm:101",
      field: "current",
      message: "Billing read permission missing",
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
      diagnostics: {
        method: "GET",
        path: "/billing/billing/history/virtual-machine/101",
        httpStatus: 403,
        providerCode: null,
        providerMessage: "Denied",
        requestId: null,
        observedAt: new Date().toISOString(),
        guidance: "Grant read access then Sync.",
      },
    },
  ];
  const html = renderContent(s);
  assert.match(html, /Still unavailable after 1 read attempt/);
  assert.match(html, /Access change required/);
  assert.match(html, /Last attempt:/);
});
