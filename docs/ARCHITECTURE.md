# Architecture

```
shared/src/index.ts      Zod request schemas, enums (mission types, attributes, conditions), API response types
server/src/
  index.ts               start, graceful shutdown
  app.ts                 Express app: middleware, routes, auth, validation, error envelope, static PWA
  config.ts              env (Zod) + RULES (all business limits)
  domain.ts              pure rules: state machine, evidence model, condition checks, constraint engine
  fallback.ts            templates, keyword parsers, template summary (no AI)
  ai.ts                  providers (Ollama, OpenAI-compatible), aiJson() with validation/retry, tasks
  providers.ts           Overpass, SerpApi, fixture discovery; Open-Meteo weather; 10-min in-process cache
  missions.ts            planning, transitions, observations, reports, evidence persistence, sync
  account.ts             anonymous owners, preferences, analytics, export, delete
  integrations.ts        last-call registry → integration statuses
  openapi.ts             OpenAPI 3.1 generated from shared schemas
  db.ts                  Mongo connection, indexes, in-memory dev mode
web/src/
  store.ts               all IndexedDB access + op queue (flush, backoff, conflicts)
  api.ts                 fetch wrapper, session token, typed endpoints
  App.tsx                shell, hash router, sync loop, Discover, Mission detail, History
  Field.tsx              Field Mode, Completion
  Settings.tsx           preferences, location opt-in, integration status, export/delete
```

## Request flow: planning
1. `PlanRequest` is validated with Zod.
2. If there is a prompt, `aiParseRequest` runs, falling back to `keywordConstraints`. Explicit fields win over parsed ones, and preference-derived conditions are merged in.
3. Locations: if `locationIds` are given they're loaded; otherwise, if `coarseLocation` is given, discovery runs. Coordinates are rounded to 2 decimals first.
4. Weather comes from Open-Meteo, only when a location is given. Evidence summaries are loaded, re-evaluated if a freshness boundary has passed.
5. `aiProposeMissions` runs; its step durations may be shortened by `fitDurations`, then `validateCandidate` checks each one. If none survive, templates are built per type and location and validated by the same engine.
6. Missions are saved as `planned`, with a 7-day TTL that is removed on start.

## Persistence (MongoDB)
Collections: `owners`, `preferences`, `missions` (session embedded), `observations`, `reports`, `evidence`, `locations`, `sync_records`.
Key indexes: unique `owners.tokenHash`, unique `observations.opId`, unique `sync_records.opId`, unique `(evidence.locationId, attribute)`, unique `reports.missionId`. TTL indexes: `missions.expireAt` (planned only) and `sync_records.serverTs` (30 days).

## Concurrency
Transitions use optimistic concurrency (`version`), and losing writers get a 409. Report creation is unique per mission. Sync idempotency is layered: `sync_records.opId`, then `observations.opId`, then `missions.appliedOpIds`. A crash between applying an op and recording it still dedupes on retry.

## Frontend
Hash routing, no router library. One sync loop (on load, on `online`, and every 15 s). Every Field Mode action goes through the queue, online or offline. The service worker (Workbox via vite-plugin-pwa) precaches the app shell only; API responses aren't cached by the SW, because mission data lives in IndexedDB.
