import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveProvider, resourceFromAzure } from "../providers/live.ts";
import { createBackend } from "../backend.ts";
import { SUB, TENANT } from "../providers/demo.ts";
import type { Scope } from "../types.ts";
const scope: Scope = {
  tenantId: TENANT,
  subscriptionId: SUB,
  groupIds: [],
  basis: "ActualCost",
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-19T23:59:59.999Z",
};
test("live transport emits scoped argument arrays, never logs in, and sanitizes authentication failures", async () => {
  const store = { get: () => undefined, set() {}, flush: async () => {} };
  const backend = createBackend(() => store as any);
  await backend.bootstrap();
  const { jobId } = backend.start({ kind: "accounts", mode: "live" });
  await new Promise((r) => setTimeout(r, 0));
  const poll = backend.poll({ jobId }) as any;
  assert.equal(poll.request.action, "system.process.exec");
  assert.equal(poll.request.payload.scope, "azure-finops");
  assert.deepEqual(poll.request.payload.args.slice(0, 2), ["account", "show"]);
  assert.equal(poll.request.payload.dryRun, false);
  assert.equal(poll.request.payload.args.includes("login"), false);
  backend.accept({
    jobId,
    nonce: poll.nonce,
    response: {
      ok: false,
      code: "PROCESS_EXIT_NON_ZERO",
      result: { stderr: "Please run az login. Bearer SECRET-TOKEN" },
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const failure = backend.poll({ jobId });
  assert.match("error" in failure ? failure.error! : "", /manually/);
  assert.doesNotMatch(JSON.stringify(failure), /SECRET-TOKEN/);
});
test("Resource Graph pagination, exact group filtering and partial cost denial remain explicit", async () => {
  let graphPage = 0;
  const calls: string[][] = [];
  const provider = new LiveProvider(async (args) => {
    calls.push(args);
    if (args[0] === "account") return { id: SUB, tenantId: TENANT };
    if (args[0] === "group")
      return [
        {
          id: `/subscriptions/${SUB}/resourceGroups/rg-dev`,
          name: "rg-dev",
          location: "westeurope",
        },
      ];
    const url = args[args.indexOf("--url") + 1];
    if (url.includes("Microsoft.ResourceGraph")) {
      graphPage++;
      return {
        data: [
          {
            id: `/subscriptions/${SUB}/resourceGroups/${graphPage === 1 ? "rg-dev" : "rg-other"}/providers/Microsoft.Compute/disks/d${graphPage}`,
            name: "d" + graphPage,
            type: "Microsoft.Compute/disks",
            properties: {},
            location: "westeurope",
            resourceGroup: graphPage === 1 ? "rg-dev" : "rg-other",
          },
        ],
        ...(graphPage === 1 ? { $skipToken: "page2" } : {}),
      };
    }
    throw new Error("Fixture permission denied");
  });
  const data = await provider.snapshot({
    ...scope,
    groupIds: [`/subscriptions/${SUB}/resourcegroups/rg-dev`],
  });
  assert.equal(graphPage, 2);
  assert.equal(data.resources.length, 1);
  assert.equal(data.costs.length, 0);
  assert.match(data.coverage.costs, /Unavailable/);
  assert.ok(data.warnings.some((w) => w.includes("costs")));
  assert.equal(
    calls.some(
      (c) =>
        c.includes("get-access-token") ||
        c.includes("login") ||
        c.includes("set"),
    ),
    false,
  );
});
test("origin fields do not infer creation from group age or retained writes", () => {
  const raw = {
    id: `/subscriptions/${SUB}/resourceGroups/old/providers/Microsoft.Network/publicIPAddresses/new`,
    name: "new",
    type: "Microsoft.Network/publicIPAddresses",
    properties: {},
    tags: { owner: "SRE" },
  };
  const resource = resourceFromAzure(raw, scope, "2026-10-19T12:00:00Z");
  assert.equal(resource.created.confidence, "Unknown");
  assert.equal(resource.creator.confidence, "Unknown");
  assert.equal(resource.firstObserved, "2026-10-19T12:00:00Z");
  assert.equal(resource.events.length, 0);
});
