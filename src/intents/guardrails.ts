import { GuardrailViolationError } from "../errors.js";
import type { AgentPolicy } from "../subagents/policy.js";

export interface TransactionIntent {
  to: string;
  value: string;
  chain: string;
  data?: string;
}

/**
 * Client-side pre-flight check. Throws GuardrailViolationError
 * with a machine-readable code if any constraint fails.
 * The Vault API enforces these again server-side.
 */
export function validateIntent(
  intent: TransactionIntent,
  policy: AgentPolicy,
): void {
  if (
    policy.allowedChains.length > 0 &&
    !policy.allowedChains.includes(intent.chain)
  ) {
    throw new GuardrailViolationError(
      "CHAIN_NOT_ALLOWED",
      `Chain "${intent.chain}" is not in the allowed list: ${policy.allowedChains.join(", ")}`,
    );
  }

  if (
    policy.maxValueEth !== null &&
    parseFloat(intent.value) > parseFloat(policy.maxValueEth)
  ) {
    throw new GuardrailViolationError(
      "VALUE_EXCEEDS_CAP",
      `Transaction value ${intent.value} ETH exceeds cap of ${policy.maxValueEth} ETH`,
    );
  }

  if (
    policy.allowedAddresses.length > 0 &&
    !policy.allowedAddresses.some(
      (addr) => addr.toLowerCase() === intent.to.toLowerCase(),
    )
  ) {
    throw new GuardrailViolationError(
      "ADDRESS_NOT_ALLOWED",
      `Address "${intent.to}" is not in the allowed list`,
    );
  }
}
