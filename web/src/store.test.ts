import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, SyncOp, SyncResult } from '@shadeloop/shared';
import { ApiError, NetworkError, backoffMs, cacheMission, clearAll, closeStore, dismissOp, enqueue, flush, getCached, listOps, resetStuck } from './store.ts';

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
