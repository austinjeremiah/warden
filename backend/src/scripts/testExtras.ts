import { runCodeTests } from '../warden/sandbox.js';
import { buildPolicyBundle } from '../warden/qualityGate.js';
import { evaluatePolicies } from '../warden/policies.js';

/**
 * Offline proof of the additional policy evaluators (no funds, no chain):
 *   - JavaScript sandbox (multi-language code_tests)
 *   - url_resolve (needs internet)
 *   - image_min_resolution
 * Run: npm run test:extras   (needs Docker + node:20-slim, and network for URLs)
 */

// --- JS sandbox fixtures ---
const JS_TESTS = 'function test_add(){ assert.strictEqual(add(2,3),5) }\nfunction test_neg(){ assert.strictEqual(add(-1,1),0) }';
const JS_GOOD = 'function add(a,b){ return a+b }';
const JS_BUGGY = 'function add(a,b){ return a-b }';

// --- fake PNG with a chosen width/height (image-size reads the IHDR header) ---
function fakePng(w: number, h: number): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // color type RGBA
  return 'data:image/png;base64,' + Buffer.concat([sig, ihdr]).toString('base64');
}

async function policy(label: string, policies: any[], deliverableText: string) {
  const bundle = buildPolicyBundle({ policies });
  const res = await evaluatePolicies(bundle, { deliverableText, deliverableType: 'text', buyerInput: '' });
  console.log(`${res.pass ? 'PASS' : 'FAIL'}  [${label}] policy=${res.policy} :: ${res.reason}`);
  return res;
}

async function main() {
  console.log('--- Additional evaluators offline test ---\n[1] JavaScript sandbox');
  const jsGood = await runCodeTests(JS_GOOD, JS_TESTS, 'javascript');
  console.log(`  GOOD js: ok=${jsGood.ok} passed=${JSON.stringify(jsGood.passed)} failed=${JSON.stringify(jsGood.failed)}`);
  const jsBug = await runCodeTests(JS_BUGGY, JS_TESTS, 'javascript');
  console.log(`  BUGGY js: ok=${jsBug.ok} passed=${JSON.stringify(jsBug.passed)} failed=${JSON.stringify(jsBug.failed)}`);

  console.log('\n[2] url_resolve (network)');
  const urlGood = await policy('URL good', [{ type: 'url_resolve' }], 'See https://example.com for details.');
  const urlBad = await policy('URL bad', [{ type: 'url_resolve' }], 'Source: https://no-such-domain-xyz-9271.invalid');

  console.log('\n[3] image_min_resolution');
  const imgGood = await policy('image 1024x768 >= 800x600', [{ type: 'image_min_resolution', minWidth: 800, minHeight: 600 }], fakePng(1024, 768));
  const imgBad = await policy('image 320x240 >= 800x600', [{ type: 'image_min_resolution', minWidth: 800, minHeight: 600 }], fakePng(320, 240));

  const ok = jsGood.ok && !jsBug.ok && urlGood.pass && !urlBad.pass && imgGood.pass && !imgBad.pass;
  console.log(`\n--- ${ok ? 'ALL EXPECTATIONS MET' : 'UNEXPECTED RESULT'} ---`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
