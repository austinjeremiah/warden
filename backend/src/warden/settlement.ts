import { AgentClient, DeliverableType } from '@croo-network/sdk';
import { Logger } from '../shared/logger.js';
import { Job } from './jobStore.js';
import { GateResult } from './qualityGate.js';

/**
 * Settlement decision — Warden's only on-chain lever, exercised as the PROVIDER
 * on Order A (Risk #8: only the provider can reject a paid order).
 *   PASS -> deliverOrder(A): escrow A releases to Warden.
 *   FAIL -> rejectOrder(A):  escrow A auto-refunds to the buyer (CAP's paid-status
 *                            refund path). We reject immediately, not wait for SLA.
 * Every decision is logged as a single-line audit record with tx hashes — this
 * is the on-chain audit trail cited in the README/demo.
 */
export async function settle(
  client: AgentClient,
  log: Logger,
  job: Job,
  validatedContent: string,
  gate: GateResult,
): Promise<void> {
  if (gate.pass) {
    const res = await client.deliverOrder(job.orderAId, {
      deliverableType: DeliverableType.Text,
      deliverableText: validatedContent,
    });
    job.status = 'settled_pass';
    audit(log, 'PASS', job, gate, { deliverTx: res.txHash });
  } else {
    await client.rejectOrder(job.orderAId, gate.reason);
    job.status = 'settled_fail';
    audit(log, 'FAIL', job, gate, {});
  }
}

function audit(
  log: Logger,
  outcome: 'PASS' | 'FAIL',
  job: Job,
  gate: GateResult,
  tx: { deliverTx?: string },
): void {
  const record = {
    decision: outcome,
    layer: gate.layer,
    reason: gate.reason,
    orderA: job.orderAId,
    orderB: job.orderBId,
    targetServiceId: job.targetServiceId,
    deliverTx: tx.deliverTx ?? null,
  };
  const banner = outcome === 'PASS' ? '✅ AUDIT PASS' : '⛔ AUDIT FAIL';
  log.info(`${banner} ${JSON.stringify(record)}`);
}
