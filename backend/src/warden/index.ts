import { EventType } from '@croo-network/sdk';
import { required } from '../shared/env.js';
import { makeClient } from '../shared/client.js';
import { enqueuePay } from '../shared/payQueue.js';
import { JobStore, Job } from './jobStore.js';
import { Policy } from './policies.js';
import { runQualityGate, buildPolicyBundle } from './qualityGate.js';
import { settle } from './settlement.js';

/**
 * WARDEN — CAP quality-gated escrow proxy.
 *
 * One agent, one wallet, one API key, ONE WebSocket. It plays Provider on
 * Order A (buyer -> Warden) and Requester on Order B (Warden -> real provider)
 * from the same process, routing every event to its job by ID.
 *
 *   NegotiationCreated  -> (Warden is provider on A) validate + acceptNegotiation
 *   OrderPaid           -> (buyer funded escrow A)   hire target provider (negotiate B)
 *   OrderCreated        -> (provider accepted B)      queue-guarded payOrder(B)
 *   OrderCompleted      -> (provider delivered B)      quality gate -> settle A
 *   OrderExpired/Rejected on B -> reject A (can't deliver) so buyer is refunded
 */

interface BuyerRequirements {
  targetServiceId: string;
  input: string;
  policies: Policy[]; // resolved bundle Warden enforces before release
}

function parseBuyerRequirements(raw: string): BuyerRequirements | { error: string } {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { error: 'Requirements must be a JSON object with targetServiceId, input, and policies[] (or acceptanceCriteria).' };
  }
  if (!obj || typeof obj !== 'object') return { error: 'Requirements JSON must be an object.' };
  if (!obj.targetServiceId || typeof obj.targetServiceId !== 'string')
    return { error: 'Missing "targetServiceId" (the CAP serviceId to verify work from).' };
  const input = typeof obj.input === 'string' ? obj.input : typeof obj.task === 'string' ? obj.task : '';
  if (!input) return { error: 'Missing "input" (the task to send the target provider).' };

  const explicit = Array.isArray(obj.policies) ? (obj.policies as Policy[]) : undefined;
  if ((!explicit || explicit.length === 0) && !obj.acceptanceCriteria) {
    return { error: 'Provide either "policies" (a bundle of quality policies) or "acceptanceCriteria".' };
  }
  const policies = buildPolicyBundle({
    policies: explicit,
    acceptanceCriteria: typeof obj.acceptanceCriteria === 'string' ? obj.acceptanceCriteria : undefined,
    requiredFields: Array.isArray(obj.requiredFields) ? obj.requiredFields.map(String) : undefined,
  });
  return { targetServiceId: obj.targetServiceId, input, policies };
}

async function main() {
  const key = required('CROO_API_KEY');
  const wardenServiceId = required('WARDEN_SERVICE_ID');
  const { client, log } = makeClient(key, 'WARDEN');
  const jobs = new JobStore();

  const stream = await client.connectWebSocket();
  log.info(`online. serviceId=${wardenServiceId}. Playing Provider(A) + Requester(B) on one connection.`);

  // ── PROVIDER SIDE (Order A) ───────────────────────────────────────────────
  // A buyer wants Warden's service. Validate their requirements, then accept.
  stream.on(EventType.NegotiationCreated, async (e) => {
    const negId = e.negotiation_id!;
    try {
      const neg = await client.getNegotiation(negId);
      // Only handle negotiations for OUR service (defensive).
      if (neg.serviceId !== wardenServiceId) {
        log.debug(`ignoring negotiation ${negId} for other service ${neg.serviceId}`);
        return;
      }
      const parsed = parseBuyerRequirements(neg.requirements);
      if ('error' in parsed) {
        log.warn(`rejecting negotiation ${negId}: ${parsed.error}`);
        await client.rejectNegotiation(negId, parsed.error);
        return;
      }
      const result = await client.acceptNegotiation(negId);
      const job: Job = {
        orderAId: result.order.orderId,
        negotiationAId: negId,
        buyerInput: parsed.input,
        targetServiceId: parsed.targetServiceId,
        policies: parsed.policies,
        status: 'accepted',
        createdAt: Date.now(),
      };
      jobs.create(job);
      log.info(
        `accepted Order A ${job.orderAId} (target=${job.targetServiceId}, policies=[${job.policies.map((p) => p.type).join(', ')}]). Awaiting buyer payment.`,
      );
    } catch (err) {
      log.error(`negotiation ${negId} handling failed:`, (err as Error).message);
    }
  });

  // Buyer funded escrow A -> hire the real provider (create + negotiate Order B).
  stream.on(EventType.OrderPaid, async (e) => {
    const job = jobs.byOrderAId(e.order_id!);
    if (!job) {
      log.debug(`OrderPaid ${e.order_id} not an Order A of ours; ignoring.`);
      return;
    }
    try {
      job.status = 'buyer_paid';
      log.info(`Order A ${job.orderAId} PAID by buyer. Hiring target provider ${job.targetServiceId}...`);
      const negB = await client.negotiateOrder({
        serviceId: job.targetServiceId,
        // CAP requires `requirements` to be valid JSON — wrap the task as an object.
        requirements: JSON.stringify({ input: job.buyerInput }),
      });
      jobs.setNegotiationB(job, negB.negotiationId);
      log.info(`opened Order B negotiation ${negB.negotiationId} with provider.`);
    } catch (err) {
      log.error(`failed to hire provider for job ${job.orderAId}:`, (err as Error).message);
      await failJob(client, log, job, `Warden could not hire the target provider: ${(err as Error).message}`);
    }
  });

  // ── REQUESTER SIDE (Order B) ──────────────────────────────────────────────
  // Provider accepted -> Order B created on-chain -> pay it (queue-guarded, Risk #3).
  stream.on(EventType.OrderCreated, async (e) => {
    const job = e.negotiation_id ? jobs.byNegotiationBId(e.negotiation_id) : undefined;
    if (!job) {
      log.debug(`OrderCreated ${e.order_id} not our Order B; ignoring.`);
      return;
    }
    jobs.setOrderB(job, e.order_id!);
    job.status = 'b_created';
    log.info(`Order B ${e.order_id} created. Queuing payOrder...`);
    try {
      const res = await enqueuePay(job.orderBId!, () => client.payOrder(job.orderBId!));
      job.status = 'b_paid';
      log.info(`paid Order B ${job.orderBId} (tx ${res.txHash}). Awaiting provider delivery.`);
    } catch (err) {
      log.error(`payOrder(B ${job.orderBId}) failed:`, (err as Error).message);
      await failJob(client, log, job, `Warden could not pay the target provider: ${(err as Error).message}`);
    }
  });

  // Provider delivered Order B -> fetch, run quality gate, settle Order A.
  stream.on(EventType.OrderCompleted, async (e) => {
    const job = jobs.byOrderBId(e.order_id!);
    if (!job) {
      log.debug(`OrderCompleted ${e.order_id} not our Order B; ignoring.`);
      return;
    }
    try {
      job.status = 'validating';
      const delivery = await client.getDelivery(job.orderBId!);
      log.info(`Order B ${job.orderBId} delivered. Enforcing ${job.policies.length} quality policies...`);
      const gate = await runQualityGate({
        deliverableText: delivery.deliverableText,
        deliverableType: delivery.deliverableType,
        buyerInput: job.buyerInput,
        policies: job.policies,
      });
      log.info(`gate [policy:${gate.policy}] -> ${gate.pass ? 'PASS' : 'FAIL'}: ${gate.reason}`);
      await settle(client, log, job, delivery.deliverableText, gate);
    } catch (err) {
      log.error(`settlement failed for job ${job.orderAId}:`, (err as Error).message);
      await failJob(client, log, job, `Warden settlement error: ${(err as Error).message}`);
    }
  });

  // If Order B never delivers (expired) or provider rejects it, Warden can't
  // deliver Order A -> reject A so the buyer is refunded.
  const handleBFailure = (label: string) => async (e: { order_id?: string; reason?: string }) => {
    const job = jobs.byOrderBId(e.order_id!);
    if (!job) return;
    log.warn(`Order B ${job.orderBId} ${label} (${e.reason ?? 'n/a'}). Rejecting Order A to refund buyer.`);
    await failJob(client, log, job, `Target provider ${label}: ${e.reason ?? 'no delivery'}`);
  };
  stream.on(EventType.OrderExpired, handleBFailure('expired'));
  stream.on(EventType.OrderRejected, handleBFailure('rejected'));

  process.on('SIGINT', () => {
    log.info('shutting down.');
    stream.close();
    process.exit(0);
  });
}

/** Reject Order A (refund buyer) when a job can't be completed. Safe if already settled. */
async function failJob(client: any, log: any, job: Job, reason: string): Promise<void> {
  if (job.status === 'settled_fail' || job.status === 'settled_pass') return;
  try {
    await client.rejectOrder(job.orderAId, reason);
    job.status = 'settled_fail';
    log.info(`AUDIT FAIL  orderA=${job.orderAId} orderB=${job.orderBId ?? '-'} reason="${reason}" action=rejected Order A (buyer refunded)`);
  } catch (err) {
    job.status = 'error';
    log.error(`failed to reject Order A ${job.orderAId}:`, (err as Error).message);
  }
}

main().catch((err) => {
  console.error('WARDEN FAILED:', err);
  process.exit(1);
});
