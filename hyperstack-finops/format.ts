/** USD uses a decimal point and no grouping, independently of display locale. */
export function usd(value: number | null | undefined, rate = false): string {
  if (value == null || !Number.isFinite(value)) return "Not reported";
  return `USD ${new Intl.NumberFormat("en-US", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: rate ? 4 : 2 }).format(Object.is(value, -0) ? 0 : value)}`;
}
