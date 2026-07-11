import { runProvider } from './providerBase.js';

/**
 * Demo Target Provider A — the GOOD-PATH provider.
 * A real, minimal text-processing service (Groq-backed). Disclosed in the
 * README as our own seed agent. Run: npm run providerA
 */
runProvider({ tag: 'PROVIDER-A', keyEnv: 'PROVIDER_A_API_KEY', forceBad: false }).catch((err) => {
  console.error('PROVIDER-A FAILED:', err);
  process.exit(1);
});
