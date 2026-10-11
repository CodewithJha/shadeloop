# Architecture

```
shared/src/index.ts      Zod request schemas, enums (mission types, attributes, conditions), API response types
server/src/
  index.ts               start, graceful shutdown
  app.ts                 Express app: middleware, routes, auth, validation, error envelope, static PWA
  config.ts              env (Zod) + RULES (all business limits)
  domain.ts              pure rules: state machine, evidence model, condition checks, constraint engine
  fallback.ts            templates, keyword parsers, template report summary (no AI)
  ai.ts                  providers (Ollama, OpenAI-compatible), aiJson() with validation/retry, tasks
  providers.ts           Overpass, SerpApi, fixture discovery; Open-Meteo weather; bounded in-process cache, one retry, 429 back-off
  missions.ts            planning, transitions, observations, reports, evidence persistence, sync
  account.ts             anonymous owners, preferences, analytics, export, delete
  integrations.ts        last-call registry → integration statuses
  openapi.ts             OpenAPI 3.1 generated from shared schemas
  db.ts                  Mongo connection, indexes, in-memory dev mode
web/src/
  store.ts               all IndexedDB access + op queue (flush, per-mission ordering, backoff, conflicts, reconciliation)
  api.ts                 fetch wrapper, session token, typed endpoints
  App.tsx                shell, hash router, sync loop, Discover, Mission detail, History
  Field.tsx              Field Mode, Completion
  Settings.tsx           preferences, location opt-in, integration status, export/delete
```

## Request flow: planning
1. `PlanRequest` is validated with Zod.
2. If there is a prompt, `aiParseRequest` runs, falling back to `keywordConstraints`. Explicit fields win over parsed ones, and preference-derived conditions are merged in.
3. Locations: if `locationIds` are given they're loaded; otherwise, if `coarseLocation` is given, discovery runs. Coordinates are rounded to 2 decimals first.
4. Weather comes from Open-Meteo, only when a location is given; it is fetched at the same time as discovery (it needs only the origin), so a slow Overpass doesn't add to it. Evidence summaries are loaded, re-evaluated if a freshness boundary has passed.
5. `aiProposeMissions` runs; its step durations may be shortened by `fitDurations`, then `validateCandidate` checks each one. If none survive, templates are built per type and location and validated by the same engine.
6. Missions are saved as `planned`, with a 7-day TTL that is removed on start or cancel (a cancelled mission stays in history). Missions cancelled before start on databases written before this change still carry the TTL and expire.

## Persistence (MongoDB)
Collections: `owners`, `preferences`, `missions` (session embedded), `observations`, `reports`, `evidence`, `locations`, `sync_records`.
Key indexes: unique `owners.tokenHash`, unique `observations.opId`, unique `sync_records.opId`, unique `(evidence.locationId, attribute)`, unique `reports.missionId`. TTL indexes: `missions.expireAt` (planned only) and `sync_records.serverTs` (30 days).

### Indexes
`ensureIndexes` (db.ts) runs at every start. `createIndex` with an unchanged spec is a no-op, so restarts are idempotent; a conflicting spec on an existing database makes startup fail with a clear log instead of running half-indexed. Nothing is ever dropped automatically. Every index serves a real query:

| Collection | Index | Serves |
|---|---|---|
| owners | `tokenHash` unique | session lookup on every request |
| preferences | `ownerId` unique | get/put preferences, export, delete |
| missions | `(ownerId, updatedAt -1)` | mission list, export, delete, analytics `$match`, report fallback by `reportId` |
| missions | `(ownerId, status, updatedAt -1)` | mission list / history filtered by status |
| missions | `expireAt` TTL | missions still planned (never started or cancelled) expire after 7 days |
| observations | `opId` unique | idempotent observations |
| observations | `(ownerId, missionId, clientTs)` | per-mission list, report build, caps, export, delete, analytics |
| observations | `(locationId, attribute, ownerId, serverTs -1, _id -1)` | evidence recompute (latest per owner) |
| reports | `missionId` unique | one report per mission |
| reports | `(ownerId, createdAt -1)` | history, export, delete, analytics |
| sync_records | `opId` unique | opId reservation |
| sync_records | `ownerId` | export and delete (added 2026-10-11; before that they scanned the collection) |
| sync_records | `serverTs` TTL | records expire after 30 days |
| evidence | `(locationId, attribute)` unique | one summary per place and attribute |

Tests run `explain` on the export (`find`) and delete (`deleteMany`) filters of every owned collection and require an index scan.

**Owners never expire.** A TTL on `owners.lastSeenAt` would orphan the owner's missions and observations, so there is none; deleting data is `DELETE /me`. `lastSeenAt` is written at most once an hour per session (it used to be written on every request), so it can drive a cleanup job later.

**Manual drop after upgrading (databases created before 2026-10-11).** The evidence index was replaced in 2026-10 by the one above; the old one stays on existing databases and only costs writes. Check, then drop by hand:
```
db.observations.getIndexes().map(i => i.name)          // look for "locationId_1_attribute_1_clientTs_-1"
db.observations.dropIndex("locationId_1_attribute_1_clientTs_-1")
```
Fresh databases never get it. Drop nothing else without checking this table.

## Concurrency
No multi-document transactions; every guarantee comes from a single-document atomic write plus a unique index.

**Transitions** use optimistic concurrency (`version`). A losing writer re-reads the mission: if its opId is already in `appliedOpIds`, or it was a `complete` and the mission is now completed, it returns that outcome; otherwise 409 `CONFLICT`.

**Completion** is one version-checked update that sets `status: completed`, the session, the feedback and a pre-generated `reportId`. Only then is the report built (`ensureReport`) from the persisted observations, with the deterministic template summary (no AI call on this path), and inserted under that id. `_id` and the unique `reports.missionId` make the insert idempotent: concurrent builders all end up reading the first one's report. A pre-existing report under another id (an orphan from the old insert-before-update order) is replaced.

**Report recovery.** If the process dies between the completion update and the report insert, the mission is completed with a `reportId` but no report. These paths call `ensureReport` and rebuild it: a repeated `complete` (same opId or not, direct or via sync), `GET /reports/:id` (falls back to the completed mission holding that `reportId`), `GET /history`, and an observation re-check (below). The client always reaches one of them: it retries the failed `complete` op and opens the report by `reportId`. A repeated `complete` on a completed mission returns the existing report rather than 409.

**Observations vs completion.** `addObservation` checks the mission is active/paused, inserts the row, then re-reads the mission. The row is kept only if the mission is still active/paused, or it is completed and its report contains the row's id (`reports.observationIds`, internal). Otherwise the row is deleted, evidence for its (location, attribute) is recomputed, and the request gets 409 `MISSION_NOT_ACTIVE`. Evidence is only recomputed for kept rows. Why this is safe:
- Re-read sees active/paused: the completion update comes after the re-read, which comes after the insert, and the report is read after the completion update, so it includes the row.
- Re-read sees completed: the report is fixed once inserted (built now if missing, which then includes the row). The row is kept exactly when the report has it, so every 201 observation is in the report and every rejected one is not.
- Re-read sees cancelled: rejected; cancelled missions have no report.

**Sync** reserves each opId before applying it: insert `{opId, ownerId, status: pending, lease, leaseUntil}` into `sync_records` (unique `opId`). The holder applies the op and finalizes the row with a conditional update on its lease. A request that hits the duplicate key reads the row: another owner → `rejected / OPID_CONFLICT`; final → `duplicate` with the stored result (including `reportId`); pending with a live lease → `retry / IN_PROGRESS`; pending with an expired lease (holder crashed, `RULES.syncLeaseMs` = 30 s) → taken over with an atomic `findOneAndUpdate` on `{status: pending, leaseUntil ≤ now}`. Re-applying after a takeover is safe because transitions dedupe on `missions.appliedOpIds` and observations on the unique `observations.opId`. Server errors and optimistic-concurrency losses delete the reservation instead of caching it, so only deterministic outcomes (applied, invalid transition, not found, validation) become the stored answer. Only the batch envelope (`SyncEnvelope`: each op's `opId`, `missionId`, `type` string and ISO `clientTs`) is validated for the whole request; the rest of each op is checked against `SyncOp` after its opId is reserved, so an invalid op becomes its own stored `rejected / VALIDATION_ERROR`.

## Frontend
Hash routing, no router library. One sync loop (on load, on `online`, and every 15 s), serialised per tab and across tabs with a Web Lock. Every Field Mode action goes through the queue, online or offline. Ops are sent in order per mission, and a refused op holds back the rest of its mission until the user acts (see OFFLINE_SYNC.md). The service worker (Workbox via vite-plugin-pwa) precaches the app shell only; API responses aren't cached by the SW, because mission data lives in IndexedDB. New builds wait for the user's "Reload" (OFFLINE_SYNC.md → Service worker).
