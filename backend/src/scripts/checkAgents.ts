import { required, optional } from '../shared/env.js';
import { makeClient } from '../shared/client.js';

/**
 * Read-only preflight: connects each of the 4 agents with its own key to prove
 * the key is valid and the WS/REST auth works. No funds, no orders. Connects
 * sequentially and closes each before the next so we never hold a WS open on a
 * key we're about to reuse for the real run.
 *
 * Run: npx tsx src/scripts/checkAgents.ts
 */
const AGENTS: { tag: string; keyEnv: string }[] = [
  { tag: 'WARDEN', keyEnv: 'CROO_API_KEY' },
  { tag: 'PROVIDER-A', keyEnv: 'PROVIDER_A_API_KEY' },
  { tag: 'PROVIDER-B', keyEnv: 'PROVIDER_B_API_KEY' },
  { tag: 'BUYER', keyEnv: 'BUYER_API_KEY' },
];

async function checkOne(tag: string, keyEnv: string): Promise<boolean> {
  const key = optional(keyEnv);
  if (!key) {
    console.error(`❌ ${tag}: missing ${keyEnv}`);
    return false;
  }
  const { client, log } = makeClient(key, tag);
  try {
    const stream = await client.connectWebSocket();
    await new Promise((r) => setTimeout(r, 1500));
    const wsErr = stream.err();
    // REST auth probe (role required per API)
    let restOk = false;
    try {
      const role = tag === 'BUYER' ? 'buyer' : 'provider';
      await client.listOrders({ role, pageSize: 1 });
      restOk = true;
    } catch (e) {
      log.warn(`REST probe: ${(e as Error).message}`);
    }
    stream.close();
    if (wsErr) {
      console.error(`❌ ${tag}: WS error ${wsErr.message}`);
      return false;
    }
    log.info(`✅ ${tag}: WS connected${restOk ? ' + REST auth ok' : ''}`);
    return true;
  } catch (err) {
    console.error(`❌ ${tag}: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  required('CROO_API_KEY'); // fail early if .env not loaded at all
  console.log('--- Warden preflight: connecting all 4 agents (read-only) ---');
  const results: boolean[] = [];
  for (const a of AGENTS) {
    results.push(await checkOne(a.tag, a.keyEnv));
    await new Promise((r) => setTimeout(r, 500));
  }
  const ok = results.filter(Boolean).length;
  console.log(`\n--- ${ok}/${AGENTS.length} agents connected ---`);
  process.exit(ok === AGENTS.length ? 0 : 1);
}

main().catch((err) => {
  console.error('PREFLIGHT FAILED:', err);
  process.exit(1);
});
