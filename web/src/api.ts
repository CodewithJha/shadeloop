import type { ApiErrorBody, Coords, Mission, PlanRequest, Preferences, Report, SyncOp, SyncResult, WeatherView } from '@shadeloop/shared';
import { ApiError, BadResponseError, NetworkError, getMeta, setMeta } from './store.ts';

const unexpected = () => new BadResponseError('The server sent an unexpected response');

let lookup: Promise<string> | null = null;

/**
 * The stored session token, creating a session if there is none. Concurrent callers share one lookup, so parallel
 * first requests and parallel 401s create a single session. `stale` is a token the server refused: it gets replaced.
 */
async function token(stale?: string): Promise<string> {
  const run = () =>
    (lookup ??= (async () => {
      const saved = await getMeta<string>('token');
      if (saved && saved !== stale) return saved;
      const { token } = await call<{ token: string }>('POST', '/sessions', undefined, false);
      if (typeof token !== 'string') throw unexpected();
      await setMeta('token', token);
      return token;
    })().finally(() => (lookup = null)));
  const t = await run();
  // Joined a lookup that started before the refusal and read the refused token.
  return t === stale ? run() : t;
}

function httpError(res: Response, data: unknown) {
  const body = (data as Partial<ApiErrorBody> | undefined)?.error;
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  let message = body?.message ?? `${res.status >= 500 ? 'Server error' : 'Request failed'} (HTTP ${res.status})`;
  if (res.status === 429 && body?.code !== 'OBSERVATION_LIMIT') message = `Too many requests, try again ${retryAfter ? `in ${retryAfter} s` : 'shortly'}`;
  return new ApiError(res.status, body?.code ?? `HTTP_${res.status}`, message, body?.requestId, retryAfter);
}

async function call<T>(method: string, path: string, body?: unknown, auth = true, retried = false): Promise<T> {
  // Outside the try below, so a failed session request keeps its own error instead of reading as "offline".
  const bearer = auth ? await token() : undefined;
  let res: Response;
  let text: string;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // Planning and report generation may wait on a local model.
      signal: AbortSignal.timeout(180_000),
    });
    text = await res.text();
  } catch (e) {
    throw new NetworkError((e as Error).name === 'TimeoutError' ? 'Request timed out' : 'You appear to be offline');
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (res.status === 401 && bearer && !retried) {
    // Session unknown to the server (e.g. data deleted or dev DB reset): replace it once, retry once.
    await token(bearer);
    return call(method, path, body, auth, true);
  }
  if (!res.ok) throw httpError(res, data);
  if (typeof data !== 'object' || data === null) throw unexpected();
  return data as T;
}

export interface PlanResponse {
  missions: Mission[];
  planning: {
    constraints: { missionType: string; availableMinutes: number; required: string[]; preferred: string[] };
    parse: { method: 'ai' | 'keywords'; provider: string | null; model: string | null; fallbackReason: string | null } | null;
    generation: { generator: 'ai' | 'template'; provider: string | null; model: string | null; fallbackUsed: boolean; fallbackReason: string | null };
    weather: WeatherView | null;
    discovery: { mode: string; sources: { name: string; ok: boolean; count: number; error?: string }[]; limitations: string[] } | null;
    memory?: { provider: string; recalled: number; saved: boolean } | null;
  };
}

export interface Dependency {
  name: string;
  role: string;
  status: string;
  detail: string;
  lastCall?: { ok: boolean; at: string; detail: string } | null;
}

export interface SimilarPlace {
  locationId: string;
  name: string | null;
  reports: number;
  similarity: number;
}

export interface HourlyReport {
  hour: number;
  attribute: string;
  value: string;
  reports: number;
}

export interface HistoryItem {
  mission: Mission;
  report: { id: string; summary: string; actualMinutes: number | null; observations: number } | null;
}

export const api = {
  plan: (body: PlanRequest) => call<PlanResponse>('POST', '/missions/plan', body),
  mission: (id: string) => call<Mission>('GET', `/missions/${id}`),
  // `sentAt` is stamped per send (not per enqueue) so the server can correct this device's clock.
  sync: async (ops: SyncOp[]) => {
    const { results } = await call<{ results: SyncResult[] }>('POST', '/sync', { ops, sentAt: new Date().toISOString() });
    if (!Array.isArray(results)) throw unexpected();
    return results;
  },
  report: (id: string) => call<Report>('GET', `/reports/${id}`),
  history: () => call<{ items: HistoryItem[]; total: number }>('GET', '/history?limit=50'),
  overview: () => call<Record<string, any>>('GET', '/analytics/overview'),
  attributes: () => call<{ items: Record<string, any>[] }>('GET', '/analytics/attributes'),
  prefs: () => call<Preferences>('GET', '/preferences'),
  savePrefs: (p: Preferences) => call<Preferences>('PUT', '/preferences', p),
  deps: () => call<{ status: string; dependencies: Dependency[]; notImplemented: string[] }>('GET', '/health/dependencies', undefined, false),
  parseNote: (missionId: string, text: string) =>
    call<{ proposals: { attribute: string; value: string }[]; method: string; model: string | null; fallbackReason: string | null }>('POST', `/missions/${missionId}/observations/parse`, { text }),
  similar: (locationId: string) => call<{ available: boolean; reason?: string; method?: string; places: SimilarPlace[] }>('GET', `/locations/${encodeURIComponent(locationId)}/similar`),
  hourly: (locationId: string) =>
    call<{ available: boolean; hours: HourlyReport[] }>('GET', `/locations/${encodeURIComponent(locationId)}/hourly?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  /** ElevenLabs audio for one step; throws when unavailable so the caller can use the browser voice. */
  speech: async (missionId: string, step: number) => {
    const res = await fetch(`/api/v1/missions/${missionId}/steps/${step}/speech`, { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('audio/')) throw new Error(`speech HTTP ${res.status}`);
    return res.blob();
  },
  reportSpeech: async (reportId: string) => {
    const res = await fetch(`/api/v1/reports/${reportId}/speech`, { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('audio/')) throw new Error(`speech HTTP ${res.status}`);
    return res.blob();
  },
  exportData: () => call<unknown>('GET', '/me/export'),
  deleteMe: () => call<unknown>('DELETE', '/me'),
};

export type { Coords };
