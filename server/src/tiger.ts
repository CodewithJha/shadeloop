/**
 * Tiger Data (TimescaleDB): a time-series mirror of place-linked observations and a 15-minute continuous aggregate,
 * read as "what people reported here, by hour of day". MongoDB stays the source of truth; Tiger failures never
 * block a field write.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { ATTRIBUTES } from '@shadeloop/shared';
import { env } from './config.ts';
import { recordCall } from './integrations.ts';
import { log } from './log.ts';

const MIGRATE = [
  'CREATE EXTENSION IF NOT EXISTS timescaledb',
  'CREATE SCHEMA IF NOT EXISTS shadeloop',
  `CREATE TABLE IF NOT EXISTS shadeloop.observations (
     time TIMESTAMPTZ NOT NULL, id TEXT NOT NULL, owner_hash TEXT NOT NULL,
     location_id TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL,
     PRIMARY KEY (id, time))`,
  "SELECT create_hypertable('shadeloop.observations', by_range('time'), if_not_exists => TRUE)",
  'CREATE INDEX IF NOT EXISTS observations_owner_idx ON shadeloop.observations (owner_hash)',
  'DROP MATERIALIZED VIEW IF EXISTS shadeloop.conditions_hourly',
  // 15-minute buckets so local hours stay exact in zones offset by :30 or :45 from UTC.
  `CREATE MATERIALIZED VIEW IF NOT EXISTS shadeloop.conditions_15m
     WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
     SELECT time_bucket('15 minutes', time) AS bucket, location_id, attribute, value, count(*) AS reports
     FROM shadeloop.observations GROUP BY bucket, location_id, attribute, value WITH NO DATA`,
  `SELECT add_continuous_aggregate_policy('shadeloop.conditions_15m', start_offset => INTERVAL '90 days',
     end_offset => INTERVAL '15 minutes', schedule_interval => INTERVAL '15 minutes', if_not_exists => TRUE)`,
];

/** One dimension per (attribute, value), in a fixed order. */
export const FINGERPRINT_DIMS = Object.entries(ATTRIBUTES).flatMap(([a, vs]) => vs.map((v) => `${a}=${v}`));

/**
 * A place's field-report fingerprint: for each attribute, the share of reports per value (0 for unreported attributes).
 * Deterministic and explainable: two places are similar when people reported the same things there.
 */
export function fingerprint(counts: { attribute: string; value: string; reports: number }[]): number[] {
  const totals = new Map<string, number>();
  for (const c of counts) totals.set(c.attribute, (totals.get(c.attribute) ?? 0) + c.reports);
  return FINGERPRINT_DIMS.map((dim) => {
    const [a, v] = dim.split('=');
    const n = counts.filter((c) => c.attribute === a && c.value === v).reduce((s, c) => s + c.reports, 0);
    const t = totals.get(a) ?? 0;
    return t ? Math.round((n / t) * 1000) / 1000 : 0;
  });
}

// pgvector is set up separately, so a database without the extension keeps the time-series features.
const VECTOR_MIGRATE = [
  'CREATE EXTENSION IF NOT EXISTS vector',
  `CREATE TABLE IF NOT EXISTS shadeloop.place_fingerprints (
     location_id TEXT PRIMARY KEY, name TEXT, reports INT NOT NULL,
     embedding vector(${FINGERPRINT_DIMS.length}) NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
];
let vectorReady: Promise<boolean> | null = null;
const vectors = (p: pg.Pool) =>
  (vectorReady ??= (async () => {
    for (const sql of VECTOR_MIGRATE) await p.query(sql);
    return true;
  })().catch((e) => {
    log.warn({ error: (e as Error).message }, 'pgvector unavailable');
    vectorReady = null;
    return false;
  }));

const vec = (v: number[]) => `[${v.join(',')}]`;

/** Rebuilds one place's fingerprint from its last 90 days of mirrored reports (or removes it when none are left). */
async function refreshFingerprint(p: pg.Pool, locationId: string, name?: string | null) {
  if (!(await vectors(p))) return;
  const { rows } = await p.query<{ attribute: string; value: string; reports: number }>(
    `SELECT attribute, value, count(*)::int AS reports FROM shadeloop.observations
     WHERE location_id = $1 AND time > now() - INTERVAL '90 days' GROUP BY 1, 2`,
    [locationId],
  );
  const total = rows.reduce((s, r) => s + r.reports, 0);
  if (!total) return void (await p.query('DELETE FROM shadeloop.place_fingerprints WHERE location_id = $1', [locationId]));
  await p.query(
    `INSERT INTO shadeloop.place_fingerprints (location_id, name, reports, embedding, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (location_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, place_fingerprints.name), reports = EXCLUDED.reports,
       embedding = EXCLUDED.embedding, updated_at = now()`,
    [locationId, name ?? null, total, vec(fingerprint(rows))],
  );
}

let ready: Promise<pg.Pool> | null = null;

function pool(): Promise<pg.Pool> | null {
  if (!env.TIGER_DATABASE_URL) return null;
  ready ??= (async () => {
    // Tiger Cloud TLS: pg treats sslmode=require as verify-full unless libpq compatibility is on.
    const u = new URL(env.TIGER_DATABASE_URL!);
    u.searchParams.set('sslmode', 'require');
    u.searchParams.set('uselibpqcompat', 'true');
    const p = new pg.Pool({ connectionString: u.toString(), max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30_000 });
    p.on('error', (e) => log.warn({ error: e.message }, 'tiger pool error'));
    for (const sql of MIGRATE) await p.query(sql);
    return p;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

const ownerHash = (ownerId: string) => createHash('sha256').update(`shadeloop-tiger:${ownerId}`).digest('hex');

async function run<T>(what: string, fn: (p: pg.Pool) => Promise<T>): Promise<T | null> {
  const p = pool();
  if (!p) return null;
  try {
    const out = await fn(await p);
    recordCall('tiger-data', true, what);
    return out;
  } catch (e) {
    recordCall('tiger-data', false, `${what}: ${(e as Error).message}`);
    log.warn({ what, error: (e as Error).message }, 'tiger call failed');
    return null;
  }
}

export const tigerRecord = (o: { _id: string; ownerId: string; locationId: string | null; attribute: string; value: string; clientTs: string }, placeName?: string | null) =>
  o.locationId
    ? run('observation mirrored', async (p) => {
        const r = await p.query('INSERT INTO shadeloop.observations VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', [
          o.clientTs,
          o._id,
          ownerHash(o.ownerId),
          o.locationId,
          o.attribute,
          o.value,
        ]);
        // The mirror row is what matters; a fingerprint failure is logged, not reported as a failed mirror.
        await refreshFingerprint(p, o.locationId!, placeName).catch((e: Error) => log.warn({ error: e.message }, 'fingerprint refresh failed'));
        return r;
      })
    : Promise.resolve(null);

export const tigerForget = (ownerId: string) =>
  run('owner rows deleted', async (p) => {
    const h = ownerHash(ownerId);
    const places = (await p.query<{ location_id: string }>('SELECT DISTINCT location_id FROM shadeloop.observations WHERE owner_hash = $1', [h])).rows;
    const n = (await p.query('DELETE FROM shadeloop.observations WHERE owner_hash = $1', [h])).rowCount ?? 0;
    for (const { location_id } of places) await refreshFingerprint(p, location_id);
    return n;
  });

/**
 * Places whose field-report fingerprints are nearest (pgvector cosine distance) to this one.
 * null when Tiger is off or failing; { vector: false } when the pgvector extension isn't available.
 */
export const tigerSimilar = (locationId: string, limit = 3) =>
  run('similar places read', async (p) => {
    if (!(await vectors(p))) return { vector: false as const, places: [] };
    const { rows } = await p.query<{ location_id: string; name: string | null; reports: number; similarity: number }>(
      `SELECT f.location_id, f.name, f.reports, round((1 - (f.embedding <=> me.embedding))::numeric, 3)::float AS similarity
       FROM shadeloop.place_fingerprints f, shadeloop.place_fingerprints me
       WHERE me.location_id = $1 AND f.location_id <> $1 AND f.reports >= 2
       ORDER BY f.embedding <=> me.embedding LIMIT $2`,
      [locationId, limit],
    );
    return { vector: true as const, places: rows.map((r) => ({ locationId: r.location_id, name: r.name, reports: r.reports, similarity: r.similarity })) };
  });

/** Reports at one place over the last 90 days, grouped by local hour of day. null when Tiger is off or failing. */
export const tigerHourly = (locationId: string, timeZone: string) =>
  run('hourly patterns read', async (p) =>
    (
      await p.query<{ hour: number; attribute: string; value: string; reports: number }>(
        `SELECT extract(hour FROM bucket AT TIME ZONE $2)::int AS hour, attribute, value, sum(reports)::int AS reports
         FROM shadeloop.conditions_15m WHERE location_id = $1 AND bucket > now() - INTERVAL '90 days'
         GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`,
        [locationId, timeZone],
      )
    ).rows,
  );
