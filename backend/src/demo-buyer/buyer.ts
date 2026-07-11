import { EventType } from '@croo-network/sdk';
import { required, optional } from '../shared/env.js';
import { makeClient } from '../shared/client.js';

/**
 * Demo Buyer — a Requester that hires Warden's "Verified Delivery Gateway".
 *
 * Usage:
 *   npm run buyer            # GOOD path -> routes Warden to Provider A
 *   npm run buyer -- bad     # BAD path  -> routes Warden to Provider B (forced-bad)
 *
 * The buyer only ever touches Order A: negotiate -> pay -> receive result OR refund.
 */

const SAMPLE_TEXT =
  'The James Webb Space Telescope, launched in December 2021, is the largest and most powerful space telescope ever built. ' +
  'Positioned at the second Lagrange point about 1.5 million kilometers from Earth, it observes the universe primarily in ' +
  'infrared light, allowing it to peer through cosmic dust and study the earliest galaxies formed after the Big Bang.';

async function main() {
  const mode = (process.argv[2] || 'good').toLowerCase();
  const wardenServiceId = required('WARDEN_SERVICE_ID');
  const targetServiceId =
    mode === 'bad'
      ? required('PROVIDER_B_SERVICE_ID')
      : required('PROVIDER_A_SERVICE_ID');

  const key = required('BUYER_API_KEY');
  const { client, log } = makeClient(key, 'BUYER');

  // Programmable quality policies attached to the order. Warden releases escrow
  // only if EVERY policy passes. The off-topic bad-path delivery fails the
  // deterministic `contains "Webb"` policy AND the semantic policy.
  const requirements = JSON.stringify({
    targetServiceId,
    input: `Summarize the following text in one clear sentence:\n\n${SAMPLE_TEXT}`,
    policies: [
      { type: 'min_length', min: 20 },
      { type: 'contains', value: 'Webb' },
      {
        type: 'semantic',
        criteria:
          'A one-sentence, on-topic, factual summary of the James Webb Space Telescope.',
      },
    ],
  });

  // Track ONLY our own negotiation/order so stale or unrelated orders on the
  // same WS are ignored (a naive "act on any order" buyer double-pays leftovers).
  let myNegotiationId = '';
  let myOrderAId = '';

  const stream = await client.connectWebSocket();
  log.info(`online. mode=${mode.toUpperCase()} -> target=${targetServiceId}. Hiring Warden...`);

  // Pay Order A when Warden accepts OUR negotiation and creates the order.
  stream.on(EventType.OrderCreated, async (e) => {
    if (e.negotiation_id !== myNegotiationId) return; // not ours
    myOrderAId = e.order_id!;
    try {
      log.info(`Order A ${myOrderAId} created by Warden. Paying escrow...`);
      const res = await client.payOrder(myOrderAId);
      log.info(`paid Order A ${myOrderAId} (tx ${res.txHash}). Waiting for verified delivery or refund...`);
    } catch (err) {
      log.error(`payOrder failed:`, (err as Error).message);
      process.exit(1);
    }
  });

  // GOOD path: Warden's gate passed and it delivered the verified result.
  stream.on(EventType.OrderCompleted, async (e) => {
    if (e.order_id !== myOrderAId) return; // not ours
    const delivery = await client.getDelivery(myOrderAId);
    log.info(`✅ RECEIVED VERIFIED RESULT for Order A ${myOrderAId}:`);
    log.info(`   "${delivery.deliverableText}"`);
    stream.close();
    process.exit(0);
  });

  // BAD path: Warden's gate failed -> it rejected Order A -> we were refunded.
  stream.on(EventType.OrderRejected, (e) => {
    if (e.order_id !== myOrderAId) return; // not ours
    log.info(`⛔ Order A ${myOrderAId} REJECTED by Warden -> escrow refunded to buyer.`);
    log.info(`   reason: ${e.reason ?? '(see Warden logs)'}`);
    stream.close();
    process.exit(0);
  });

  const neg = await client.negotiateOrder({ serviceId: wardenServiceId, requirements });
  myNegotiationId = neg.negotiationId;
  log.info(`negotiation opened: ${myNegotiationId}. Waiting for Warden to accept + create Order A...`);

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('BUYER FAILED:', err);
  process.exit(1);
});
