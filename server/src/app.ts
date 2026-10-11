import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import {
  CompletePayload,
  DiscoveryRequest,
  MISSION_ACTIONS,
  MISSION_STATUSES,
  NoteParseRequest,
  ObservationInput,
  PlanRequest,
  Preferences,
  SyncEnvelope,
  TransitionPayload,
  type MissionAction,
} from '@shadeloop/shared';
import { env } from './config.ts';
import { log } from './log.ts';
import { AppError } from './errors.ts';
import { pingDb } from './db.ts';
import { aiHealth, aiParseNote } from './ai.ts';
import { lastCall, statusFrom } from './integrations.ts';
import { keywordObservations } from './fallback.ts';
import { discover } from './providers.ts';
import { analyticsAttributes, analyticsOverview, createOwner, deleteData, exportData, getPrefs, ownerFromToken, putPrefs } from './account.ts';
import { addObservation, clockOffset, getMission, getReport, history, listMissions, listObservations, missionView, planMissions, sync, transition } from './missions.ts';
import { openapi } from './openapi.ts';

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

const Id = z.string().min(1).max(100);
const Page = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(z.enum(MISSION_STATUSES)))
    .optional(),
});
const CompleteBody = CompletePayload.extend({ clientTs: TransitionPayload.shape.clientTs, sentAt: TransitionPayload.shape.sentAt });

const NOT_IMPLEMENTED = ['elevenlabs', 'sentry', 'tiger-data', 'mastra', 'temporal', 'backboard', 'tabpfn'];

const owner = (res: Response) => res.locals.ownerId as string;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      // No headers, IPs or bodies in request logs.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());

  const limitHandler = (_req: Request, _res: Response, next: NextFunction) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down'));
  const limiter = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: limitHandler });

  const api = express.Router();
  api.use(limiter(env.RATE_LIMIT_PER_MIN));
  api.use(express.json({ limit: '100kb' }));

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  api.get('/health/dependencies', async (_req, res) => {
    const [mongoOk, ai] = await Promise.all([pingDb(), aiHealth()]);
    const live = env.DISCOVERY_MODE === 'live';
    const checkedAt = new Date().toISOString();
    const dependencies = [
      {
        name: 'mongodb',
        role: 'Operational datastore',
        status: mongoOk ? 'VERIFIED' : 'DEGRADED',
        detail: `${mongoOk ? 'ping ok' : 'ping failed'}${env.MONGODB_URI === 'memory' ? ' (in-memory dev database, not persisted)' : ''}`,
        checkedAt,
      },
      { name: ai.name, role: 'AI suggestions (advisory, optional)', status: ai.status, detail: ai.detail, checkedAt, lastCall: ai.lastGeneration },
      {
        name: 'openstreetmap',
        role: 'Place discovery via Overpass API',
        status: statusFrom({ name: 'openstreetmap', enabled: live, configured: true, needsConfig: false }),
        detail: live ? 'No key needed. Status reflects the last real call.' : 'Disabled by DISCOVERY_MODE=fixture',
        lastCall: lastCall('openstreetmap'),
      },
      {
        name: 'serpapi',
        role: 'Extra place discovery (Google Maps results)',
        status: statusFrom({ name: 'serpapi', enabled: live, configured: Boolean(env.SERPAPI_KEY), needsConfig: true }),
        detail: env.SERPAPI_KEY ? 'Key present. Status reflects the last real call.' : 'Set SERPAPI_KEY to enable',
        lastCall: lastCall('serpapi'),
      },
      {
        name: 'fixture',
        role: 'Sample places for demos (not real)',
        status: live ? 'DISABLED' : 'CONFIGURED',
        detail: live ? 'Enable with DISCOVERY_MODE=fixture' : 'All discovered places are labelled fixtures',
      },
      {
        name: 'open-meteo',
        role: 'Current weather',
        status: statusFrom({ name: 'open-meteo', enabled: true, configured: true, needsConfig: false }),
        detail: 'No key needed. Status reflects the last real call.',
        lastCall: lastCall('open-meteo'),
      },
      { name: 'web-speech', role: 'Optional voice notes and step read-out (browser APIs)', status: 'IMPLEMENTED', detail: 'Runs in the browser where supported; not checked by the server' },
    ];
    res.status(mongoOk ? 200 : 503).json({ status: mongoOk ? 'ok' : 'degraded', dependencies, notImplemented: NOT_IMPLEMENTED });
  });

  api.get('/openapi.json', (_req, res) => {
    res.json(openapi());
  });

  api.post('/sessions', limiter(Math.ceil(env.RATE_LIMIT_PER_MIN / 6)), async (_req, res) => {
    res.status(201).json({ token: await createOwner() });
  });

  api.use(async (req, res, next) => {
    const m = req.headers.authorization?.match(/^Bearer (\S+)$/);
    if (!m) throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer session token. POST /api/v1/sessions to get one.');
    res.locals.ownerId = await ownerFromToken(m[1]);
    next();
  });

  // Planning, discovery and note parsing call external services or the model, so they get a tighter budget.
  const expensive = limiter(Math.ceil(env.RATE_LIMIT_PER_MIN / 8));

  api.post('/discovery/search', expensive, async (req, res) => {
    const body = parse(DiscoveryRequest, req.body);
    const r = await discover({ lat: body.lat, lon: body.lon }, body.radiusM, body.query);
    if (r.mode === 'live' && r.sources.every((s) => !s.ok)) {
      throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'Place discovery is unavailable right now', { sources: r.sources });
    }
    res.json(r);
  });

  api.post('/missions/plan', expensive, async (req, res) => {
    res.status(201).json(await planMissions(owner(res), parse(PlanRequest, req.body)));
  });

  api.get('/missions', async (req, res) => {
    const q = parse(Page, req.query);
    res.json(await listMissions(owner(res), { status: q.status }, q.page, q.limit));
  });

  api.get('/missions/:id', async (req, res) => {
    res.json(missionView(await getMission(owner(res), parse(Id, req.params.id))));
  });

  api.get('/missions/:id/observations', async (req, res) => {
    res.json({ items: await listObservations(owner(res), parse(Id, req.params.id)) });
  });

  api.post('/missions/:id/observations', async (req, res) => {
    const { sentAt, ...input } = parse(ObservationInput, req.body);
    const r = await addObservation(owner(res), parse(Id, req.params.id), { ...input, offsetMs: clockOffset(sentAt) });
    const { ownerId: _o, _id, ...o } = r.observation;
    res.status(r.duplicate ? 200 : 201).json({ observation: { id: _id, ...o }, duplicate: r.duplicate, evidence: r.evidence });
  });

  // Turns a typed or dictated note into *proposed* observations. Nothing is saved; the client confirms each one.
  api.post('/missions/:id/observations/parse', expensive, async (req, res) => {
    await getMission(owner(res), parse(Id, req.params.id));
    const { text } = parse(NoteParseRequest, req.body);
    const ai = await aiParseNote(text);
    res.json({
      proposals: ai.data?.observations ?? keywordObservations(text),
      method: ai.data ? 'ai' : 'keywords',
      provider: ai.meta.provider,
      model: ai.meta.model,
      fallbackUsed: !ai.data,
      fallbackReason: ai.meta.fallbackReason,
    });
  });

  api.post('/missions/:id/:action', async (req, res) => {
    const action = req.params.action as MissionAction;
    if (!MISSION_ACTIONS.includes(action)) throw new AppError(404, 'NOT_FOUND', 'Unknown action');
    const id = parse(Id, req.params.id);
    if (action === 'complete') {
      const { clientTs, sentAt, currentStep, ...rest } = parse(CompleteBody, req.body ?? {});
      const r = await transition(owner(res), id, action, { clientTs, offsetMs: clockOffset(sentAt), currentStep, complete: rest });
      res.json({ mission: r.mission, reportId: r.reportId });
      return;
    }
    const { clientTs, sentAt, currentStep } = parse(TransitionPayload, req.body ?? {});
    const r = await transition(owner(res), id, action, { clientTs, offsetMs: clockOffset(sentAt), currentStep });
    res.json({ mission: r.mission, reportId: r.reportId });
  });

  api.post('/sync', async (req, res) => {
    const { ops, sentAt } = parse(SyncEnvelope, req.body);
    res.json({ results: await sync(owner(res), ops, sentAt) });
  });

  api.get('/history', async (req, res) => {
    const q = parse(Page, req.query);
    res.json(await history(owner(res), q.page, q.limit));
  });

  api.get('/reports/:id', async (req, res) => {
    res.json(await getReport(owner(res), parse(Id, req.params.id)));
  });

  api.get('/preferences', async (_req, res) => {
    res.json(await getPrefs(owner(res)));
  });

  api.put('/preferences', async (req, res) => {
    res.json(await putPrefs(owner(res), parse(Preferences, req.body)));
  });

  api.get('/analytics/overview', async (_req, res) => {
    res.json(await analyticsOverview(owner(res)));
  });

  api.get('/analytics/attributes', async (_req, res) => {
    res.json({ items: await analyticsAttributes(owner(res)) });
  });

  api.get('/me/export', async (_req, res) => {
    res.setHeader('content-disposition', 'attachment; filename="shadeloop-export.json"');
    res.json(await exportData(owner(res)));
  });

  api.delete('/me', async (_req, res) => {
    res.json(await deleteData(owner(res)));
  });

  api.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));

  app.use('/api/v1', api);

  const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false }));
    app.use((req, res, next) => (req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile('index.html', { root: dist }) : next()));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let e: AppError;
    const type = (err as { type?: string })?.type;
    if (err instanceof AppError) e = err;
    else if (type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    else if (type === 'entity.parse.failed') e = new AppError(400, 'INVALID_JSON', 'Malformed JSON body');
    else {
      req.log.error({ err }, 'unhandled error');
      e = new AppError(500, 'INTERNAL', 'Internal server error');
    }
    res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}), requestId: String(req.id) } });
  });

  return app;
}
