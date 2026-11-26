import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeDetails,
  changes,
  explainChange,
  filterResources,
  findings,
  projection,
  totals,
  windows,
} from "../domain";
import { demoSnapshot } from "../demo";
test("UTC billing windows compare elapsed month to matching previous elapsed time and handle leap years", () => {
  const w = windows("month", new Date("2024-03-15T12:00:00Z"));
  assert.equal(w.current.start, "2024-03-01T00:00:00.000Z");
  assert.equal(w.previous.start, "2024-02-01T00:00:00.000Z");
  assert.equal(w.previous.end, "2024-02-15T12:00:00.000Z");
  const last = windows("last-month", new Date("2024-03-15T12:00:00Z"));
  assert.equal(last.current.start, w.previous.start);
  assert.equal(last.current.end, w.current.start);
  assert.equal(
    windows("yesterday", new Date("2024-03-01T03:00:00Z")).current.start,
    "2024-02-29T00:00:00.000Z",
  );
});
test("scope totals preserve unknowns, project a monthly run rate and keep deleted resources searchable", () => {
  const s = demoSnapshot(new Date("2026-11-16T00:00:00Z"));
  assert.equal(totals(s.resources).current, 900);
  assert.equal(projection(s, s.resources), 1800);
  assert.equal(
    filterResources(s.resources, "training", "NORWAY-1", "completed")[0].state,
    "DELETED",
  );
  const unknown = structuredClone(s.resources);
  unknown[0].current = null;
  assert.equal(totals(unknown).current, 420);
  assert.equal(totals(unknown).currentMissing, 1);
  assert.equal(totals(unknown).delta, null);
  assert.equal(projection(s, unknown), null);
  s.windows.period = "yesterday";
  assert.equal(projection(s, s.resources), null);
});
test("findings require observed active billing and verified detached status; contract savings stay unknown", () => {
  const s = demoSnapshot();
  assert.equal(findings(s.resources).length, 2);
  const volume = structuredClone(s.resources.find((r) => r.id === 202)!);
  volume.attachmentsKnown = false;
  assert.equal(findings([volume]).length, 0);
  volume.attachmentsKnown = true;
  volume.billingActive = false;
  assert.equal(findings([volume]).length, 0);
  const stopped = structuredClone(s.resources[1]);
  stopped.contract = true;
  assert.equal(findings([stopped])[0].hourlySavings, null);
  stopped.currentRate = null;
  assert.equal(findings([stopped]).length, 0);
});
test("dollar change ranking distinguishes hours, rates and proven new creation without guessing", () => {
  const s = demoSnapshot();
  const r = structuredClone(s.resources[0]);
  assert.equal(explainChange(r, s.windows.current.start), "More billed hours");
  r.current!.rate = 8;
  assert.equal(
    explainChange(r, s.windows.current.start),
    "More billed hours and changed effective rate",
  );
  r.current!.hours = r.previous!.hours;
  assert.equal(
    explainChange(r, s.windows.current.start),
    "Changed effective rate",
  );
  r.previous!.cost = 0;
  r.createdAt = s.windows.current.start;
  assert.equal(
    explainChange(r, s.windows.current.start),
    "Newly created resource",
  );
  r.createdAt = null;
  r.current!.hours = null;
  assert.equal(
    explainChange(r, s.windows.current.start),
    "Newly billed in selected dates",
  );
  assert.equal(
    changes(s.resources, s.windows.current.start)[0].resource.id,
    101,
  );
});

test("custom dates are inclusive calendar dates with an equal preceding comparison and bounded future input", () => {
  const now = new Date("2026-11-26T10:00:00Z");
  const w = windows("custom", now, { start: "2026-11-02", end: "2026-11-04" });
  assert.deepEqual(w.current, {
    start: "2026-11-02T00:00:00.000Z",
    end: "2026-11-05T00:00:00.000Z",
  });
  assert.deepEqual(w.previous, {
    start: "2026-10-30T00:00:00.000Z",
    end: "2026-11-02T00:00:00.000Z",
  });
  assert.equal(
    windows("custom", now, { start: "2026-11-26", end: "2026-11-26" }).current
      .end,
    now.toISOString(),
  );
  for (const range of [
    { start: "2026-02-30", end: "2026-03-01" },
    { start: "2026-11-10", end: "2026-11-01" },
    { start: "2026-11-01", end: "2026-11-27" },
    { start: "2024-01-01", end: "2026-11-01" },
  ])
    assert.throws(() => windows("custom", now, range), /Invalid date range/);
});

test("missing IP splits do not poison fully reported aggregate spend or mix cost bases in comparisons", () => {
  const s = demoSnapshot(new Date("2026-11-16T00:00:00Z"));
  const vm = s.resources.find((r) => r.key === "vm:102")!,
    ip = s.resources.find((r) => r.key === "public-ip:102")!;
  vm.current!.cost! += ip.current!.cost!;
  vm.current!.includesPublicIp = true;
  ip.current = null;
  const summary = totals(s.resources);
  assert.equal(summary.current, 900);
  assert.equal(summary.currentMissing, 0);
  assert.equal(summary.currentIncludedIps, 1);
  assert.equal(projection(s, s.resources), 1800);
  const compared = changes(s.resources, s.windows.current.start);
  const row = compared.find((c) => c.resource.key === vm.key)!;
  assert.equal(row.delta, 165);
  assert.equal(row.combinedPublicIp, true);
  assert.ok(!compared.some((c) => c.resource.key === ip.key));
  assert.equal(
    totals([ip]).current,
    null,
    "Without its parent in scope no separate IP cost is invented",
  );
});

test("change evidence attributes dollar movement and explains zero baselines and public-IP limitations", () => {
  const s = demoSnapshot();
  const vm = structuredClone(s.resources[0]);
  vm.current = { cost: 240, hours: 30, rate: 8 };
  vm.previous = { cost: 80, hours: 20, rate: 4 };
  const detail = changeDetails(vm, s.windows.current.start);
  assert.equal(detail.hoursImpact, 40);
  assert.equal(detail.rateImpact, 120);
  assert.match(detail.details.join(" "), /not proof/);
  vm.current = { cost: 40, hours: 10, rate: 4 };
  vm.previous = { cost: 80, hours: 20, rate: 4 };
  assert.equal(
    explainChange(vm, s.windows.current.start),
    "Fewer billed hours",
  );
  vm.current.cost = 0;
  vm.deletedAt = new Date().toISOString();
  assert.equal(
    explainChange(vm, s.windows.current.start),
    "Resource deleted; charges ended",
  );
  assert.match(
    changeDetails(
      s.resources.find((r) => r.kind === "public-ip")!,
      s.windows.current.start,
    ).details.join(" "),
    /without independent IP usage hours/,
  );
});
