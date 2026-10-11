/** AI providers (Ollama, OpenAI-compatible). Advisory only: output is Zod-validated and callers always have a deterministic fallback. */
import { z } from 'zod';
import { CONDITIONS, MissionType, ObservationValue, type Condition } from '@shadeloop/shared';
import { env, RULES } from './config.ts';
import { log } from './log.ts';
import { lastCall, recordCall, type IntegrationStatus } from './integrations.ts';
import { Candidate } from './domain.ts';

interface Provider {
  name: 'ollama' | 'openai';
  model: string;
  complete(system: string, user: string, jsonSchema: object): Promise<string>;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

const providers = {
  ollama: (): Provider => ({
    name: 'ollama',
    model: env.OLLAMA_MODEL,
    async complete(system, user, format) {
      const body = (await postJson(`${env.OLLAMA_URL}/api/chat`, {
        model: env.OLLAMA_MODEL,
        stream: false,
        format,
        options: { temperature: 0.3 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      })) as { message?: { content?: unknown } };
      if (typeof body.message?.content !== 'string') throw new Error('response missing message content');
      return body.message.content;
    },
  }),
  openai: (): Provider => ({
    name: 'openai',
    model: env.OPENAI_MODEL!,
    async complete(system, user) {
      const body = (await postJson(
        `${env.OPENAI_BASE_URL!.replace(/\/$/, '')}/chat/completions`,
        {
          model: env.OPENAI_MODEL,
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      )) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('response missing choices[0].message.content');
      return content;
    },
  }),
};

const provider = (): Provider | null => (env.AI_PROVIDER === 'none' ? null : providers[env.AI_PROVIDER]());

export interface AiMeta {
  provider: string | null;
  model: string | null;
  attempts: number;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

/** Call the model, parse JSON, validate with Zod, retry a bounded number of times. Returns data=null when the caller must fall back. */
export async function aiJson<T>(task: string, system: string, user: string, schema: z.ZodType<T>): Promise<{ data: T | null; meta: AiMeta }> {
  const p = provider();
  if (!p) return { data: null, meta: { provider: null, model: null, attempts: 0, fallbackUsed: true, fallbackReason: 'AI provider not configured' } };
  const jsonSchema = z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' });
  const sys = `${system}\nRespond with a single JSON object only, matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
  let reason = 'unknown error';
  const attempts = env.AI_MAX_RETRIES + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const parsed = schema.safeParse(JSON.parse(await p.complete(sys, user, jsonSchema)));
      if (parsed.success) {
        recordCall(`ai:${p.name}`, true, `${task}: valid output`);
        return { data: parsed.data, meta: { provider: p.name, model: p.model, attempts: attempt, fallbackUsed: false, fallbackReason: null } };
      }
      const issue = parsed.error.issues[0];
      reason = `invalid output at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`;
    } catch (e) {
      // SyntaxError messages can echo model output; keep reasons generic.
      reason = e instanceof SyntaxError ? 'malformed JSON' : (e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message;
    }
    log.warn({ task, attempt, reason }, 'AI attempt failed');
  }
  recordCall(`ai:${p.name}`, false, `${task}: ${reason}`);
  return { data: null, meta: { provider: p.name, model: p.model, attempts, fallbackUsed: true, fallbackReason: reason } };
}

type Probe = { status: IntegrationStatus; detail: string };
let lastProbe: { at: number; provider: string; result: Promise<Probe> } | null = null;
export const clearAiHealthCache = () => void (lastProbe = null);

/** Health is public, so one live probe is shared by every caller for `RULES.aiHealthCacheMs`. */
export async function aiHealth(): Promise<{ name: string; status: IntegrationStatus; detail: string; lastGeneration: ReturnType<typeof lastCall> }> {
  if (env.AI_PROVIDER === 'none') {
    return { name: 'ai', status: 'DISABLED', detail: 'AI_PROVIDER=none; deterministic templates are used', lastGeneration: null };
  }
  const name = `ai:${env.AI_PROVIDER}`;
  if (!lastProbe || lastProbe.provider !== name || Date.now() - lastProbe.at >= RULES.aiHealthCacheMs) {
    lastProbe = { at: Date.now(), provider: name, result: probeAi() };
  }
  return { name, ...(await lastProbe.result), lastGeneration: lastCall(name) };
}

async function probeAi(): Promise<Probe> {
  try {
    if (env.AI_PROVIDER === 'ollama') {
      const res = await fetch(`${env.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { models = [] } = (await res.json()) as { models?: { name: string }[] };
      const present = models.some((m) => m.name === env.OLLAMA_MODEL || m.name === `${env.OLLAMA_MODEL}:latest`);
      return present
        ? { status: 'VERIFIED', detail: `Ollama reachable; model ${env.OLLAMA_MODEL} installed` }
        : { status: 'DEGRADED', detail: `Ollama reachable but model ${env.OLLAMA_MODEL} is not installed` };
    }
    const res = await fetch(`${env.OPENAI_BASE_URL!.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: 'VERIFIED', detail: 'OpenAI-compatible /models reachable with configured key' };
  } catch (e) {
    return { status: 'DEGRADED', detail: `health check failed: ${(e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message}` };
  }
}

/* ---------------- Tasks ---------------- */

const ParsedRequest = z.object({
  missionType: MissionType.nullable(),
  availableMinutes: z.number().int().min(5).max(240).nullable(),
  preferred: z.array(z.enum(CONDITIONS)).max(CONDITIONS.length),
});

export async function aiParseRequest(prompt: string) {
  const r = await aiJson(
    'parse_request',
    `You extract constraints from a request for a short outdoor activity. Mission types: ${MissionType.options.join(', ')}. ` +
      `Conditions: ${CONDITIONS.join(', ')}. Use null when not stated. Never add conditions the user did not mention.`,
    `Request: """${prompt}"""`,
    ParsedRequest,
  );
  return {
    meta: r.meta,
    data: r.data && {
      missionType: r.data.missionType ?? undefined,
      availableMinutes: r.data.availableMinutes ?? undefined,
      required: [] as Condition[],
      preferred: r.data.preferred,
    },
  };
}

const Proposals = z.object({ missions: z.array(Candidate).min(1).max(3) });

export async function aiProposeMissions(input: {
  request: string | undefined;
  missionType: string;
  availableMinutes: number;
  maxWalkMinutes: number;
  timeOfDay: string;
  required: string[];
  preferred: string[];
  locations: { id: string; name: string; category: string; maxStepMinutes: number; evidence: Record<string, string> }[];
  weather: string;
}) {
  const system = [
    'You design short, safe outdoor micro-missions (5-120 minutes) for one person.',
    'Rules you must follow:',
    '- locationId must be one of the supplied location ids, or null. Never invent places.',
    "- The sum of step minutes must not exceed the location's maxStepMinutes.",
    '- Put each step\'s duration only in its "minutes" field. Never state a duration in any text (no "10 minutes", "half an hour"); minutes may be shortened to fit.',
    '- Steps of kind "walk" count against the walking limit.',
    '- Do not claim a place has shade, benches, quiet, access or is open; you only know the supplied evidence.',
    '- Public places only. No private property, no closed areas. No medical or health advice.',
    '- observationPrompts must be attribute names from: bench_availability, shade_quality, noise_level, crowding, path_condition, step_free_access, temperature_feel.',
    '- Keep text plain, concrete and kind. whyItMatches explains the fit using only supplied facts.',
  ].join('\n');
  return aiJson('propose_missions', system, JSON.stringify(input), Proposals);
}

const NoteObservations = z.object({ observations: z.array(ObservationValue).max(7) });

export async function aiParseNote(text: string) {
  return aiJson(
    'parse_note',
    'Convert a field note about an outdoor place into structured observations. Only include attributes the note clearly states. ' +
      'Allowed values: bench_availability: not_found|found; shade_quality: none|partial|good; noise_level: quiet|moderate|loud; ' +
      'crowding: empty|some_people|busy; path_condition: blocked|uneven|good; step_free_access: no|yes; ' +
      'temperature_feel: cooler_than_expected|as_expected|hotter_than_expected.',
    `Note: """${text}"""`,
    NoteObservations,
  );
}
