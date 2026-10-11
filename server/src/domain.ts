/** Pure, deterministic business rules: evidence model, condition checks, state machine, candidate validation. No I/O. */
import { z } from 'zod';
import {
  AttributeName,
  MissionType,
  type Attribute,
  type Condition,
  type ConditionCheck,
  type Coords,
  type EvidenceView,
  type LocationView,
  type MissionAction,
  type MissionStatus,
  type Preferences,
  type Step,
} from '@shadeloop/shared';
import { RULES } from './config.ts';

/* ---------------- State machine ---------------- */

const TRANSITIONS: Record<MissionAction, { from: MissionStatus[]; to: MissionStatus }> = {
  start: { from: ['planned'], to: 'active' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  complete: { from: ['active', 'paused'], to: 'completed' },
  cancel: { from: ['planned', 'active', 'paused'], to: 'cancelled' },
};

export const nextStatus = (status: MissionStatus, action: MissionAction): MissionStatus | null =>
  TRANSITIONS[action].from.includes(status) ? TRANSITIONS[action].to : null;

/* ---------------- Evidence model ---------------- */

export interface EvidenceReport {
  ownerId: string;
  value: string;
  observedAt: Date;
}

export interface EvidenceSummary extends Omit<EvidenceView, 'locationId' | 'lastObservedAt' | 'expiresAt'> {
  lastObservedAt: Date | null;
  expiresAt: Date | null;
  /** When the summary must be recomputed because a counted report leaves its freshness window. */
  reevaluateAt: Date | null;
}

export const isEvidenceAttribute = (a: Attribute) => RULES.evidence.freshnessDays[a] !== undefined;

/**
 * Rules (documented in docs/DOMAIN_MODEL.md):
 * - no reports → unknown; reports exist but all older than the attribute window → stale
 * - only each owner's latest fresh report counts (independence = distinct owners)
 * - tie for top value, or minority share ≥ 1/3 → conflicting (estimate withheld)
 * - top value backed by ≥ 3 independent owners → moderate, otherwise low (so one report is never above low)
 */
export function summarizeEvidence(attribute: Attribute, reports: EvidenceReport[], now = new Date()): EvidenceSummary {
  const days = RULES.evidence.freshnessDays[attribute];
  if (days === undefined) throw new Error(`${attribute} is not a location evidence attribute`);
  const windowMs = days * 86_400_000;
  const sorted = [...reports].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const empty = { attribute, sourceType: 'aggregated' as const, supporting: 0, contradicting: 0, valueCounts: {} };
  if (!sorted.length) {
    return { ...empty, sources: [], estimate: null, confidence: 'unknown', lastObservedAt: null, expiresAt: null, reevaluateAt: null };
  }
  const lastObservedAt = sorted[0].observedAt;
  const expiresAt = new Date(lastObservedAt.getTime() + windowMs);
  const latestPerOwner = new Map<string, EvidenceReport>();
  for (const r of sorted) {
    if (now.getTime() - r.observedAt.getTime() <= windowMs && !latestPerOwner.has(r.ownerId)) latestPerOwner.set(r.ownerId, r);
  }
  if (!latestPerOwner.size) {
    return { ...empty, sources: ['user_report'], estimate: sorted[0].value, confidence: 'stale', lastObservedAt, expiresAt, reevaluateAt: null };
  }
  const counted = [...latestPerOwner.values()];
  const valueCounts: Record<string, number> = {};
  for (const r of counted) valueCounts[r.value] = (valueCounts[r.value] ?? 0) + 1;
  const ranked = Object.entries(valueCounts).sort((a, b) => b[1] - a[1]);
  const [topValue, top] = ranked[0];
  const total = counted.length;
  const contradicting = total - top;
  const conflicting = ranked[1]?.[1] === top || contradicting / total >= RULES.evidence.conflictMinorityShare;
  const oldestCounted = Math.min(...counted.map((r) => r.observedAt.getTime()));
  return {
    ...empty,
    sources: ['user_report'],
    estimate: conflicting ? null : topValue,
    confidence: conflicting ? 'conflicting' : top >= RULES.evidence.moderateMinIndependent ? 'moderate' : 'low',
    supporting: top,
    contradicting,
    valueCounts,
    lastObservedAt,
    expiresAt,
    reevaluateAt: new Date(oldestCounted + windowMs),
  };
}

/* ---------------- Conditions ---------------- */

export function checkCondition(
  condition: Condition,
  required: boolean,
  ev?: Pick<EvidenceView, 'estimate' | 'confidence'> & Partial<Pick<EvidenceView, 'supporting' | 'contradicting'>>,
): ConditionCheck {
  const { attribute, accept } = RULES.conditions[condition];
  const reports = (ev?.supporting ?? 0) + (ev?.contradicting ?? 0);
  const provenance = !ev || ev.confidence === 'unknown' ? 'unknown' : reports === 1 ? 'user_report' : 'aggregated';
  const base = { condition, required, attribute, confidence: ev?.confidence ?? 'unknown', estimate: ev?.estimate ?? null, provenance, verification: 'unverified' } as const;
  if (!ev || ev.confidence === 'unknown') return { ...base, status: 'unknown' };
  if (ev.confidence === 'stale' || ev.confidence === 'conflicting') return { ...base, status: ev.confidence };
  const ok = ev.estimate !== null && accept.includes(ev.estimate);
  if (ev.confidence === 'moderate') return { ...base, status: ok ? 'supported' : 'contradicted' };
  return { ...base, status: ok ? 'weak_support' : 'weak_against' };
}

export const isAccessibility = (c: Condition) => RULES.accessibilityConditions.includes(c);

/** Merge explicit, parsed and preference-derived conditions. Required wins over preferred. */
export function mergeConditions(prefs: Preferences, ...sources: { required?: Condition[]; preferred?: Condition[] }[]) {
  const required = new Set<Condition>(sources.flatMap((s) => s.required ?? []));
  if (prefs.accessibility.stepFreeRequired) required.add('step_free');
  if (prefs.accessibility.needsSeating) required.add('bench');
  const preferred = new Set<Condition>(sources.flatMap((s) => s.preferred ?? []));
  if (prefs.accessibility.avoidCrowds) preferred.add('not_crowded');
  for (const c of required) preferred.delete(c);
  return { required: [...required], preferred: [...preferred] };
}

/* ---------------- Geometry ---------------- */

export function roundCoords(c: Coords): Coords {
  const f = 10 ** RULES.coordDecimals;
  return { lat: Math.round(c.lat * f) / f, lon: Math.round(c.lon * f) / f };
}

export function distanceM(a: Coords, b: Coords): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

/* ---------------- Candidate validation (constraint engine) ---------------- */

export const Candidate = z.object({
  title: z.string().trim().min(3).max(80),
  description: z.string().trim().min(10).max(400),
  type: MissionType,
  objective: z.string().trim().min(5).max(200),
  locationId: z.string().max(200).nullable(),
  steps: z
    .array(z.object({ text: z.string().trim().min(3).max(240).describe('Instruction only. Never state a duration here: it goes in minutes.'), minutes: z.number().int().min(1).max(RULES.maxStepMinutes), kind: z.enum(['walk', 'still', 'observe']) }))
    .min(1)
    .max(RULES.maxSteps),
  observationPrompts: z.array(AttributeName).min(1).max(7),
  whyItMatches: z.string().trim().min(5).max(300),
});
export type Candidate = z.infer<typeof Candidate>;

export interface PlanContext {
  availableMinutes: number;
  prefs: Preferences;
  required: Condition[];
  preferred: Condition[];
  locations: Map<string, LocationView>;
  evidence: Map<string, Map<Attribute, EvidenceView>>;
}

export function findUnsafeText(text: string): string | null {
  for (const p of RULES.unsafePatterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

export function travelFor(loc: LocationView | null, prefs: Preferences) {
  if (!loc || loc.distanceM === undefined) return null;
  const oneWay = Math.ceil(loc.distanceM / RULES.walkingSpeedMPerMin[prefs.walkingPace]);
  return { distanceM: loc.distanceM, minutesRoundTrip: oneWay * 2, approximate: true as const };
}

export const sumMinutes = (steps: Pick<Step, 'minutes'>[]) => steps.reduce((s, x) => s + x.minutes, 0);

export function conditionChecksFor(locationId: string | null, ctx: PlanContext): ConditionCheck[] {
  const ev = locationId ? ctx.evidence.get(locationId) : undefined;
  return [
    ...ctx.required.map((c) => checkCondition(c, true, ev?.get(RULES.conditions[c].attribute))),
    ...ctx.preferred.map((c) => checkCondition(c, false, ev?.get(RULES.conditions[c].attribute))),
  ];
}

export type ValidatedCandidate = Extract<ReturnType<typeof validateCandidate>, { ok: true }>;

/** Deterministic checks every candidate (AI or template) must pass. AI text can't override these. */
export function validateCandidate(c: Candidate, ctx: PlanContext) {
  const errors: string[] = [];
  const unsafe = findUnsafeText([c.title, c.description, c.objective, c.whyItMatches, ...c.steps.map((s) => s.text)].join('\n'));
  if (unsafe) errors.push(`unsafe text: "${unsafe}"`);
  const duration = [c.title, c.description, c.objective, ...c.steps.map((s) => s.text)].join('\n').match(RULES.durationPattern);
  if (duration) errors.push(`text states a duration ("${duration[0]}"); durations belong only in step minutes`);
  if (c.steps.some((s) => !Number.isInteger(s.minutes) || s.minutes < 1 || s.minutes > RULES.maxStepMinutes)) {
    errors.push(`step minutes must be whole numbers from 1 to ${RULES.maxStepMinutes}`);
  }
  const loc = c.locationId ? ctx.locations.get(c.locationId) ?? null : null;
  if (c.locationId && !loc) errors.push('location not in supplied candidates');
  const travel = travelFor(loc, ctx.prefs);
  const estimatedMinutes = sumMinutes(c.steps) + (travel?.minutesRoundTrip ?? 0);
  const walkingMinutes = (travel?.minutesRoundTrip ?? 0) + sumMinutes(c.steps.filter((s) => s.kind === 'walk'));
  const maxMinutes = Math.min(ctx.availableMinutes, RULES.maxMissionMinutes);
  if (estimatedMinutes > maxMinutes) errors.push(`estimated ${estimatedMinutes} min exceeds limit ${maxMinutes} min`);
  if (estimatedMinutes < RULES.minMissionMinutes) errors.push(`estimated ${estimatedMinutes} min below minimum`);
  if (walkingMinutes > ctx.prefs.maxWalkMinutes) errors.push(`walking ${walkingMinutes} min exceeds your limit of ${ctx.prefs.maxWalkMinutes} min`);
  const conditionChecks = conditionChecksFor(loc?.id ?? null, ctx);
  for (const chk of conditionChecks) {
    if (chk.required && chk.status === 'contradicted') errors.push(`required condition ${chk.condition} is contradicted by reports`);
  }
  if (errors.length) return { ok: false as const, errors };

  const uncertainty: string[] = [];
  for (const chk of conditionChecks) {
    if (isAccessibility(chk.condition) && chk.verification !== 'verified') {
      uncertainty.push(
        `${chk.required ? 'Required' : 'Preferred'} accessibility condition "${chk.condition}" is unverified (${chk.status.replace('_', ' ')}): ` +
          'it rests only on anonymous reports, if any. Check access yourself before relying on it.',
      );
    } else if (chk.status !== 'supported') {
      uncertainty.push(`${chk.required ? 'Required' : 'Preferred'} condition "${chk.condition}" is not confirmed (${chk.status.replace('_', ' ')}).`);
    }
  }
  if (!loc) uncertainty.push('No specific place selected: travel time is not included in the estimate.');
  else if (loc.distanceM === undefined) uncertainty.push('Distance to this place is unknown: travel time is not included.');
  else uncertainty.push('Distance is a straight-line estimate from a coarse location, not a route.');

  const ev = loc ? ctx.evidence.get(loc.id) : undefined;
  const prompts = [...new Set(c.observationPrompts)];
  return {
    ok: true as const,
    candidate: { ...c, observationPrompts: prompts },
    location: loc,
    travel,
    estimatedMinutes,
    walkingMinutes,
    conditionChecks,
    uncertainty,
    expectations: prompts.filter(isEvidenceAttribute).map((attribute) => {
      const e = ev?.get(attribute);
      return { attribute, estimate: e?.estimate ?? null, confidence: e?.confidence ?? ('unknown' as const), sourceType: 'aggregated' as const };
    }),
  };
}

/**
 * Proportionally shorten step minutes (each ≥ 1) so steps fit `budget`. Returns null if they can't.
 * Used on AI candidates, which often overshoot; the change is reported to the user as uncertainty.
 */
export function fitDurations(c: Candidate, budget: number): Candidate | null {
  const total = sumMinutes(c.steps);
  if (total <= budget) return c;
  if (c.steps.length > budget) return null;
  const steps = c.steps.map((s) => ({ ...s, minutes: Math.max(1, Math.floor((s.minutes * budget) / total)) }));
  return sumMinutes(steps) <= budget ? { ...c, steps } : null;
}

/** Locations ordered for template use: drop ones contradicting a required condition, prefer more support, then named, then nearer. */
export function rankLocations(ctx: PlanContext): LocationView[] {
  const score = (loc: LocationView) =>
    conditionChecksFor(loc.id, ctx).reduce((s, c) => s + (c.status === 'supported' ? 2 : c.status === 'weak_support' ? 1 : 0), 0);
  return [...ctx.locations.values()]
    .filter((l) => !conditionChecksFor(l.id, ctx).some((c) => c.required && c.status === 'contradicted'))
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        Number(a.name.startsWith('Unnamed')) - Number(b.name.startsWith('Unnamed')) ||
        (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity),
    );
}

/** Planned-vs-observed comparison for one attribute, using the value order in ATTRIBUTES. */
export function compareObservation(order: readonly string[], expected: string | null, observed: string) {
  if (expected === null) return 'no_expectation';
  const d = order.indexOf(observed) - order.indexOf(expected);
  return d === 0 ? 'matched' : d < 0 ? 'observed_lower_than_expected' : 'observed_higher_than_expected';
}
