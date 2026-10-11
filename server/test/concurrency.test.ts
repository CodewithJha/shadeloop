import request from 'supertest';
import type { Express } from 'express';
import { Collection } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mission, Report } from '@shadeloop/shared';
import { closeDb, col, connectDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';

let app: Express;

beforeAll(async () => {
  await connectDb();
  app = createApp();
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('fetch failed');
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});
afterEach(() => vi.restoreAllMocks());

const api = '/api/v1';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
async function session() {
  const r = await request(app).post(`${api}/sessions`).expect(201);
  return { Authorization: `Bearer ${r.body.token}` };
}
async function started(h: Record<string, string>) {
  const r = await request(app).post(`${api}/missions/plan`).set(h).send({ availableMinutes: 20, missionType: 'quiet_break' }).expect(201);
  const m = r.body.missions[0] as Mission;
  await request(app).post(`${api}/missions/${m.id}/start`).set(h).send({}).expect(200);
  return m;
}
const observe = (h: Record<string, string>, id: string, attribute: string, value: string, opId = uuid()) =>
  request(app).post(`${api}/missions/${id}/observations`).set(h).send({ attribute, value, opId, clientTs: now() });
const complete = (h: Record<string, string>, id: string, body: object = {}) => request(app).post(`${api}/missions/${id}/complete`).set(h).send(body);
const reportCount = (missionId: string) => col('reports').countDocuments({ missionId });

/** Make the next insert into `reports` fail like a dropped connection would. */
function failNextReportInsert() {
  const orig = Collection.prototype.insertOne;
  const spy = vi.spyOn(Collection.prototype, 'insertOne').mockImplementation(function (this: Collection, ...args: unknown[]) {
    if (this.collectionName === 'reports') {
      spy.mockRestore();
      return Promise.reject(new Error('injected report write failure'));
    }
    return (orig as (...a: unknown[]) => never).apply(this, args);
  });
}

describe('completion vs observations', () => {
  const OBS: [string, string][] = [
    ['noise_level', 'quiet'],
    ['crowding', 'busy'],
    ['shade_quality', 'good'],
    ['bench_availability', 'found'],
    ['path_condition', 'uneven'],
    ['step_free_access', 'yes'],
  ];

  it('every accepted observation is in the report and every other one is rejected', async () => {
    const h = await session();
    for (let i = 0; i < 15; i++) {
      const m = await started(h);
      const [done, ...obs] = await Promise.all([complete(h, m.id), ...OBS.map(([a, v]) => observe(h, m.id, a, v))]);
      expect(done.status).toBe(200);
      const report = (await request(app).get(`${api}/reports/${done.body.reportId}`).set(h).expect(200)).body as Report;
      const inReport = new Set(report.actual.observations.map((o) => o.attribute));
      OBS.forEach(([a], j) => {
        expect([201, 409]).toContain(obs[j].status);
        if (obs[j].status === 201) expect(inReport.has(a as never), `${a} accepted but missing from report`).toBe(true);
        else {
          expect(obs[j].body.error.code).toBe('MISSION_NOT_ACTIVE');
          expect(inReport.has(a as never), `${a} rejected but in report`).toBe(false);
        }
      });
      const stored = (await request(app).get(`${api}/missions/${m.id}/observations`).set(h).expect(200)).body.items;
      expect(stored).toHaveLength(report.actual.observations.length);
    }
  });

  /** Run `fn` right before (or right after) the next observation row is written, to force one interleaving. */
  function aroundNextObservationInsert(when: 'before' | 'after', fn: () => Promise<unknown>) {
    const orig = Collection.prototype.insertOne;
    const spy = vi.spyOn(Collection.prototype, 'insertOne').mockImplementation(async function (this: Collection, ...args: unknown[]) {
      const insert = () => (orig as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      if (this.collectionName !== 'observations') return insert() as never;
      spy.mockRestore();
      if (when === 'before') await fn();
      const r = await insert();
      if (when === 'after') await fn();
      return r as never;
    });
  }

  it('rejects an observation written after the report was built, and keeps it out of evidence', async () => {
    const h = await session();
    const m = await started(h);
    await col('missions').updateOne({ _id: m.id as never }, { $set: { selectedLocation: { ...m.candidateLocations[0], id: 'test:race' } } });
    let reportId = '';
    aroundNextObservationInsert('before', async () => (reportId = (await complete(h, m.id).expect(200)).body.reportId));
    expect((await observe(h, m.id, 'shade_quality', 'good').expect(409)).body.error.code).toBe('MISSION_NOT_ACTIVE');
    const report = (await request(app).get(`${api}/reports/${reportId}`).set(h).expect(200)).body as Report;
    expect(report.actual.observations).toHaveLength(0);
    expect(await col('observations').countDocuments({ missionId: m.id })).toBe(0);
    expect(await col('evidence').findOne({ locationId: 'test:race' })).toBeNull();
  });

  it('accepts an observation written before the completion it raced, and it is in the report', async () => {
    const h = await session();
    const m = await started(h);
    let reportId = '';
    aroundNextObservationInsert('after', async () => (reportId = (await complete(h, m.id).expect(200)).body.reportId));
    await observe(h, m.id, 'noise_level', 'loud').expect(201);
    const report = (await request(app).get(`${api}/reports/${reportId}`).set(h).expect(200)).body as Report;
    expect(report.actual.observations).toMatchObject([{ attribute: 'noise_level', value: 'loud' }]);
  });
});

describe('report persistence and recovery', () => {
  it('a failed report write leaves the mission completed and any retry builds the one report', async () => {
    const h = await session();
    const m = await started(h);
    await observe(h, m.id, 'noise_level', 'quiet').expect(201);
    failNextReportInsert();
    await complete(h, m.id, { rating: 5, feedback: 'nice' }).expect(500);
    const mission = (await request(app).get(`${api}/missions/${m.id}`).set(h).expect(200)).body as Mission;
    expect(mission.status).toBe('completed');
    expect(mission.reportId).toBeTruthy();
    expect(await reportCount(m.id)).toBe(0);

    // Reading the report by its id heals it.
    const report = (await request(app).get(`${api}/reports/${mission.reportId}`).set(h).expect(200)).body as Report;
    expect(report).toMatchObject({ id: mission.reportId, missionId: m.id, feedback: { rating: 5, text: 'nice' } });
    expect(report.actual.observations).toHaveLength(1);
    expect(report.summary).toMatchObject({ generator: 'template', provider: null });
    expect(await reportCount(m.id)).toBe(1);
  });

  it('a repeated complete also heals a missing report, and so does history', async () => {
    const h = await session();
    const a = await started(h);
    failNextReportInsert();
    await complete(h, a.id).expect(500);
    const again = await complete(h, a.id).expect(200);
    expect(again.body.reportId).toBe(((await col('missions').findOne({ _id: a.id as never }))!).reportId);
    expect(await reportCount(a.id)).toBe(1);

    const b = await started(h);
    failNextReportInsert();
    await complete(h, b.id).expect(500);
    const hist = await request(app).get(`${api}/history`).set(h).expect(200);
    expect(hist.body.items.find((i: { mission: Mission }) => i.mission.id === b.id).report).toBeTruthy();
    expect(await reportCount(b.id)).toBe(1);
  });

  it('replaces an orphan report left by the old insert-before-update order', async () => {
    const h = await session();
    const m = await started(h);
    await col('reports').insertOne({ _id: 'orphan' as never, ownerId: 'x', missionId: m.id });
    const done = await complete(h, m.id).expect(200);
    expect(done.body.reportId).not.toBe('orphan');
    await request(app).get(`${api}/reports/${done.body.reportId}`).set(h).expect(200);
    expect(await reportCount(m.id)).toBe(1);
  });

  it('repeating complete after success returns the same report', async () => {
    const h = await session();
    const m = await started(h);
    const first = await complete(h, m.id).expect(200);
    const results = await Promise.all([complete(h, m.id), complete(h, m.id), complete(h, m.id, { rating: 1 })]);
    for (const r of results) expect(r.status === 200 && r.body.reportId).toBe(first.body.reportId);
    expect(await reportCount(m.id)).toBe(1);
  });

  it('concurrent completes produce one report', async () => {
    const h = await session();
    const m = await started(h);
    const results = await Promise.all(Array.from({ length: 10 }, () => complete(h, m.id)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(results.map((r) => r.body.reportId)).size).toBe(1);
    expect(await reportCount(m.id)).toBe(1);
  });
});

describe('cross-session isolation', () => {
  it('another session cannot complete, observe or read the mission or its report', async () => {
    const h = await session();
    const other = await session();
    const m = await started(h);
    await complete(other, m.id).expect(404);
    await observe(other, m.id, 'noise_level', 'quiet').expect(404);
    await request(app).get(`${api}/missions/${m.id}`).set(other).expect(404);
    const done = await complete(h, m.id).expect(200);
    await request(app).get(`${api}/reports/${done.body.reportId}`).set(other).expect(404);
    await complete(other, m.id).expect(404);
  });
});
