import { imageSize } from 'image-size';
import { chat } from '../shared/groq.js';
import { runCodeTests, SandboxLanguage } from './sandbox.js';

/**
 * Pluggable policy engine — the heart of Warden's value proposition.
 *
 * CAP moves money when work is DELIVERED. Warden moves money only when work
 * SATISFIES PROGRAMMABLE QUALITY POLICIES. A buyer attaches a policy bundle to
 * the order; Warden executes the bundle against the delivery and releases escrow
 * only if every policy passes. New domains = new policy evaluators, no core change.
 */

export interface Policy {
  type: string;
  [param: string]: any;
}

export interface PolicyContext {
  deliverableText: string;
  deliverableType: string;
  buyerInput: string;
}

export interface PolicyOutcome {
  pass: boolean;
  reason: string;
}

/** Aggregate result across a whole bundle. `policy` = the type that decided it. */
export interface GateResult {
  pass: boolean;
  reason: string;
  policy: string;
}

type Evaluator = (p: Policy, ctx: PolicyContext) => PolicyOutcome | Promise<PolicyOutcome>;

const GARBAGE_EXACT = new Set(['', 'null', 'undefined', 'nan', 'none', 'n/a', '{}', '[]']);
const ERROR_PREFIXES = ['error', 'traceback', 'exception', 'undefined', 'null'];

function text(ctx: PolicyContext): string {
  return (ctx.deliverableText ?? '').trim();
}

/** Strip markdown code fences an LLM may wrap around delivered source. */
function stripFences(s: string): string {
  const t = (s ?? '').trim();
  const m = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

/** True if the URL responds with HTTP < 400 (tries HEAD, falls back to GET). */
async function urlResolves(url: string): Promise<boolean> {
  const attempt = async (method: 'HEAD' | 'GET') => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal });
      return res.status < 400;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  if (await attempt('HEAD')) return true;
  return attempt('GET'); // some servers reject HEAD
}

/** Load image bytes from a data URI, an http(s) URL, or raw base64. */
async function loadImageBytes(s: string): Promise<Uint8Array | null> {
  const t = s.trim();
  const dataUri = t.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
  if (dataUri) return new Uint8Array(Buffer.from(dataUri[1], 'base64'));

  const url = t.match(/https?:\/\/[^\s"'<>)\]]+/);
  if (url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url[0].replace(/[.,;:]+$/, ''), { redirect: 'follow', signal: ctrl.signal });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.length > 100) {
    return new Uint8Array(Buffer.from(t.replace(/\s+/g, ''), 'base64'));
  }
  return null;
}

export const POLICY_REGISTRY: Record<string, Evaluator> = {
  min_length: (p, ctx) => {
    const min = Number(p.min ?? 1);
    const len = text(ctx).length;
    return len >= min
      ? { pass: true, reason: `length ${len} >= ${min}` }
      : { pass: false, reason: `Delivery too short: ${len} chars, need >= ${min}.` };
  },

  max_length: (p, ctx) => {
    const max = Number(p.max ?? Infinity);
    const len = text(ctx).length;
    return len <= max
      ? { pass: true, reason: `length ${len} <= ${max}` }
      : { pass: false, reason: `Delivery too long: ${len} chars, max ${max}.` };
  },

  no_placeholder: (_p, ctx) => {
    const t = text(ctx);
    const lower = t.toLowerCase();
    if (GARBAGE_EXACT.has(lower)) return { pass: false, reason: `Delivery is empty or a placeholder ("${t || 'empty'}").` };
    if (ERROR_PREFIXES.some((e) => lower.startsWith(e))) return { pass: false, reason: `Delivery starts with an error marker ("${t.slice(0, 40)}...").` };
    return { pass: true, reason: 'no placeholder/error markers' };
  },

  contains: (p, ctx) => {
    const value = String(p.value ?? '');
    const ci = p.caseInsensitive !== false;
    const hay = ci ? text(ctx).toLowerCase() : text(ctx);
    const needle = ci ? value.toLowerCase() : value;
    return hay.includes(needle)
      ? { pass: true, reason: `contains "${value}"` }
      : { pass: false, reason: `Delivery must contain "${value}" but does not.` };
  },

  not_contains: (p, ctx) => {
    const value = String(p.value ?? '');
    const ci = p.caseInsensitive !== false;
    const hay = ci ? text(ctx).toLowerCase() : text(ctx);
    const needle = ci ? value.toLowerCase() : value;
    return !hay.includes(needle)
      ? { pass: true, reason: `does not contain "${value}"` }
      : { pass: false, reason: `Delivery must NOT contain "${value}" but does.` };
  },

  regex: (p, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(String(p.pattern), typeof p.flags === 'string' ? p.flags : undefined);
    } catch {
      return { pass: false, reason: `Invalid regex policy pattern: ${p.pattern}` };
    }
    return re.test(text(ctx))
      ? { pass: true, reason: `matches /${p.pattern}/` }
      : { pass: false, reason: `Delivery must match /${p.pattern}/ but does not.` };
  },

  json_valid: (_p, ctx) => {
    try {
      JSON.parse(text(ctx));
      return { pass: true, reason: 'valid JSON' };
    } catch {
      return { pass: false, reason: 'Delivery must be valid JSON but failed to parse.' };
    }
  },

  json_fields: (p, ctx) => {
    const fields: string[] = Array.isArray(p.fields) ? p.fields.map(String) : [];
    let obj: any;
    try {
      obj = JSON.parse(text(ctx));
    } catch {
      return { pass: false, reason: `Delivery must be JSON with fields [${fields.join(', ')}] but is not valid JSON.` };
    }
    const missing = fields.filter((f) => obj == null || obj[f] === undefined || obj[f] === null || obj[f] === '');
    return missing.length === 0
      ? { pass: true, reason: `has fields [${fields.join(', ')}]` }
      : { pass: false, reason: `Delivery missing required field(s): [${missing.join(', ')}].` };
  },

  // Executable, objective verification: run the delivered code against the
  // buyer's test suite inside a hardened Docker sandbox. Escrow releases only
  // if every test passes. This is "quality" as a FACT, not an LLM opinion.
  code_tests: async (p, ctx) => {
    const testsCode = String(p.tests ?? '');
    if (!testsCode.trim()) return { pass: false, reason: 'code_tests policy provided no tests.' };
    const solution = stripFences(ctx.deliverableText);
    if (!solution) return { pass: false, reason: 'No code was delivered to test.' };

    const language: SandboxLanguage = p.language === 'javascript' || p.language === 'js' ? 'javascript' : 'python';
    const res = await runCodeTests(solution, testsCode, language);
    if (res.runnerError) return { pass: false, reason: `Sandbox error: ${res.runnerError}` };
    if (res.loadError) return { pass: false, reason: `Delivered code failed to load: ${res.loadError}` };

    const total = res.passed.length + res.failed.length;
    if (res.ok) return { pass: true, reason: `All ${res.passed.length}/${total} tests passed in sandbox.` };
    const first = res.failed[0];
    return {
      pass: false,
      reason: `${res.passed.length}/${total} tests passed. First failure: ${first ? `${first.name} — ${first.error}` : 'no tests ran'}.`,
    };
  },

  // Verify that URLs cited in the delivery actually resolve (HTTP < 400).
  // Use `urls` to pin an explicit list, else every http(s) URL in the text is checked.
  url_resolve: async (p, ctx) => {
    const explicit: string[] = Array.isArray(p.urls) ? p.urls.map(String) : [];
    const found = [...text(ctx).matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''));
    const urls = explicit.length ? explicit : Array.from(new Set(found));
    const min = Number(p.min ?? 1);
    if (urls.length < min) return { pass: false, reason: `Expected at least ${min} URL(s) to verify but found ${urls.length}.` };
    for (const u of urls) {
      if (!(await urlResolves(u))) return { pass: false, reason: `Cited URL does not resolve: ${u}` };
    }
    return { pass: true, reason: `All ${urls.length} cited URL(s) resolve.` };
  },

  // Verify a delivered image meets minimum pixel dimensions. The delivery may be
  // a data URI, an image URL, or raw base64.
  image_min_resolution: async (p, ctx) => {
    const minW = Number(p.minWidth ?? 0);
    const minH = Number(p.minHeight ?? 0);
    let bytes: Uint8Array | null;
    try {
      bytes = await loadImageBytes(text(ctx));
    } catch (e) {
      return { pass: false, reason: `Could not load image: ${(e as Error).message}` };
    }
    if (!bytes) return { pass: false, reason: 'No image found in delivery (expected a URL, data URI, or base64).' };
    let dim: { width?: number; height?: number };
    try {
      dim = imageSize(bytes);
    } catch {
      return { pass: false, reason: 'Delivered data is not a recognizable image.' };
    }
    if (!dim.width || !dim.height) return { pass: false, reason: 'Could not read image dimensions.' };
    if (dim.width < minW || dim.height < minH) {
      return { pass: false, reason: `Image ${dim.width}x${dim.height} is below required ${minW}x${minH}.` };
    }
    return { pass: true, reason: `Image ${dim.width}x${dim.height} meets minimum ${minW}x${minH}.` };
  },

  semantic: async (p, ctx) => {
    const criteria = String(p.criteria ?? p.acceptanceCriteria ?? '');
    const system =
      'You are a strict quality inspector for a payment escrow. A buyer paid for a task and stated acceptance criteria. ' +
      'Decide whether the delivered result genuinely satisfies the task and criteria. Be strict: off-topic, generic, ' +
      'incomplete, or non-responsive deliveries must FAIL. Respond in EXACTLY this format:\n' +
      'VERDICT: PASS or FAIL\nREASON: <one concise sentence>';
    const user =
      `BUYER'S TASK:\n${ctx.buyerInput || '(none)'}\n\nACCEPTANCE CRITERIA:\n${criteria || '(none)'}\n\nDELIVERED RESULT:\n${ctx.deliverableText}`;
    let raw: string;
    try {
      raw = await chat(system, user, { temperature: 0, maxTokens: 200 });
    } catch (err) {
      // Fail closed — protect the buyer if the judge is unreachable.
      return { pass: false, reason: `Semantic policy unavailable (${(err as Error).message}); rejecting to protect buyer.` };
    }
    const verdict = raw.match(/VERDICT:\s*(PASS|FAIL)/i)?.[1]?.toUpperCase();
    const reason = raw.match(/REASON:\s*(.+)/i)?.[1]?.trim() || raw.trim().slice(0, 200);
    return verdict === 'PASS'
      ? { pass: true, reason: reason || 'meets acceptance criteria' }
      : { pass: false, reason: reason || 'did not meet acceptance criteria' };
  },
};

/** Execute a policy bundle fail-fast. Returns the first failure, or overall pass. */
export async function evaluatePolicies(policies: Policy[], ctx: PolicyContext): Promise<GateResult> {
  for (const policy of policies) {
    const evaluator = POLICY_REGISTRY[policy.type];
    if (!evaluator) {
      return { pass: false, reason: `Unknown policy type "${policy.type}".`, policy: policy.type };
    }
    const outcome = await evaluator(policy, ctx);
    if (!outcome.pass) {
      return { pass: false, reason: outcome.reason, policy: policy.type };
    }
  }
  return { pass: true, reason: `All ${policies.length} polic${policies.length === 1 ? 'y' : 'ies'} passed.`, policy: 'all' };
}
