import { buildPolicyBundle } from '../warden/qualityGate.js';
import { evaluatePolicies } from '../warden/policies.js';

/**
 * Offline proof of the policy engine — no funds, no CROO, no on-chain calls.
 * (Uses Groq only for the semantic policy.) Run: npx tsx src/scripts/testPolicies.ts
 */
const BUYER_POLICIES = [
  { type: 'min_length', min: 20 },
  { type: 'contains', value: 'Webb' },
  { type: 'semantic', criteria: 'A one-sentence, on-topic, factual summary of the James Webb Space Telescope.' },
];
const bundle = buildPolicyBundle({ policies: BUYER_POLICIES });
const buyerInput = 'Summarize in one sentence: The James Webb Space Telescope observes the universe in infrared.';

const GOOD = 'The James Webb Space Telescope is the most powerful space telescope ever built, observing the universe in infrared to study the earliest galaxies.';
const BAD = 'The weather today is partly cloudy with a gentle northwest breeze and mild temperatures through the afternoon.';
const EMPTY = '   ';
const JSONCASE = '{"summary":"Webb telescope studies infrared light from early galaxies."}';

async function run(label: string, text: string, policies = bundle) {
  const res = await evaluatePolicies(policies, { deliverableText: text, deliverableType: 'text', buyerInput });
  console.log(`${res.pass ? '✅ PASS' : '⛔ FAIL'}  [${label}] policy=${res.policy} :: ${res.reason}`);
  return res;
}

async function main() {
  console.log('--- Policy engine offline test ---');
  const good = await run('GOOD summary', GOOD);
  const bad = await run('BAD off-topic', BAD);
  const empty = await run('EMPTY', EMPTY);
  const jsonFields = await run(
    'JSON fields',
    JSONCASE,
    buildPolicyBundle({ policies: [{ type: 'json_valid' }, { type: 'json_fields', fields: ['summary'] }] }),
  );

  const ok = good.pass && !bad.pass && !empty.pass && jsonFields.pass;
  console.log(`\n--- ${ok ? 'ALL EXPECTATIONS MET ✅' : 'UNEXPECTED RESULT ❌'} ---`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
