import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Hardened, multi-language code-execution sandbox for the `code_tests` policy.
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

export type SandboxLanguage = 'python' | 'javascript';

export interface CodeTestResult {
  ok: boolean; // all tests passed
  passed: string[];
  failed: { name: string; error: string }[];
  loadError?: string; // solution/tests failed to even load (syntax, import, etc.)
  runnerError?: string; // sandbox itself failed (docker/timeout)
}

const WALL_TIMEOUT_MS = 15_000; // host-side hard cap
const MEM = '128m';
const CPUS = '0.5';
const PIDS = '64';

// Runner executed INSIDE the container. Loads solution + tests into one shared
// scope, runs every `test_*` function, prints a machine-readable result line.
const PYTHON_RUNNER = `
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

const JS_RUNNER = `
const fs = require('fs'); const vm = require('vm');
const out = { passed: [], failed: [], loadError: null };
const ctx = { assert: require('assert'), console };
vm.createContext(ctx);
try {
  vm.runInContext(fs.readFileSync('/work/solution.js','utf8'), ctx, { filename: 'solution.js' });
  vm.runInContext(fs.readFileSync('/work/tests.js','utf8'), ctx, { filename: 'tests.js' });
} catch (e) {
  out.loadError = (e.name || 'Error') + ': ' + (e.message || String(e));
  console.log('__RESULT__' + JSON.stringify(out)); process.exit(0);
}
for (const k of Object.keys(ctx).sort()) {
  if (k.startsWith('test_') && typeof ctx[k] === 'function') {
    try { ctx[k](); out.passed.push(k); }
    catch (e) { out.failed.push({ name: k, error: (e.name || 'Error') + ': ' + (e.message || String(e)) }); }
  }
}
console.log('__RESULT__' + JSON.stringify(out));
`;

const LANGS: Record<SandboxLanguage, { image: string; ext: string; runnerFile: string; runner: string; cmd: (f: string) => string[] }> = {
  python: { image: 'python:3.11-slim', ext: 'py', runnerFile: 'runner.py', runner: PYTHON_RUNNER, cmd: (f) => ['python', f] },
  javascript: { image: 'node:20-slim', ext: 'js', runnerFile: 'runner.js', runner: JS_RUNNER, cmd: (f) => ['node', f] },
};

export async function runCodeTests(
  solutionCode: string,
  testsCode: string,
  language: SandboxLanguage = 'python',
): Promise<CodeTestResult> {
  const lang = LANGS[language];
  if (!lang) return fail({ runnerError: `Unsupported sandbox language: ${language}` });

  const dir = await mkdtemp(join(tmpdir(), 'warden-sbx-'));
  try {
    await writeFile(join(dir, `solution.${lang.ext}`), solutionCode, 'utf8');
    await writeFile(join(dir, `tests.${lang.ext}`), testsCode, 'utf8');
    await writeFile(join(dir, lang.runnerFile), lang.runner, 'utf8');

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
      lang.image,
      ...lang.cmd(`/work/${lang.runnerFile}`),
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
