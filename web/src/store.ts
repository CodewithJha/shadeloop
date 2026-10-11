/** All IndexedDB access: session token, cached missions with local progress, and the offline op queue. */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Attribute, Mission, SyncOp, SyncResult } from '@shadeloop/shared';

export type OpState = 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';
export type QueuedOp = SyncOp & { seq: number; state: OpState; attempts: number; nextAttemptAt: number; lastError?: string; syncedAt?: number; result?: SyncResult };

export interface LocalProgress {
  status: Mission['status'];
  currentStep: number;
  startedAt: string | null;
  completedAt: string | null;
  observations: { opId: string; attribute: Attribute; value: string; at: string }[];
  reportId: string | null;
}
export interface CachedMission {
  id: string;
  mission: Mission;
  local: LocalProgress;
  cachedAt: string;
  /** The server answered 404: expired (planned missions live 7 days), deleted, or owned by another session. */
  gone?: boolean;
}

interface Schema extends DBSchema {
  meta: { key: string; value: unknown };
  missions: { key: string; value: CachedMission };
  ops: { key: string; value: QueuedOp; indexes: { seq: number } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
const db = () =>
  (dbp ??= openDB<Schema>('shadeloop', 1, {
    upgrade(d) {
      d.createObjectStore('meta');
      d.createObjectStore('missions', { keyPath: 'id' });
      d.createObjectStore('ops', { keyPath: 'opId' }).createIndex('seq', 'seq');
    },
  }));

/** Drop the cached connection (tests use this to simulate a page reload). */
export async function closeStore() {
  (await dbp)?.close();
  dbp = null;
}

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
const notify = () => listeners.forEach((fn) => fn());

export const getMeta = async <T>(key: string) => (await (await db()).get('meta', key)) as T | undefined;
export const setMeta = async (key: string, value: unknown) => void (await (await db()).put('meta', value, key));
export const delMeta = async (key: string) => (await db()).delete('meta', key);

/* ---------------- Missions ---------------- */

/**
 * Store a mission fetched from the server. Local optimistic progress is kept only while this mission has ops still
 * headed for the server; otherwise (nothing queued, or the queue is held behind a refused op) the server state wins.
 */
export async function cacheMission(mission: Mission) {
  const d = await db();
  const prev = await d.get('missions', mission.id);
  const ops = (await d.getAll('ops')).filter((q) => q.missionId === mission.id);
  const keepLocal = prev && ops.some((q) => q.state !== 'synced') && !ops.some((q) => q.state === 'conflict');
  const s = mission.session;
  const local: LocalProgress = keepLocal
    ? prev.local
    : {
        status: mission.status,
        // Step navigation isn't synced, so keep this device's step while the status agrees.
        currentStep: prev?.local.status === mission.status ? prev.local.currentStep : s.currentStep,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        observations: prev?.local.observations ?? [],
        reportId: mission.reportId,
      };
  if (mission.reportId) local.reportId = mission.reportId;
  await d.put('missions', { id: mission.id, mission, local, cachedAt: new Date().toISOString() });
  notify();
}

/** Fetch and reconcile one mission. A 404 marks the cached copy `gone` (its queued data stays) and is rethrown. */
export async function refreshMission(id: string, get: (id: string) => Promise<Mission>) {
  try {
    await cacheMission(await get(id));
  } catch (e) {
    const d = await db();
    const c = e instanceof ApiError && e.status === 404 ? await d.get('missions', id) : undefined;
    if (c) {
      await d.put('missions', { ...c, gone: true });
      notify();
    }
    throw e;
  }
}

export const getCached = async (id: string) => (await db()).get('missions', id);
export const listCached = async () => (await (await db()).getAll('missions')).sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));

export async function updateLocal(id: string, fn: (l: LocalProgress) => LocalProgress) {
  const d = await db();
  const c = await d.get('missions', id);
  if (!c) throw new Error('Mission is not cached on this device');
  await d.put('missions', { ...c, local: fn(c.local) });
  notify();
}

/* ---------------- Op queue ---------------- */

type NewOp = SyncOp extends infer T ? (T extends SyncOp ? Omit<T, 'opId' | 'clientTs'> : never) : never;
let counter = 0;

/** Queue an op with a stable client opId. It survives reloads until the server confirms it. */
export async function enqueue(op: NewOp): Promise<QueuedOp> {
  const q = {
    ...op,
    opId: crypto.randomUUID(),
    clientTs: new Date().toISOString(),
    seq: Date.now() * 1000 + (counter++ % 1000),
    state: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
  } as QueuedOp;
  await (await db()).put('ops', q);
  notify();
  return q;
}

export const listOps = async () => (await db()).getAllFromIndex('ops', 'seq');

/** After a crash mid-request, ops stuck in "syncing" are safe to resend: the server dedupes by opId. */
export async function resetStuck() {
  const d = await db();
  for (const q of await d.getAll('ops')) if (q.state === 'syncing') await d.put('ops', { ...q, state: 'pending' });
}

/** User acknowledged a conflict. This is the only way an unsynced op leaves the queue. */
export async function dismissOp(opId: string) {
  const d = await db();
  const q = await d.get('ops', opId);
  await d.delete('ops', opId);
  const c = q && (await d.get('missions', q.missionId));
  if (c) await d.put('missions', { ...c, local: { ...c.local, observations: c.local.observations.filter((o) => o.opId !== opId) } });
  notify();
}

/** Connectivity came back: retry failed ops now instead of waiting out their backoff. */
export async function retryFailed() {
  const d = await db();
  for (const q of await d.getAll('ops')) if (q.state === 'failed') await d.put('ops', { ...q, nextAttemptAt: 0 });
}

export async function retryOp(opId: string) {
  const d = await db();
  const q = await d.get('ops', opId);
  if (q?.state === 'failed' || q?.state === 'conflict') await d.put('ops', { ...q, state: 'pending', nextAttemptAt: 0 });
  notify();
}

/** The request never got an HTTP response: offline, aborted or timed out. */
export class NetworkError extends Error {}
/** The server answered with an HTTP error. `code`/`requestId` come from its error envelope when it sent one. */
export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  /** Seconds, from `Retry-After`. */
  retryAfter?: number;
  constructor(status: number, code: string, message: string, requestId?: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}
/** A 2xx response whose body isn't the expected JSON (e.g. a proxy page). The request may have been applied. */
export class BadResponseError extends Error {}

export const isRecoverable = (e: unknown) =>
  e instanceof NetworkError || e instanceof BadResponseError || (e instanceof ApiError && (e.status >= 500 || e.status === 429));
export const backoffMs = (attempts: number) => Math.min(1000 * 2 ** attempts, 5 * 60_000);
const SYNCED_RETENTION_MS = 24 * 3_600_000;

const wire = ({ opId, missionId, clientTs, type, payload }: QueuedOp) => ({ opId, missionId, clientTs, type, payload }) as SyncOp;

let flushing: Promise<void> | null = null;

/** One flush at a time per tab (`flushing`) and across tabs/PWA windows (Web Lock). Without Web Locks, server opId dedupe is the backstop. */
const exclusive = (fn: () => Promise<void>) =>
  typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('shadeloop-sync', { ifAvailable: true }, (lock) => (lock ? fn() : undefined)) : fn();

/**
 * Send due ops in order. Recoverable failures back off and retry; server refusals become visible conflicts.
 * With `getMission`, missions with a new refusal are refetched so local state matches the server.
 */
export function flush(send: (ops: SyncOp[]) => Promise<SyncResult[]>, now = Date.now(), getMission?: (id: string) => Promise<Mission>): Promise<void> {
  return (flushing ??= exclusive(async () => {
    const refused = await doFlush(send, now);
    if (getMission) for (const id of refused) await refreshMission(id, getMission).catch(() => {});
  }).finally(() => {
    flushing = null;
    notify();
  }));
}

/** Ops of one mission go strictly in `seq` order: the first one that isn't sendable holds back the rest of that mission. */
function dueOps(all: QueuedOp[], now: number) {
  const held = new Set<string>();
  const due: QueuedOp[] = [];
  for (const q of all) {
    if (q.state === 'synced') continue;
    // `syncing` here is left over from a crash or closed tab: we hold the lock, so nobody else is sending it.
    const sendable = q.state === 'pending' || q.state === 'syncing' || (q.state === 'failed' && q.nextAttemptAt <= now);
    if (!sendable || held.has(q.missionId)) held.add(q.missionId);
    else if (due.length < 50) due.push(q);
  }
  return due;
}

async function doFlush(send: (ops: SyncOp[]) => Promise<SyncResult[]>, now: number): Promise<Set<string>> {
  const refused = new Set<string>();
  const d = await db();
  const all = await d.getAllFromIndex('ops', 'seq');
  for (const q of all) if (q.state === 'synced' && now - (q.syncedAt ?? 0) > SYNCED_RETENTION_MS) await d.delete('ops', q.opId);
  const due = dueOps(all, now);
  if (!due.length) return refused;
  for (const q of due) await d.put('ops', { ...q, state: 'syncing' });
  let results: SyncResult[];
  try {
    results = await send(due.map(wire));
  } catch (e) {
    const recoverable = isRecoverable(e);
    const retryAfterMs = e instanceof ApiError && e.retryAfter ? e.retryAfter * 1000 : 0;
    for (const q of due) {
      const attempts = q.attempts + 1;
      const nextAttemptAt = now + Math.max(backoffMs(attempts), retryAfterMs);
      await d.put('ops', { ...q, state: recoverable ? 'failed' : 'conflict', attempts, nextAttemptAt, lastError: (e as Error).message });
      if (!recoverable) refused.add(q.missionId);
    }
    return refused;
  }
  const byId = new Map(results.map((r) => [r.opId, r]));
  for (const q of due) {
    const r = byId.get(q.opId);
    // A resent op whose first answer was a refusal comes back as `duplicate` carrying that answer.
    const original = (r?.result as { originalStatus?: string } | undefined)?.originalStatus;
    if (!r || r.status === 'retry') {
      await d.put('ops', { ...q, state: 'failed', attempts: q.attempts + 1, nextAttemptAt: now + backoffMs(q.attempts + 1), lastError: r?.error?.message ?? 'No result returned' });
    } else if (r.status === 'applied' || (r.status === 'duplicate' && original !== 'conflict' && original !== 'rejected')) {
      await d.put('ops', { ...q, state: 'synced', syncedAt: now, result: r, lastError: undefined });
      const reportId = (r.result as { reportId?: string } | undefined)?.reportId;
      if (q.type === 'complete' && reportId && (await d.get('missions', q.missionId))) await updateLocal(q.missionId, (l) => ({ ...l, reportId }));
    } else {
      await d.put('ops', { ...q, state: 'conflict', result: r, lastError: r.error?.message ?? r.status });
      refused.add(q.missionId);
    }
  }
  return refused;
}

export async function clearAll() {
  const d = await db();
  await Promise.all([d.clear('meta'), d.clear('missions'), d.clear('ops')]);
  notify();
}
