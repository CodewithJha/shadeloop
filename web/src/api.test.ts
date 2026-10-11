import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncOp } from '@shadeloop/shared';
import { api } from './api.ts';
import { ApiError, BadResponseError, NetworkError, clearAll, delMeta, enqueue, flush, getMeta, isRecoverable, listOps, setMeta } from './store.ts';

const OLD = 'o'.repeat(43);
const NEW = 'n'.repeat(43);
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const fetchMock = vi.fn(async (url: string, init: RequestInit) => handler(url.replace('/api/v1', ''), init));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const envelope = (status: number, code: string, message: string, headers?: Record<string, string>) => json(status, { error: { code, message, requestId: 'req-1' } }, headers);
const bearer = (init: RequestInit) => (init.headers as Record<string, string>).authorization;
const calls = (path: string) => fetchMock.mock.calls.filter(([u]) => u === `/api/v1${path}`);
const fail = (p: Promise<unknown>) => p.then(() => expect.unreachable('expected a rejection'), (e: Error) => e);
async function failsAs(p: Promise<unknown>, cls: new (...a: never[]) => Error, props: object) {
  const e = await fail(p);
  expect(e).toBeInstanceOf(cls);
  expect(e).toMatchObject(props);
  return e;
}
/** `/sessions` answers with NEW; everything else with `{}` unless `rest` says otherwise. */
const server = (rest: Handler = () => json(200, {})): Handler => (path, init) => (path === '/sessions' ? json(201, { token: NEW }) : rest(path, init));

beforeEach(async () => {
  await clearAll();
  fetchMock.mockClear();
  handler = server();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('session creation', () => {
  it('a 429 from POST /sessions is a rate-limit ApiError with Retry-After, not "offline"', async () => {
    handler = () => envelope(429, 'RATE_LIMITED', 'Too many requests, slow down', { 'retry-after': '42' });
    const e = await fail(api.prefs());
    expect(e).toBeInstanceOf(ApiError);
    expect(e).not.toBeInstanceOf(NetworkError);
    expect(e).toMatchObject({ status: 429, code: 'RATE_LIMITED', requestId: 'req-1', retryAfter: 42, message: 'Too many requests, try again in 42 s' });
    expect(isRecoverable(e)).toBe(true);
  });

  it('a 5xx from POST /sessions is a server error, not "offline"', async () => {
    handler = () => envelope(500, 'INTERNAL', 'Internal server error');
    expect(await fail(api.prefs())).toMatchObject({ status: 500, code: 'INTERNAL', message: 'Internal server error' });
    handler = () => new Response('<html>Bad gateway</html>', { status: 502 });
    const e = await fail(api.prefs());
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 502, code: 'HTTP_502', message: 'Server error (HTTP 502)' });
  });

  it('parallel first requests share one POST /sessions', async () => {
    await Promise.all([api.history(), api.overview(), api.attributes(), api.prefs()]);
    expect(calls('/sessions')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => !u.endsWith('/sessions')).map(([, init]) => bearer(init))).toEqual([`Bearer ${NEW}`, `Bearer ${NEW}`, `Bearer ${NEW}`, `Bearer ${NEW}`]);
    expect(await getMeta('token')).toBe(NEW);
  });

  it('a failed session request is not remembered: the next call creates the session', async () => {
    handler = () => envelope(503, 'DEPENDENCY_UNAVAILABLE', 'down');
    await fail(Promise.all([api.prefs(), api.history()]));
    expect(calls('/sessions')).toHaveLength(1);
    handler = server();
    await api.prefs();
    expect(calls('/sessions')).toHaveLength(2);
    expect(await getMeta('token')).toBe(NEW);
  });
});

describe('error classes', () => {
  beforeEach(() => setMeta('token', NEW));

  it('only a failed fetch is a NetworkError', async () => {
    handler = () => {
      throw new TypeError('Failed to fetch');
    };
    await failsAs(api.prefs(), NetworkError, { message: 'You appear to be offline' });
    handler = () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    await failsAs(api.prefs(), NetworkError, { message: 'Request timed out' });
    // Failing to reach POST /sessions is offline too.
    await delMeta('token');
    await failsAs(api.prefs(), NetworkError, { message: 'Request timed out' });
  });

  it('keeps the server envelope for 404 and 409', async () => {
    handler = () => envelope(404, 'NOT_FOUND', 'Mission not found');
    await failsAs(api.mission('m1'), ApiError, { status: 404, code: 'NOT_FOUND', message: 'Mission not found', requestId: 'req-1' });
    handler = () => envelope(409, 'INVALID_TRANSITION', 'Cannot start a mission that is completed');
    expect(await fail(api.mission('m1'))).toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });

  it('a malformed success response is a distinct, retryable error', async () => {
    handler = () => new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    const e = await fail(api.prefs());
    expect(e).toBeInstanceOf(BadResponseError);
    expect(e).not.toBeInstanceOf(NetworkError);
    expect(isRecoverable(e)).toBe(true);
    handler = () => json(200, { nope: true });
    expect(await fail(api.sync([]))).toBeInstanceOf(BadResponseError);
  });

  it('the queue backs off on a malformed response instead of marking a conflict', async () => {
    handler = () => json(200, { results: 'nope' });
    await enqueue({ type: 'start', missionId: 'm1' });
    await flush(api.sync, 0);
    expect((await listOps())[0]).toMatchObject({ state: 'failed', attempts: 1, lastError: 'The server sent an unexpected response' });
  });
});

describe('expired sessions (401)', () => {
  beforeEach(() => setMeta('token', OLD));
  const refuseOld: Handler = server((_p, init) => (bearer(init) === `Bearer ${OLD}` ? envelope(401, 'UNAUTHORIZED', 'Unknown session token') : json(200, {})));

  it('replaces the session once and retries once', async () => {
    handler = refuseOld;
    await api.prefs();
    expect(fetchMock.mock.calls.map(([u, init]) => [u, bearer(init)])).toEqual([
      ['/api/v1/preferences', `Bearer ${OLD}`],
      ['/api/v1/sessions', undefined],
      ['/api/v1/preferences', `Bearer ${NEW}`],
    ]);
    expect(await getMeta('token')).toBe(NEW);
  });

  it('concurrent 401s share one replacement session', async () => {
    handler = refuseOld;
    await Promise.all([api.history(), api.overview(), api.attributes()]);
    expect(calls('/sessions')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('a persistent 401 is reported after one replacement, without looping', async () => {
    handler = server(() => envelope(401, 'UNAUTHORIZED', 'Unknown session token'));
    const e = await failsAs(api.prefs(), ApiError, { status: 401, code: 'UNAUTHORIZED' });
    expect(e.message).not.toContain(OLD);
    expect(e.message).not.toContain(NEW);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('sync request', () => {
  it('stamps sentAt when sending, leaving queued opIds and clientTs untouched', async () => {
    await setMeta('token', NEW);
    let sent: { ops: SyncOp[]; sentAt: string } | undefined;
    handler = (_p, init) => {
      sent = JSON.parse(String(init.body));
      return json(200, { results: sent!.ops.map((o) => ({ opId: o.opId, status: 'applied' })) });
    };
    const op: SyncOp = { opId: crypto.randomUUID(), missionId: 'm1', clientTs: '2026-10-11T08:00:00.000Z', type: 'start' };
    const before = Date.now();
    await api.sync([op]);
    expect(sent!.ops).toEqual([op]);
    expect(Date.parse(sent!.sentAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(sent!.sentAt)).toBeLessThanOrEqual(Date.now());
  });
});
