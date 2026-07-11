import Groq from 'groq-sdk';
import { required, optional } from './env.js';

let _groq: Groq | null = null;
function groq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: required('GROQ_API_KEY') });
  return _groq;
}

const MODEL = optional('GROQ_MODEL', 'llama-3.3-70b-versatile');

/** Single low-latency chat completion. Used by demo providers + quality gate. */
export async function chat(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await groq().chat.completions.create({
    model: MODEL,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 512,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return (res.choices[0]?.message?.content ?? '').trim();
}
