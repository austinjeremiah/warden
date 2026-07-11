import { EventType, DeliverableType } from '@croo-network/sdk';
import { makeClient } from '../shared/client.js';
import { chat } from '../shared/groq.js';

/**
 * Shared runtime for the demo "target provider" agents that Warden hires.
 *
 * These are honest, minimal real services: they take a text task in the
 * order's `requirements` and return a real Groq completion. Provider B can be
 * flipped into a deliberately-bad mode (FORCE_BAD_OUTPUT) so we can show the
 * reject/refund path on-chain WITHOUT faking any transaction — the "badness"
 * is a real, off-topic delivery, just an honest test fixture (Risk #10 / §10).
 */

/** Pull the actual instruction out of whatever the requester sent. */
function parseInstruction(requirements: string | undefined): string {
  if (!requirements) return '';
  const raw = requirements.trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      return String(obj.input ?? obj.task ?? obj.prompt ?? raw);
    }
  } catch {
    /* not JSON — treat as plain-text instruction */
  }
  return raw;
}

async function runGoodTask(instruction: string): Promise<string> {
  if (!instruction) return 'No task was provided.';
  const out = await chat(
    'You are a professional service agent. Complete the user task accurately and concisely. ' +
      'If the task asks for code, output ONLY the raw source code that solves it — a complete, runnable ' +
      'implementation with the exact function/name requested, no explanation. ' +
      'Never wrap output in markdown fences.',
    instruction,
    { temperature: 0.2, maxTokens: 700 },
  );
  return stripFences(out);
}

/** Strip markdown code fences the model may add despite instructions. */
function stripFences(s: string): string {
  const t = (s ?? '').trim();
  const m = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

/**
 * Deliberately-bad delivery for the demo bad-path. Coherent and non-empty (so
 * it passes the cheap rules layer) but completely off-topic (so Warden's
 * semantic gate is what catches it) — this showcases the real quality gate.
 */
function badTask(): string {
  return 'The weather today is partly cloudy with a gentle northwest breeze. Mild temperatures are expected through the afternoon, with clear skies arriving by early evening. A pleasant day overall.';
}

export async function runProvider(opts: { tag: string; keyEnv: string; forceBad: boolean }) {
  const { tag, forceBad } = opts;
  const key = process.env[opts.keyEnv];
  if (!key) throw new Error(`Missing ${opts.keyEnv} in backend/.env — register this provider first`);

  const { client, log } = makeClient(key, tag);
  const requirementsByOrder = new Map<string, string>();

  const stream = await client.connectWebSocket();
  log.info(`online. forceBad=${forceBad}. Waiting for negotiations...`);

  // 1) Accept any incoming negotiation (price/SLA are fixed at registration — no haggling, Risk #9)
  stream.on(EventType.NegotiationCreated, async (e) => {
    try {
      const neg = await client.getNegotiation(e.negotiation_id!);
      const result = await client.acceptNegotiation(e.negotiation_id!);
      requirementsByOrder.set(result.order.orderId, neg.requirements);
      log.info(`accepted negotiation ${e.negotiation_id} -> order ${result.order.orderId}`);
    } catch (err) {
      log.error(`accept failed for ${e.negotiation_id}:`, (err as Error).message);
    }
  });

  // 2) On payment, do the real work and deliver (needEvaluation=false default -> straight to CLEAR)
  stream.on(EventType.OrderPaid, async (e) => {
    const orderId = e.order_id!;
    try {
      const instruction = parseInstruction(requirementsByOrder.get(orderId));
      log.info(`order ${orderId} paid. Running task: "${instruction.slice(0, 80)}..."`);
      const output = forceBad ? badTask() : await runGoodTask(instruction);
      const res = await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: output,
      });
      log.info(`delivered order ${orderId} (tx ${res.txHash}). Output: "${output.slice(0, 80)}..."`);
    } catch (err) {
      log.error(`deliver failed for ${orderId}:`, (err as Error).message);
    }
  });

  process.on('SIGINT', () => {
    log.info('shutting down.');
    stream.close();
    process.exit(0);
  });
}
