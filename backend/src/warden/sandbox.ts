import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Hardened code-execution sandbox for the `code_tests` policy.
 *
 * Warden runs UNTRUSTED code delivered by an anonymous provider and lets the
 * result move real money — so isolation is the whole game. We execute inside a
 * throwaway Docker container locked down on every axis:
 *   --network=none        no network (can't exfiltrate Warden's wallet key)
 *   --read-only + tmpfs   immutable root fs; only a small tmpfs is writable
 *   --user 65534:65534    non-root (nobody)
 *   --memory / --cpus     resource caps (no memory bomb / CPU hog)
 *   --pids-limit          no fork bomb
 *   --cap-drop ALL        drop all Linux capabilities
 *   --security-opt no-new-privileges
 *   host-side kill timer  hard wall-clock timeout even if Docker hangs
 * The workdir is a fresh temp dir, bind-mounted read-only, destroyed after.
 */

export interface CodeTestResult {
  ok: boolean; // all tests passed
  passed: string[];
  failed: { name: string; error: string }[];
  loadError?: string; // solution/tests failed to even load (syntax, import, etc.)
  runnerError?: string; // sandbox itself failed (docker/timeout)
}

const IMAGE = 'python:3.11-slim';
const MEM = '128m';
const CPUS = '0.5';
const PIDS = '64';
const WALL_TIMEOUT_MS = 12_000; // host-side hard cap

// Runner executed INSIDE the container. Loads solution + tests into one
// namespace, runs every `test_*` callable, and prints a machine-readable line.
const RUNNER = `
import json, sys
ns = {}
out = {"passed": [], "failed": [], "loadError": None}
try:
    with open('/work/solution.py') as f: exec(compile(f.read(), 'solution.py', 'exec'), ns)
    with open('/work/tests.py') as f: exec(compile(f.read(), 'tests.py', 'exec'), ns)
except Exception as e:
    out["loadError"] = type(e).__name__ + ": " + str(e)
    print("__RESULT__" + json.dumps(out)); sys.exit(0)
for name in sorted([k for k in ns if k.startswith('test_') and callable(ns[k])]):
    try:
        ns[name]()
        out["passed"].append(name)
    except Exception as e:
        out["failed"].append({"name": name, "error": type(e).__name__ + ": " + str(e)})
print("__RESULT__" + json.dumps(out))
`;

export async function runCodeTests(solutionCode: string, testsCode: string): Promise<CodeTestResult> {
  const dir = await mkdtemp(join(tmpdir(), 'warden-sbx-'));
  try {
    await writeFile(join(dir, 'solution.py'), solutionCode, 'utf8');
    await writeFile(join(dir, 'tests.py'), testsCode, 'utf8');
    await writeFile(join(dir, 'runner.py'), RUNNER, 'utf8');

    const args = [
      'run', '--rm', '-i',
      '--network=none',
      '--read-only',
      '--tmpfs', '/tmp:rw,size=16m',
      `--memory=${MEM}`, `--memory-swap=${MEM}`,
      `--cpus=${CPUS}`,
      `--pids-limit=${PIDS}`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--user', '65534:65534',
      '-v', `${dir}:/work:ro`,
      '-w', '/work',
      '-e', 'PYTHONDONTWRITEBYTECODE=1',
      IMAGE,
      'python', '/work/runner.py',
    ];

    const { stdout, timedOut, spawnError } = await runDocker(args);
    if (spawnError) return fail({ runnerError: `sandbox spawn failed: ${spawnError}` });
    if (timedOut) return fail({ runnerError: `sandbox timed out after ${WALL_TIMEOUT_MS}ms` });

    const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
    if (!line) return fail({ runnerError: `no result from sandbox (output: ${stdout.slice(0, 200)})` });

    const parsed = JSON.parse(line.slice('__RESULT__'.length));
    return {
      ok: !parsed.loadError && parsed.failed.length === 0 && parsed.passed.length > 0,
      passed: parsed.passed,
      failed: parsed.failed,
      loadError: parsed.loadError ?? undefined,
    };
  } catch (err) {
    return fail({ runnerError: (err as Error).message });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function fail(extra: Partial<CodeTestResult>): CodeTestResult {
  return { ok: false, passed: [], failed: [], ...extra };
}

function runDocker(args: string[]): Promise<{ stdout: string; timedOut: boolean; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ stdout, timedOut: true });
    }, WALL_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, timedOut: false, spawnError: e.message });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, timedOut: false });
    });
  });
}
