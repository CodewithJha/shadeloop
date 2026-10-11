import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MISSION_TYPES, ObservationInput, Preferences, SyncRequest, type EvidenceView, type LocationView } from '@shadeloop/shared';
import { RULES } from '../src/config.ts';
import {
  checkCondition,
  compareObservation,
  fitDurations,
  mergeConditions,
  nextStatus,
  roundCoords,
  summarizeEvidence,
  validateCandidate,
  type Candidate,
  type PlanContext,
} from '../src/domain.ts';
import { buildTemplate, keywordConstraints, keywordObservations, templateSummary } from '../src/fallback.ts';
import { aiJson, aiProposeMissions } from '../src/ai.ts';
import { createLogger } from '../src/log.ts';
import { z } from 'zod';

const DAY = 86_400_000;
const now = new Date('2026-06-01T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const prefs = Preferences.parse({});

const loc = (id: string, distanceM?: number): LocationView => ({
  id,
  name: id,
  category: 'park',
  coords: { lat: 0, lon: 0 },
  source: 'openstreetmap',
  isFixture: false,
  externalId: id,
  attribution: 'test',
  retrievedAt: now.toISOString(),
  ...(distanceM !== undefined ? { distanceM } : {}),
});

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  availableMinutes: 20,
  prefs,
  required: [],
  preferred: [],
  locations: new Map([['p1', loc('p1', 350)]]),
  evidence: new Map(),
  ...over,
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'Shade check',
  description: 'Sit somewhere and notice the shade.',
  type: 'quiet_break',
  objective: 'Notice the shade',
  locationId: null,
  steps: [
    { text: 'Find a seat', minutes: 2, kind: 'still' },
    { text: 'Sit quietly', minutes: 10, kind: 'still' },
  ],
  observationPrompts: ['shade_quality'],
  whyItMatches: 'Fits the time',
  ...over,
});

const ev = (estimate: string | null, confidence: EvidenceView['confidence']) => ({ estimate, confidence });

describe('state machine', () => {
  it('allows the documented transitions', () => {
    expect(nextStatus('planned', 'start')).toBe('active');
    expect(nextStatus('active', 'pause')).toBe('paused');
    expect(nextStatus('paused', 'resume')).toBe('active');
    expect(nextStatus('active', 'complete')).toBe('completed');
    expect(nextStatus('paused', 'complete')).toBe('completed');
    for (const s of ['planned', 'active', 'paused'] as const) expect(nextStatus(s, 'cancel')).toBe('cancelled');
  });
  it('rejects invalid transitions', () => {
    expect(nextStatus('planned', 'complete')).toBeNull();
    expect(nextStatus('planned', 'pause')).toBeNull();
    expect(nextStatus('active', 'start')).toBeNull();
    expect(nextStatus('completed', 'cancel')).toBeNull();
    expect(nextStatus('cancelled', 'resume')).toBeNull();
  });
});

describe('evidence model', () => {
  const r = (ownerId: string, value: string, days = 1) => ({ ownerId, value, observedAt: ago(days) });

  it('is unknown with no reports', () => {
    expect(summarizeEvidence('shade_quality', [], now)).toMatchObject({ confidence: 'unknown', estimate: null });
  });
  it('never rates a single report above low', () => {
    expect(summarizeEvidence('shade_quality', [r('a', 'good')], now)).toMatchObject({ confidence: 'low', estimate: 'good', supporting: 1 });
  });
  it('counts one owner once (independence)', () => {
    const s = summarizeEvidence('shade_quality', [r('a', 'good', 1), r('a', 'good', 2), r('a', 'good', 3)], now);
    expect(s).toMatchObject({ confidence: 'low', supporting: 1 });
  });
  it('needs 3 independent agreeing reports for moderate', () => {
    expect(summarizeEvidence('shade_quality', [r('a', 'good'), r('b', 'good')], now).confidence).toBe('low');
    expect(summarizeEvidence('shade_quality', [r('a', 'good'), r('b', 'good'), r('c', 'good')], now)).toMatchObject({ confidence: 'moderate', estimate: 'good' });
  });
  it('marks contradictions as conflicting and withholds the estimate', () => {
    expect(summarizeEvidence('bench_availability', [r('a', 'found'), r('b', 'not_found')], now)).toMatchObject({ confidence: 'conflicting', estimate: null });
    expect(summarizeEvidence('bench_availability', [r('a', 'found'), r('b', 'found'), r('c', 'not_found')], now).confidence).toBe('conflicting');
  });
  it('tolerates a small minority (< 1/3)', () => {
    const s = summarizeEvidence('noise_level', [r('a', 'quiet'), r('b', 'quiet'), r('c', 'quiet'), r('d', 'loud')], now);
    expect(s).toMatchObject({ confidence: 'moderate', estimate: 'quiet', supporting: 3, contradicting: 1 });
  });
  it('uses each owner latest report only', () => {
    const s = summarizeEvidence('noise_level', [r('a', 'loud', 5), r('a', 'quiet', 1)], now);
    expect(s).toMatchObject({ estimate: 'quiet', contradicting: 0 });
  });
  it('marks reports older than the attribute window as stale', () => {
    const s = summarizeEvidence('crowding', [r('a', 'busy', 10), r('b', 'busy', 11), r('c', 'busy', 12)], now);
    expect(s).toMatchObject({ confidence: 'stale', estimate: 'busy' });
  });
  it('drops expired reports from the count and schedules re-evaluation', () => {
    const s = summarizeEvidence('shade_quality', [r('a', 'good', 1), r('b', 'good', 2), r('c', 'good', 30)], now);
    expect(s.confidence).toBe('low');
    expect(s.reevaluateAt?.getTime()).toBe(ago(2).getTime() + 21 * DAY);
  });
  it('refuses non-location attributes', () => {
    expect(() => summarizeEvidence('temperature_feel', [], now)).toThrow();
  });
});

describe('conditions', () => {
  it('maps evidence to condition status, unknown is never satisfied', () => {
    expect(checkCondition('shade', true).status).toBe('unknown');
    expect(checkCondition('shade', true, ev('good', 'moderate')).status).toBe('supported');
    expect(checkCondition('shade', true, ev('none', 'moderate')).status).toBe('contradicted');
    expect(checkCondition('shade', true, ev('good', 'low')).status).toBe('weak_support');
    expect(checkCondition('shade', true, ev('none', 'low')).status).toBe('weak_against');
    expect(checkCondition('shade', true, ev(null, 'conflicting')).status).toBe('conflicting');
    expect(checkCondition('shade', true, ev('good', 'stale')).status).toBe('stale');
  });
  it('merges preference-derived conditions; required wins', () => {
    const p = Preferences.parse({ accessibility: { stepFreeRequired: true, needsSeating: false, avoidCrowds: true } });
    expect(mergeConditions(p, { preferred: ['step_free', 'shade'] })).toEqual({ required: ['step_free'], preferred: ['shade', 'not_crowded'] });
  });
});

describe('constraint engine', () => {
  it('accepts a fitting candidate and reports unverified conditions', () => {
    const v = validateCandidate(candidate(), ctx({ preferred: ['shade'] }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.estimatedMinutes).toBe(12);
      expect(v.uncertainty.join(' ')).toMatch(/shade.*not confirmed/);
    }
  });
  it('includes round-trip travel in the duration', () => {
    const v = validateCandidate(candidate({ locationId: 'p1' }), ctx({ availableMinutes: 30 }));
    expect(v.ok && v.travel).toEqual({ distanceM: 350, minutesRoundTrip: 10, approximate: true });
    expect(v.ok && v.estimatedMinutes).toBe(22);
  });
  it('rejects candidates over the available time', () => {
    const v = validateCandidate(candidate({ locationId: 'p1' }), ctx());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join()).toMatch(/exceeds limit 20/);
  });
  it('rejects invented locations', () => {
    const v = validateCandidate(candidate({ locationId: 'made-up' }), ctx());
    expect(!v.ok && v.errors).toContain('location not in supplied candidates');
  });
  it('rejects trespass and medical text regardless of source', () => {
    for (const text of ['Climb over the fence to the lawn', 'This walk will cure anxiety', 'Explore the private property next door']) {
      const v = validateCandidate(candidate({ steps: [{ text, minutes: 5, kind: 'walk' }] }), ctx());
      expect(v.ok, text).toBe(false);
    }
  });
  it('enforces the walking limit', () => {
    const p = Preferences.parse({ maxWalkMinutes: 5 });
    const v = validateCandidate(candidate({ steps: [{ text: 'Walk slowly', minutes: 10, kind: 'walk' }] }), ctx({ prefs: p }));
    expect(!v.ok && v.errors.join()).toMatch(/walking 10 min exceeds/);
  });
  it('rejects a location whose required condition is contradicted', () => {
    const evidence = new Map([['p1', new Map([['shade_quality' as const, { ...ev('none', 'moderate'), locationId: 'p1', attribute: 'shade_quality' } as EvidenceView]])]]);
    const v = validateCandidate(candidate({ locationId: 'p1', steps: [{ text: 'Sit', minutes: 5, kind: 'still' }] }), ctx({ required: ['shade'], evidence }));
    expect(!v.ok && v.errors.join()).toMatch(/shade is contradicted/);
  });
  it('fitDurations shrinks proportionally or gives up', () => {
    const c = candidate({ steps: [{ text: 'a b c', minutes: 20, kind: 'still' }, { text: 'd e f', minutes: 20, kind: 'observe' }] });
    expect(fitDurations(c, 20)!.steps.map((s) => s.minutes)).toEqual([10, 10]);
    expect(fitDurations(c, 1)).toBeNull();
    expect(fitDurations(c, 50)).toBe(c);
  });
  it('templates fit the budget and respect walking caps', () => {
    const t = buildTemplate('mindful_walk', 30, 10, null)!;
    expect(t.steps.reduce((s, x) => s + x.minutes, 0)).toBeLessThanOrEqual(30);
    expect(t.steps.find((s) => s.kind === 'walk')!.minutes).toBe(10);
    expect(buildTemplate('mindful_walk', 30, 0, null)).toBeNull();
    expect(buildTemplate('quiet_break', 4, 10, null)).toBeNull();
    expect(validateCandidate(buildTemplate('quiet_break', 5, 0, null)!, ctx({ availableMinutes: 5 })).ok).toBe(true);
  });
  it('rejects text that states a duration, in digits or words', () => {
    const phrases = [
      'Sit on the bench for 10 minutes',
      'Take a ten-minute pause',
      'Rest for half an hour',
      'Walk for a quarter hour',
      'Breathe slowly, 5 mins',
      'Stay 1.5 hrs if you like',
      'Listen for thirty seconds',
      'Pause for a minute',
      'Spend twenty-five minutes here',
      'Look around for a few minutes',
    ];
    for (const text of phrases) {
      const v = validateCandidate(candidate({ steps: [{ text, minutes: 5, kind: 'still' }] }), ctx());
      expect(!v.ok && v.errors.join(), text).toMatch(/states a duration/);
    }
    const v = validateCandidate(candidate({ description: 'A calm 15 minute sit somewhere shady.' }), ctx());
    expect(!v.ok && v.errors.join()).toMatch(/states a duration/);
    for (const text of ['Find a second bench nearby', 'Walk 200 m along the path', 'Notice the minute details', 'Take one slow breath']) {
      expect(validateCandidate(candidate({ steps: [{ text, minutes: 5, kind: 'still' }] }), ctx()).ok, text).toBe(true);
    }
  });
  it('rejects step minutes outside the configured bounds', () => {
    for (const minutes of [0, 1.5, RULES.maxStepMinutes + 1]) {
      const v = validateCandidate(candidate({ steps: [{ text: 'Sit', minutes, kind: 'still' }] }), ctx({ availableMinutes: 240 }));
      expect(!v.ok && v.errors.join(), String(minutes)).toMatch(/step minutes/);
    }
  });
  it('every template is a valid, duration-free mission for every time budget', () => {
    for (const type of MISSION_TYPES) {
      for (const budget of [5, 6, 10, 15, 20, 30, 45, 60, 90, 120]) {
        for (const walk of [1, 10, 120]) {
          const t = buildTemplate(type, budget, walk, null);
          expect(t, `${type} ${budget} ${walk}`).not.toBeNull();
          const v = validateCandidate(t!, ctx({ availableMinutes: budget, prefs: Preferences.parse({ maxWalkMinutes: walk }) }));
          expect(v.ok, `${type} ${budget} ${walk}: ${!v.ok && v.errors.join()}`).toBe(true);
          expect(t!.steps.reduce((s, x) => s + x.minutes, 0)).toBeLessThanOrEqual(budget);
          for (const text of [t!.title, t!.description, t!.objective, ...t!.steps.map((s) => s.text)]) expect(text).not.toMatch(RULES.durationPattern);
        }
      }
    }
  });
});

describe('schemas and parsers', () => {
  it('validates observation values per attribute', () => {
    const base = { opId: crypto.randomUUID(), clientTs: now.toISOString() };
    expect(ObservationInput.safeParse({ ...base, attribute: 'noise_level', value: 'quiet' }).success).toBe(true);
    expect(ObservationInput.safeParse({ ...base, attribute: 'noise_level', value: 'not_found' }).success).toBe(false);
    expect(ObservationInput.safeParse({ ...base, attribute: 'vibes', value: 'good' }).success).toBe(false);
    expect(ObservationInput.safeParse({ attribute: 'noise_level', value: 'quiet', opId: 'nope', clientTs: base.clientTs }).success).toBe(false);
  });
  it('validates sync batches', () => {
    expect(SyncRequest.safeParse({ ops: [] }).success).toBe(false);
    expect(SyncRequest.safeParse({ ops: [{ opId: crypto.randomUUID(), missionId: 'm', clientTs: now.toISOString(), type: 'explode' }] }).success).toBe(false);
  });
  it('keyword parsers extract time, type, conditions and notes', () => {
    expect(keywordConstraints('I have 25 minutes for a quiet shady bench break')).toMatchObject({
      availableMinutes: 25,
      missionType: 'quiet_break',
      preferred: ['shade', 'bench', 'quiet'],
    });
    expect(keywordConstraints('half an hour mindful walk').availableMinutes).toBe(30);
    expect(keywordObservations('No bench anywhere, some shade, really noisy and hotter than I thought')).toEqual([
      { attribute: 'bench_availability', value: 'not_found' },
      { attribute: 'shade_quality', value: 'partial' },
      { attribute: 'noise_level', value: 'loud' },
      { attribute: 'temperature_feel', value: 'hotter_than_expected' },
    ]);
  });
  it('compares planned vs observed by value order', () => {
    expect(compareObservation(['none', 'partial', 'good'], 'good', 'none')).toBe('observed_lower_than_expected');
    expect(compareObservation(['empty', 'some_people', 'busy'], 'empty', 'busy')).toBe('observed_higher_than_expected');
    expect(compareObservation(['quiet'], 'quiet', 'quiet')).toBe('matched');
    expect(compareObservation(['quiet'], null, 'quiet')).toBe('no_expectation');
    expect(templateSummary({ title: 'T', completionStatus: 'completed', plannedMinutes: 10, actualMinutes: 12, observationCount: 1, comparisons: [{ attribute: 'shade_quality', result: 'observed_lower_than_expected' }] })).toMatch(
      /shade quality \(lower than expected\)/,
    );
  });
  it('template summary states only recorded facts and compares only where an expectation existed', () => {
    const base = { title: 'T', completionStatus: 'completed', plannedMinutes: 10, actualMinutes: 0, observationCount: 0, comparisons: [] };
    expect(templateSummary(base)).toBe('Completed "T" in about 0 min (planned 10). No observations were recorded.');
    const noExpectation = templateSummary({ ...base, completionStatus: 'partial', actualMinutes: 7, observationCount: 2, comparisons: [{ attribute: 'crowding', result: 'no_expectation' }, { attribute: 'noise_level', result: 'matched' }] });
    expect(noExpectation).toBe('Partly completed "T" in about 7 min (planned 10). You recorded 2 observations.');
    expect(noExpectation).not.toMatch(/busier|quieter|safer|accessible|than (expected|anticipated)/i);
    expect(templateSummary({ ...base, actualMinutes: 7, minutesSource: 'user' })).toBe('Completed "T" in about 7 min by your estimate (planned 10). No observations were recorded.');
    expect(templateSummary({ ...base, actualMinutes: 7, minutesSource: 'timestamps' })).toBe('Completed "T" in about 7 min (planned 10). No observations were recorded.');
  });
  it('rounds coordinates to a coarse grid', () => {
    expect(roundCoords({ lat: 12.97634, lon: 77.59291 })).toEqual({ lat: 12.98, lon: 77.59 });
  });
});

describe('AI output validation', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (content: string) => new Response(JSON.stringify({ message: { content } }), { status: 200 });
  const schema = z.object({ summary: z.string().min(3) });

  it('retries malformed output, then succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply('not json {')).mockResolvedValueOnce(reply('{"summary":"fine"}'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await aiJson('t', 'sys', 'user', schema);
    expect(r.data).toEqual({ summary: 'fine' });
    expect(r.meta).toMatchObject({ attempts: 2, fallbackUsed: false, provider: 'ollama' });
  });
  it('ignores a leading <thought> block (Gemma 4 on AI Studio)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('<thought>plan {not json}</thought>\n{"summary":"fine"}')));
    const r = await aiJson('t', 'sys', 'user', schema);
    expect(r.data).toEqual({ summary: 'fine' });
    expect(r.meta.attempts).toBe(1);
  });
  it('falls back after bounded retries on schema-invalid output', async () => {
    const fetchMock = vi.fn(async () => reply('{"summary":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await aiJson('t', 'sys', 'user', schema);
    expect(r.data).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.meta).toMatchObject({ fallbackUsed: true, attempts: 2 });
    expect(r.meta.fallbackReason).toMatch(/invalid output at summary/);
  });
  it('falls back when the provider is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const r = await aiProposeMissions({ request: 'x', missionType: 'quiet_break', availableMinutes: 10, maxWalkMinutes: 10, timeOfDay: 'any', required: [], preferred: [], locations: [], weather: 'unknown', rememberedRequests: [] });
    expect(r).toMatchObject({ data: null, meta: { fallbackUsed: true, fallbackReason: 'fetch failed' } });
  });
  it('does not echo model output in fallback reasons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('SECRET-USER-TEXT not json')));
    const r = await aiJson('t', 'sys', 'user', schema);
    expect(r.meta.fallbackReason).toBe('malformed JSON');
  });
});

describe('log redaction', () => {
  it('removes tokens, transcripts, prompts and coordinates', () => {
    let out = '';
    const sink = new Writable({ write: (chunk, _e, cb) => ((out += chunk), cb()) });
    const logger = createLogger(sink);
    logger.level = 'info';
    logger.info(
      {
        req: { headers: { authorization: 'Bearer SECRET_TOKEN_123' } },
        token: 'SECRET_TOKEN_456',
        body: { text: 'my private voice note', prompt: 'quiet place near my house', coarseLocation: { lat: 12.97, lon: 77.59 } },
        apiKey: 'sk-live-abc',
        lat: 12.97,
      },
      'test',
    );
    expect(out).toContain('[REDACTED]');
    for (const secret of ['SECRET_TOKEN_123', 'SECRET_TOKEN_456', 'private voice note', 'near my house', '12.97', '77.59', 'sk-live-abc']) {
      expect(out).not.toContain(secret);
    }
  });
});
