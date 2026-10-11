import { MongoClient, type Db, type Document, type Collection } from 'mongodb';
import { env, RULES } from './config.ts';
import { log } from './log.ts';

let client: MongoClient | null = null;
let db: Db | null = null;
let memoryServer: { stop: () => Promise<boolean> } | null = null;

export async function connectDb(uri = env.MONGODB_URI, dbName = env.MONGODB_DB): Promise<Db> {
  if (uri === 'memory') {
    // Dev/test only (config refuses this in production). Data is lost on restart.
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mem = await MongoMemoryServer.create();
    memoryServer = mem;
    uri = mem.getUri();
    log.warn('Using in-memory MongoDB: data is not persisted');
  }
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: 'shadeloop' });
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes(db);
  return db;
}

export async function closeDb() {
  await client?.close();
  await memoryServer?.stop();
  client = db = memoryServer = null;
}

export function col<T extends Document = Document>(name: CollectionName): Collection<T> {
  if (!db) throw new Error('Database not connected');
  return db.collection<T>(name);
}

export async function pingDb(): Promise<boolean> {
  try {
    await db?.command({ ping: 1 });
    return Boolean(db);
  } catch {
    return false;
  }
}

type CollectionName =
  | 'owners'
  | 'preferences'
  | 'missions'
  | 'observations'
  | 'reports'
  | 'sync_records'
  | 'evidence'
  | 'locations';

/** Runs at every start; creating an index that already exists with the same spec is a no-op. Never drops anything. */
export async function ensureIndexes(d: Db) {
  const day = 86_400;
  await Promise.all([
    d.collection('owners').createIndex({ tokenHash: 1 }, { unique: true }),
    d.collection('preferences').createIndex({ ownerId: 1 }, { unique: true }),
    d.collection('missions').createIndex({ ownerId: 1, updatedAt: -1 }),
    d.collection('missions').createIndex({ ownerId: 1, status: 1, updatedAt: -1 }),
    d.collection('missions').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
    d.collection('observations').createIndex({ opId: 1 }, { unique: true }),
    d.collection('observations').createIndex({ ownerId: 1, missionId: 1, clientTs: 1 }),
    d.collection('observations').createIndex({ locationId: 1, attribute: 1, ownerId: 1, serverTs: -1, _id: -1 }),
    d.collection('reports').createIndex({ missionId: 1 }, { unique: true }),
    d.collection('reports').createIndex({ ownerId: 1, createdAt: -1 }),
    d.collection('sync_records').createIndex({ opId: 1 }, { unique: true }),
    d.collection('sync_records').createIndex({ ownerId: 1 }),
    d.collection('sync_records').createIndex({ serverTs: 1 }, { expireAfterSeconds: RULES.syncRecordTtlDays * day }),
    d.collection('evidence').createIndex({ locationId: 1, attribute: 1 }, { unique: true }),
  ]);
}

export const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;
