import { chat } from '../shared/groq.js';

export interface GateInput {
  deliverableText: string;
  deliverableType: string;
  acceptanceCriteria: string;
  requiredFields?: string[];
  buyerInput: string;
}

export interface GateResult {
  pass: boolean;
  reason: string;
  layer: 'rules' | 'semantic';
}

// Whole-output error markers — if the delivery is essentially just one of these,
// it's a broken result, not real work. Kept conservative to avoid false rejects.
const GARBAGE_EXACT = new Set(['', 'null', 'undefined', 'nan', 'none', 'n/a', '{}', '[]']);
const ERROR_PREFIXES = ['error', 'traceback', 'exception', 'undefined', 'null'];

/**
 * Two-layer quality gate.
 *  Layer 1 (rules): free + instant. Structural sanity — non-empty, not garbage,
 *                   required fields present. Fail fast here.
 *  Layer 2 (semantic): one Groq call. Does the content actually satisfy the
 *                   buyer's stated acceptance criteria for their task?
 * Returns a human-readable `reason` — this is what gets passed to rejectOrder.
 */
export async function runQualityGate(input: GateInput): Promise<GateResult> {
  const rules = rulesLayer(input);
  if (!rules.pass) return rules;

  return semanticLayer(input);
}

function rulesLayer(input: GateInput): GateResult {
  const text = (input.deliverableText ?? '').trim();
  const lower = text.toLowerCase();

  if (GARBAGE_EXACT.has(lower)) {
    return { pass: false, reason: `Delivery is empty or a placeholder value ("${text || 'empty'}").`, layer: 'rules' };
  }
  if (text.length < 10) {
    return { pass: false, reason: `Delivery is too short (${text.length} chars) to be a real result.`, layer: 'rules' };
  }
  if (ERROR_PREFIXES.some((p) => lower.startsWith(p))) {
    return { pass: false, reason: `Delivery starts with an error marker ("${text.slice(0, 40)}...").`, layer: 'rules' };
  }

  // If the buyer required specific fields, the deliverable must be JSON containing them.
  if (input.requiredFields && input.requiredFields.length > 0) {
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      return { pass: false, reason: `Delivery must be JSON with fields [${input.requiredFields.join(', ')}] but is not valid JSON.`, layer: 'rules' };
    }
    const missing = input.requiredFields.filter((f) => obj == null || obj[f] === undefined || obj[f] === null || obj[f] === '');
    if (missing.length > 0) {
      return { pass: false, reason: `Delivery is missing required field(s): [${missing.join(', ')}].`, layer: 'rules' };
    }
  }

  return { pass: true, reason: 'Passed structural checks.', layer: 'rules' };
}

async function semanticLayer(input: GateInput): Promise<GateResult> {
  const system =
    'You are a strict quality inspector for a payment escrow. A buyer paid for a task and stated acceptance criteria. ' +
    'Decide whether the delivered result genuinely satisfies the task and criteria. Be strict: off-topic, generic, ' +
    'incomplete, or non-responsive deliveries must FAIL. Respond in EXACTLY this format:\n' +
    'VERDICT: PASS or FAIL\n' +
    'REASON: <one concise sentence>';

  const user =
    `BUYER'S TASK:\n${input.buyerInput || '(none provided)'}\n\n` +
    `ACCEPTANCE CRITERIA:\n${input.acceptanceCriteria || '(none provided)'}\n\n` +
    `DELIVERED RESULT:\n${input.deliverableText}`;

  let raw: string;
  try {
    raw = await chat(system, user, { temperature: 0, maxTokens: 200 });
  } catch (err) {
    // If the judge is unreachable, fail closed with a clear reason (protect the buyer).
    return { pass: false, reason: `Semantic validation unavailable (${(err as Error).message}); rejecting to protect buyer.`, layer: 'semantic' };
  }

  const verdictMatch = raw.match(/VERDICT:\s*(PASS|FAIL)/i);
  const reasonMatch = raw.match(/REASON:\s*(.+)/i);
  const verdict = verdictMatch?.[1]?.toUpperCase();
  const reason = reasonMatch?.[1]?.trim() || raw.trim().slice(0, 200);

  if (verdict === 'PASS') {
    return { pass: true, reason: reason || 'Meets acceptance criteria.', layer: 'semantic' };
  }
  // Default to FAIL when the verdict is FAIL or unparseable — fail closed.
  return { pass: false, reason: reason || 'Did not meet acceptance criteria.', layer: 'semantic' };
}
