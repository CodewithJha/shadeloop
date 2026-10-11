import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Report } from '@shadeloop/shared';
import { closeDb, col, connectDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { clearProviderCache } from '../src/providers.ts';
import { env, RULES } from '../src/config.ts';

type Route = (url: string, init?: RequestInit) => Response;
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const down: Route = () => {
  throw new TypeError('fetch failed');
};
const overpass = {
  elements: [
    { type: 'way', id: 1, center: { lat: 12.981, lon: 77.591 }, tags: { leisure: 'park', name: 'Test Park' } },
    { type: 'node', id: 2, lat: 12.979, lon: 77.589, tags: { amenity: 'bench' } },
  ],
};
const meteo = { current: { time: '2026-06-01T06:00', temperature_2m: 34, apparent_temperature: 36, precipitation: 0, wind_speed_10m: 5, weather_code: 0 } };
const liveData: Route = (url, init) => (url.includes('overpass') ? json(overpass) : url.includes('open-meteo') ? json(meteo) : down(url, init));

let routes: Route = down;
let app: Express;

beforeAll(async () => {
  await connectDb();
  app = createApp();
  vi.stubGlobal('fetch', async (u: string | URL, init?: RequestInit) => routes(String(u), init));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});
beforeEach(() => {
  routes = down;
  clearProviderCache();
});

const api = '/api/v1';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
async function session() {
  const r = await request(app).post(`${api}/sessions`).expect(201);
  return { Authorization: `Bearer ${r.body.token}` };
}
async function plan(h: Record<string, string>, body: object = { availableMinutes: 20, missionType: 'quiet_break' }) {
  const r = await request(app).post(`${api}/missions/plan`).set(h).send(body).expect(201);
  return r.body as { missions: Mission[]; planning: Record<string, any> };
}
const observe = (h: Record<string, string>, id: string, attribute: string, value: string, opId = uuid()) =>
  request(app).post(`${api}/missions/${id}/observations`).set(h).send({ attribute, value, opId, clientTs: now() });

describe('health and errors', () => {
  it('reports liveness and honest dependency status when everything external is down', async () => {
    await request(app).get(`${api}/health`).expect(200, /ok/);
    const r = await request(app).get(`${api}/health/dependencies`).expect(200);
    const byName = Object.fromEntries(r.body.dependencies.map((d: { name: string; status: string }) => [d.name, d.status]));
    expect(byName).toMatchObject({ mongodb: 'VERIFIED', 'ai:ollama': 'DEGRADED', serpapi: 'NOT_CONFIGURED', fixture: 'DISABLED' });
    expect(r.body.notImplemented).toContain('elevenlabs');
  });
  it('requires a session token and uses the error envelope', async () => {
    const r = await request(app).get(`${api}/missions`).expect(401);
    expect(r.body.error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(r.body.error.requestId).toBeTruthy();
    await request(app).get(`${api}/missions`).set({ Authorization: 'Bearer nope' }).expect(401);
  });
  it('validates input, rejects bad JSON and oversized bodies', async () => {
    const h = await session();
    const r = await request(app).post(`${api}/missions/plan`).set(h).send({ availableMinutes: 2 }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    await request(app).post(`${api}/missions/plan`).set(h).set('content-type', 'application/json').send('{bad').expect(400);
    await request(app).post(`${api}/missions/plan`).set(h).send({ prompt: 'x'.repeat(200_000) }).expect(413);
    await request(app).get(`${api}/nope`).set(h).expect(404);
  });
  it('serves a generated OpenAPI document', async () => {
    const r = await request(app).get(`${api}/openapi.json`).expect(200);
    expect(r.body.paths['/sync'].post.requestBody).toBeTruthy();
  });
});

describe('planning with AI down (fallback)', () => {
  it('persists template missions with honest provenance and owner isolation', async () => {
    const h = await session();
    const { missions, planning } = await plan(h, { prompt: 'I have 15 minutes for a quiet break with some shade' });
    expect(missions.length).toBeGreaterThan(0);
    const m = missions[0];
    expect(m.provenance).toMatchObject({ generator: 'template', fallbackUsed: true, provider: 'ollama', fallbackReason: 'fetch failed' });
    expect(planning.parse.method).toBe('keywords');
    expect(m.estimatedMinutes).toBeLessThanOrEqual(15);
    expect(m.conditionChecks.find((c) => c.condition === 'shade')?.status).toBe('unknown');
    expect(m.uncertainty.join(' ')).toMatch(/weather was not checked/);
    const got = await request(app).get(`${api}/missions/${m.id}`).set(h).expect(200);
    expect(got.body.id).toBe(m.id);
    await request(app).get(`${api}/missions/${m.id}`).set(await session()).expect(404);
  });
});

describe('planning with AI up', () => {
  const chat = (content: object) => json({ message: { content: JSON.stringify(content) } });
  const aiRoutes = (proposal: object): Route => (url, init) => {
    if (!url.includes('/api/chat')) return liveData(url, init);
    const body = JSON.parse(String(init?.body));
    const system: string = body.messages[0].content;
    if (system.includes('extract constraints')) return chat({ missionType: 'nature_observation', availableMinutes: 20, preferred: ['shade'] });
    if (system.includes('micro-missions')) return chat({ missions: [proposal] });
    return chat({ summary: 'You spent time outside and noted the shade.' });
  };
  const good = {
    title: 'Leaf count',
    description: 'Count leaf shapes near a tree in the park.',
    type: 'nature_observation',
    objective: 'Notice variety',
    locationId: 'null',
    steps: [{ text: 'Find a tree and count leaf shapes', minutes: 30, kind: 'observe' }],
    observationPrompts: ['shade_quality'],
    whyItMatches: 'Short and observational.',
  };

  it('uses validated AI output, shrinking durations to fit and labelling it', async () => {
    routes = aiRoutes(good);
    const { missions, planning } = await plan(await session(), { prompt: 'twenty minutes looking at plants' });
    expect(planning.parse.method).toBe('ai');
    expect(missions[0].provenance).toMatchObject({ generator: 'ai', fallbackUsed: false, model: 'gemma3:4b' });
    expect(missions[0].estimatedMinutes).toBe(20);
    expect(missions[0].uncertainty.join(' ')).toMatch(/shortened by the constraint engine/);
    expect(missions[0].whyItMatches[0]).toMatchObject({ sourceType: 'ai_suggestion' });
  });
  it('rejects AI that invents locations or gives unsafe advice, then falls back', async () => {
    for (const bad of [{ ...good, locationId: 'osm:way/999999' }, { ...good, steps: [{ text: 'Climb over the fence for a better view', minutes: 5, kind: 'walk' }] }]) {
      routes = aiRoutes(bad);
      const { missions, planning } = await plan(await session(), { prompt: 'twenty minutes looking at plants' });
      expect(missions[0].provenance.generator).toBe('template');
      expect(planning.generation.rejectedCandidates.length).toBe(1);
    }
  });
  const stepsFit = (m: Mission, available: number) => {
    expect(m.steps.reduce((s, x) => s + x.minutes, 0) + (m.travel?.minutesRoundTrip ?? 0)).toBe(m.estimatedMinutes);
    expect(m.estimatedMinutes).toBeLessThanOrEqual(available);
    for (const s of m.steps) {
      expect(s.minutes).toBeGreaterThanOrEqual(1);
      expect(s.minutes).toBeLessThanOrEqual(RULES.maxStepMinutes);
      expect(s.text).not.toMatch(RULES.durationPattern);
    }
  };
  it('rejects AI step text that states a duration, even when minutes are shortened, and falls back honestly', async () => {
    for (const text of ['Sit under a tree for 10 minutes', 'Rest here for half an hour', 'Count leaves for ten minutes']) {
      routes = aiRoutes({ ...good, steps: [{ text, minutes: 30, kind: 'observe' }] });
      const { missions, planning } = await plan(await session(), { prompt: 'twenty minutes looking at plants' });
      expect(planning.generation.rejectedCandidates).toHaveLength(1);
      expect(missions[0].provenance).toMatchObject({ generator: 'template', fallbackUsed: true });
      expect(missions[0].provenance.fallbackReason).toMatch(/all AI candidates failed constraints: "Leaf count": text states a duration/);
      for (const m of missions) stepsFit(m, 20);
    }
  });
  it('falls back with the validation reason on malformed or missing step durations', async () => {
    for (const steps of [[{ text: 'Find a tree', kind: 'observe' }], [{ text: 'Find a tree', minutes: '5', kind: 'observe' }], [{ text: 'Find a tree', minutes: 5, kind: 'run' }], []]) {
      routes = aiRoutes({ ...good, steps });
      const { missions } = await plan(await session(), { prompt: 'twenty minutes looking at plants' });
      expect(missions[0].provenance).toMatchObject({ generator: 'template', fallbackUsed: true });
      expect(missions[0].provenance.fallbackReason).toMatch(/^invalid output at missions\.0\.steps/);
      for (const m of missions) stepsFit(m, 20);
    }
  });
  it('fits overshooting AI step durations into every budget', async () => {
    const steps = ['Find a tree', 'Count leaf shapes', 'Note the shade'].map((text) => ({ text, minutes: 40, kind: 'observe' }));
    routes = aiRoutes({ ...good, steps });
    for (const available of [10, 20, 45, 90]) {
      const { missions } = await plan(await session(), { prompt: 'looking at plants', availableMinutes: available });
      expect(missions[0].provenance.generator).toBe('ai');
      for (const m of missions) stepsFit(m, available);
    }
  });
});

describe('completion report summary', () => {
  let chatCalls = 0;
  const run = async (scenario: Route, complete: object = { actualMinutes: 7 }) => {
    chatCalls = 0;
    routes = (url, init) => {
      if (url.includes('/api/chat')) chatCalls++;
      return scenario(url, init);
    };
    const h = await session();
    const [m] = (await plan(h)).missions;
    await request(app).post(`${api}/missions/${m.id}/start`).set(h).send({}).expect(200);
    await observe(h, m.id, 'crowding', 'busy').expect(201);
    const callsBeforeCompletion = chatCalls;
    const done = await request(app).post(`${api}/missions/${m.id}/complete`).set(h).send(complete).expect(200);
    const report = (await request(app).get(`${api}/reports/${done.body.reportId}`).set(h).expect(200)).body as Report;
    expect(chatCalls, 'AI called during completion').toBe(callsBeforeCompletion);
    return { m, report };
  };
  // An AI that would overstate if it were ever asked for a summary.
  const chatty: Route = (url) =>
    url.includes('/api/chat') ? json({ message: { content: JSON.stringify({ summary: 'It was busier than anticipated and safer than expected.' }) } }) : down(url);

  it('is template-derived from recorded facts and never asks the AI, even when the AI would overstate', async () => {
    const { m, report } = await run(chatty);
    expect(report.comparisons).toEqual([{ attribute: 'crowding', expected: null, expectedConfidence: 'unknown', observed: 'busy', result: 'no_expectation' }]);
    expect(report.summary).toEqual({
      text: `Completed "${m.title}" in about 7 min (planned ${m.estimatedMinutes}). You recorded 1 observation.`,
      generator: 'template',
      provider: null,
      model: null,
      fallbackUsed: false,
      fallbackReason: null,
    });
    expect(report.summary.text).not.toMatch(/busier|safer|anticipated/i);
    expect(Object.keys(report)).not.toContain('aiNarrative');
  });
  it('uses the timestamp duration when the user gives none', async () => {
    const { m, report } = await run(down, {});
    expect(report.actual).toMatchObject({ minutesSource: 'timestamps', minutes: 0 });
    expect(report.summary.text).toBe(`Completed "${m.title}" in about 0 min (planned ${m.estimatedMinutes}). You recorded 1 observation.`);
  });
  it('is the same whether the AI is disabled, unreachable, timing out or returning invalid output', async () => {
    const timeout: Route = (url) => {
      if (url.includes('/api/chat')) throw new DOMException('The operation timed out.', 'TimeoutError');
      return down(url);
    };
    const invalid: Route = (url) => (url.includes('/api/chat') ? json({ message: { content: '{"missions": "nope"}' } }) : down(url));
    const texts: string[] = [];
    for (const scenario of [down, timeout, invalid]) texts.push((await run(scenario)).report.summary.text);
    env.AI_PROVIDER = 'none';
    try {
      const { report } = await run(chatty);
      texts.push(report.summary.text);
      expect(chatCalls).toBe(0);
    } finally {
      env.AI_PROVIDER = 'ollama';
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toMatch(/^Completed "Quiet break outside" in about 7 min \(planned \d+\)\. You recorded 1 observation\.$/);
  });
});

describe('mission lifecycle', () => {
  it('enforces the state machine with 409s', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    const go = (a: string) => request(app).post(`${api}/missions/${m.id}/${a}`).set(h).send({});
    expect((await go('complete').expect(409)).body.error.code).toBe('INVALID_TRANSITION');
    await go('start').expect(200);
    await go('start').expect(409);
    await go('pause').expect(200);
    await go('resume').expect(200);
    const done = await request(app).post(`${api}/missions/${m.id}/complete`).set(h).send({ actualMinutes: 14, rating: 4 }).expect(200);
    expect(done.body.mission.status).toBe('completed');
    expect(done.body.reportId).toBeTruthy();
    await go('cancel').expect(409);
    await go('explode').expect(404);
  });
  it('keeps a mission cancelled before it started (no TTL), so it stays in history', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    expect((await col('missions').findOne({ _id: m.id as never }))?.expireAt).toBeInstanceOf(Date);
    await request(app).post(`${api}/missions/${m.id}/cancel`).set(h).send({}).expect(200);
    expect((await col('missions').findOne({ _id: m.id as never }))?.expireAt).toBeUndefined();
    const hist = await request(app).get(`${api}/history`).set(h).expect(200);
    expect(hist.body.items.map((i: { mission: Mission }) => i.mission.id)).toContain(m.id);
  });
  it('validates observations and makes them idempotent by opId', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    expect((await observe(h, m.id, 'noise_level', 'quiet').expect(409)).body.error.code).toBe('MISSION_NOT_ACTIVE');
    await request(app).post(`${api}/missions/${m.id}/start`).set(h).send({}).expect(200);
    await observe(h, m.id, 'noise_level', 'found').expect(400);
    const opId = uuid();
    await observe(h, m.id, 'noise_level', 'quiet', opId).expect(201);
    const again = await observe(h, m.id, 'noise_level', 'quiet', opId).expect(200);
    expect(again.body.duplicate).toBe(true);
    const list = await request(app).get(`${api}/missions/${m.id}/observations`).set(h).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ sourceType: 'user_report', verificationStatus: 'unverified', privacy: 'mission_only' });
  });
  it('turns notes into proposed observations without saving them', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    const r = await request(app).post(`${api}/missions/${m.id}/observations/parse`).set(h).send({ text: 'no bench, very noisy' }).expect(200);
    expect(r.body).toMatchObject({ method: 'keywords', fallbackUsed: true });
    expect(r.body.proposals).toEqual([
      { attribute: 'bench_availability', value: 'not_found' },
      { attribute: 'noise_level', value: 'loud' },
    ]);
    expect((await request(app).get(`${api}/missions/${m.id}/observations`).set(h)).body.items).toHaveLength(0);
  });
});

describe('field truth loop (end to end)', () => {
  it('plan → start → observe → complete → report → evidence → better next plan', async () => {
    routes = liveData;
    const origin = { lat: 12.98, lon: 77.59 };
    const disc = await request(app).post(`${api}/discovery/search`).set(await session()).send(origin).expect(200);
    expect(disc.body.locations[0]).toMatchObject({ id: 'osm:way/1', name: 'Test Park', source: 'openstreetmap', isFixture: false });
    expect(disc.body.limitations.join(' ')).toMatch(/not that it has shade/);

    const runOnce = async (shade: string) => {
      const h = await session();
      const { missions } = await plan(h, { availableMinutes: 30, missionType: 'quiet_break', preferred: ['shade'], locationIds: ['osm:way/1'], coarseLocation: origin });
      const m = missions[0];
      expect(m.selectedLocation?.id).toBe('osm:way/1');
      expect(m.safetyNotes.join(' ')).toMatch(/feels hot: 36°C/);
      await request(app).post(`${api}/missions/${m.id}/start`).set(h).send({}).expect(200);
      await observe(h, m.id, 'shade_quality', shade).expect(201);
      await observe(h, m.id, 'temperature_feel', 'hotter_than_expected').expect(201);
      const done = await request(app).post(`${api}/missions/${m.id}/complete`).set(h).send({}).expect(200);
      const report = (await request(app).get(`${api}/reports/${done.body.reportId}`).set(h).expect(200)).body as Report;
      return { m, report, h };
    };

    const first = await runOnce('none');
    expect(first.report.comparisons.find((c) => c.attribute === 'shade_quality')).toMatchObject({ expected: null, result: 'no_expectation' });
    expect(first.report.comparisons.find((c) => c.attribute === 'temperature_feel')?.result).toBe('observed_higher_than_expected');
    expect(first.report.evidenceRefs[0]).toMatchObject({ attribute: 'shade_quality', confidence: 'low', estimate: 'none', supporting: 1 });
    expect(first.report.summary).toMatchObject({ generator: 'template', fallbackUsed: false, fallbackReason: null });

    await runOnce('none');
    const third = await runOnce('none');
    expect(third.report.evidenceRefs[0]).toMatchObject({ confidence: 'moderate', estimate: 'none', supporting: 3 });

    // Next user who prefers shade sees the contradiction instead of a silent "yes".
    const fourth = await runOnce('good');
    expect(fourth.m.conditionChecks[0]).toMatchObject({ condition: 'shade', status: 'contradicted' });
    expect(fourth.m.expectations.find((e) => e.attribute === 'shade_quality')).toMatchObject({ estimate: 'none', confidence: 'moderate' });
    expect(fourth.report.comparisons.find((c) => c.attribute === 'shade_quality')?.result).toBe('observed_higher_than_expected');

    // A user who *requires* shade is not sent there.
    const strict = await plan(await session(), { availableMinutes: 30, missionType: 'quiet_break', required: ['shade'], locationIds: ['osm:way/1'], coarseLocation: origin });
    expect(strict.missions[0].selectedLocation).toBeNull();

    const hist = await request(app).get(`${api}/history`).set(first.h).expect(200);
    expect(hist.body.items[0].report.summary).toMatch(/Completed/);

    // Deleting a contributor's data recomputes shared evidence.
    await request(app).delete(`${api}/me`).set(first.h).expect(200);
    await request(app).get(`${api}/missions`).set(first.h).expect(401);
    const e = await col('evidence').findOne({ locationId: 'osm:way/1', attribute: 'shade_quality' });
    expect(e).toMatchObject({ confidence: 'conflicting', valueCounts: { none: 2, good: 1 } });
  });
});

describe('offline sync', () => {
  it('applies a batch, replays idempotently, and reports conflicts per op', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    // Timestamps can't precede the mission or exceed the 5-minute clock-skew allowance, so stay inside that window.
    const t0 = Date.parse(m.createdAt);
    const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const ops = [
      { opId: uuid(), missionId: m.id, clientTs: at(0), type: 'start' },
      { opId: uuid(), missionId: m.id, clientTs: at(0.5), type: 'observation', payload: { attribute: 'crowding', value: 'busy' } },
      { opId: uuid(), missionId: m.id, clientTs: at(1), type: 'pause', payload: { currentStep: 1 } },
      { opId: uuid(), missionId: m.id, clientTs: at(3), type: 'resume' },
      { opId: uuid(), missionId: m.id, clientTs: at(4), type: 'complete', payload: { currentStep: 3 } },
    ];
    const first = await request(app).post(`${api}/sync`).set(h).send({ ops }).expect(200);
    expect(first.body.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    const reportId = first.body.results[4].result.reportId;
    const report = (await request(app).get(`${api}/reports/${reportId}`).set(h).expect(200)).body as Report;
    expect(report.actual).toMatchObject({ minutes: 2, minutesSource: 'timestamps', stepsReached: 4 });

    const replay = await request(app).post(`${api}/sync`).set(h).send({ ops }).expect(200);
    expect(replay.body.results.every((r: { status: string }) => r.status === 'duplicate')).toBe(true);
    expect(replay.body.results[4].result.reportId).toBe(reportId);
    expect((await request(app).get(`${api}/missions/${m.id}/observations`).set(h)).body.items).toHaveLength(1);

    const late = await request(app)
      .post(`${api}/sync`)
      .set(h)
      .send({
        ops: [
          { opId: uuid(), missionId: m.id, clientTs: now(), type: 'observation', payload: { attribute: 'noise_level', value: 'quiet' } },
          { opId: uuid(), missionId: m.id, clientTs: new Date(Date.now() + 3_600_000).toISOString(), type: 'cancel' },
          { opId: uuid(), missionId: 'missing', clientTs: now(), type: 'start' },
        ],
      })
      .expect(200);
    expect(late.body.results.map((r: { status: string; error: { code: string } }) => [r.status, r.error.code])).toEqual([
      ['conflict', 'MISSION_NOT_ACTIVE'],
      ['conflict', 'INVALID_TRANSITION'],
      ['rejected', 'NOT_FOUND'],
    ]);

    const stolen = await request(app).post(`${api}/sync`).set(await session()).send({ ops: [ops[0]] }).expect(200);
    expect(stolen.body.results[0]).toMatchObject({ status: 'rejected', error: { code: 'OPID_CONFLICT' } });
  });
  it('rejects future timestamps', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    const r = await request(app)
      .post(`${api}/sync`)
      .set(h)
      .send({ ops: [{ opId: uuid(), missionId: m.id, clientTs: new Date(Date.now() + 3_600_000).toISOString(), type: 'start' }] })
      .expect(200);
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', error: { code: 'CLOCK_SKEW' } });
  });
  it('refuses an invalid op on its own (e.g. from an older client) and applies the rest of the batch', async () => {
    const h = await session();
    const [a] = (await plan(h)).missions;
    const [b] = (await plan(h)).missions;
    const op = (missionId: string, type: string, payload?: object) => ({ opId: uuid(), missionId, clientTs: now(), type, ...(payload ? { payload } : {}) });
    const ops = [
      op(a.id, 'start'),
      op(b.id, 'start'),
      op(a.id, 'complete', { actualMinutes: 300 }), // allowed by an older client, over today's 240 cap
      op(b.id, 'observation', { attribute: 'crowding', value: 'purple' }),
      op(b.id, 'observation', { attribute: 'crowding', value: 'busy' }),
      op(b.id, 'teleport'),
      op(b.id, 'complete', { actualMinutes: 10 }),
    ];
    const first = await syncBody(h, { ops, sentAt: now() }).expect(200);
    const summary = (r: { status: string; error?: { code: string } }) => [r.status, r.error?.code ?? null];
    expect(first.body.results.map(summary)).toEqual([
      ['applied', null],
      ['applied', null],
      ['rejected', 'VALIDATION_ERROR'],
      ['rejected', 'VALIDATION_ERROR'],
      ['applied', null],
      ['rejected', 'VALIDATION_ERROR'],
      ['applied', null],
    ]);
    expect(first.body.results[2].error.details).toEqual([expect.objectContaining({ path: 'payload.actualMinutes' })]);
    expect((await getMission(h, a.id)).status).toBe('active');
    const report = await reportOf(h, first.body.results[6].result.reportId);
    expect(report.actual.observations).toEqual([expect.objectContaining({ attribute: 'crowding', value: 'busy' })]);

    // A resend is answered from the stored results, refusals included.
    const again = await syncBody(h, { ops, sentAt: now() }).expect(200);
    expect(again.body.results.map((r: { status: string }) => r.status)).toEqual(Array(7).fill('duplicate'));
    expect(again.body.results[2]).toMatchObject({ result: { originalStatus: 'rejected' }, error: { code: 'VALIDATION_ERROR' } });
    expect(await col('sync_records').countDocuments({ opId: { $in: ops.map((o) => o.opId) } })).toBe(7);

    // The refused completion can be redone with a valid value under a new opId.
    const redo = await syncBody(h, { ops: [op(a.id, 'complete', { actualMinutes: 240 })] }).expect(200);
    expect(redo.body.results[0].status).toBe('applied');
  });
  it('still refuses a malformed batch envelope with 400', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    const op = { opId: uuid(), missionId: m.id, clientTs: now(), type: 'start' };
    for (const body of [{}, { ops: [] }, { ops: 'x' }, { ops: [{ ...op, opId: 'not-a-uuid' }] }, { ops: [{ ...op, type: undefined }] }, { ops: [op], extra: 1 }, { ops: Array(51).fill(op) }]) {
      expect((await syncBody(h, body).expect(400)).body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await getMission(h, m.id)).status).toBe('planned');
  });
});

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
/** A planned mission backdated as if planned `ago` ms earlier, so offline events can fall between then and now. */
async function backdated(h: Record<string, string>, ago: number) {
  const [m] = (await plan(h)).missions;
  await col('missions').updateOne({ _id: m.id as never }, { $set: { createdAt: iso(Date.now() - ago) } });
  return m;
}
const syncBody = (h: Record<string, string>, body: object) => request(app).post(`${api}/sync`).set(h).send(body);
const getMission = async (h: Record<string, string>, id: string) => (await request(app).get(`${api}/missions/${id}`).set(h).expect(200)).body as Mission;
const listObs = async (h: Record<string, string>, id: string) =>
  (await request(app).get(`${api}/missions/${id}/observations`).set(h).expect(200)).body.items as { clientTs: string; clientTsRaw: string; serverTs: string }[];
const reportOf = async (h: Record<string, string>, reportId: string) => (await request(app).get(`${api}/reports/${reportId}`).set(h).expect(200)).body as Report;

describe('client clock correction (sentAt)', () => {
  /** Ops at real times `at` (ms ago), stamped by a device clock that is `skew` ms off, sent now. */
  const offlineBatch = (missionId: string, skew: number, at: { start: number; obs: number[]; complete: number }) => {
    const t = Date.now();
    const ts = (ago: number) => iso(t - ago + skew);
    return {
      sentAt: ts(0),
      ops: [
        { opId: uuid(), missionId, clientTs: ts(at.start), type: 'start' },
        ...at.obs.map((ago, i) => ({ opId: uuid(), missionId, clientTs: ts(ago), type: 'observation', payload: { attribute: i % 2 ? 'crowding' : 'noise_level', value: i % 2 ? 'busy' : 'quiet' } })),
        { opId: uuid(), missionId, clientTs: ts(at.complete), type: 'complete' },
      ],
    };
  };

  it.each([
    ['1 h ahead', 60 * MIN],
    ['2 h behind', -120 * MIN],
    ['1 day behind', -24 * 60 * MIN],
  ])('corrects a device clock %s onto the server clock, keeping order and spacing', async (_name, skew) => {
    const h = await session();
    const m = await backdated(h, 60 * MIN);
    const body = offlineBatch(m.id, skew, { start: 30 * MIN, obs: [25 * MIN, 20 * MIN, 15 * MIN], complete: 10 * MIN });
    const r = await syncBody(h, body).expect(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);

    const real = Date.parse(body.sentAt) - skew; // what the device clock should have read when it sent
    const near = (got: string, ago: number) => expect(Math.abs(Date.parse(got) - (real - ago))).toBeLessThan(5_000);
    const mission = await getMission(h, m.id);
    near(mission.session.startedAt!, 30 * MIN);
    near(mission.session.completedAt!, 10 * MIN);
    const obs = await listObs(h, m.id);
    expect(obs.map((o) => o.clientTsRaw)).toEqual(body.ops.slice(1, 4).map((o) => o.clientTs));
    const times = obs.map((o) => Date.parse(o.clientTs));
    expect(times.slice(1).map((x, i) => x - times[i])).toEqual([5 * MIN, 5 * MIN]);
    expect(Date.parse(obs[0].clientTs) - Date.parse(mission.session.startedAt!)).toBe(5 * MIN);
    near(obs[0].clientTs, 25 * MIN);

    const report = await reportOf(h, r.body.results[4].result.reportId);
    expect(report.actual).toMatchObject({ minutes: 20, minutesSource: 'timestamps' });
  });

  it('fixes an op’s times when first applied: a resend with a later sentAt changes nothing', async () => {
    const h = await session();
    const m = await backdated(h, 60 * MIN);
    const body = offlineBatch(m.id, 0, { start: 30 * MIN, obs: [20 * MIN], complete: 10 * MIN });
    await syncBody(h, { ...body, ops: body.ops.slice(0, 2) }).expect(200);
    const before = { mission: await getMission(h, m.id), obs: await listObs(h, m.id) };

    const later = await syncBody(h, { ...body, ops: body.ops.slice(0, 2), sentAt: iso(Date.parse(body.sentAt) - 45 * MIN) }).expect(200);
    expect(later.body.results.map((x: { status: string }) => x.status)).toEqual(['duplicate', 'duplicate']);
    const after = { mission: await getMission(h, m.id), obs: await listObs(h, m.id) };
    expect(after.mission.session.startedAt).toBe(before.mission.session.startedAt);
    expect(after.obs).toEqual(before.obs);
  });

  it('clamps corrected times into [previous event, server now] instead of refusing them', async () => {
    const h = await session();
    const m = await backdated(h, 10 * MIN);
    const sentAt = now();
    // The device clock jumped between recording and sending: one op claims a time after the send, one before the plan.
    const r = await syncBody(h, {
      sentAt,
      ops: [
        { opId: uuid(), missionId: m.id, clientTs: iso(Date.now() - 24 * 60 * MIN), type: 'start' },
        { opId: uuid(), missionId: m.id, clientTs: iso(Date.now() + 120 * MIN), type: 'observation', payload: { attribute: 'crowding', value: 'busy' } },
      ],
    }).expect(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['applied', 'applied']);
    const mission = await getMission(h, m.id);
    expect(mission.session.startedAt).toBe((await col('missions').findOne({ _id: m.id as never }))!.createdAt);
    const [o] = await listObs(h, m.id);
    expect(Date.parse(o.clientTs)).toBeLessThanOrEqual(Date.parse(o.serverTs));
    expect(Date.parse(o.clientTs)).toBeGreaterThan(Date.now() - MIN);
  });

  it('refuses missing or invalid timestamps with VALIDATION_ERROR', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    const op = { opId: uuid(), missionId: m.id, clientTs: now(), type: 'start' };
    for (const body of [{ ops: [{ ...op, clientTs: 'yesterday' }] }, { ops: [{ ...op, clientTs: undefined }] }, { ops: [op], sentAt: 'now' }, { ops: [op], sentAt: 1_700_000_000_000 }]) {
      const r = await syncBody(h, body).expect(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await getMission(h, m.id)).status).toBe('planned');
  });

  it('keeps the legacy rule without sentAt: up to 5 min ahead accepted as sent, beyond refused as CLOCK_SKEW', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    const ahead = iso(Date.now() + 4 * MIN);
    const ok = await syncBody(h, { ops: [{ opId: uuid(), missionId: m.id, clientTs: ahead, type: 'start' }] }).expect(200);
    expect(ok.body.results[0].status).toBe('applied');
    expect((await getMission(h, m.id)).session.startedAt).toBe(ahead);
    const far = await syncBody(h, { ops: [{ opId: uuid(), missionId: m.id, clientTs: iso(Date.now() + 6 * MIN), type: 'pause' }] }).expect(200);
    expect(far.body.results[0]).toMatchObject({ status: 'rejected', error: { code: 'CLOCK_SKEW' } });
  });

  it('corrects direct transition and observation requests that send sentAt', async () => {
    const h = await session();
    const m = await backdated(h, 60 * MIN);
    const skew = 90 * MIN;
    const clientNow = () => Date.now() + skew;
    await request(app).post(`${api}/missions/${m.id}/start`).set(h).send({ clientTs: iso(clientNow() - 10 * MIN), sentAt: iso(clientNow()) }).expect(200);
    await request(app)
      .post(`${api}/missions/${m.id}/observations`)
      .set(h)
      .send({ attribute: 'crowding', value: 'busy', opId: uuid(), clientTs: iso(clientNow() - 5 * MIN), sentAt: iso(clientNow()) })
      .expect(201);
    const done = await request(app).post(`${api}/missions/${m.id}/complete`).set(h).send({ clientTs: iso(clientNow()), sentAt: iso(clientNow()) }).expect(200);
    expect(Math.abs(Date.parse((await getMission(h, m.id)).session.startedAt!) - (Date.now() - 10 * MIN))).toBeLessThan(5_000);
    expect(Math.abs(Date.parse((await listObs(h, m.id))[0].clientTs) - (Date.now() - 5 * MIN))).toBeLessThan(5_000);
    expect((await reportOf(h, done.body.reportId)).actual).toMatchObject({ minutes: 10, minutesSource: 'timestamps' });
  });
});

describe('durations', () => {
  /** Start `startAgo` ms ago and complete now (server-corrected), optionally with user minutes. */
  async function finished(h: Record<string, string>, startAgo: number, complete: object = {}) {
    const m = await backdated(h, startAgo + MIN);
    const t = now();
    const r = await syncBody(h, {
      sentAt: t,
      ops: [
        { opId: uuid(), missionId: m.id, clientTs: iso(Date.parse(t) - startAgo), type: 'start' },
        { opId: uuid(), missionId: m.id, clientTs: t, type: 'complete', payload: complete },
      ],
    }).expect(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['applied', 'applied']);
    return reportOf(h, r.body.results[1].result.reportId);
  }

  it('refuses user minutes outside 0..240 with 400 and keeps valid ones as user-sourced', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    await request(app).post(`${api}/missions/${m.id}/start`).set(h).send({}).expect(200);
    for (const actualMinutes of [241, 600, -1, 12.5]) {
      const r = await request(app).post(`${api}/missions/${m.id}/complete`).set(h).send({ actualMinutes }).expect(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await getMission(h, m.id)).status).toBe('active');
    const done = await request(app).post(`${api}/missions/${m.id}/complete`).set(h).send({ actualMinutes: 240 }).expect(200);
    expect((await reportOf(h, done.body.reportId)).actual).toMatchObject({ minutes: 240, minutesSource: 'user' });
    expect((await finished(h, 5 * MIN, { actualMinutes: 0 })).actual).toMatchObject({ minutes: 0, minutesSource: 'user' });
  });

  it('keeps the measured duration next to a user estimate and counts estimates in analytics', async () => {
    const h = await session();
    expect((await finished(h, 30 * MIN, { actualMinutes: 12 })).actual).toMatchObject({ minutes: 12, minutesSource: 'user', measuredMinutes: 30 });
    expect((await finished(h, 20 * MIN)).actual).toMatchObject({ minutes: 20, minutesSource: 'timestamps', measuredMinutes: 20 });
    const o = (await request(app).get(`${api}/analytics/overview`).set(h).expect(200)).body;
    expect(o).toMatchObject({ totalMinutesOutside: 32, minutesSampleSize: 2, minutesUserEstimated: 1, minutesExcluded: 0 });
  });

  it('keeps a long mission within the limit and marks an interrupted one unknown', async () => {
    const h = await session();
    expect((await finished(h, 200 * MIN)).actual).toMatchObject({ minutes: 200, minutesSource: 'timestamps' });
    const interrupted = await finished(h, 2 * 24 * 60 * MIN);
    expect(interrupted.actual).toMatchObject({ minutes: null, minutesSource: 'timestamps' });
    expect(interrupted.summary.text).toMatch(/^Completed "[^"]+" \(planned \d+ min; actual duration unknown\)\./);
  });

  it('marks inconsistent stored timestamps unknown when the report is (re)built', async () => {
    const h = await session();
    const [m] = (await plan(h)).missions;
    const reportId = uuid();
    const s = (await col('missions').findOne({ _id: m.id as never }))!.session;
    await col('missions').updateOne(
      { _id: m.id as never },
      { $set: { status: 'completed', reportId, session: { ...s, startedAt: iso(Date.now()), completedAt: iso(Date.now() - 30 * MIN), completionStatus: 'completed' } } },
    );
    expect((await reportOf(h, reportId)).actual).toMatchObject({ minutes: null, minutesSource: 'timestamps' });
  });

  it('aggregates only trusted durations and says how many were left out', async () => {
    const h = await session();
    await finished(h, 200 * MIN);
    await finished(h, 3 * 24 * 60 * MIN);
    const legacy = await finished(h, 5 * MIN);
    // A report stored by an older version with an over-cap user value.
    await col('reports').updateOne({ _id: legacy.id as never }, { $set: { 'actual.minutes': 600, 'actual.minutesSource': 'user' } });
    const o = (await request(app).get(`${api}/analytics/overview`).set(h).expect(200)).body;
    expect(o).toMatchObject({ totalMinutesOutside: 200, minutesSampleSize: 1, minutesExcluded: 2, averageMinutes: null });
    for (let i = 0; i < 4; i++) await finished(h, 10 * MIN);
    const o2 = (await request(app).get(`${api}/analytics/overview`).set(h).expect(200)).body;
    expect(o2).toMatchObject({ totalMinutesOutside: 240, minutesSampleSize: 5, minutesExcluded: 2, averageMinutes: 48 });
  });
});

describe('preferences, analytics, export', () => {
  it('round-trips preferences and applies them to planning', async () => {
    const h = await session();
    const prefs = (await request(app).get(`${api}/preferences`).set(h).expect(200)).body;
    expect(prefs.defaultMinutes).toBe(20);
    await request(app).put(`${api}/preferences`).set(h).send({ ...prefs, maxWalkMinutes: 500 }).expect(400);
    await request(app).put(`${api}/preferences`).set(h).send({ ...prefs, accessibility: { ...prefs.accessibility, stepFreeRequired: true } }).expect(200);
    await request(app).put(`${api}/preferences`).set(h).send({ ...prefs, sneaky: true }).expect(400);
    const { missions } = await plan(h);
    expect(missions[0].constraints.required).toContain('step_free');
  });
  it('returns insufficient data instead of invented stats', async () => {
    const h = await session();
    const o = (await request(app).get(`${api}/analytics/overview`).set(h).expect(200)).body;
    expect(o).toMatchObject({ insufficientData: true, completionRate: null, averageMinutes: null, sampleSize: 0 });
    const a = (await request(app).get(`${api}/analytics/attributes`).set(h).expect(200)).body;
    expect(a.items.every((i: { insufficientData: boolean }) => i.insufficientData)).toBe(true);
  });
  it('exports only the caller’s data', async () => {
    const h = await session();
    await plan(h);
    const r = await request(app).get(`${api}/me/export`).set(h).expect(200);
    expect(r.body.missions.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain('ownerId');
  });
});
