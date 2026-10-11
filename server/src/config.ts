import { z } from 'zod';
import { MAX_ACTUAL_MINUTES, type Attribute, type Condition, type MissionType } from '@shadeloop/shared';

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required (use "memory" for local dev)'),
    MONGODB_DB: z.string().min(1).default('shadeloop'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
    AI_PROVIDER: z.enum(['none', 'ollama', 'openai']).default('none'),
    OLLAMA_URL: z.url().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().min(1).default('gemma3:4b'),
    OPENAI_BASE_URL: z.url().optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(60_000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
    DISCOVERY_MODE: z.enum(['live', 'fixture']).default('live'),
    SERPAPI_KEY: z.string().min(1).optional(),
    OVERPASS_URL: z.url().default('https://overpass-api.de/api/interpreter'),
    OPEN_METEO_URL: z.url().default('https://api.open-meteo.com/v1/forecast'),
    HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(20_000),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.MONGODB_URI === 'memory'), {
    message: 'MONGODB_URI=memory is not allowed in production',
    path: ['MONGODB_URI'],
  })
  .refine((e) => e.AI_PROVIDER !== 'openai' || (e.OPENAI_BASE_URL && e.OPENAI_API_KEY && e.OPENAI_MODEL), {
    message: 'AI_PROVIDER=openai requires OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL',
    path: ['AI_PROVIDER'],
  });

function loadEnv() {
  // Treat empty values (e.g. `SERPAPI_KEY=` copied from .env.example) as unset.
  const parsed = Env.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    // Print field names and messages only, never values.
    for (const issue of parsed.error.issues) console.error(`Invalid env ${issue.path.join('.')}: ${issue.message}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/** Business rules. Change limits here, not in the code that uses them. */
export const RULES = {
  minMissionMinutes: 5,
  maxMissionMinutes: 120,
  maxSteps: 8,
  maxStepMinutes: 90,
  maxCandidates: 3,
  maxDiscoveredLocations: 8,
  walkingSpeedMPerMin: { slow: 55, moderate: 70, brisk: 90 },
  /** Only for requests without `sentAt`: how far ahead of the server a client timestamp may be. */
  clockSkewMs: 5 * 60_000,
  /** Reports: user-entered minutes above this are refused (400); timestamp durations outside 0..this become `null`. */
  maxActualMinutes: MAX_ACTUAL_MINUTES,
  coordDecimals: 2, // ~1.1 km, coarse on purpose
  heatApparentC: 32,
  coldApparentC: 0,
  rainMm: 0.5,
  plannedMissionTtlDays: 7,
  syncRecordTtlDays: 30,
  syncLeaseMs: 30_000, // how long a request may hold an op before another request can take it over
  minAnalyticsSamples: 5,
  /** Place/weather results per process: entries live `ttlMs`; past `maxEntries` the oldest is dropped. */
  providerCache: { maxEntries: 500, ttlMs: 10 * 60_000 },
  /** Wait before the one retry of a network error or 5xx. Both attempts share `HTTP_TIMEOUT_MS`. */
  providerRetryDelayMs: 500,
  /** After a 429 a provider isn't called for its `Retry-After`, or this long without one (capped at 10 min). */
  providerCooldownMs: 60_000,
  /** `/health/dependencies` reuses one AI probe for this long, so the public endpoint can't drive provider calls. */
  aiHealthCacheMs: 60_000,
  /** `owners.lastSeenAt` is rewritten at most this often per session, not on every request. */
  ownerSeenWriteMs: 60 * 60_000,
  evidence: {
    moderateMinIndependent: 3,
    conflictMinorityShare: 1 / 3,
    /** Distinct owners (each owner's latest report) considered per (location, attribute). */
    maxReportsConsidered: 500,
    freshnessDays: {
      bench_availability: 90,
      shade_quality: 21,
      noise_level: 14,
      crowding: 3,
      path_condition: 30,
      step_free_access: 180,
    } as Partial<Record<Attribute, number>>,
  },
  conditions: {
    shade: { attribute: 'shade_quality', accept: ['good', 'partial'] },
    bench: { attribute: 'bench_availability', accept: ['found'] },
    quiet: { attribute: 'noise_level', accept: ['quiet'] },
    not_crowded: { attribute: 'crowding', accept: ['empty', 'some_people'] },
    step_free: { attribute: 'step_free_access', accept: ['yes'] },
    smooth_path: { attribute: 'path_condition', accept: ['good'] },
  } as Record<Condition, { attribute: Attribute; accept: string[] }>,
  /** Always shown as unverified with an explicit notice: no verified accessibility source exists, only anonymous reports. */
  accessibilityConditions: ['step_free', 'bench', 'smooth_path'] as Condition[],
  /** Per mission; excess observations are refused with 429 OBSERVATION_LIMIT. */
  observationLimits: { perMission: 40, perAttribute: 10 },
  walkingTypes: ['mindful_walk', 'neighborhood_exploration'] as MissionType[],
  /** Phrases that make AI text unusable: trespass or medical advice. Matched case-insensitively on word boundaries. */
  unsafePatterns: [
    /\bprivate (property|land|garden|yard)\b/i,
    /\btrespass/i,
    /\b(climb|hop|jump|squeeze)\s+(over|through|under)\b/i,
    /\brestricted area\b/i,
    /\b(cure|cures|diagnos\w*|medication|dosage|prescri\w*|therapy|therapeutic|treat (your|an?) )/i,
  ],
  /**
   * A duration stated in mission text ("10 minutes", "ten-minute", "half an hour", "quarter hour"). Durations live only
   * in step `minutes`, which the engine may shorten, so text stating one could contradict them.
   */
  durationPattern:
    /(?:(?:\d+(?:[.,]\d+)?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|few|couple(?: of)?|several|half|quarter))\s*-?\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|h)|\ban?\s+(?:mins?|minutes?|hrs?|hours?))\b/i,
  baseSafetyNotes: [
    'Stay on public paths and spaces. Do not enter private property or closed areas.',
    'Stop and head back if you feel unwell, unsafe or too hot or cold. This app gives no medical advice.',
    'Conditions shown are estimates from past reports, not guarantees of shade, safety, access or opening hours.',
  ],
} as const;
