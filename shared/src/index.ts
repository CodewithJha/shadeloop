import { z } from 'zod';

export const MISSION_TYPES = [
  'quiet_break',
  'nature_observation',
  'sensory_exploration',
  'neighborhood_exploration',
  'mindful_walk',
  'environmental_observation',
] as const;
export const MissionType = z.enum(MISSION_TYPES);
export type MissionType = z.infer<typeof MissionType>;

/** Observable attributes and their allowed values, ordered low → high so reports can say "lower/higher than expected". */
export const ATTRIBUTES = {
  bench_availability: ['not_found', 'found'],
  shade_quality: ['none', 'partial', 'good'],
  noise_level: ['quiet', 'moderate', 'loud'],
  crowding: ['empty', 'some_people', 'busy'],
  path_condition: ['blocked', 'uneven', 'good'],
  step_free_access: ['no', 'yes'],
  temperature_feel: ['cooler_than_expected', 'as_expected', 'hotter_than_expected'],
} as const;
export type Attribute = keyof typeof ATTRIBUTES;
export const ATTRIBUTE_NAMES = Object.keys(ATTRIBUTES) as [Attribute, ...Attribute[]];
export const AttributeName = z.enum(ATTRIBUTE_NAMES);

export const CONDITIONS = ['shade', 'bench', 'quiet', 'not_crowded', 'step_free', 'smooth_path'] as const;
export const Condition = z.enum(CONDITIONS);
export type Condition = z.infer<typeof Condition>;

export const MISSION_STATUSES = ['planned', 'active', 'paused', 'completed', 'cancelled'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];
export const MISSION_ACTIONS = ['start', 'pause', 'resume', 'complete', 'cancel'] as const;
export type MissionAction = (typeof MISSION_ACTIONS)[number];

/**
 * `verified_external` is reserved for a validated source (none is integrated). `external_map_data` is third-party
 * crowd-sourced map data such as OpenStreetMap: attributed, not verified. `aggregated` = several anonymous reports.
 */
export const SOURCE_TYPES = ['verified_external', 'external_map_data', 'user_report', 'inferred', 'ai_suggestion', 'aggregated'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const CONFIDENCE = ['unknown', 'low', 'moderate', 'conflicting', 'stale'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

const isoDate = z.iso.datetime({ offset: true });

export const Coords = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type Coords = z.infer<typeof Coords>;

export const PlanRequest = z
  .object({
    prompt: z.string().trim().max(500).optional(),
    availableMinutes: z.number().int().min(5).max(240).optional(),
    missionType: MissionType.optional(),
    required: z.array(Condition).max(CONDITIONS.length).optional(),
    preferred: z.array(Condition).max(CONDITIONS.length).optional(),
    coarseLocation: Coords.optional(),
    locationIds: z.array(z.string().min(1).max(200)).max(10).optional(),
  })
  .strict()
  .refine((r) => r.prompt || r.availableMinutes || r.missionType, {
    message: 'Provide a prompt, availableMinutes or missionType',
  });
export type PlanRequest = z.infer<typeof PlanRequest>;

export const DiscoveryRequest = z
  .object({
    lat: Coords.shape.lat,
    lon: Coords.shape.lon,
    radiusM: z.number().int().min(200).max(3000).default(1000),
    query: z.string().trim().max(100).optional(),
  })
  .strict();

export const ObservationValue = z
  .object({ attribute: AttributeName, value: z.string().max(40) })
  .refine((o) => (ATTRIBUTES[o.attribute] as readonly string[]).includes(o.value), {
    message: 'Value is not allowed for this attribute',
    path: ['value'],
  });
export type ObservationValue = z.infer<typeof ObservationValue>;

/** The client's clock when it sent the request. Lets the server remove the client clock's offset from `clientTs`. */
const sentAt = isoDate.optional();

export const ObservationInput = z.intersection(
  ObservationValue,
  z.object({ opId: z.uuid(), clientTs: isoDate, sentAt }),
);

/** Longest duration a report accepts from the user, and trusts from timestamps. */
export const MAX_ACTUAL_MINUTES = 240;

export const CompletePayload = z
  .object({
    completionStatus: z.enum(['completed', 'partial']).default('completed'),
    actualMinutes: z.number().int().min(0).max(MAX_ACTUAL_MINUTES).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    feedback: z.string().trim().max(1000).optional(),
    currentStep: z.number().int().min(0).max(50).optional(),
  })
  .strict();

export const TransitionPayload = z
  .object({ clientTs: isoDate.optional(), sentAt, currentStep: z.number().int().min(0).max(50).optional() })
  .strict();

export const SyncOp = z.discriminatedUnion('type', [
  z.object({ opId: z.uuid(), missionId: z.string().max(100), clientTs: isoDate, type: z.literal('observation'), payload: ObservationValue }),
  z.object({ opId: z.uuid(), missionId: z.string().max(100), clientTs: isoDate, type: z.literal('complete'), payload: CompletePayload.optional() }),
  ...(['start', 'pause', 'resume', 'cancel'] as const).map((type) =>
    z.object({
      opId: z.uuid(),
      missionId: z.string().max(100),
      clientTs: isoDate,
      type: z.literal(type),
      payload: z.object({ currentStep: z.number().int().min(0).max(50).optional() }).strict().optional(),
    }),
  ),
]);
export type SyncOp = z.infer<typeof SyncOp>;
export const SyncRequest = z.object({ ops: z.array(SyncOp).min(1).max(50), sentAt }).strict();

export const NoteParseRequest = z.object({ text: z.string().trim().min(1).max(1000) }).strict();

export const Preferences = z
  .object({
    missionTypes: z.array(MissionType).max(MISSION_TYPES.length).default([]),
    defaultMinutes: z.number().int().min(5).max(120).default(20),
    timeOfDay: z.enum(['any', 'morning', 'midday', 'afternoon', 'evening']).default('any'),
    maxWalkMinutes: z.number().int().min(0).max(120).default(20),
    walkingPace: z.enum(['slow', 'moderate', 'brisk']).default('moderate'),
    accessibility: z
      .object({
        stepFreeRequired: z.boolean().default(false),
        needsSeating: z.boolean().default(false),
        avoidCrowds: z.boolean().default(false),
      })
      .strict()
      .default({ stepFreeRequired: false, needsSeating: false, avoidCrowds: false }),
    language: z.enum(['en']).default('en'),
    voice: z
      .object({ readStepsAloud: z.boolean().default(false), voiceNotes: z.boolean().default(false) })
      .strict()
      .default({ readStepsAloud: false, voiceNotes: false }),
    privacy: z
      .object({ useCoarseLocation: z.boolean().default(false) })
      .strict()
      .default({ useCoarseLocation: false }),
  })
  .strict();
export type Preferences = z.infer<typeof Preferences>;

/* ---------- API response shapes (types only) ---------- */

export interface EvidenceView {
  locationId: string;
  attribute: Attribute;
  estimate: string | null;
  confidence: Confidence;
  supporting: number;
  contradicting: number;
  valueCounts: Record<string, number>;
  lastObservedAt: string | null;
  expiresAt: string | null;
  sourceType: 'aggregated';
  sources: SourceType[];
}

export interface LocationView {
  id: string;
  name: string;
  category: string;
  coords: Coords | null;
  source: 'openstreetmap' | 'serpapi' | 'fixture';
  isFixture: boolean;
  externalId: string;
  attribution: string;
  retrievedAt: string;
  distanceM?: number;
}

export interface ConditionCheck {
  condition: Condition;
  required: boolean;
  attribute: Attribute;
  status: 'supported' | 'weak_support' | 'weak_against' | 'contradicted' | 'conflicting' | 'stale' | 'unknown';
  confidence: Confidence;
  estimate: string | null;
  /** `unknown` (no reports), `user_report` (one anonymous session) or `aggregated` (several anonymous sessions). */
  provenance: SourceType | 'unknown';
  /** `verified` needs a `verified_external` source; none exists, so every check is `unverified`. */
  verification: 'verified' | 'unverified';
}

export interface Step {
  text: string;
  minutes: number;
  kind: 'walk' | 'still' | 'observe';
}

export interface Provenance {
  generator: 'ai' | 'template';
  provider: string | null;
  model: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface Mission {
  id: string;
  title: string;
  description: string;
  type: MissionType;
  objective: string;
  availableMinutes: number;
  estimatedMinutes: number;
  walkingMinutes: number;
  constraints: { required: Condition[]; preferred: Condition[] };
  conditionChecks: ConditionCheck[];
  candidateLocations: LocationView[];
  selectedLocation: LocationView | null;
  travel: { distanceM: number; minutesRoundTrip: number; approximate: true } | null;
  route: null;
  steps: Step[];
  observationPrompts: Attribute[];
  safetyNotes: string[];
  expectations: { attribute: Attribute; estimate: string | null; confidence: Confidence; sourceType: SourceType }[];
  weather: WeatherView | null;
  whyItMatches: { text: string; sourceType: SourceType }[];
  provenance: Provenance;
  uncertainty: string[];
  status: MissionStatus;
  session: {
    id: string | null;
    startedAt: string | null;
    pausedAt: string | null;
    totalPausedMs: number;
    completedAt: string | null;
    cancelledAt: string | null;
    currentStep: number;
    completionStatus: 'completed' | 'partial' | null;
    userMinutes: number | null;
    lastEventAt: string | null;
  };
  reportId: string | null;
  createdAt: string;
  version: number;
}

export interface WeatherView {
  available: boolean;
  source: 'open-meteo';
  retrievedAt: string;
  observedAt?: string;
  temperatureC?: number;
  apparentTemperatureC?: number;
  precipitationMm?: number;
  windKmh?: number;
  weatherCode?: number;
  reason?: string;
}

export type ComparisonResult = 'matched' | 'observed_lower_than_expected' | 'observed_higher_than_expected' | 'no_expectation';

export interface Report {
  id: string;
  missionId: string;
  createdAt: string;
  completionStatus: 'completed' | 'partial';
  planned: {
    title: string;
    estimatedMinutes: number;
    availableMinutes: number;
    stepCount: number;
    location: string | null;
    expectations: Mission['expectations'];
  };
  actual: {
    /** `null` when timestamps gave an implausible duration (negative or over `MAX_ACTUAL_MINUTES`); never counted in analytics. */
    minutes: number | null;
    minutesSource: 'user' | 'timestamps';
    stepsReached: number;
    observations: { attribute: Attribute; value: string; observedAt: string }[];
  };
  comparisons: { attribute: Attribute; expected: string | null; expectedConfidence: Confidence | null; observed: string; result: ComparisonResult }[];
  feedback: { rating: number | null; text: string | null };
  summary: { text: string; generator: 'ai' | 'template'; provider: string | null; model: string | null; fallbackUsed: boolean; fallbackReason: string | null };
  evidenceRefs: EvidenceView[];
}

export interface SyncResult {
  opId: string;
  /** `retry` is transient (op in progress elsewhere, or lost a concurrent write): resend the same op later. */
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'retry';
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}
