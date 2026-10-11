/** Mission workflow: plan → start → observe → complete → report → evidence, plus idempotent sync. */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  ATTRIBUTES,
  type Attribute,
  type CompletePayload,
  type ConditionCheck,
  type EvidenceView,
  type LocationView,
  type Mission,
  type MissionAction,
  type PlanRequest,
  type Report,
  SyncOp,
  type SyncEnvelope,
  type SyncResult,
  type WeatherView,
} from '@shadeloop/shared';
import { env, RULES } from './config.ts';
import { col, isDuplicateKey } from './db.ts';
import {
  compareObservation,
  fitDurations,
  isAccessibility,
  isEvidenceAttribute,
  mergeConditions,
  nextStatus,
  rankLocations,
  summarizeEvidence,
  travelFor,
  validateCandidate,
  type EvidenceSummary,
  type PlanContext,
  type ValidatedCandidate,
} from './domain.ts';
import { AppError, notFound } from './errors.ts';
import { aiParseRequest, aiProposeMissions, type AiMeta } from './ai.ts';
import { buildTemplate, keywordConstraints, relatedTypes, templateSummary } from './fallback.ts';
import { discover, getWeather, loadLocations, recall, remember, type DiscoveryResult } from './providers.ts';
import { span, tool } from './integrations.ts';
import { tigerRecord } from './tiger.ts';
import { getPrefs } from './account.ts';
import { log } from './log.ts';

export type MissionDoc = Omit<Mission, 'id'> & {
  _id: string;
  ownerId: string;
  planId: string;
  updatedAt: string;
  expireAt?: Date;
  appliedOpIds: string[];
  /** Saved with the completion so the report can be (re)built from the mission alone. */
  feedback?: Report['feedback'];
};
type ReportDoc = Omit<Report, 'id'> & { _id: string; ownerId: string; observationIds?: string[] };
export type ObservationDoc = {
  _id: string;
  opId: string;
  ownerId: string;
  missionId: string;
  sessionId: string | null;
  attribute: Attribute;
  value: string;
  sourceType: 'user_report';
  /** Event time: the client's time corrected to the server clock and clamped (see `eventTime`). */
  clientTs: string;
  /** `clientTs` exactly as the client sent it. Absent on rows stored before 2026-10-11. */
  clientTsRaw?: string;
  serverTs: string;
  locationId: string | null;
  verificationStatus: 'unverified';
  privacy: 'location_linked' | 'mission_only';
};
type EvidenceDoc = EvidenceSummary & { locationId: string; updatedAt: Date; computedAt?: number };

const missions = () => col<MissionDoc>('missions');
const observations = () => col<ObservationDoc>('observations');
const reports = () => col<ReportDoc>('reports');
const evidenceCol = () => col<EvidenceDoc>('evidence');

export function missionView(d: MissionDoc): Mission {
  const { _id, ownerId: _o, planId: _p, updatedAt: _u, expireAt: _e, appliedOpIds: _a, feedback: _f, ...rest } = d;
  return { id: _id, ...rest };
}

export function reportView(d: ReportDoc): Report {
  const { _id, ownerId: _o, observationIds: _i, ...rest } = d;
  return { id: _id, ...rest };
}

function evidenceView(d: EvidenceDoc): EvidenceView {
  return {
    locationId: d.locationId,
    attribute: d.attribute,
    estimate: d.estimate,
    confidence: d.confidence,
    supporting: d.supporting,
    contradicting: d.contradicting,
    valueCounts: d.valueCounts,
    lastObservedAt: d.lastObservedAt?.toISOString() ?? null,
    expiresAt: d.expiresAt?.toISOString() ?? null,
    sourceType: 'aggregated',
    sources: d.sources,
  };
}

/* ---------------- Evidence ---------------- */

/**
 * Full recompute from source observations: each owner's latest report (by server receipt) is picked inside the query,
 * before the limit, so one owner's flood can't push other owners out. A write only lands if no recompute that started
 * later has written already (`computedAt`), so an older snapshot never overwrites a newer one.
 */
// ponytail: `computedAt` is this host's clock; with several instances, clock skew could reorder near-simultaneous recomputes. Use a per-key counter if that matters.
export async function recomputeEvidence(locationId: string, attribute: Attribute): Promise<EvidenceView | null> {
  if (!isEvidenceAttribute(attribute)) return null;
  const computedAt = performance.timeOrigin + performance.now();
  const latest = await observations()
    .aggregate<{ _id: string; value: string; clientTs: string }>([
      { $match: { locationId, attribute } },
      { $sort: { ownerId: 1, serverTs: -1, _id: -1 } },
      { $group: { _id: '$ownerId', value: { $first: '$value' }, clientTs: { $first: '$clientTs' }, serverTs: { $first: '$serverTs' } } },
      { $sort: { serverTs: -1, _id: 1 } },
      { $limit: RULES.evidence.maxReportsConsidered },
    ])
    .toArray();
  const olderThanMe = { locationId, attribute, computedAt: { $not: { $gte: computedAt } } };
  if (!latest.length) {
    await evidenceCol().deleteOne(olderThanMe);
    return null;
  }
  const summary = summarizeEvidence(
    attribute,
    latest.map((o) => ({ ownerId: o._id, value: o.value, observedAt: new Date(o.clientTs) })),
  );
  const doc = { ...summary, locationId, updatedAt: new Date(), computedAt };
  try {
    await evidenceCol().updateOne(olderThanMe, { $set: doc }, { upsert: true });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const newer = await evidenceCol().findOne({ locationId, attribute });
    return newer && evidenceView(newer);
  }
  // A later recompute may have seen every observation deleted and removed the summary before we wrote ours back.
  if (!(await observations().findOne({ locationId, attribute }, { projection: { _id: 1 } }))) {
    await evidenceCol().deleteOne({ locationId, attribute, computedAt });
    return null;
  }
  return evidenceView(doc);
}

export async function loadEvidence(locationIds: string[]): Promise<Map<string, Map<Attribute, EvidenceView>>> {
  const out = new Map<string, Map<Attribute, EvidenceView>>();
  if (!locationIds.length) return out;
  const now = new Date();
  for (const d of await evidenceCol().find({ locationId: { $in: locationIds } }).toArray()) {
    const view = d.reevaluateAt && d.reevaluateAt <= now ? await recomputeEvidence(d.locationId, d.attribute) : evidenceView(d);
    if (!view) continue;
    if (!out.has(d.locationId)) out.set(d.locationId, new Map());
    out.get(d.locationId)!.set(d.attribute, view);
  }
  return out;
}

/* ---------------- Planning ---------------- */

const CHECK_TEXT: Record<ConditionCheck['status'], string> = {
  supported: 'supported by field reports from several separate anonymous sessions',
  weak_support: 'one or two reports suggest yes (low confidence)',
  weak_against: 'one or two reports suggest no (low confidence)',
  contradicted: 'field reports say no',
  conflicting: 'field reports disagree',
  stale: 'reports are too old to rely on',
  unknown: 'no field reports yet, so this is unverified',
};

function safetyNotes(weather: WeatherView | null): string[] {
  const notes: string[] = [...RULES.baseSafetyNotes];
  if (weather?.available) {
    const at = `at ${weather.observedAt} (Open-Meteo)`;
    if (weather.apparentTemperatureC! >= RULES.heatApparentC) notes.push(`It feels hot: ${weather.apparentTemperatureC}°C apparent ${at}. Prefer shade and carry water.`);
    if (weather.apparentTemperatureC! <= RULES.coldApparentC) notes.push(`It feels cold: ${weather.apparentTemperatureC}°C apparent ${at}. Dress warmly.`);
    if (weather.precipitationMm! >= RULES.rainMm) notes.push(`Precipitation was reported ${at}.`);
  }
  return notes;
}

export const planMissions = (ownerId: string, input: PlanRequest) =>
  span('gen_ai.invoke_agent', 'invoke_agent plan_missions', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'shadeloop.planner' }, async (s) => {
    const r = await plan(ownerId, input);
    s.setAttributes({
      'shadeloop.missions': r.missions.length,
      'shadeloop.rejected_candidates': r.planning.generation.rejectedCandidates.length,
      'shadeloop.generator': r.planning.generation.generator,
    });
    return r;
  });

async function plan(ownerId: string, input: PlanRequest) {
  const prefs = await getPrefs(ownerId);

  let parse: (AiMeta & { method: 'ai' | 'keywords' }) | null = null;
  let parsed: Partial<ReturnType<typeof keywordConstraints>> = {};
  if (input.prompt) {
    const ai = await aiParseRequest(input.prompt);
    parsed = ai.data ?? keywordConstraints(input.prompt);
    parse = { ...ai.meta, method: ai.data ? 'ai' : 'keywords' };
  }
  const missionType = input.missionType ?? parsed.missionType ?? prefs.missionTypes[0] ?? 'quiet_break';
  const availableMinutes = input.availableMinutes ?? parsed.availableMinutes ?? prefs.defaultMinutes;
  const { required, preferred } = mergeConditions(prefs, { required: input.required, preferred: input.preferred }, parsed);

  const memoryOn = Boolean(input.prompt && prefs.privacy.rememberRequests && env.BACKBOARD_API_KEY);
  const remembered = memoryOn ? await tool('recall_memory', () => recall(ownerId, input.prompt!)) : [];

  const origin = input.coarseLocation;
  // Weather needs only the origin, so it runs alongside discovery. It never rejects (failures become `available: false`).
  const weatherP = origin ? tool('get_weather', () => getWeather(origin)) : Promise.resolve(null);
  let locations: LocationView[] = [];
  let discovery: DiscoveryResult | null = null;
  if (input.locationIds?.length) locations = await loadLocations(input.locationIds, origin);
  else if (origin) {
    discovery = await tool('discover_places', () => discover(origin));
    locations = discovery.locations;
  }
  locations = locations
    .filter((l) => l.category !== 'bench')
    .concat(locations.filter((l) => l.category === 'bench'))
    .slice(0, RULES.maxDiscoveredLocations);
  const weather = await weatherP;
  const evidence = await loadEvidence(locations.map((l) => l.id));
  const ctx: PlanContext = { availableMinutes, prefs, required, preferred, locations: new Map(locations.map((l) => [l.id, l])), evidence };
  const typeOrder = input.missionType ? [missionType] : [missionType, ...relatedTypes(missionType)];
  const maxMinutes = Math.min(availableMinutes, RULES.maxMissionMinutes);

  const ai = await aiProposeMissions({
    request: input.prompt,
    missionType: input.missionType ? missionType : `${missionType} (or related: ${relatedTypes(missionType).join(', ')})`,
    availableMinutes: maxMinutes,
    maxWalkMinutes: prefs.maxWalkMinutes,
    timeOfDay: prefs.timeOfDay,
    required,
    preferred,
    locations: [
      { id: 'null', name: 'no specific place', category: 'none', maxStepMinutes: maxMinutes, evidence: {} },
      ...locations.map((l) => ({
        id: l.id,
        name: l.name,
        category: l.category,
        maxStepMinutes: maxMinutes - (travelFor(l, prefs)?.minutesRoundTrip ?? 0),
        evidence: Object.fromEntries(
          [...(evidence.get(l.id)?.values() ?? [])].map((e) => [
            e.attribute,
            `${e.estimate ?? 'none'} (${e.confidence}, ${e.supporting + e.contradicting} unverified anonymous reports)`,
          ]),
        ),
      })),
    ],
    weather: weather?.available ? `${weather.temperatureC}°C, feels ${weather.apparentTemperatureC}°C, precipitation ${weather.precipitationMm} mm` : 'unknown',
    rememberedRequests: remembered,
  });
  const rejected: string[] = [];
  let accepted: (ValidatedCandidate & { aiText?: string })[] = [];
  for (const c of ai.data?.missions ?? []) {
    const locationId = c.locationId === 'null' ? null : c.locationId;
    const loc = locationId ? ctx.locations.get(locationId) ?? null : null;
    const raw = { ...c, locationId };
    const candidate = fitDurations(raw, maxMinutes - (travelFor(loc, prefs)?.minutesRoundTrip ?? 0)) ?? raw;
    const v = validateCandidate(candidate, ctx);
    if (!v.ok) rejected.push(`"${c.title}": ${v.errors.join('; ')}`);
    else if (input.missionType && v.candidate.type !== missionType) rejected.push(`"${c.title}": wrong mission type`);
    else {
      if (candidate !== raw) v.uncertainty.push('Step durations were shortened by the constraint engine to fit your time.');
      accepted.push({ ...v, aiText: c.whyItMatches });
    }
  }
  if (rejected.length) log.info({ rejected: rejected.length }, 'AI candidates rejected by constraint engine');

  const usedAi = accepted.length > 0;
  const fallbackReason = usedAi ? null : (ai.meta.fallbackReason ?? `all AI candidates failed constraints: ${rejected.join(' | ')}`.slice(0, 500));
  if (!usedAi) {
    const ranked = rankLocations(ctx);
    const used = new Set<string>();
    for (const type of typeOrder.slice(0, RULES.maxCandidates)) {
      const options = [...ranked.filter((l) => !used.has(l.id)), ...ranked.filter((l) => used.has(l.id)), null];
      for (const loc of options) {
        const travel = travelFor(loc, prefs)?.minutesRoundTrip ?? 0;
        const c = buildTemplate(type, maxMinutes - travel, prefs.maxWalkMinutes - travel, loc);
        const v = c && validateCandidate(c, ctx);
        if (v?.ok) {
          accepted.push(v);
          if (loc) used.add(loc.id);
          break;
        }
      }
    }
  }
  accepted = accepted.slice(0, RULES.maxCandidates);
  if (!accepted.length) {
    throw new AppError(422, 'NO_FEASIBLE_MISSION', 'No mission fits these constraints. Try more time or relax walking limits.', { rejected });
  }

  const now = new Date();
  const planId = randomUUID();
  const provenance = {
    generator: usedAi ? ('ai' as const) : ('template' as const),
    provider: ai.meta.provider,
    model: ai.meta.model,
    fallbackUsed: !usedAi,
    fallbackReason,
  };
  const docs: MissionDoc[] = accepted.map((v) => ({
    _id: randomUUID(),
    ownerId,
    planId,
    title: v.candidate.title,
    description: v.candidate.description,
    type: v.candidate.type,
    objective: v.candidate.objective,
    availableMinutes,
    estimatedMinutes: v.estimatedMinutes,
    walkingMinutes: v.walkingMinutes,
    constraints: { required, preferred },
    conditionChecks: v.conditionChecks,
    candidateLocations: locations,
    selectedLocation: v.location,
    travel: v.travel,
    route: null,
    steps: v.candidate.steps,
    observationPrompts: v.candidate.observationPrompts,
    safetyNotes: safetyNotes(weather),
    expectations: v.expectations,
    weather,
    whyItMatches: [
      ...(v.aiText ? [{ text: v.aiText, sourceType: 'ai_suggestion' as const }] : [{ text: v.candidate.whyItMatches, sourceType: 'inferred' as const }]),
      { text: `Estimated ${v.estimatedMinutes} min fits your ${availableMinutes} min.`, sourceType: 'inferred' as const },
      ...v.conditionChecks.map((c) => ({
        text: `${c.condition.replace('_', ' ')} (${c.required ? 'required' : 'preferred'}): ${CHECK_TEXT[c.status]}${c.verification === 'unverified' && isAccessibility(c.condition) ? ' (anonymous, not verified)' : ''}.`,
        sourceType: c.provenance === 'unknown' ? ('inferred' as const) : c.provenance,
      })),
      ...(v.location && !v.location.isFixture
        ? [{ text: `${v.location.name} is mapped as a ${v.location.category} (${v.location.attribution}).`, sourceType: 'external_map_data' as const }]
        : []),
    ],
    provenance,
    uncertainty: [
      ...v.uncertainty,
      ...(weather === null ? ['No location shared, so weather was not checked.'] : weather.available ? [] : ['Weather is unavailable. Check conditions yourself.']),
      ...(v.location?.isFixture ? ['This place is a sample fixture for demos, not a real location.'] : []),
    ],
    status: 'planned',
    session: {
      id: null,
      startedAt: null,
      pausedAt: null,
      totalPausedMs: 0,
      completedAt: null,
      cancelledAt: null,
      currentStep: 0,
      completionStatus: null,
      userMinutes: null,
      lastEventAt: null,
    },
    reportId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
    expireAt: new Date(now.getTime() + RULES.plannedMissionTtlDays * 86_400_000),
    appliedOpIds: [],
  }));
  await missions().insertMany(docs);
  const saved = memoryOn && (await tool('save_memory', () => remember(ownerId, input.prompt!)));

  return {
    planId,
    missions: docs.map(missionView),
    planning: {
      constraints: { missionType, availableMinutes, required, preferred },
      parse,
      generation: { ...provenance, attempts: ai.meta.attempts, rejectedCandidates: rejected },
      weather,
      discovery: discovery && { mode: discovery.mode, sources: discovery.sources, limitations: discovery.limitations },
      memory: memoryOn ? { provider: 'backboard', recalled: remembered.length, saved } : null,
    },
  };
}

/* ---------------- Reads ---------------- */

export async function getMission(ownerId: string, id: string) {
  const d = await missions().findOne({ _id: id, ownerId });
  if (!d) throw notFound('Mission');
  return d;
}

// ponytail: skip/limit pagination degrades on deep pages; switch to an (updatedAt, _id) cursor if histories get long.
export async function listMissions(ownerId: string, filter: { status?: string[] }, page: number, limit: number) {
  const q = { ownerId, ...(filter.status ? { status: { $in: filter.status as Mission['status'][] } } : {}) };
  const [items, total] = await Promise.all([
    missions().find(q).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    missions().countDocuments(q),
  ]);
  return { items: items.map(missionView), page, limit, total };
}

export async function history(ownerId: string, page: number, limit: number) {
  const list = await listMissions(ownerId, { status: ['completed', 'cancelled'] }, page, limit);
  const reps = await reports()
    .find({ ownerId, missionId: { $in: list.items.map((m) => m.id) } }, { projection: { missionId: 1, summary: 1, actual: 1, comparisons: 1 } })
    .toArray();
  const byMission = new Map(reps.map((r) => [r.missionId, r]));
  for (const m of list.items) {
    if (m.status === 'completed' && !byMission.has(m.id)) byMission.set(m.id, await ensureReport(await getMission(ownerId, m.id)));
  }
  return {
    ...list,
    items: list.items.map((m) => {
      const r = byMission.get(m.id);
      return {
        mission: m,
        report: r ? { id: r._id, summary: r.summary.text, actualMinutes: r.actual.minutes, observations: r.actual.observations.length, comparisons: r.comparisons } : null,
      };
    }),
  };
}

export async function getReport(ownerId: string, id: string) {
  const r = await reports().findOne({ _id: id, ownerId });
  if (r) return reportView(r);
  const m = await missions().findOne({ reportId: id, ownerId, status: 'completed' });
  if (!m) throw notFound('Report');
  return reportView(await ensureReport(m));
}

export async function listObservations(ownerId: string, missionId: string) {
  await getMission(ownerId, missionId);
  const items = await observations().find({ ownerId, missionId }).sort({ clientTs: 1 }).toArray();
  return items.map(({ ownerId: _o, _id, ...o }) => ({ id: _id, ...o }));
}

/* ---------------- Transitions ---------------- */

/** Server clock minus client clock, from the client's `sentAt`. Overstates by the request's latency. Undefined without `sentAt`. */
export const clockOffset = (sentAt: string | undefined) => (sentAt ? Date.now() - Date.parse(sentAt) : undefined);

/**
 * A client timestamp moved onto the server clock. With a known offset it is shifted by it and clamped to now; without
 * one (older clients) a time more than `clockSkewMs` ahead is refused. Never before `floorIso` (the previous event).
 */
function eventTime(clientTs: string | undefined, floorIso: string, offsetMs?: number): string {
  const now = Date.now();
  let t = clientTs ? Date.parse(clientTs) : now;
  if (offsetMs !== undefined) t = Math.min(t + offsetMs, now);
  else if (t > now + RULES.clockSkewMs) throw new AppError(400, 'CLOCK_SKEW', 'clientTs is in the future');
  return new Date(Math.max(t, Date.parse(floorIso))).toISOString();
}

type CompleteInput = z.infer<typeof CompletePayload>;

export async function transition(
  ownerId: string,
  id: string,
  action: MissionAction,
  opts: { clientTs?: string; offsetMs?: number; opId?: string; currentStep?: number; complete?: Partial<CompleteInput> } = {},
) {
  const m = await getMission(ownerId, id);
  // Repeating a complete (same opId or not) returns the one report, building it if a crash left it missing.
  const settled = async (d: MissionDoc) => {
    if (d.status === 'completed') await ensureReport(d);
    return { mission: missionView(d), reportId: d.reportId, alreadyApplied: true };
  };
  if ((opts.opId && m.appliedOpIds.includes(opts.opId)) || (action === 'complete' && m.status === 'completed')) return settled(m);
  const to = nextStatus(m.status, action);
  if (!to) throw new AppError(409, 'INVALID_TRANSITION', `Cannot ${action} a mission that is ${m.status}`, { currentStatus: m.status, action });

  const ts = eventTime(opts.clientTs, m.session.lastEventAt ?? m.createdAt, opts.offsetMs);
  const s = { ...m.session, lastEventAt: ts };
  const closePause = () => {
    if (s.pausedAt) s.totalPausedMs += Date.parse(ts) - Date.parse(s.pausedAt);
    s.pausedAt = null;
  };
  if (action === 'start') {
    s.id = randomUUID();
    s.startedAt = ts;
  } else if (action === 'pause') s.pausedAt = ts;
  else if (action === 'resume') closePause();
  else if (action === 'cancel') {
    closePause();
    s.cancelledAt = ts;
  } else {
    closePause();
    s.completedAt = ts;
    s.completionStatus = opts.complete?.completionStatus ?? 'completed';
    s.userMinutes = opts.complete?.actualMinutes ?? null;
  }
  const step = opts.currentStep ?? opts.complete?.currentStep;
  if (step !== undefined) s.currentStep = Math.min(step, m.steps.length - 1);

  const completion =
    action === 'complete' ? { reportId: randomUUID(), feedback: { rating: opts.complete?.rating ?? null, text: opts.complete?.feedback ?? null } } : {};
  const updated = await missions().findOneAndUpdate(
    { _id: id, ownerId, version: m.version },
    {
      $set: { status: to, session: s, updatedAt: new Date().toISOString(), ...completion },
      $inc: { version: 1 },
      ...(opts.opId ? { $push: { appliedOpIds: { $each: [opts.opId], $slice: -100 } } } : {}),
      // Only untouched planned missions expire; a cancelled one is history.
      ...(action === 'start' || action === 'cancel' ? { $unset: { expireAt: '' } } : {}),
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    const now = await getMission(ownerId, id);
    if ((opts.opId && now.appliedOpIds.includes(opts.opId)) || (action === 'complete' && now.status === 'completed')) return settled(now);
    throw new AppError(409, 'CONFLICT', 'Mission changed at the same time. Reload and retry.');
  }
  if (action === 'complete') await ensureReport(updated);
  return { mission: missionView(updated), reportId: updated.reportId, alreadyApplied: false };
}

/**
 * The report of a completed mission, built once from persisted observations. Safe to call concurrently and after a crash:
 * its id was fixed when the mission was completed, so the first insert wins and everyone else reads it.
 */
async function ensureReport(m: MissionDoc): Promise<ReportDoc> {
  const id = m.reportId!;
  const existing = await reports().findOne({ _id: id });
  if (existing) return existing;
  const report = await buildReport(m, id);
  try {
    await reports().insertOne(report);
    return report;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
  const won = await reports().findOne({ _id: id });
  if (won) return won;
  // A report under another id is an orphan from before completion committed first; it may miss observations.
  await reports().deleteMany({ missionId: m._id, _id: { $ne: id } });
  try {
    await reports().insertOne(report);
    return report;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return (await reports().findOne({ _id: id }))!;
  }
}

async function buildReport(m: MissionDoc, id: string): Promise<ReportDoc> {
  const s = m.session;
  const input = m.feedback ?? { rating: null, text: null };
  const obs = await observations().find({ ownerId: m.ownerId, missionId: m._id }).sort({ clientTs: 1 }).toArray();
  const latest = new Map<Attribute, string>();
  for (const o of obs) latest.set(o.attribute, o.value);
  const comparisons = [...latest].map(([attribute, observed]) => {
    // temperature_feel is already relative to what the user expected.
    const exp = attribute === 'temperature_feel' ? { estimate: 'as_expected', confidence: null } : m.expectations.find((e) => e.attribute === attribute);
    const expected = exp && (exp.confidence === null || exp.confidence === 'low' || exp.confidence === 'moderate') ? exp.estimate : null;
    return {
      attribute,
      expected,
      expectedConfidence: attribute === 'temperature_feel' ? null : (exp?.confidence ?? 'unknown'),
      observed,
      result: compareObservation(ATTRIBUTES[attribute], expected, observed),
    } as Report['comparisons'][number];
  });
  // Active time between corrected event times. Negative or over-long (e.g. left running and completed days later) is not a duration.
  const timed = (Date.parse(s.completedAt!) - Date.parse(s.startedAt!) - s.totalPausedMs) / 60_000;
  const computed = timed >= 0 && timed <= RULES.maxActualMinutes ? Math.round(timed) : null;
  const actualMinutes = s.userMinutes ?? computed;
  const completionStatus = s.completionStatus ?? 'completed';
  const facts = {
    title: m.title,
    type: m.type,
    completionStatus,
    plannedMinutes: m.estimatedMinutes,
    actualMinutes,
    stepsReached: s.currentStep + 1,
    stepCount: m.steps.length,
    comparisons: comparisons.map(({ attribute, expected, observed, result }) => ({ attribute, expected, observed, result })),
  };
  const locationId = m.selectedLocation?.id;
  const evidenceRefs = locationId
    ? (await evidenceCol().find({ locationId, attribute: { $in: [...latest.keys()] } }).toArray()).map(evidenceView)
    : [];
  return {
    _id: id,
    ownerId: m.ownerId,
    missionId: m._id,
    createdAt: new Date().toISOString(),
    completionStatus,
    planned: {
      title: m.title,
      estimatedMinutes: m.estimatedMinutes,
      availableMinutes: m.availableMinutes,
      stepCount: m.steps.length,
      location: m.selectedLocation?.name ?? null,
      expectations: m.expectations,
    },
    actual: {
      minutes: actualMinutes,
      minutesSource: s.userMinutes !== null ? 'user' : 'timestamps',
      measuredMinutes: computed,
      stepsReached: s.currentStep + 1,
      observations: obs.map((o) => ({ attribute: o.attribute, value: o.value, observedAt: o.clientTs })),
    },
    comparisons,
    feedback: input,
    summary: { text: templateSummary({ ...facts, minutesSource: s.userMinutes !== null ? 'user' : 'timestamps', observationCount: obs.length }), generator: 'template', provider: null, model: null, fallbackUsed: false, fallbackReason: null },
    evidenceRefs,
    observationIds: obs.map((o) => o._id),
  };
}

/* ---------------- Observations ---------------- */

export async function addObservation(
  ownerId: string,
  missionId: string,
  input: { attribute: Attribute; value: string; opId: string; clientTs: string; offsetMs?: number },
) {
  const m = await getMission(ownerId, missionId);
  const notActive = (status: Mission['status']) =>
    new AppError(409, 'MISSION_NOT_ACTIVE', `Observations need an active or paused mission (currently ${status})`, { currentStatus: status });
  if (m.status !== 'active' && m.status !== 'paused') throw notActive(m.status);
  const locationId = m.selectedLocation?.id ?? null;
  let doc: ObservationDoc = {
    _id: randomUUID(),
    opId: input.opId,
    ownerId,
    missionId,
    sessionId: m.session.id,
    attribute: input.attribute,
    value: input.value,
    sourceType: 'user_report',
    clientTs: eventTime(input.clientTs, m.session.startedAt ?? m.createdAt, input.offsetMs),
    clientTsRaw: input.clientTs,
    serverTs: new Date().toISOString(),
    locationId,
    verificationStatus: 'unverified',
    privacy: locationId ? 'location_linked' : 'mission_only',
  };
  let duplicate = false;
  try {
    await observations().insertOne(doc);
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const prior = await observations().findOne({ opId: input.opId });
    if (!prior || prior.ownerId !== ownerId) throw new AppError(409, 'OPID_CONFLICT', 'opId already used');
    doc = prior;
    duplicate = true;
  }
  const overLimit = !duplicate && (await overObservationLimit(doc));
  // The mission may have been completed or cancelled since the check above. The observation is kept only if the
  // mission is still open (so any later report reads it) or the mission's report already contains it.
  const now = await getMission(ownerId, doc.missionId);
  const open = now.status === 'active' || now.status === 'paused';
  const kept = (open && !overLimit) || (now.status === 'completed' && (await ensureReport(now)).observationIds?.includes(doc._id));
  if (!kept) {
    await observations().deleteOne({ _id: doc._id });
    if (doc.locationId) await recomputeEvidence(doc.locationId, doc.attribute);
    if (open) {
      const { perMission, perAttribute } = RULES.observationLimits;
      throw new AppError(429, 'OBSERVATION_LIMIT', `A mission accepts at most ${perMission} observations and ${perAttribute} per attribute`, { perMission, perAttribute });
    }
    throw notActive(now.status);
  }
  if (duplicate) return { observation: doc, duplicate: true, evidence: null };
  await tigerRecord(doc);
  const evidence = locationId ? await recomputeEvidence(locationId, input.attribute) : null;
  return { observation: doc, duplicate: false, evidence };
}

/**
 * Counted after our own insert. Accepted rows are never removed by this check, so whichever accepted request counted
 * last saw all of them: the cap can't be exceeded. Concurrent requests at the boundary may all be refused instead.
 */
async function overObservationLimit(doc: ObservationDoc) {
  const q = { ownerId: doc.ownerId, missionId: doc.missionId };
  const [all, same] = await Promise.all([observations().countDocuments(q), observations().countDocuments({ ...q, attribute: doc.attribute })]);
  return all > RULES.observationLimits.perMission || same > RULES.observationLimits.perAttribute;
}

/* ---------------- Sync ---------------- */

type SyncRecord = {
  opId: string;
  ownerId: string;
  entityType: 'mission' | 'observation';
  entityId: string;
  /** A `SyncOp` type, or whatever an op refused as invalid claimed to be. */
  opType: string;
  clientTs: string;
  serverTs: Date;
  /** `pending` while one request holds the lease and applies the op; anything else is the final answer. */
  status: Exclude<SyncResult['status'], 'duplicate' | 'retry'> | 'pending';
  lease?: string;
  leaseUntil?: Date;
  result?: Record<string, unknown>;
  error?: SyncResult['error'];
};

async function applyOp(
  ownerId: string,
  op: SyncOp,
  offsetMs: number | undefined,
): Promise<{ status: Exclude<SyncResult['status'], 'duplicate'>; result?: Record<string, unknown>; error?: SyncResult['error'] }> {
  try {
    if (op.type === 'observation') {
      const r = await addObservation(ownerId, op.missionId, { ...op.payload, opId: op.opId, clientTs: op.clientTs, offsetMs });
      return { status: 'applied', result: { observationId: r.observation._id } };
    }
    const r = await transition(ownerId, op.missionId, op.type, {
      clientTs: op.clientTs,
      offsetMs,
      opId: op.opId,
      currentStep: op.payload?.currentStep,
      complete: op.type === 'complete' ? op.payload : undefined,
    });
    return { status: 'applied', result: { missionStatus: r.mission.status, version: r.mission.version, reportId: r.reportId } };
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    const error = { code: e.code, message: e.message, details: e.details };
    // Losing an optimistic-concurrency race says nothing about the op itself, so it must not become its stored answer.
    if (e.code === 'CONFLICT') return { status: 'retry', error };
    return { status: e.status === 409 ? 'conflict' : 'rejected', error };
  }
}

const syncRecords = () => col<SyncRecord>('sync_records');

type EnvelopeOp = z.infer<typeof SyncEnvelope>['ops'][number];

/** Claim an opId before applying it: returns our lease, or the answer to send instead (stored result, foreign opId, or still in progress). */
async function reserve(ownerId: string, op: EnvelopeOp): Promise<string | SyncResult> {
  const lease = randomUUID();
  const leaseUntil = () => new Date(Date.now() + RULES.syncLeaseMs);
  try {
    await syncRecords().insertOne({
      opId: op.opId,
      ownerId,
      entityType: op.type === 'observation' ? 'observation' : 'mission',
      entityId: op.missionId,
      opType: op.type,
      clientTs: op.clientTs,
      serverTs: new Date(),
      status: 'pending',
      lease,
      leaseUntil: leaseUntil(),
    });
    return lease;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
  const inProgress: SyncResult = { opId: op.opId, status: 'retry', error: { code: 'IN_PROGRESS', message: 'This op is being applied by another request. Resend it later.' } };
  const prior = await syncRecords().findOne({ opId: op.opId });
  if (!prior) return inProgress;
  if (prior.ownerId !== ownerId) return { opId: op.opId, status: 'rejected', error: { code: 'OPID_CONFLICT', message: 'opId already used' } };
  if (prior.status !== 'pending') {
    return { opId: op.opId, status: 'duplicate', result: { originalStatus: prior.status, ...prior.result }, ...(prior.error ? { error: prior.error } : {}) };
  }
  // The holder crashed or stalled past its lease: take the op over. Re-applying is safe because the domain dedupes by opId.
  const taken = await syncRecords().findOneAndUpdate(
    { opId: op.opId, ownerId, status: 'pending', leaseUntil: { $lte: new Date() } },
    { $set: { lease, leaseUntil: leaseUntil() } },
  );
  return taken ? lease : inProgress;
}

/**
 * Apply ops in order, each at most once per opId. Repeated opIds return the stored result. Server errors release the
 * op and abort the batch so the client retries; a `retry` result stops the batch too, so later ops never run out of order.
 * One clock offset (from `sentAt`) applies to the whole batch, so ops keep their order and spacing. An op's times are
 * fixed when it is first applied; a resend with a later `sentAt` returns the stored result.
 * An op that fails `SyncOp` validation is `rejected / VALIDATION_ERROR` (stored, like other refusals); the others still
 * run. Each op is judged against the mission's current state, so a refused op doesn't hold back later ops here: those
 * that depended on it get their own refusal from the state machine.
 */
export async function sync(ownerId: string, ops: EnvelopeOp[], sentAt?: string): Promise<SyncResult[]> {
  const offsetMs = clockOffset(sentAt);
  const results: SyncResult[] = [];
  for (const op of ops) {
    const lease = await reserve(ownerId, op);
    if (typeof lease !== 'string') {
      results.push(lease);
      if (lease.status === 'retry') break;
      continue;
    }
    let res: Awaited<ReturnType<typeof applyOp>>;
    try {
      const parsed = SyncOp.safeParse(op);
      res = parsed.success
        ? await applyOp(ownerId, parsed.data, offsetMs)
        : {
            status: 'rejected',
            error: { code: 'VALIDATION_ERROR', message: 'Invalid op', details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
          };
    } catch (e) {
      await syncRecords().deleteOne({ opId: op.opId, lease });
      throw e;
    }
    results.push({ opId: op.opId, ...res });
    if (res.status === 'retry') {
      await syncRecords().deleteOne({ opId: op.opId, lease });
      break;
    }
    await syncRecords().updateOne(
      { opId: op.opId, lease },
      { $set: { status: res.status, serverTs: new Date(), ...(res.result ? { result: res.result } : {}), ...(res.error ? { error: res.error } : {}) }, $unset: { lease: '', leaseUntil: '' } },
    );
  }
  return results;
}
