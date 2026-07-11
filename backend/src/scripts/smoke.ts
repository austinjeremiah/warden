import { required } from '../shared/env.js';
import { makeClient } from '../shared/client.js';

/**
 * Phase 3 connectivity smoke test.
 * Connects as Warden, opens the WebSocket, logs any event, then exits.
 * Confirms: API key valid, endpoints reachable, agent flips to `online`.
 *
 * Run:  npm run smoke
 * Safe: read-only, no funds, auto-exits after 8s. Kill any other Warden
 * process first (one WS per key).
 */
async function main() {
  const key = required('CROO_API_KEY');
  const { client, log } = makeClient(key, 'SMOKE');

  log.info('connecting websocket...');
  const stream = await client.connectWebSocket();
  log.info('websocket connected — Warden should now show ONLINE in the dashboard');

  stream.onAny((e) => log.info(`event: ${e.type}`, JSON.stringify(e)));

  // Sanity: list our own orders (proves REST auth works too)
  try {
    const orders = await client.listOrders({ pageSize: 5 });
    log.info(`REST ok — listOrders returned ${orders.length} order(s)`);
  } catch (err) {
    log.warn('listOrders failed (non-fatal for smoke):', (err as Error).message);
  }

  setTimeout(() => {
    log.info('smoke done, closing.');
    stream.close();
    process.exit(0);
  }, 8000);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
