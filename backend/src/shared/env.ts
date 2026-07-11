import 'dotenv/config';

/** Read a required env var or throw a clear error. */
export function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name} (check backend/.env)`);
  }
  return v.trim();
}

/** Read an optional env var with a fallback. */
export function optional(name: string, fallback = ''): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

/** Shared CROO endpoints (same for every agent/process). */
export const crooEndpoints = {
  baseURL: optional('CROO_API_URL', 'https://api.croo.network'),
  wsURL: optional('CROO_WS_URL', 'wss://api.croo.network/ws'),
  rpcURL: optional('CROO_RPC_URL', 'https://mainnet.base.org'),
};
