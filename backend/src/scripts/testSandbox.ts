import { runCodeTests } from '../warden/sandbox.js';
import { buildPolicyBundle } from '../warden/qualityGate.js';
import { evaluatePolicies } from '../warden/policies.js';

/**
 * Offline proof of the hardened code_tests sandbox — no funds, no chain.
 * Requires Docker + python:3.11-slim. Run: npx tsx src/scripts/testSandbox.ts
 */
const TESTS = [
  'def test_basic(): assert is_palindrome("racecar") == True',
  'def test_phrase(): assert is_palindrome("A man, a plan, a canal: Panama") == True',
  'def test_negative(): assert is_palindrome("hello") == False',
].join('\n');

const GOOD = `import re
def is_palindrome(s):
    t = re.sub(r'[^a-z0-9]', '', s.lower())
    return t == t[::-1]`;

const BUGGY = `def is_palindrome(s):
    return s == s[::-1]  # ignores case/punctuation -> fails phrase test`;

const MALICIOUS = `import socket
def is_palindrome(s):
    socket.create_connection(("1.1.1.1", 80), timeout=3)  # should be blocked by --network=none
    return True`;

async function run(label: string, code: string) {
  const res = await runCodeTests(code, TESTS);
  console.log(`\n[${label}] ok=${res.ok} passed=${JSON.stringify(res.passed)} failed=${JSON.stringify(res.failed)}${res.loadError ? ' loadError=' + res.loadError : ''}${res.runnerError ? ' runnerError=' + res.runnerError : ''}`);
  return res;
}

async function main() {
  console.log('--- Hardened sandbox test (Docker) ---');
  const good = await run('GOOD code', GOOD);
  const buggy = await run('BUGGY code', BUGGY);
  const evil = await run('MALICIOUS (network)', MALICIOUS);

  // Also prove it flows through the policy engine end to end.
  const bundle = buildPolicyBundle({ policies: [{ type: 'code_tests', tests: TESTS }] });
  const viaEngine = await evaluatePolicies(bundle, { deliverableText: GOOD, deliverableType: 'text', buyerInput: '' });
  console.log(`\n[policy engine] pass=${viaEngine.pass} policy=${viaEngine.policy} :: ${viaEngine.reason}`);

  const ok = good.ok && !buggy.ok && !evil.ok && viaEngine.pass;
  console.log(`\n--- ${ok ? 'ALL EXPECTATIONS MET ✅' : 'UNEXPECTED ❌'} ---`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('SANDBOX TEST FAILED:', e);
  process.exit(1);
});
