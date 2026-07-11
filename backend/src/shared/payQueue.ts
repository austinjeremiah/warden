import PQueue from 'p-queue';

/**
 * Nonce-safety guard (Risk #3 in the build spec).
 *
 * Every on-chain write that spends from an agent's AA wallet — chiefly
 * `payOrder` — must be serialized. Concurrent pay txs from the same wallet
 * collide on the account nonce and fail with NONCE_ERROR / PIMLICO_ERROR.
 *
 * We wrap all such calls in a single-worker queue (concurrency: 1) so only one
 * wallet-spending tx is ever in flight. Extra jobs queue up and drain in order.
 */
const payMutex = new PQueue({ concurrency: 1 });

export function enqueuePay<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return payMutex.add(async () => fn()) as Promise<T>;
}

export function payQueueSize(): number {
  return payMutex.size + payMutex.pending;
}
