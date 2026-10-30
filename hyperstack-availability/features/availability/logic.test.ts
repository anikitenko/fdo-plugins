import {test} from "node:test";
import assert from "node:assert/strict";
import {
  classifyAvailability,
  filterAvailability,
  getAvailabilityFilterOptions,
  summarizeAvailability,
  validateAvailabilityResponse,
} from "./logic";
import type {AvailabilityItem, StockEvidence} from "./logic";

function validatedItems(input: unknown): readonly AvailabilityItem[] {
  const result = validateAvailabilityResponse(input);
  if (!result.valid) {
    assert.fail(`Expected valid availability: ${JSON.stringify(result.issues)}`);
  }
  return result.data.items;
}

function fixtureItems(): readonly AvailabilityItem[] {
  return validatedItems({
    items: [
      {
        id: "eu-a100",
        region: "Europe",
        gpu: "A100",
        flavor: "gpu-a100-small",
        availableCount: 3,
        isAvailable: true,
      },
      {
        id: "us-h100",
        region: "US",
        gpu: "H100",
        flavor: "gpu-h100-large",
        availableCount: 0,
        isAvailable: false,
      },
      {
        id: "eu-h100",
        region: "Europe",
        gpu: "H100",
        flavor: "gpu-h100-medium",
      },
      {
        id: "us-a100",
        region: "US",
        gpu: "A100",
        flavor: "gpu-a100-large",
        isAvailable: true,
      },
    ],
  });
}

test("classifies available unavailable and unknown VM stock", () => {
  const cases: readonly {
    evidence: StockEvidence;
    expected: AvailabilityItem["status"];
  }[] = [
    {evidence: {availableCount: 4}, expected: "available"},
    {evidence: {availableCount: 0}, expected: "unavailable"},
    {evidence: {isAvailable: true}, expected: "available"},
    {evidence: {isAvailable: false}, expected: "unavailable"},
    {
      evidence: {availableCount: 2, isAvailable: true},
      expected: "available",
    },
    {
      evidence: {availableCount: 0, isAvailable: false},
      expected: "unavailable",
    },
    {
      evidence: {availableCount: Number.MAX_SAFE_INTEGER},
      expected: "available",
    },
    {evidence: {}, expected: "unknown"},
    {
      evidence: {availableCount: null, isAvailable: null},
      expected: "unknown",
    },
    {
      evidence: {availableCount: null, isAvailable: true},
      expected: "available",
    },
    {
      evidence: {availableCount: 0, isAvailable: null},
      expected: "unavailable",
    },
    {
      evidence: {availableCount: 0, isAvailable: true},
      expected: "unknown",
    },
    {
      evidence: {availableCount: 2, isAvailable: false},
      expected: "unknown",
    },
  ];

  for (const {evidence, expected} of cases) {
    assert.equal(classifyAvailability(evidence), expected);

    const items = validatedItems({
      items: [
        {
          id: "stock-case",
          region: "Europe",
          gpu: "A100",
          flavor: "gpu-a100-small",
          ...evidence,
        },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.status, expected);
  }

  const items = fixtureItems();
  assert.deepEqual(
    items.map((item) => ({id: item.id, status: item.status})),
    [
      {id: "eu-a100", status: "available"},
      {id: "us-h100", status: "unavailable"},
      {id: "eu-h100", status: "unknown"},
      {id: "us-a100", status: "available"},
    ],
  );
  assert.equal(items[2]?.availableCount, null);
  assert.equal(items[2]?.isAvailable, null);

  for (const malformedStock of [
    {availableCount: -1},
    {availableCount: 1.5},
    {availableCount: "5"},
    {availableCount: Number.NaN},
    {availableCount: Number.POSITIVE_INFINITY},
    {availableCount: Number.NEGATIVE_INFINITY},
    {availableCount: Number.MAX_SAFE_INTEGER + 1},
    {availableCount: true},
    {availableCount: {}},
    {availableCount: []},
    {isAvailable: "true"},
    {isAvailable: 1},
    {isAvailable: {}},
    {isAvailable: []},
    {availableCount: -1, isAvailable: true},
    {availableCount: 3, isAvailable: "true"},
  ]) {
    const result = validateAvailabilityResponse({
      items: [
        {
          id: "malformed-stock",
          region: "Europe",
          gpu: "A100",
          flavor: "gpu-a100-small",
          ...malformedStock,
        },
      ],
    });
    assert.equal(
      result.valid,
      false,
      "Malformed stock must not become confirmed availability",
    );
    if (!result.valid) {
      assert.ok(result.issues.length > 0);
      assert.ok(
        result.issues.some(
          (issue) =>
            issue.path === "items[0].availableCount" ||
            issue.path === "items[0].isAvailable",
        ),
      );
    }
  }
});

test("validates response structure and required VM identity fields", () => {
  const malformedResponses: readonly unknown[] = [
    null,
    undefined,
    false,
    "availability",
    [],
    {},
    {items: null},
    {items: {}},
    {items: [null]},
    {items: ["VM"]},
    {items: [[]]},
  ];

  for (const input of malformedResponses) {
    const result = validateAvailabilityResponse(input);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.issues.length > 0);
      for (const issue of result.issues) {
        assert.equal(typeof issue.path, "string");
        assert.equal(typeof issue.message, "string");
        assert.ok(issue.message.length > 0);
      }
    }
  }

  const validRow = {
    id: "eu-a100",
    region: "Europe",
    gpu: "A100",
    flavor: "gpu-a100-small",
    availableCount: 1,
  };

  for (const field of ["id", "region", "gpu", "flavor"] as const) {
    for (const invalidValue of [undefined, null, "", "   ", 42]) {
      const result = validateAvailabilityResponse({
        items: [{...validRow, [field]: invalidValue}],
      });
      assert.equal(
        result.valid,
        false,
        `Expected invalid ${field} to be rejected`,
      );
      if (!result.valid) {
        assert.ok(
          result.issues.some((issue) => issue.path === `items[0].${field}`),
        );
      }
    }
  }
});

test("accepts empty responses without fabricating available stock", () => {
  const items = validatedItems({items: []});
  assert.deepEqual(items, []);
  assert.deepEqual(summarizeAvailability(items), {
    total: 0,
    available: 0,
    unavailable: 0,
    unknown: 0,
  });
  assert.deepEqual(getAvailabilityFilterOptions(items), {
    regions: [],
    gpus: [],
  });
  assert.deepEqual(filterAvailability(items, {status: "available"}), []);
});

test("preserves explicit stock evidence and provider identity", () => {
  const items = validatedItems({
    items: [
      {
        id: "explicit-count",
        region: "Europe",
        gpu: "A100",
        flavor: "gpu-a100-small",
        availableCount: 7,
      },
      {
        id: "explicit-boolean",
        region: "US",
        gpu: "H100",
        flavor: "gpu-h100-large",
        isAvailable: false,
      },
    ],
  });

  assert.deepEqual(items, [
    {
      id: "explicit-count",
      region: "Europe",
      gpu: "A100",
      flavor: "gpu-a100-small",
      availableCount: 7,
      isAvailable: null,
      status: "available",
    },
    {
      id: "explicit-boolean",
      region: "US",
      gpu: "H100",
      flavor: "gpu-h100-large",
      availableCount: null,
      isAvailable: false,
      status: "unavailable",
    },
  ]);
});

test("rejects malformed rows instead of returning partial availability", () => {
  const result = validateAvailabilityResponse({
    items: [
      {
        id: "valid",
        region: "Europe",
        gpu: "A100",
        flavor: "gpu-a100-small",
        availableCount: 2,
      },
      {
        id: "invalid",
        region: "US",
        gpu: "H100",
        flavor: "gpu-h100-large",
        availableCount: "untrusted-stock-value",
      },
    ],
  });

  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.issues.length > 0);
    assert.ok(
      result.issues.some(
        (issue) => issue.path === "items[1].availableCount",
      ),
    );
    assert.equal("data" in result, false);
    assert.equal(
      JSON.stringify(result.issues).includes("untrusted-stock-value"),
      false,
      "Validation issues must not echo rejected provider values",
    );
  }
});

test("rejects duplicate normalized identifiers", () => {
  const row = {
    id: "same-vm",
    region: "Europe",
    gpu: "A100",
    flavor: "gpu-a100-small",
    availableCount: 2,
  };
  const result = validateAvailabilityResponse({
    items: [
      row,
      {...row, id: " same-vm ", region: "US"},
    ],
  });

  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.issues.some((issue) => issue.path === "items[1].id"));
    assert.equal("data" in result, false);
  }
});

test("normalizes identity and derives status without trusting extra fields", () => {
  const input = {
    items: [
      {
        id: " vm-one ",
        region: " Europe ",
        gpu: " A100 ",
        flavor: " gpu-a100-small ",
        status: "available",
        gpuCount: 8,
        runningVmCount: 10,
        providerSecret: "discard-this-value",
      },
    ],
  };
  const before = JSON.stringify(input);
  const items = validatedItems(input);

  assert.deepEqual(items, [
    {
      id: "vm-one",
      region: "Europe",
      gpu: "A100",
      flavor: "gpu-a100-small",
      availableCount: null,
      isAvailable: null,
      status: "unknown",
    },
  ]);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(items).includes("discard-this-value"), false);
});

test("filters VM options by region GPU and stock status", () => {
  const items = fixtureItems();
  const ids = (result: readonly AvailabilityItem[]) =>
    result.map((item) => item.id);

  assert.deepEqual(ids(filterAvailability(items)), [
    "eu-a100",
    "us-h100",
    "eu-h100",
    "us-a100",
  ]);
  assert.deepEqual(ids(filterAvailability(items, {region: "Europe"})), [
    "eu-a100",
    "eu-h100",
  ]);
  assert.deepEqual(ids(filterAvailability(items, {gpu: "H100"})), [
    "us-h100",
    "eu-h100",
  ]);
  assert.deepEqual(ids(filterAvailability(items, {status: "available"})), [
    "eu-a100",
    "us-a100",
  ]);
  assert.deepEqual(ids(filterAvailability(items, {status: "unavailable"})), [
    "us-h100",
  ]);
  assert.deepEqual(ids(filterAvailability(items, {status: "unknown"})), [
    "eu-h100",
  ]);
  assert.deepEqual(
    ids(
      filterAvailability(items, {
        region: "Europe",
        gpu: "H100",
        status: "unknown",
      }),
    ),
    ["eu-h100"],
  );
  assert.deepEqual(
    filterAvailability(items, {region: "Europe", status: "unavailable"}),
    [],
  );
  assert.deepEqual(filterAvailability(items, {region: "Missing region"}), []);
  assert.deepEqual(filterAvailability(items, {region: "Euro"}), []);
  assert.deepEqual(filterAvailability(items, {gpu: "H10"}), []);
});

test("supports blank filters and case insensitive substring searches", () => {
  const items = fixtureItems();
  const ids = (result: readonly AvailabilityItem[]) =>
    result.map((item) => item.id);

  assert.deepEqual(
    filterAvailability(items, {
      region: "",
      gpu: "",
      status: "all",
      query: "",
    }),
    items,
  );
  assert.deepEqual(
    filterAvailability(items, {region: "  ", gpu: "\t", query: " \n"}),
    items,
  );
  assert.deepEqual(
    ids(filterAvailability(items, {region: " eUrOpE ", gpu: " h100 "})),
    ["eu-h100"],
  );
  assert.deepEqual(ids(filterAvailability(items, {query: "eUrOp"})), [
    "eu-a100",
    "eu-h100",
  ]);
  assert.deepEqual(ids(filterAvailability(items, {query: "a100"})), [
    "eu-a100",
    "us-a100",
  ]);
  assert.deepEqual(ids(filterAvailability(items, {query: " MeDiUm "})), [
    "eu-h100",
  ]);
  assert.deepEqual(
    ids(filterAvailability(items, {query: "LARGE", status: "available"})),
    ["us-a100"],
  );
  assert.deepEqual(filterAvailability(items, {query: "no matching VM"}), []);
});

test("summarizes all stock states and filtered results independently", () => {
  const items = fixtureItems();
  assert.deepEqual(summarizeAvailability(items), {
    total: 4,
    available: 2,
    unavailable: 1,
    unknown: 1,
  });
  assert.deepEqual(
    summarizeAvailability(filterAvailability(items, {region: "Europe"})),
    {
      total: 2,
      available: 1,
      unavailable: 0,
      unknown: 1,
    },
  );
  assert.deepEqual(
    summarizeAvailability(filterAvailability(items, {status: "unknown"})),
    {
      total: 1,
      available: 0,
      unavailable: 0,
      unknown: 1,
    },
  );
});

test("derives unique region and GPU filter options without changing input", () => {
  const items = fixtureItems();
  const before = items.map((item) => ({...item}));

  const options = getAvailabilityFilterOptions(items);
  assert.deepEqual(options.regions, ["Europe", "US"]);
  assert.deepEqual(options.gpus, ["A100", "H100"]);
  assert.equal(options.regions.length, 2);
  assert.equal(options.gpus.length, 2);

  const filtered = filterAvailability(items, {region: "Europe"});
  assert.notEqual(filtered, items);
  summarizeAvailability(items);
  assert.deepEqual(items, before);
  assert.deepEqual(getAvailabilityFilterOptions(items), options);
});