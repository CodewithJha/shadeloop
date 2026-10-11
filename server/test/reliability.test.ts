import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, col, connectDb, ensureIndexes } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { clearProviderCache, discover, getWeather } from '../src/providers.ts';
import { clearAiHealthCache } from '../src/ai.ts';
import { lastCall } from '../src/integrations.ts';
import { env, RULES } from '../src/config.ts';

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
const down: Route = () => {
  throw new TypeError('fetch failed');
};
const meteo = { current: { time: '2026-06-01T06:00', temperature_2m: 20, apparent_temperature: 20, precipitation: 0, wind_speed_10m: 5, weather_code: 0 } };
const overpass = { elements: [{ type: 'way', id: 1, center: { lat: 12.981, lon: 77.591 }, tags: { leisure: 'park', name: 'Test Park' } }] };

let routes: Route = down;
let calls: string[] = [];
let app: Express;
let db: Db;
const rules = RULES as unknown as { providerCache: { maxEntries: number; ttlMs: number }; providerRetryDelayMs: number };
const saved = { cache: { ...rules.providerCache }, delay: rules.providerRetryDelayMs, timeout: env.HTTP_TIMEOUT_MS };

beforeAll(async () => {
  db = await connectDb();
  app = createApp();
  vi.stubGlobal('fetch', async (u: string | URL, init?: RequestInit) => {
    calls.push(String(u));
    return routes(String(u), init);
  });
  rules.providerRetryDelayMs = 10;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  rules.providerRetryDelayMs = saved.delay;
  await closeDb();
});
beforeEach(() => {
  routes = down;
  calls = [];
  clearProviderCache();
  clearAiHealthCache();
});
afterEach(() => {
  rules.providerCache = { ...saved.cache };
  env.HTTP_TIMEOUT_MS = saved.timeout;
  vi.useRealTimers();
});

const api = '/api/v1';
const meteoCalls = () => calls.filter((u) => u.includes('open-meteo')).length;
const at = (lat: number) => ({ lat, lon: 77.59 });

describe('indexes', () => {
  const OWNED = ['missions', 'observations', 'reports', 'sync_records', 'preferences'];
  const plan = (o: unknown) => JSON.stringify(o);

  it('are created idempotently on every start and never include the replaced observations index', async () => {
    const names = async () => Object.fromEntries(await Promise.all(['observations', 'sync_records'].map(async (c) => [c, (await db.collection(c).indexes()).map((i) => i.name).sort()])));
    const before = await names();
    await ensureIndexes(db);
    await ensureIndexes(db);
    expect(await names()).toEqual(before);
    expect(before.sync_records).toContain('ownerId_1');
    expect(before.observations).not.toContain('locationId_1_attribute_1_clientTs_-1');
  });

  it('serve the export (find) and delete (deleteMany) filters of every owned collection with an index scan', async () => {
    for (const c of OWNED) {
      const find = await db.collection(c).find({ ownerId: 'o1' }).explain('queryPlanner');
      expect(plan(find.queryPlanner.winningPlan), `${c} find`).toContain('IXSCAN');
      const del = await db.command({ explain: { delete: c, deletes: [{ q: { ownerId: 'o1' }, limit: 0 }] }, verbosity: 'queryPlanner' });
      expect(plan(del.queryPlanner.winningPlan), `${c} delete`).toContain('IXSCAN');
      expect(plan(del.queryPlanner.winningPlan), `${c} delete`).not.toContain('COLLSCAN');
    }
  });
});

describe('provider cache', () => {
  it('evicts the oldest entry past the size cap', async () => {
    rules.providerCache = { maxEntries: 2, ttlMs: 60_000 };
    routes = () => json(meteo);
    for (const lat of [10, 11, 12]) await getWeather(at(lat));
    expect(meteoCalls()).toBe(3);
    await getWeather(at(12));
    await getWeather(at(11));
    expect(meteoCalls()).toBe(3);
    await getWeather(at(10));
    expect(meteoCalls()).toBe(4);
  });

  it('expires entries after the TTL and keeps the original retrievedAt on a hit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    routes = () => json(meteo);
    const first = await getWeather(at(10));
    vi.setSystemTime(new Date('2026-10-11T10:05:00Z'));
    const hit = await getWeather(at(10));
    expect(meteoCalls()).toBe(1);
    expect(hit.retrievedAt).toBe(first.retrievedAt);
    expect(hit.retrievedAt).toBe('2026-10-11T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-11T10:11:00Z'));
    const fresh = await getWeather(at(10));
    expect(meteoCalls()).toBe(2);
    expect(fresh.retrievedAt).toBe('2026-10-11T10:11:00.000Z');
  });

  it('keys Overpass by cell and radius only, so free-text queries share one call', async () => {
    routes = (url) => (url.includes('overpass') ? json(overpass) : down(url));
    await discover({ lat: 12.98, lon: 77.59 }, 1000, 'park');
    await discover({ lat: 12.9812, lon: 77.5899 }, 1000, 'some long free text');
    expect(calls.filter((u) => u.includes('overpass'))).toHaveLength(1);
  });
});

describe('provider failures', () => {
  it('retries a 5xx once and succeeds', async () => {
    let n = 0;
    routes = () => (++n === 1 ? json({}, 503) : json(meteo));
    expect(await getWeather(at(10))).toMatchObject({ available: true });
    expect(meteoCalls()).toBe(2);
  });

  it('gives up after one retry on repeated 5xx or network errors and reports DEGRADED', async () => {
    routes = () => json({}, 504);
    expect(await getWeather(at(10))).toMatchObject({ available: false, reason: 'Open-Meteo HTTP 504' });
    expect(meteoCalls()).toBe(2);
    routes = down;
    expect(await getWeather(at(11))).toMatchObject({ available: false, reason: 'fetch failed' });
    expect(meteoCalls()).toBe(4);
    expect(lastCall('open-meteo')).toMatchObject({ ok: false });
  });

  it('does not retry a 429 and leaves the provider alone until Retry-After passes', async () => {
    routes = () => json({}, 429, { 'retry-after': '120' });
    expect(await getWeather(at(10))).toMatchObject({ available: false, reason: 'Open-Meteo HTTP 429' });
    routes = () => json(meteo);
    const next = await getWeather(at(11));
    expect(next).toMatchObject({ available: false });
    expect(next.reason).toMatch(/rate limited us; not called for 1\d\d s/);
    expect(meteoCalls()).toBe(1);
    expect(lastCall('open-meteo')).toMatchObject({ ok: false });
  });

  it('does not retry a timeout', async () => {
    env.HTTP_TIMEOUT_MS = 50;
    routes = (_u, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    expect(await getWeather(at(10))).toMatchObject({ available: false, reason: 'timeout' });
    expect(meteoCalls()).toBe(1);
  });

  it('marks discovery DEGRADED and never invents places when Overpass fails', async () => {
    routes = () => json({}, 504);
    const r = await discover({ lat: 12.98, lon: 77.59 });
    expect(r.locations).toEqual([]);
    expect(r.sources).toEqual([{ name: 'openstreetmap', ok: false, count: 0, error: 'Overpass HTTP 504' }]);
    expect(calls.filter((u) => u.includes('overpass'))).toHaveLength(2);
  });
});

describe('planning', () => {
  it('starts discovery and weather together instead of one after the other', async () => {
    const started = new Set<string>();
    let bothStartedFirst = false;
    let anyResolved = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    routes = async (url) => {
      const name = url.includes('overpass') ? 'osm' : url.includes('open-meteo') ? 'meteo' : null;
      if (!name) return down(url);
      started.add(name);
      if (started.size === 2) {
        bothStartedFirst = !anyResolved;
        release();
      }
      // Sequential code would wait out this timeout before starting the second call.
      await Promise.race([gate, new Promise((r) => setTimeout(r, 3000))]);
      anyResolved = true;
      return json(name === 'osm' ? overpass : meteo);
    };
    const h = { Authorization: `Bearer ${(await request(app).post(`${api}/sessions`).expect(201)).body.token}` };
    const r = await request(app).post(`${api}/missions/plan`).set(h).send({ availableMinutes: 20, missionType: 'quiet_break', coarseLocation: { lat: 12.98, lon: 77.59 } }).expect(201);
    expect(bothStartedFirst).toBe(true);
    expect(r.body.planning.weather).toMatchObject({ available: true });
  });
});

describe('health and sessions', () => {
  it('reuses one AI probe for repeated /health/dependencies calls', async () => {
    await request(app).get(`${api}/health/dependencies`).expect(200);
    await request(app).get(`${api}/health/dependencies`).expect(200);
    expect(calls.filter((u) => u.includes('/api/tags'))).toHaveLength(1);
  });

  it('writes lastSeenAt at most once per throttle window', async () => {
    const { token } = (await request(app).post(`${api}/sessions`).expect(201)).body;
    const filter = { tokenHash: createHash('sha256').update(token).digest('hex') };
    const seen = async () => (await col('owners').findOne(filter))!.lastSeenAt as Date;
    const created = await seen();
    await request(app).get(`${api}/preferences`).set({ Authorization: `Bearer ${token}` }).expect(200);
    expect(await seen()).toEqual(created);
    await col('owners').updateOne(filter, { $set: { lastSeenAt: new Date(Date.now() - RULES.ownerSeenWriteMs - 1000) } });
    await request(app).get(`${api}/preferences`).set({ Authorization: `Bearer ${token}` }).expect(200);
    expect(Date.now() - (await seen()).getTime()).toBeLessThan(5000);
  });

  it('only asks browsers to upgrade to HTTPS in production', async () => {
    const csp = async (a: Express) => (await request(a).get(`${api}/health`).expect(200)).headers['content-security-policy'];
    expect(await csp(app)).not.toContain('upgrade-insecure-requests');
    env.NODE_ENV = 'production';
    try {
      expect(await csp(createApp())).toContain('upgrade-insecure-requests');
    } finally {
      env.NODE_ENV = 'test';
    }
  });
});

describe('process startup', () => {
  const run = (file: string, extra: Record<string, string>) =>
    spawnSync(process.execPath, [fileURLToPath(new URL(`../src/${file}`, import.meta.url))], {
      env: { ...process.env, LOG_LEVEL: 'info', ...extra },
      encoding: 'utf8',
      timeout: 30_000,
    });

  it('refuses the in-memory database in production', () => {
    const r = run('config.ts', { NODE_ENV: 'production', MONGODB_URI: 'memory' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MONGODB_URI: MONGODB_URI=memory is not allowed in production');
  });

  it('exits non-zero with a clear log when MongoDB is unreachable, without printing credentials', () => {
    const r = run('index.ts', { NODE_ENV: 'production', MONGODB_URI: 'mongodb://shadeloop:s3cret-pw@127.0.0.1:9/x' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('startup failed: could not connect to MongoDB');
    expect(r.stdout + r.stderr).not.toContain('s3cret-pw');
  });
});
