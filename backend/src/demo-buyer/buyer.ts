import { EventType } from '@croo-network/sdk';
import { required } from '../shared/env.js';
import { makeClient } from '../shared/client.js';

/**
 * Demo Buyer — a Requester that hires Warden's "Verified Delivery Gateway".
 *
 * Usage:
 *   npm run buyer            # GOOD  (text)  -> Provider A, expect verified delivery
 *   npm run buyer -- bad     # BAD   (text)  -> Provider B (forced-bad), expect refund
 *   npm run buyer -- code    # GOOD  (python code) -> Provider A, code passes sandbox tests
 *   npm run buyer -- codebad # BAD   (python code) -> Provider B (forced-bad), tests fail, refund
 *   npm run buyer -- codejs  # GOOD  (js code)     -> Provider A, JS passes node sandbox tests
 *
 * The buyer only ever touches Order A: negotiate -> pay -> receive result OR refund.
 */

const SAMPLE_TEXT =
  'The James Webb Space Telescope, launched in December 2021, is the largest and most powerful space telescope ever built. ' +
  'Positioned at the second Lagrange point about 1.5 million kilometers from Earth, it observes the universe primarily in ' +
  'infrared light, allowing it to peer through cosmic dust and study the earliest galaxies formed after the Big Bang.';

// Buyer's definition of done, as executable tests run in Warden's sandbox.
const PALINDROME_TESTS = [
  'def test_basic(): assert is_palindrome("racecar") == True',
  'def test_phrase(): assert is_palindrome("A man, a plan, a canal: Panama") == True',
  'def test_negative(): assert is_palindrome("hello") == False',
  'def test_empty(): assert is_palindrome("") == True',
  'def test_case(): assert is_palindrome("RaceCar") == True',
].join('\n');

// Same acceptance criteria expressed as JavaScript tests (run in the node sandbox).
const JS_PALINDROME_TESTS = [
  'function test_basic(){ assert.strictEqual(isPalindrome("racecar"), true) }',
  'function test_phrase(){ assert.strictEqual(isPalindrome("A man, a plan, a canal: Panama"), true) }',
  'function test_negative(){ assert.strictEqual(isPalindrome("hello"), false) }',
  'function test_empty(){ assert.strictEqual(isPalindrome(""), true) }',
  'function test_case(){ assert.strictEqual(isPalindrome("RaceCar"), true) }',
].join('\n');

/** Returns { input, policies } for the chosen demo mode. */
function buildTask(mode: string) {
  if (mode === 'codejs' || mode === 'codejsbad') {
    return {
      input:
        'Write a JavaScript function `isPalindrome(s)` that returns true if the string reads the same ' +
        'forwards and backwards, ignoring case and all non-alphanumeric characters, else false. ' +
        'Return only the function definition, no module.exports.',
      policies: [
        {
          type: 'code_tests',
          language: 'javascript',
          tests: JS_PALINDROME_TESTS,
        },
      ],
    };
  }
  if (mode === 'code' || mode === 'codebad') {
    return {
      input:
        'Write a Python function `is_palindrome(s)` that returns True if the string reads the same ' +
        'forwards and backwards, ignoring case and all non-alphanumeric characters, else False. ' +
        'Return only the function definition.',
      policies: [
        {
          type: 'code_tests',
          language: 'python',
          tests: PALINDROME_TESTS,
        },
      ],
    };
  }
  // text modes
  return {
    input: `Summarize the following text in one clear sentence:\n\n${SAMPLE_TEXT}`,
    policies: [
      { type: 'min_length', min: 20 },
      { type: 'contains', value: 'Webb' },
      { type: 'semantic', criteria: 'A one-sentence, on-topic, factual summary of the James Webb Space Telescope.' },
    ],
  };
}

async function main() {
  const mode = (process.argv[2] || 'good').toLowerCase();
  const wardenServiceId = required('WARDEN_SERVICE_ID');
  const badMode = mode === 'bad' || mode === 'codebad' || mode === 'codejsbad';
  const targetServiceId = badMode
    ? required('PROVIDER_B_SERVICE_ID')
    : required('PROVIDER_A_SERVICE_ID');

  const key = required('BUYER_API_KEY');
  const { client, log } = makeClient(key, 'BUYER');

  // Programmable quality policies attached to the order. Warden releases escrow
  // only if EVERY policy passes.
  const task = buildTask(mode);
  const requirements = JSON.stringify({ targetServiceId, input: task.input, policies: task.policies });

  // Track ONLY our own negotiation/order so stale or unrelated orders on the
  // same WS are ignored (a naive "act on any order" buyer double-pays leftovers).
  let myNegotiationId = '';
  let myOrderAId = '';

  const stream = await client.connectWebSocket();
  log.info(`online. mode=${mode.toUpperCase()} -> target=${targetServiceId}. Hiring Warden...`);

  // Pay Order A when Warden accepts OUR negotiation and creates the order.
  stream.on(EventType.OrderCreated, async (e) => {
    if (e.negotiation_id !== myNegotiationId) return; // not ours
    myOrderAId = e.order_id!;
    try {
      log.info(`Order A ${myOrderAId} created by Warden. Paying escrow...`);
      const res = await client.payOrder(myOrderAId);
      log.info(`paid Order A ${myOrderAId} (tx ${res.txHash}). Waiting for verified delivery or refund...`);
    } catch (err) {
      log.error(`payOrder failed:`, (err as Error).message);
      process.exit(1);
    }
  });

  // GOOD path: Warden's gate passed and it delivered the verified result.
  stream.on(EventType.OrderCompleted, async (e) => {
    if (e.order_id !== myOrderAId) return; // not ours
    const delivery = await client.getDelivery(myOrderAId);
    log.info(`VERIFIED RESULT RECEIVED for Order A ${myOrderAId} (escrow released to Warden):`);
    log.info(`   ${delivery.deliverableText.replace(/\n/g, '\n   ')}`);
    stream.close();
    process.exit(0);
  });

  // BAD path: Warden's gate failed -> it rejected Order A -> we were refunded.
  stream.on(EventType.OrderRejected, (e) => {
    if (e.order_id !== myOrderAId) return; // not ours
    log.info(`ORDER A REJECTED by Warden -> escrow refunded to buyer. Order ${myOrderAId}`);
    log.info(`   reason: ${e.reason ?? '(see Warden logs)'}`);
    stream.close();
    process.exit(0);
  });

  const neg = await client.negotiateOrder({ serviceId: wardenServiceId, requirements });
  myNegotiationId = neg.negotiationId;
  log.info(`negotiation opened: ${myNegotiationId}. Waiting for Warden to accept + create Order A...`);

  process.on('SIGINT', () => {
    stream.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('BUYER FAILED:', err);
  process.exit(1);
});
