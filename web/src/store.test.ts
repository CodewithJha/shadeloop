import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, SyncOp, SyncResult } from '@shadeloop/shared';
import { ApiError, NetworkError, backoffMs, cacheMission, clearAll, closeStore, dismissOp, enqueue, flush, getCached, listOps, resetStuck, updateLocal } from './store.ts';

const applied = (ops: SyncOp[]): SyncResult[] => ops.map((o) => ({ opId: o.opId, status: 'applied', result: o.type === 'complete' ? { reportId: 'r1' } : {} }));

beforeEach(async () => {
  await clearAll();
});

describe('offline op queue', () => {
  it('persists ops in order with unique stable opIds across reloads', async () => {
    const a = await enqueue({ type: 'start', missionId: 'm1' });
    const b = await enqueue({ type: 'observation', missionId: 'm1', payload: { attribute: 'noise_level', value: 'quiet' } });
    expect(a.opId).not.toBe(b.opId);
    await closeStore();
    const ops = await listOps();
    expect(ops.map((o) => o.opId)).toEqual([a.opId, b.opId]);
    expect(ops.every((o) => o.state === 'pending')).toBe(true);
  });

  it('marks ops synced and records the report id for completed missions', async () => {
    await cacheMission({ id: 'm1', status: 'active', session: { currentStep: 0, startedAt: null, completedAt: null }, reportId: null } as unknown as Mission);
    await enqueue({ type: 'complete', missionId: 'm1' });
    const send = vi.fn(async (ops: SyncOp[]) => applied(ops));
    await flush(send);
    expect(send).toHaveBeenCalledOnce();
    expect((await listOps())[0]).toMatchObject({ state: 'synced' });
    expect((await getCached('m1'))!.local.reportId).toBe('r1');
  });

  it('backs off on network errors and retries only when due', async () => {
    const op = await enqueue({ type: 'start', missionId: 'm1' });
    const t = 1_000_000;
    await flush(async () => {
      throw new NetworkError('offline');
    }, t);
    let [q] = await listOps();
    expect(q).toMatchObject({ state: 'failed', attempts: 1, nextAttemptAt: t + backoffMs(1), lastError: 'offline' });

    const send = vi.fn(async (ops: SyncOp[]) => applied(ops));
    await flush(send, t + 100);
    expect(send).not.toHaveBeenCalled();
    await flush(send, t + backoffMs(1));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0][0].opId).toBe(op.opId);
    [q] = await listOps();
    expect(q.state).toBe('synced');
  });

  it('treats 5xx/429 as recoverable and 4xx as conflicts', async () => {
    await enqueue({ type: 'start', missionId: 'm1' });
    await flush(async () => {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'down');
    }, 0);
    expect((await listOps())[0].state).toBe('failed');
    await flush(async () => {
      throw new ApiError(400, 'VALIDATION_ERROR', 'bad batch');
    }, backoffMs(1));
    expect((await listOps())[0]).toMatchObject({ state: 'conflict', lastError: 'bad batch' });
  });

  it('surfaces per-op conflicts without dropping them, and only the user can dismiss', async () => {
    const ok = await enqueue({ type: 'observation', missionId: 'm1', payload: { attribute: 'crowding', value: 'busy' } });
    const bad = await enqueue({ type: 'start', missionId: 'm1' });
    await flush(async () => [
      { opId: ok.opId, status: 'duplicate' },
      { opId: bad.opId, status: 'conflict', error: { code: 'INVALID_TRANSITION', message: 'Cannot start a mission that is completed' } },
    ]);
    const ops = await listOps();
    expect(ops.map((o) => o.state)).toEqual(['synced', 'conflict']);
    expect(ops[1].lastError).toMatch(/Cannot start/);
    await flush(async () => {
      throw new Error('should not resend conflicts');
    });
    await dismissOp(bad.opId);
    expect((await listOps()).map((o) => o.opId)).toEqual([ok.opId]);
  });

  it('backs off and resends ops the server says to retry, never turning them into conflicts', async () => {
    const op = await enqueue({ type: 'complete', missionId: 'm1' });
    await flush(async () => [{ opId: op.opId, status: 'retry', error: { code: 'IN_PROGRESS', message: 'in progress' } }], 0);
    expect((await listOps())[0]).toMatchObject({ state: 'failed', attempts: 1, nextAttemptAt: backoffMs(1), lastError: 'in progress' });
    await flush(async (ops) => applied(ops), backoffMs(1));
    expect((await listOps())[0].state).toBe('synced');
  });

  it('resends ops left in "syncing" by a crash', async () => {
    await enqueue({ type: 'start', missionId: 'm1' });
    let release!: () => void;
    const pending = flush(() => new Promise<SyncResult[]>((r) => (release = () => r([])))); // never resolves before "crash"
    await new Promise((r) => setTimeout(r, 10));
    expect((await listOps())[0].state).toBe('syncing');
    await resetStuck();
    expect((await listOps())[0].state).toBe('pending');
    release();
    await pending;
  });
});

const mission = (status: Mission['status'], session: Partial<Mission['session']> = {}, reportId: string | null = null) =>
  ({ id: 'm1', status, session: { currentStep: 0, startedAt: null, completedAt: null, ...session }, reportId }) as unknown as Mission;
const obs = (missionId = 'm1') => enqueue({ type: 'observation', missionId, payload: { attribute: 'noise_level', value: 'quiet' } });
const states = async () => (await listOps()).map((o) => `${o.type}:${o.state}`);
const sentTypes = (send: { mock: { calls: SyncOp[][][] } }) => send.mock.calls.map((c) => c[0].map((o) => `${o.missionId}:${o.type}`));

describe('queue ordering', () => {
  it('holds a later observation while the start before it backs off after a 503, then sends both in order', async () => {
    const start = await enqueue({ type: 'start', missionId: 'm1' });
    const t = 1_000_000;
    await flush(async () => {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'down');
    }, t);
    const o = await obs();
    const other = await obs('m2');

    const send = vi.fn(async (ops: SyncOp[]) => applied(ops));
    await flush(send, t + 100);
    expect(sentTypes(send)).toEqual([['m2:observation']]); // other missions don't wait; m1's observation does
    expect(await states()).toEqual(['start:failed', 'observation:pending', 'observation:synced']);

    send.mockClear();
    await flush(send, t + backoffMs(1));
    expect(send.mock.calls[0][0].map((x) => x.opId)).toEqual([start.opId, o.opId]);
    expect((await listOps()).filter((x) => x.opId !== other.opId).map((x) => x.state)).toEqual(['synced', 'synced']);
  });

  it.each([
    ['429', async (): Promise<SyncResult[]> => Promise.reject(new ApiError(429, 'RATE_LIMITED', 'slow down'))],
    ['timeout', async (): Promise<SyncResult[]> => Promise.reject(new NetworkError('Request timed out'))],
    ['retry status', async (ops: SyncOp[]): Promise<SyncResult[]> => [{ opId: ops[0].opId, status: 'retry', error: { code: 'IN_PROGRESS', message: 'in progress' } }]],
    ['missing result', async (): Promise<SyncResult[]> => []],
  ])('a %s does not let dependent ops overtake or become conflicts', async (_name, fail) => {
    await enqueue({ type: 'start', missionId: 'm1' });
    await flush(fail, 0);
    await obs();
    const send = vi.fn(async (ops: SyncOp[]) => applied(ops));
    await flush(send, 1);
    expect(send).not.toHaveBeenCalled();
    expect(await states()).toEqual(['start:failed', 'observation:pending']);
    await flush(send, backoffMs(1));
    expect(sentTypes(send)).toEqual([['m1:start', 'm1:observation']]);
    expect(await states()).toEqual(['start:synced', 'observation:synced']);
  });

  it('stops after a server retry mid-batch and resends the rest in order', async () => {
    const [a, b, c] = [await enqueue({ type: 'start', missionId: 'm1' }), await obs(), await obs()];
    await flush(async () => [
      { opId: a.opId, status: 'applied' },
      { opId: b.opId, status: 'retry', error: { code: 'CONFLICT', message: 'busy' } },
    ], 0);
    expect(await states()).toEqual(['start:synced', 'observation:failed', 'observation:failed']);
    const send = vi.fn(async (ops: SyncOp[]) => applied(ops));
    await flush(send, backoffMs(1));
    expect(send.mock.calls[0][0].map((x) => x.opId)).toEqual([b.opId, c.opId]);
  });

  it('resends a lost-response observation with the same opId and never duplicates it locally', async () => {
    await cacheMission(mission('active'));
    const q = await obs();
    await updateLocal('m1', (l) => ({ ...l, observations: [...l.observations, { opId: q.opId, attribute: 'noise_level', value: 'quiet', at: q.clientTs }] }));
    const send = vi.fn(async (ops: SyncOp[]): Promise<SyncResult[]> => {
      if (send.mock.calls.length === 1) throw new NetworkError('Request timed out'); // server applied it, response lost
      return ops.map((o) => ({ opId: o.opId, status: 'duplicate', result: { originalStatus: 'applied' } }));
    });
    await flush(send, 0);
    await flush(send, backoffMs(1));
    expect(send.mock.calls.map((c) => c[0][0].opId)).toEqual([q.opId, q.opId]);
    expect(await states()).toEqual(['observation:synced']);
    expect((await getCached('m1'))!.local.observations).toHaveLength(1);
  });

  it('keeps a resent op a conflict when its stored answer was a refusal', async () => {
    const q = await obs();
    await flush(async () => [{ opId: q.opId, status: 'duplicate', result: { originalStatus: 'conflict' }, error: { code: 'MISSION_NOT_ACTIVE', message: 'not active' } }]);
    expect((await listOps())[0]).toMatchObject({ state: 'conflict', lastError: 'not active' });
  });

  it('never processes the queue concurrently, in this tab or across tabs', async () => {
    const q = await enqueue({ type: 'start', missionId: 'm1' });
    let release!: () => void;
    const send = vi.fn((ops: SyncOp[]) => new Promise<SyncResult[]>((r) => (release = () => r(applied(ops)))));
    const runs = [flush(send), flush(send), flush(send)];
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    runs.push(flush(send));
    release();
    await Promise.all(runs);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].map((o) => o.opId)).toEqual([q.opId]);

    await enqueue({ type: 'pause', missionId: 'm1' });
    let unlock!: () => void;
    const otherTab = navigator.locks.request('shadeloop-sync', () => new Promise<void>((r) => (unlock = r)));
    await vi.waitFor(() => expect(unlock).toBeDefined());
    const send2 = vi.fn(async (ops: SyncOp[]) => applied(ops));
    await flush(send2);
    expect(send2).not.toHaveBeenCalled();
    unlock();
    await otherTab;
    await flush(send2);
    expect(send2).toHaveBeenCalledOnce();
  });

  it('recovers an op left "syncing" by a reload and resends it with the same opId', async () => {
    const q = await enqueue({ type: 'start', missionId: 'm1' });
    await closeStore();
    const raw = await openDB('shadeloop', 1);
    await raw.put('ops', { ...(await raw.get('ops', q.opId)), state: 'syncing' });
    raw.close();
    const send = vi.fn(async (ops: SyncOp[]) => applied(ops));
    await flush(send);
    expect(send.mock.calls[0][0].map((o) => o.opId)).toEqual([q.opId]);
    expect(await states()).toEqual(['start:synced']);
  });
});

describe('reconciliation', () => {
  it('adopts server mission state when nothing is queued for it', async () => {
    await cacheMission(mission('planned'));
    await updateLocal('m1', (l) => ({ ...l, status: 'active', currentStep: 2 }));
    await cacheMission(mission('completed', { currentStep: 3, startedAt: '2026-10-11T10:00:00Z', completedAt: '2026-10-11T10:20:00Z' }, 'r9'));
    expect((await getCached('m1'))!.local).toMatchObject({ status: 'completed', currentStep: 3, completedAt: '2026-10-11T10:20:00Z', reportId: 'r9' });
  });

  it('keeps local optimistic state while ops for the mission are still queued', async () => {
    await cacheMission(mission('planned'));
    await enqueue({ type: 'start', missionId: 'm1' });
    await updateLocal('m1', (l) => ({ ...l, status: 'active', currentStep: 2 }));
    await cacheMission(mission('planned'));
    expect((await getCached('m1'))!.local).toMatchObject({ status: 'active', currentStep: 2 });
  });

  it('refetches a mission after a refusal and adopts its state without discarding queued data', async () => {
    await cacheMission(mission('planned'));
    const start = await enqueue({ type: 'start', missionId: 'm1' });
    await updateLocal('m1', (l) => ({ ...l, status: 'active' }));
    const getMission = vi.fn(async () => mission('cancelled'));
    await flush(async () => [{ opId: start.opId, status: 'conflict', error: { code: 'INVALID_TRANSITION', message: 'Cannot start a mission that is cancelled' } }], 0, getMission);
    expect(getMission).toHaveBeenCalledWith('m1');
    expect((await getCached('m1'))!.local.status).toBe('cancelled');
    expect(await states()).toEqual(['start:conflict']);
  });

  it('stops sending for an expired (404) mission, keeps its ops and leaves them exportable', async () => {
    await cacheMission(mission('planned'));
    const start = await enqueue({ type: 'start', missionId: 'm1' });
    await updateLocal('m1', (l) => ({ ...l, status: 'active' }));
    const getMission = vi.fn(async (): Promise<Mission> => Promise.reject(new ApiError(404, 'NOT_FOUND', 'Mission not found')));
    const send = vi.fn(async (ops: SyncOp[]): Promise<SyncResult[]> => ops.map((o) => ({ opId: o.opId, status: 'rejected', error: { code: 'NOT_FOUND', message: 'Mission not found' } })));
    await flush(send, 0, getMission);
    expect((await getCached('m1'))!.gone).toBe(true);
    await obs(); // recorded before the device learned the mission is gone
    for (const t of [1, 60_000, 3_600_000]) await flush(send, t, getMission);
    expect(send).toHaveBeenCalledOnce();
    expect(getMission).toHaveBeenCalledOnce();
    const ops = JSON.parse(JSON.stringify(await listOps()));
    expect(ops.map((o: SyncOp & { state: string }) => [o.opId === start.opId, o.state])).toEqual([[true, 'conflict'], [false, 'pending']]);
    expect(ops[1].payload).toEqual({ attribute: 'noise_level', value: 'quiet' });
  });
});
