/** OpenAPI 3.1 document generated from the shared Zod schemas. Served at /api/v1/openapi.json; `npm run openapi` writes docs/openapi.json. */
import { z } from 'zod';
import { CompletePayload, DiscoveryRequest, NoteParseRequest, ObservationInput, PlanRequest, Preferences, SyncRequest, TransitionPayload } from '@shadeloop/shared';

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
const json = (s: z.ZodType) => ({ required: true, content: { 'application/json': { schema: schema(s) } } });
const ok = { description: 'OK' };
const err = { description: 'Error: { error: { code, message, details?, requestId } }' };
const op = (summary: string, extra: object = {}) => ({
  summary,
  security: [{ session: [] }],
  responses: { 200: ok, 400: err, 401: err, 404: err, 409: err, 429: err },
  ...extra,
});
const page = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
];
const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];

export function openapi() {
  const transitions = Object.fromEntries(
    (['start', 'pause', 'resume', 'cancel'] as const).map((a) => [
      `/missions/{id}/${a}`,
      { post: op(`${a} mission (state machine; 409 on invalid transition)`, { parameters: idParam, requestBody: { ...json(TransitionPayload), required: false } }) },
    ]),
  );
  return {
    openapi: '3.1.0',
    info: { title: 'ShadeLoop API', version: '0.1.0', description: 'Anonymous session API. Full auth is not implemented.' },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { session: { type: 'http', scheme: 'bearer', description: 'Token from POST /sessions' } } },
    paths: {
      '/health': { get: { summary: 'Liveness', responses: { 200: ok } } },
      '/health/dependencies': { get: { summary: 'Integration status registry', responses: { 200: ok, 503: err } } },
      '/sessions': { post: { summary: 'Create anonymous session; returns { token }', responses: { 201: ok, 429: err } } },
      '/discovery/search': { post: op('Find mapped parks/gardens/benches near coarse coordinates', { requestBody: json(DiscoveryRequest) }) },
      '/missions/plan': { post: op('Plan up to 3 constraint-validated missions (201)', { requestBody: json(PlanRequest) }) },
      '/missions': { get: op('List own missions', { parameters: [...page, { name: 'status', in: 'query', schema: { type: 'string' }, description: 'comma-separated statuses' }] }) },
      '/missions/{id}': { get: op('Get mission', { parameters: idParam }) },
      ...transitions,
      '/missions/{id}/complete': { post: op('Complete mission and generate report', { parameters: idParam, requestBody: { ...json(CompletePayload), required: false } }) },
      '/missions/{id}/observations': {
        get: op('List observations for a mission', { parameters: idParam }),
        post: op('Record an observation (idempotent by opId)', { parameters: idParam, requestBody: json(ObservationInput) }),
      },
      '/missions/{id}/observations/parse': { post: op('Propose observations from a note (nothing saved)', { parameters: idParam, requestBody: json(NoteParseRequest) }) },
      '/sync': { post: op('Apply queued offline ops idempotently; per-op results', { requestBody: json(SyncRequest) }) },
      '/history': { get: op('Completed and cancelled missions with report summaries', { parameters: page }) },
      '/reports/{id}': { get: op('Completion report', { parameters: idParam }) },
      '/preferences': { get: op('Get preferences'), put: op('Replace preferences', { requestBody: json(Preferences) }) },
      '/analytics/overview': { get: op('Own mission stats; derived rates are null when data is insufficient') },
      '/analytics/attributes': { get: op('Own observations per attribute') },
      '/me/export': { get: op('Download all own data as JSON') },
      '/me': { delete: op('Delete all own data and the session') },
    },
  };
}

if (import.meta.main) console.log(JSON.stringify(openapi(), null, 2));
