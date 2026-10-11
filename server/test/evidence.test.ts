import request from 'supertest';
import type { Express } from 'express';
import { Collection } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mission } from '@shadeloop/shared';
import { closeDb, col, connectDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { RULES } from '../src/config.ts';
import { recomputeEvidence } from '../src/missions.ts';

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

type H = Record<string, string>;
const api = '/api/v1';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const { perMission, perAttribute } = RULES.observationLimits;

async function session(): Promise<H> {
  const r = await request(app).post(`${api}/sessions`).expect(201);
  return { Authorization: `Bearer ${r.body.token}` };
}
/** A started mission whose selected place is `locationId`, so its observations feed that place's evidence. */
async function startedAt(h: H, locationId: string | null = null) {
  const r = await request(app).post(`${api}/missions/plan`).set(h).send({ availableMinutes: 20, missionType: 'quiet_break' }).expect(201);
  const m = r.body.missions[0] as Mission;
  if (locationId) await col('missions').updateOne({ _id: m.id as never }, { $set: { selectedLocation: { id: locationId, name: 'Test place' } } });
  await request(app).post(`${api}/missions/${m.id}/start`).set(h).send({}).expect(200);
  return m;
}
const observe = (h: H, id: string, attribute: string, value: string, opId = uuid()) =>
  request(app).post(`${api}/missions/${id}/observations`).set(h).send({ attribute, value, opId, clientTs: now() });
const obsOp = (missionId: string, attribute: string, value: string) => ({
  opId: uuid(),
  missionId,
  clientTs: now(),
  type: 'observation',
  payload: { attribute, value },
});
const sync = async (h: H, ops: object[]) => (await request(app).post(`${api}/sync`).set(h).send({ ops }).expect(200)).body.results as { status: string; error?: { code: string }; result?: Record<string, unknown> }[];
const evidence = (locationId: string, attribute: string) => col('evidence').findOne({ locationId, attribute });
/** One fresh owner reports `value` once at `locationId`. */
async function report(locationId: string, attribute: string, value: string) {
  const h = await session();
  await observe(h, (await startedAt(h, locationId)).id, attribute, value).expect(201);
  return h;
}

describe('evidence aggregation (one owner, one vote)', () => {
  it('A: a flood from one owner across many missions does not erase independent reports', async () => {
    const limits = RULES.evidence as { maxReportsConsidered: number };
    const saved = limits.maxReportsConsidered;
    // A small window makes the old "latest N raw rows, then dedupe" query fail with far fewer requests.
    limits.maxReportsConsidered = 5;
    try {
      const loc = 'test:flood';
      for (let i = 0; i < 3; i++) await report(loc, 'shade_quality', 'good');
      const attacker = await session();
      let accepted = 0;
      for (let i = 0; i < 30; i++) {
        const m = await startedAt(attacker, loc);
        const results = await sync(attacker, Array.from({ length: perAttribute }, () => obsOp(m.id, 'shade_quality', 'none')));
        accepted += results.filter((r) => r.status === 'applied').length;
      }
      expect(accepted).toBe(30 * perAttribute);
      expect(await col('observations').countDocuments({ locationId: loc })).toBe(3 + 30 * perAttribute);
      expect(await evidence(loc, 'shade_quality')).toMatchObject({
        estimate: 'good',
        confidence: 'moderate',
        supporting: 3,
        contradicting: 1,
        valueCounts: { good: 3, none: 1 },
      });
    } finally {
      limits.maxReportsConsidered = saved;
    }
  });

  it("B: repeated observations from one owner count once, using that owner's latest", async () => {
    const loc = 'test:repeat';
    const h = await session();
    const a = await startedAt(h, loc);
    for (let i = 0; i < 3; i++) await observe(h, a.id, 'noise_level', 'quiet').expect(201);
    expect(await evidence(loc, 'noise_level')).toMatchObject({ supporting: 1, contradicting: 0, confidence: 'low', valueCounts: { quiet: 1 } });
    const b = await startedAt(h, loc);
    await observe(h, b.id, 'noise_level', 'loud').expect(201);
    expect(await evidence(loc, 'noise_level')).toMatchObject({ estimate: 'loud', supporting: 1, contradicting: 0, valueCounts: { loud: 1 } });
  });

  it('C: contradictory reports from distinct owners stay visible as conflicting', async () => {
    const loc = 'test:conflict';
    await report(loc, 'bench_availability', 'found');
    await report(loc, 'bench_availability', 'not_found');
    expect(await evidence(loc, 'bench_availability')).toMatchObject({ confidence: 'conflicting', estimate: null, valueCounts: { found: 1, not_found: 1 } });
  });

  it('H: a rejected observation leaves no stale support behind', async () => {
    const loc = 'test:reject';
    await report(loc, 'crowding', 'busy');
    const h = await session();
    const m = await startedAt(h, loc);
    for (let i = 0; i < perAttribute; i++) await observe(h, m.id, 'crowding', 'empty').expect(201);
    expect(await evidence(loc, 'crowding')).toMatchObject({ valueCounts: { busy: 1, empty: 1 } });
    // Over the cap: a concurrent recompute counts the row in the moment before it is refused and deleted.
    const orig = Collection.prototype.insertOne;
    let during: unknown;
    const spy = vi.spyOn(Collection.prototype, 'insertOne').mockImplementation(async function (this: Collection, ...args: unknown[]) {
      const r = await (orig as (...a: unknown[]) => Promise<never>).apply(this, args);
      if (this.collectionName === 'observations') {
        spy.mockRestore();
        await recomputeEvidence(loc, 'crowding');
        during = await evidence(loc, 'crowding');
      }
      return r;
    });
    await observe(h, m.id, 'crowding', 'busy').expect(429);
    expect(during).toMatchObject({ valueCounts: { busy: 2 } });
    expect(await evidence(loc, 'crowding')).toMatchObject({ confidence: 'conflicting', supporting: 1, contradicting: 1, valueCounts: { busy: 1, empty: 1 } });

    // Deleting every contributor removes the summary instead of leaving old counts.
    const only = 'test:reject-only';
    const solo = await report(only, 'crowding', 'busy');
    await request(app).delete(`${api}/me`).set(solo).expect(200);
    expect(await evidence(only, 'crowding')).toBeNull();
  });

  it('concurrent observations and recomputes end at the same summary as a sequential recompute', async () => {
    const loc = 'test:concurrent';
    const owners = await Promise.all(Array.from({ length: 8 }, async (_, i) => ({ h: await session(), value: i % 3 === 0 ? 'none' : 'good' })));
    const missions = await Promise.all(owners.map(({ h }) => startedAt(h, loc)));
    await Promise.all([
      ...owners.flatMap(({ h, value }, i) => [observe(h, missions[i].id, 'shade_quality', value), observe(h, missions[i].id, 'shade_quality', 'partial')]),
      ...Array.from({ length: 10 }, () => recomputeEvidence(loc, 'shade_quality')),
    ]);
    const settled = await evidence(loc, 'shade_quality');
    await recomputeEvidence(loc, 'shade_quality');
    const fresh = await evidence(loc, 'shade_quality');
    const pick = (d: typeof settled) => ({ ...d, _id: undefined, updatedAt: undefined, computedAt: undefined });
    expect(pick(settled)).toEqual(pick(fresh));
    expect(fresh!.supporting + fresh!.contradicting).toBe(8);
  });

  it('an older recompute finishing last does not overwrite a newer one', async () => {
    const loc = 'test:ordering';
    const h = await session();
    const m = await startedAt(h, loc);
    await observe(h, m.id, 'path_condition', 'good').expect(201);
    // Hold the first recompute's write until a later recompute has seen a new report and written.
    const orig = Collection.prototype.updateOne;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(Collection.prototype, 'updateOne').mockImplementation(async function (this: Collection, ...args: unknown[]) {
      if (this.collectionName === 'evidence') {
        spy.mockRestore();
        await held;
      }
      return (orig as (...a: unknown[]) => Promise<never>).apply(this, args);
    });
    const older = recomputeEvidence(loc, 'path_condition');
    await new Promise((r) => setTimeout(r, 20));
    await report(loc, 'path_condition', 'blocked');
    release();
    await older;
    expect(await evidence(loc, 'path_condition')).toMatchObject({ valueCounts: { good: 1, blocked: 1 } });
  });
});

describe('observation limits', () => {
  it('D: refuses observations over the per-attribute and per-mission caps, directly and via sync', async () => {
    const h = await session();
    const m = await startedAt(h);
    for (let i = 0; i < perAttribute; i++) await observe(h, m.id, 'noise_level', 'quiet').expect(201);
    const direct = await observe(h, m.id, 'noise_level', 'quiet').expect(429);
    expect(direct.body.error).toMatchObject({ code: 'OBSERVATION_LIMIT', details: { perMission, perAttribute } });

    const op = obsOp(m.id, 'noise_level', 'loud');
    expect((await sync(h, [op]))[0]).toMatchObject({ status: 'rejected', error: { code: 'OBSERVATION_LIMIT' } });
    // A resend returns the stored refusal, never a retry.
    expect((await sync(h, [op]))[0]).toMatchObject({ status: 'duplicate', result: { originalStatus: 'rejected' }, error: { code: 'OBSERVATION_LIMIT' } });

    const attrs = ['crowding', 'shade_quality', 'path_condition'];
    for (const a of attrs) {
      const results = await sync(h, Array.from({ length: perAttribute }, () => obsOp(m.id, a, a === 'crowding' ? 'busy' : 'good')));
      expect(results.every((r) => r.status === 'applied')).toBe(true);
    }
    expect(perAttribute * (attrs.length + 1)).toBe(perMission);
    expect((await observe(h, m.id, 'bench_availability', 'found').expect(429)).body.error.code).toBe('OBSERVATION_LIMIT');
    const list = await request(app).get(`${api}/missions/${m.id}/observations`).set(h).expect(200);
    expect(list.body.items).toHaveLength(perMission);
  });

  it('D: a concurrent burst cannot exceed the cap', async () => {
    const h = await session();
    const m = await startedAt(h);
    const results = await Promise.all(Array.from({ length: perAttribute * 3 }, () => observe(h, m.id, 'crowding', 'busy')));
    const ok = results.filter((r) => r.status === 201).length;
    for (const r of results.filter((x) => x.status !== 201)) expect([r.status, r.body.error.code]).toEqual([429, 'OBSERVATION_LIMIT']);
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThanOrEqual(perAttribute);
    expect(await col('observations').countDocuments({ missionId: m.id })).toBe(ok);
  });
});

describe('accessibility honesty', () => {
  const loc = 'osm:way/7700';
  const plan = async (h: H, body: object) => (await request(app).post(`${api}/missions/plan`).set(h).send(body).expect(201)).body as { missions: Mission[] };
  beforeAll(async () => {
    const retrievedAt = now();
    await col('locations').insertOne({
      _id: loc as never,
      name: 'Access Test Park',
      category: 'park',
      coords: { lat: 12.98, lon: 77.59 },
      source: 'openstreetmap',
      isFixture: false,
      externalId: 'way/7700',
      attribution: '© OpenStreetMap contributors (ODbL)',
      retrievedAt,
      lastCheckedAt: retrievedAt,
    });
  });

  it('E/F/G: fresh sessions with zero-duration missions reach "supported" but never "verified"', async () => {
    // Three brand-new sessions, each observing the instant their mission starts.
    for (let i = 0; i < 3; i++) await report(loc, 'step_free_access', 'yes');
    expect(await evidence(loc, 'step_free_access')).toMatchObject({ confidence: 'moderate', supporting: 3 });

    const { missions } = await plan(await session(), { availableMinutes: 30, missionType: 'quiet_break', required: ['step_free'], locationIds: [loc] });
    const m = missions[0];
    expect(m.selectedLocation?.id).toBe(loc);
    const check = m.conditionChecks.find((c) => c.condition === 'step_free')!;
    expect(check).toMatchObject({ required: true, status: 'supported', provenance: 'aggregated', verification: 'unverified' });
    expect(m.uncertainty.join(' ')).toMatch(/Required accessibility condition "step_free" is unverified \(supported\)/);
    expect(m.whyItMatches.find((w) => w.text.startsWith('step free'))).toMatchObject({ sourceType: 'aggregated', text: expect.stringMatching(/not verified/) });
    // The place itself is OpenStreetMap data: attributed, not verified.
    expect(m.whyItMatches.find((w) => w.text.includes('is mapped as'))?.sourceType).toBe('external_map_data');
    expect(JSON.stringify(m)).not.toMatch(/"verified(_external)?"/);
  });

  it('E: a single report is labelled as one user report, and unknown stays unknown', async () => {
    const single = 'osm:way/7701';
    await col('locations').insertOne({ ...(await col('locations').findOne({ _id: loc as never }))!, _id: single as never });
    await report(single, 'bench_availability', 'found');
    const { missions } = await plan(await session(), { availableMinutes: 30, missionType: 'quiet_break', required: ['bench', 'smooth_path'], locationIds: [single] });
    const byCond = Object.fromEntries(missions[0].conditionChecks.map((c) => [c.condition, c]));
    expect(byCond.bench).toMatchObject({ status: 'weak_support', provenance: 'user_report', verification: 'unverified' });
    expect(byCond.smooth_path).toMatchObject({ status: 'unknown', provenance: 'unknown', verification: 'unverified' });
    const text = missions[0].uncertainty.join(' ');
    expect(text).toMatch(/accessibility condition "bench" is unverified/);
    expect(text).toMatch(/accessibility condition "smooth_path" is unverified/);
  });

  it('I: non-accessibility conditions keep their existing behaviour', async () => {
    const shady = 'osm:way/7702';
    await col('locations').insertOne({ ...(await col('locations').findOne({ _id: loc as never }))!, _id: shady as never });
    for (let i = 0; i < 3; i++) await report(shady, 'shade_quality', 'good');
    const { missions } = await plan(await session(), { availableMinutes: 30, missionType: 'quiet_break', required: ['shade'], locationIds: [shady] });
    expect(missions[0].conditionChecks[0]).toMatchObject({ condition: 'shade', status: 'supported', verification: 'unverified' });
    expect(missions[0].uncertainty.join(' ')).not.toMatch(/"shade"/);
  });
});
