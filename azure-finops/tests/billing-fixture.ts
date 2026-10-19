import { CostReadCoordinator } from "../providers/cost-policy.ts";
/** Fixtures exercise response semantics without real-time Azure pacing. */
export const fastBilling = () =>
  new CostReadCoordinator({ spacingMs: 0, retries: 0, jitter: () => 0 });
