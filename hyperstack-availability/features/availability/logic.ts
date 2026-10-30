/**
 * Pure availability contracts and derivations.
 *
 * This module deliberately does not assume a Hyperstack wire format. The service
 * must map its verified provider response into the normalized { items } envelope
 * below, then validate it before returning data to the UI.
 *
 * Stock evidence must describe capacity to launch the represented VM flavor.
 * A GPU count or the number of already-running VMs is not stock evidence.
 */

export type AvailabilityStatus = "available" | "unavailable" | "unknown";

export interface StockEvidence {
  /** Nonnegative integer count of launchable VMs, if explicitly reported. */
  readonly availableCount?: number | null;
  /** Explicit provider confirmation that this VM flavor is launchable. */
  readonly isAvailable?: boolean | null;
}

export interface AvailabilityItem {
  /** Stable identifier supplied by the service adapter. */
  readonly id: string;
  readonly region: string;
  readonly gpu: string;
  readonly flavor: string;
  readonly availableCount: number | null;
  readonly isAvailable: boolean | null;
  readonly status: AvailabilityStatus;
}

export interface AvailabilityResponse {
  readonly items: readonly AvailabilityItem[];
}

export interface AvailabilitySnapshot extends AvailabilityResponse {
  /** ISO timestamp recorded by the service after a successful validated check. */
  readonly checkedAt: string;
}

export interface AvailabilityFilters {
  /** Omitted or blank values match every region/GPU. */
  readonly region?: string;
  readonly gpu?: string;
  readonly status?: AvailabilityStatus | "all";
  /** Case-insensitive substring search across region, GPU and flavor. */
  readonly query?: string;
}

export interface AvailabilitySummary {
  readonly total: number;
  readonly available: number;
  readonly unavailable: number;
  readonly unknown: number;
}

export interface AvailabilityFilterOptions {
  readonly regions: readonly string[];
  readonly gpus: readonly string[];
}

export interface AvailabilityValidationIssue {
  /** A structural path only; never contains rejected provider values. */
  readonly path: string;
  readonly message: string;
}

export type AvailabilityValidationResult =
  | {
      readonly valid: true;
      readonly data: AvailabilityResponse;
    }
  | {
      readonly valid: false;
      readonly issues: readonly AvailabilityValidationIssue[];
    };

export const AVAILABILITY_STATUS_LABELS: Readonly<
  Record<AvailabilityStatus, string>
> = {
  available: "Available",
  unavailable: "Out of stock",
  unknown: "Availability unknown",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStockCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/**
 * Never infer availability from a flavor's existence alone. Missing, malformed
 * or contradictory evidence is unknown, including zero stock paired with true.
 */
export function classifyAvailability(
  evidence: StockEvidence,
): AvailabilityStatus {
  const count: unknown = evidence.availableCount;
  const flag: unknown = evidence.isAvailable;

  if (count !== undefined && count !== null && !isStockCount(count)) {
    return "unknown";
  }
  if (flag !== undefined && flag !== null && typeof flag !== "boolean") {
    return "unknown";
  }

  const countStatus: AvailabilityStatus =
    isStockCount(count)
      ? count > 0
        ? "available"
        : "unavailable"
      : "unknown";

  const flagStatus: AvailabilityStatus =
    typeof flag === "boolean"
      ? flag
        ? "available"
        : "unavailable"
      : "unknown";

  if (
    countStatus !== "unknown" &&
    flagStatus !== "unknown" &&
    countStatus !== flagStatus
  ) {
    return "unknown";
  }
  return countStatus !== "unknown" ? countStatus : flagStatus;
}

/**
 * Validates the service adapter's normalized envelope, not an undocumented
 * provider response. Required row fields are id, region, gpu and flavor.
 *
 * Missing or null stock evidence is accepted as unknown. Malformed stock
 * evidence rejects the entire response rather than returning partial stock.
 * Contradictory, otherwise well-formed evidence remains unknown.
 *
 * Invalid row identity or envelope structure rejects the entire response.
 * Unknown fields are discarded; raw responses and credentials are never echoed.
 */
export function validateAvailabilityResponse(
  input: unknown,
): AvailabilityValidationResult {
  if (!isRecord(input) || !Array.isArray(input.items)) {
    return {
      valid: false,
      issues: [
        {
          path: "items",
          message: "Expected an availability items array.",
        },
      ],
    };
  }

  const items: AvailabilityItem[] = [];
  const issues: AvailabilityValidationIssue[] = [];
  const identifiers = new Set<string>();

  for (let index = 0; index < input.items.length; index += 1) {
    const row: unknown = input.items[index];
    const path = `items[${index}]`;

    if (!isRecord(row)) {
      issues.push({ path, message: "Expected an availability item object." });
      continue;
    }

    const id = readText(row.id);
    const region = readText(row.region);
    const gpu = readText(row.gpu);
    const flavor = readText(row.flavor);

    for (const field of ["id", "region", "gpu", "flavor"] as const) {
      if (readText(row[field]) === null) {
        issues.push({
          path: `${path}.${field}`,
          message: "Expected a nonempty string.",
        });
      }
    }

    if (id === null || region === null || gpu === null || flavor === null) {
      continue;
    }

    if (identifiers.has(id)) {
      issues.push({
        path: `${path}.id`,
        message: "Availability item identifiers must be unique.",
      });
      continue;
    }
    identifiers.add(id);

    const countValid =
      row.availableCount === undefined ||
      row.availableCount === null ||
      isStockCount(row.availableCount);
    const flagValid =
      row.isAvailable === undefined ||
      row.isAvailable === null ||
      typeof row.isAvailable === "boolean";

    if (!countValid) {
      issues.push({
        path: `${path}.availableCount`,
        message: "Expected a nonnegative safe integer, null or omitted count.",
      });
    }
    if (!flagValid) {
      issues.push({
        path: `${path}.isAvailable`,
        message: "Expected a boolean, null or omitted availability flag.",
      });
    }
    if (!countValid || !flagValid) {
      continue;
    }

    const availableCount = isStockCount(row.availableCount)
      ? row.availableCount
      : null;
    const isAvailable = typeof row.isAvailable === "boolean"
      ? row.isAvailable
      : null;

    items.push({
      id,
      region,
      gpu,
      flavor,
      availableCount,
      isAvailable,
      status: classifyAvailability({ availableCount, isAvailable }),
    });
  }

  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, data: { items } };
}

function normalizeFilter(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Preserves input ordering and does not mutate the source collection. */
export function filterAvailability(
  items: readonly AvailabilityItem[],
  filters: AvailabilityFilters = {},
): AvailabilityItem[] {
  const region = normalizeFilter(filters.region);
  const gpu = normalizeFilter(filters.gpu);
  const query = normalizeFilter(filters.query);

  return items.filter((item) => {
    if (region && item.region.toLowerCase() !== region) return false;
    if (gpu && item.gpu.toLowerCase() !== gpu) return false;
    if (
      filters.status !== undefined &&
      filters.status !== "all" &&
      item.status !== filters.status
    ) {
      return false;
    }
    return (
      !query ||
      [item.region, item.gpu, item.flavor].some((value) =>
        value.toLowerCase().includes(query),
      )
    );
  });
}

/** Counts VM flavor/region options, rather than summing VM stock quantities. */
export function summarizeAvailability(
  items: readonly AvailabilityItem[],
): AvailabilitySummary {
  let available = 0;
  let unavailable = 0;
  let unknown = 0;

  for (const item of items) {
    switch (item.status) {
      case "available":
        available += 1;
        break;
      case "unavailable":
        unavailable += 1;
        break;
      default:
        unknown += 1;
    }
  }

  return { total: items.length, available, unavailable, unknown };
}

/** Derive choices from the full snapshot so filtering cannot erase choices. */
export function getAvailabilityFilterOptions(
  items: readonly AvailabilityItem[],
): AvailabilityFilterOptions {
  return {
    regions: Array.from(new Set(items.map((item) => item.region))).sort(),
    gpus: Array.from(new Set(items.map((item) => item.gpu))).sort(),
  };
}