/**
 * Tiger Data (TimescaleDB): a time-series mirror of place-linked observations and a 15-minute continuous aggregate,
 * read as "what people reported here, by hour of day". MongoDB stays the source of truth; Tiger failures never
 * block a field write.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
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

export const tigerRecord = (o: { _id: string; ownerId: string; locationId: string | null; attribute: string; value: string; clientTs: string }) =>
  o.locationId
    ? run('observation mirrored', (p) =>
        p.query('INSERT INTO shadeloop.observations VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', [
          o.clientTs,
          o._id,
          ownerHash(o.ownerId),
          o.locationId,
          o.attribute,
          o.value,
        ]),
      )
    : Promise.resolve(null);

export const tigerForget = (ownerId: string) =>
  run('owner rows deleted', async (p) => (await p.query('DELETE FROM shadeloop.observations WHERE owner_hash = $1', [ownerHash(ownerId)])).rowCount ?? 0);

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
