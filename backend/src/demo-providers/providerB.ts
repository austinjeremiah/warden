import { runProvider } from './providerBase.js';
import { optional } from '../shared/env.js';

/**
 * Demo Target Provider B — used to demonstrate the BAD-PATH on-chain.
 *
 * FORCE_BAD_OUTPUT is a DEMO TOGGLE (default true here). When on, this provider
 * returns a real but off-topic delivery so Warden's quality gate rejects it and
 * the buyer is refunded — every transaction stays genuinely on-chain; only the
 * content is an honest test fixture, never a faked log. Set FORCE_BAD_OUTPUT=false
 * to make Provider B behave like a normal good provider.
 * Run: npm run providerB
 */
const forceBad = optional('FORCE_BAD_OUTPUT', 'true').toLowerCase() !== 'false';

runProvider({ tag: 'PROVIDER-B', keyEnv: 'PROVIDER_B_API_KEY', forceBad }).catch((err) => {
  console.error('PROVIDER-B FAILED:', err);
  process.exit(1);
});
