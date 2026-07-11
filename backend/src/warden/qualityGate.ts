import { Policy, PolicyContext, GateResult, evaluatePolicies } from './policies.js';

export type { GateResult } from './policies.js';

/**
 * Quality gate = run the buyer's policy bundle against the delivery.
 *
 * The buyer may attach an explicit `policies[]` bundle to the order. For
 * backward compatibility (and convenience), a bundle can also be synthesized
 * from the older `acceptanceCriteria` + `requiredFields` fields. Either way a
 * baseline `no_placeholder` guard is always prepended so junk never settles.
 */
export function buildPolicyBundle(input: {
  policies?: Policy[];
  acceptanceCriteria?: string;
  requiredFields?: string[];
}): Policy[] {
  const baseline: Policy = { type: 'no_placeholder' };

  if (input.policies && input.policies.length > 0) {
    return [baseline, ...input.policies];
  }

  // Legacy synthesis path.
  const synthesized: Policy[] = [baseline, { type: 'min_length', min: 10 }];
  if (input.requiredFields && input.requiredFields.length > 0) {
    synthesized.push({ type: 'json_fields', fields: input.requiredFields });
  }
  if (input.acceptanceCriteria) {
    synthesized.push({ type: 'semantic', criteria: input.acceptanceCriteria });
  }
  return synthesized;
}

export async function runQualityGate(input: {
  deliverableText: string;
  deliverableType: string;
  buyerInput: string;
  policies: Policy[];
}): Promise<GateResult> {
  const ctx: PolicyContext = {
    deliverableText: input.deliverableText,
    deliverableType: input.deliverableType,
    buyerInput: input.buyerInput,
  };
  return evaluatePolicies(input.policies, ctx);
}
