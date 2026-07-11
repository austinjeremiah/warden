import { AgentClient } from '@croo-network/sdk';
import { crooEndpoints } from './env.js';
import { makeLogger, Logger } from './logger.js';

/**
 * Builds a single long-lived AgentClient for one agent identity.
 *
 * CRITICAL (Risk #2): exactly ONE AgentClient + ONE connectWebSocket() per
 * API key, for the whole life of the process. A second WS on the same key gets
 * booted with close code 1008. Each of our 4 processes (warden, providerA,
 * providerB, buyer) uses its own key, so they never collide with each other.
 */
export function makeClient(sdkKey: string, tag: string): { client: AgentClient; log: Logger } {
  const log = makeLogger(tag);

  // The SDK logs its own internal chatter (websocket connecting, received
  // message, order paid, ...) at info level. Route that to debug so the demo
  // terminal only shows Warden's own narrative. Warnings/errors still surface.
  // Run with DEBUG=1 to see the raw SDK/protocol traffic.
  const sdkLogger: Logger = {
    info: (m, ...a) => log.debug(m, ...a),
    debug: (m, ...a) => log.debug(m, ...a),
    warn: (m, ...a) => log.warn(m, ...a),
    error: (m, ...a) => log.error(m, ...a),
  };

  const client = new AgentClient(
    {
      baseURL: crooEndpoints.baseURL,
      wsURL: crooEndpoints.wsURL,
      rpcURL: crooEndpoints.rpcURL,
      logger: sdkLogger,
    },
    sdkKey,
  );
  return { client, log };
}
