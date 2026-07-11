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
  const client = new AgentClient(
    {
      baseURL: crooEndpoints.baseURL,
      wsURL: crooEndpoints.wsURL,
      rpcURL: crooEndpoints.rpcURL,
      logger: log,
    },
    sdkKey,
  );
  return { client, log };
}
