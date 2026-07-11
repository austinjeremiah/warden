import { EventType } from '@croo-network/sdk';
import { required } from '../shared/env.js';
import { makeClient } from '../shared/client.js';

/**
 * DRY-RUN price discovery — ZERO funds, ZERO payments.
 * The Buyer negotiates Provider A; Provider A accepts -> an Order is created
 * on-chain (gas sponsored, no USDC). We read the real price + feeAmount +
 * paymentToken off the created order and exit WITHOUT paying. The order simply
 * expires. Requires Provider A to be running (npm run providerA).
 */
async function main() {
  const buyerKey = required('BUYER_API_KEY');
  const serviceId = required('PROVIDER_A_SERVICE_ID');
  const { client, log } = makeClient(buyerKey, 'BUYER');

  const stream = await client.connectWebSocket();
  log.info('DRY RUN: negotiating Provider A to read on-chain terms (NO payment will be made)...');

  stream.on(EventType.OrderCreated, async (e) => {
    try {
      const order = await client.getOrder(e.order_id!);
      log.info('✅ Order created (UNPAID). Real on-chain terms:');
      console.log(
        JSON.stringify(
          {
            orderId: order.orderId,
            price: order.price,
            feeAmount: order.feeAmount ?? '(none)',
            paymentToken: order.paymentToken,
            requesterWallet: order.requesterWalletAddress,
            providerWallet: order.providerWalletAddress,
            status: order.status,
          },
          null,
          2,
        ),
      );
      log.info('NOT paying. Order will expire on its own. No funds moved.');
    } catch (err) {
      log.error('getOrder failed:', (err as Error).message);
    } finally {
      stream.close();
      process.exit(0);
    }
  });

  const neg = await client.negotiateOrder({
    serviceId,
    requirements: JSON.stringify({ note: 'DRY-RUN price discovery only — no payment expected' }),
  });
  log.info(`negotiation ${neg.negotiationId} opened; waiting for Provider A to accept...`);

  setTimeout(() => {
    log.warn('timed out waiting for OrderCreated (is Provider A running?).');
    stream.close();
    process.exit(1);
  }, 25000);
}

main().catch((err) => {
  console.error('DISCOVER FAILED:', err);
  process.exit(1);
});
