import type { Coords, Mission, PlanRequest, Preferences, Report, SyncOp, SyncResult, WeatherView } from '@shadeloop/shared';
import { ApiError, NetworkError, delMeta, getMeta, setMeta } from './store.ts';

async function token(): Promise<string> {
  const saved = await getMeta<string>('token');
  if (saved) return saved;
  const { token } = await call<{ token: string }>('POST', '/sessions', undefined, false);
  await setMeta('token', token);
  return token;
}

async function call<T>(method: string, path: string, body?: unknown, auth = true, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${await token()}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // Planning and report generation may wait on a local model.
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new NetworkError((e as Error).name === 'TimeoutError' ? 'Request timed out' : 'You appear to be offline');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && auth && !retried) {
    // Session unknown to the server (e.g. data deleted or dev DB reset): start a fresh anonymous session once.
    await delMeta('token');
    return call(method, path, body, auth, true);
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? res.statusText);
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
  };
}

export interface Dependency {
  name: string;
  role: string;
  status: string;
  detail: string;
  lastCall?: { ok: boolean; at: string; detail: string } | null;
}

export interface HistoryItem {
  mission: Mission;
  report: { id: string; summary: string; actualMinutes: number; observations: number } | null;
}

export const api = {
  plan: (body: PlanRequest) => call<PlanResponse>('POST', '/missions/plan', body),
  mission: (id: string) => call<Mission>('GET', `/missions/${id}`),
  sync: async (ops: SyncOp[]) => (await call<{ results: SyncResult[] }>('POST', '/sync', { ops })).results,
  report: (id: string) => call<Report>('GET', `/reports/${id}`),
  history: () => call<{ items: HistoryItem[]; total: number }>('GET', '/history?limit=50'),
  overview: () => call<Record<string, any>>('GET', '/analytics/overview'),
  attributes: () => call<{ items: Record<string, any>[] }>('GET', '/analytics/attributes'),
  prefs: () => call<Preferences>('GET', '/preferences'),
  savePrefs: (p: Preferences) => call<Preferences>('PUT', '/preferences', p),
  deps: () => call<{ status: string; dependencies: Dependency[]; notImplemented: string[] }>('GET', '/health/dependencies', undefined, false),
  parseNote: (missionId: string, text: string) =>
    call<{ proposals: { attribute: string; value: string }[]; method: string; model: string | null; fallbackReason: string | null }>('POST', `/missions/${missionId}/observations/parse`, { text }),
  exportData: () => call<unknown>('GET', '/me/export'),
  deleteMe: () => call<unknown>('DELETE', '/me'),
};

export type { Coords };
