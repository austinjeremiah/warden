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

  const requirements = JSON.stringify({
    targetServiceId,
    input: `Summarize the following text in one clear sentence:\n\n${SAMPLE_TEXT}`,
    acceptanceCriteria:
      'A one-sentence summary that accurately captures the main point about the James Webb Space Telescope. Must be on-topic and factual.',
  });

  const stream = await client.connectWebSocket();
  log.info(`online. mode=${mode.toUpperCase()} -> target=${targetServiceId}. Hiring Warden...`);

  // Pay Order A when Warden accepts our negotiation and the order is created.
  stream.on(EventType.OrderCreated, async (e) => {
    try {
      log.info(`Order A ${e.order_id} created by Warden. Paying escrow...`);
      const res = await client.payOrder(e.order_id!);
      log.info(`paid Order A ${e.order_id} (tx ${res.txHash}). Waiting for verified delivery or refund...`);
    } catch (err) {
      log.error(`payOrder failed:`, (err as Error).message);
      process.exit(1);
    }
  });

  // GOOD path: Warden's gate passed and it delivered the verified result.
  stream.on(EventType.OrderCompleted, async (e) => {
    const delivery = await client.getDelivery(e.order_id!);
    log.info(`✅ RECEIVED VERIFIED RESULT for Order A ${e.order_id}:`);
    log.info(`   "${delivery.deliverableText}"`);
    stream.close();
    process.exit(0);
  });

  // BAD path: Warden's gate failed -> it rejected Order A -> we were refunded.
  stream.on(EventType.OrderRejected, (e) => {
    log.info(`⛔ Order A ${e.order_id} REJECTED by Warden -> escrow refunded to buyer.`);
    log.info(`   reason: ${e.reason ?? '(see Warden logs)'}`);
    stream.close();
    process.exit(0);
  });

  const neg = await client.negotiateOrder({ serviceId: wardenServiceId, requirements });
  log.info(`negotiation opened: ${neg.negotiationId}. Waiting for Warden to accept + create Order A...`);

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('BUYER FAILED:', err);
  process.exit(1);
});
