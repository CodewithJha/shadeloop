/** Anonymous owners, preferences, analytics, data export and deletion. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ATTRIBUTE_NAMES, Preferences, type Attribute } from '@shadeloop/shared';
import { RULES } from './config.ts';
import { col } from './db.ts';
import { AppError } from './errors.ts';
import { recomputeEvidence, missionView, reportView, type MissionDoc, type ObservationDoc } from './missions.ts';

type OwnerDoc = { _id: string; tokenHash: string; createdAt: Date; lastSeenAt: Date };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createOwner() {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await col<OwnerDoc>('owners').insertOne({ _id: randomUUID(), tokenHash: hash(token), createdAt: now, lastSeenAt: now });
  return token;
}

export async function ownerFromToken(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid session token');
  const owner = await col<OwnerDoc>('owners').findOne({ tokenHash: hash(token) }, { projection: { _id: 1, lastSeenAt: 1 } });
  if (!owner) throw new AppError(401, 'UNAUTHORIZED', 'Unknown session token');
  const stale = new Date(Date.now() - RULES.ownerSeenWriteMs);
  if (!(owner.lastSeenAt > stale)) await col<OwnerDoc>('owners').updateOne({ _id: owner._id, lastSeenAt: { $not: { $gt: stale } } }, { $set: { lastSeenAt: new Date() } });
  return owner._id;
}

const DEFAULT_PREFS = Preferences.parse({});

export async function getPrefs(ownerId: string): Promise<Preferences> {
  const doc = await col('preferences').findOne({ ownerId }, { projection: { _id: 0, ownerId: 0, createdAt: 0, updatedAt: 0 } });
  return doc ? Preferences.parse(doc) : DEFAULT_PREFS;
}

export async function putPrefs(ownerId: string, prefs: Preferences) {
  const now = new Date().toISOString();
  await col('preferences').updateOne({ ownerId }, { $set: { ...prefs, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
  return prefs;
}

export async function analyticsOverview(ownerId: string) {
  // Only trusted durations count: `null` (implausible timestamps) and values over the cap stored by older versions are left out.
  const trusted = { ownerId, 'actual.minutes': { $gte: 0, $lte: RULES.maxActualMinutes } };
  const [statusRows, observationCount, reportCount, minuteRows] = await Promise.all([
    col<MissionDoc>('missions').aggregate<{ _id: string; n: number }>([{ $match: { ownerId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    col('observations').countDocuments({ ownerId }),
    col('reports').countDocuments({ ownerId }),
    col('reports')
      .aggregate<{ total: number; n: number; user: number }>([
        { $match: trusted },
        { $group: { _id: null, total: { $sum: '$actual.minutes' }, n: { $sum: 1 }, user: { $sum: { $cond: [{ $eq: ['$actual.minutesSource', 'user'] }, 1, 0] } } } },
      ])
      .toArray(),
  ]);
  const missions = Object.fromEntries(['planned', 'active', 'paused', 'completed', 'cancelled'].map((s) => [s, statusRows.find((r) => r._id === s)?.n ?? 0]));
  const started = missions.active + missions.paused + missions.completed + missions.cancelled;
  const enough = started >= RULES.minAnalyticsSamples;
  const timed = minuteRows[0]?.n ?? 0;
  return {
    missions,
    observations: observationCount,
    totalMinutesOutside: minuteRows[0]?.total ?? 0,
    minutesSampleSize: timed,
    /** How many of `minutesSampleSize` are the user's own estimates rather than measured. */
    minutesUserEstimated: minuteRows[0]?.user ?? 0,
    minutesExcluded: reportCount - timed,
    completionRate: enough ? missions.completed / started : null,
    averageMinutes: timed >= RULES.minAnalyticsSamples ? Math.round(minuteRows[0].total / timed) : null,
    sampleSize: started,
    minSamples: RULES.minAnalyticsSamples,
    insufficientData: !enough,
  };
}

export async function analyticsAttributes(ownerId: string) {
  const [valueRows, compRows] = await Promise.all([
    col('observations')
      .aggregate<{ _id: { a: Attribute; v: string }; n: number }>([{ $match: { ownerId } }, { $group: { _id: { a: '$attribute', v: '$value' }, n: { $sum: 1 } } }])
      .toArray(),
    col('reports')
      .aggregate<{ _id: { a: Attribute; r: string }; n: number }>([
        { $match: { ownerId } },
        { $unwind: '$comparisons' },
        { $group: { _id: { a: '$comparisons.attribute', r: '$comparisons.result' }, n: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  return ATTRIBUTE_NAMES.map((attribute) => {
    const values = valueRows.filter((r) => r._id.a === attribute);
    const n = values.reduce((s, r) => s + r.n, 0);
    const comp = (pred: (r: string) => boolean) => compRows.filter((r) => r._id.a === attribute && pred(r._id.r)).reduce((s, r) => s + r.n, 0);
    const matched = comp((r) => r === 'matched');
    const differed = comp((r) => r.startsWith('observed_'));
    return {
      attribute,
      observations: n,
      valueCounts: Object.fromEntries(values.map((r) => [r._id.v, r.n])),
      comparisons: { matched, differed, noExpectation: comp((r) => r === 'no_expectation') },
      expectationMatchRate: matched + differed >= RULES.minAnalyticsSamples ? matched / (matched + differed) : null,
      insufficientData: n < RULES.minAnalyticsSamples,
    };
  });
}

const OWNED = ['missions', 'observations', 'reports', 'sync_records', 'preferences'] as const;

export async function exportData(ownerId: string) {
  const [missions, observations, reports, syncRecords, preferences] = await Promise.all(OWNED.map((c) => col(c).find({ ownerId }).toArray()));
  const strip = ({ ownerId: _o, ...rest }: Record<string, unknown>) => rest;
  return {
    exportedAt: new Date().toISOString(),
    preferences: preferences[0] ? strip(preferences[0]) : null,
    missions: (missions as unknown as MissionDoc[]).map(missionView),
    observations: (observations as unknown as ObservationDoc[]).map(strip),
    reports: reports.map((r) => reportView(r as never)),
    syncRecords: syncRecords.map(strip),
  };
}

/** Delete everything owned by this session, then recompute shared evidence the deleted observations contributed to. */
export async function deleteData(ownerId: string) {
  const touched = await col<ObservationDoc>('observations')
    .aggregate<{ _id: { l: string; a: Attribute } }>([{ $match: { ownerId, locationId: { $ne: null } } }, { $group: { _id: { l: '$locationId', a: '$attribute' } } }])
    .toArray();
  const counts = await Promise.all(OWNED.map((c) => col(c).deleteMany({ ownerId })));
  for (const { _id } of touched) await recomputeEvidence(_id.l, _id.a);
  await col<OwnerDoc>('owners').deleteOne({ _id: ownerId });
  return { deleted: Object.fromEntries(OWNED.map((c, i) => [c, counts[i].deletedCount])), evidenceRecomputed: touched.length };
}
