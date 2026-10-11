# API (v1)

Base path: `/api/v1`. The machine-readable OpenAPI 3.1 document is served at `GET /api/v1/openapi.json`, and a snapshot lives in `docs/openapi.json` (regenerate with `npm run openapi`). Request schemas are generated from `shared/src/index.ts`.

## Auth
Anonymous sessions only. `POST /sessions` → `201 {token}`. Send `Authorization: Bearer <token>` on every other endpoint except health and openapi. All resources are scoped to the session; other sessions' IDs return 404. There are no accounts and no full auth.

## Errors
`{ "error": { "code", "message", "details"?, "requestId" } }`. Every response also carries an `x-request-id` header.
Codes: `VALIDATION_ERROR` 400, `INVALID_JSON` 400, `CLOCK_SKEW` 400 (only for requests without `sentAt`, see Timestamps), `UNAUTHORIZED` 401, `NOT_FOUND` 404, `INVALID_TRANSITION` / `MISSION_NOT_ACTIVE` / `CONFLICT` / `OPID_CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `NO_FEASIBLE_MISSION` 422, `RATE_LIMITED` 429 (transient, with `Retry-After` seconds and `RateLimit` headers), `OBSERVATION_LIMIT` 429 (permanent for that mission: `details {perMission, perAttribute}`; don't retry), `INTERNAL` 500, `DEPENDENCY_UNAVAILABLE` 503.

**Web client error classes** (`web/src/api.ts`, `web/src/store.ts`):
- `NetworkError`: no HTTP response at all (fetch failed, aborted, or the 180 s timeout). Message "You appear to be offline" or "Request timed out".
- `ApiError {status, code, message, requestId?, retryAfter?}`: any HTTP error, with the envelope's `code`/`requestId` when present (otherwise `HTTP_<status>`). 429 `RATE_LIMITED` reads "Too many requests, try again in N s"; 5xx without an envelope reads "Server error (HTTP n)".
- `BadResponseError`: a 2xx whose body isn't the expected JSON object (e.g. an HTML page from a proxy), or a `/sync` response without `results`. Never reported as offline.
- Session token: obtained before the request, outside the network `try`, so a 429/5xx from `POST /sessions` surfaces as that `ApiError`. Concurrent callers share one in-flight session request, which is forgotten if it fails so the next call retries. On a 401 the client replaces the session once (concurrent 401s share the replacement) and retries the request once; a second 401 is returned as an `ApiError`.
- The offline queue retries `NetworkError`, `BadResponseError`, 5xx and 429 (waiting at least `Retry-After`); any other HTTP error is a conflict.

## Endpoints
| Method & path | Notes |
|---|---|
| `GET /health` | Liveness (no DB or network call) |
| `GET /health/dependencies` | Integration registry: `{status, dependencies[{name, role, status, detail, lastCall}], notImplemented[]}`. 503 if Mongo is down. Pings Mongo; the AI probe is reused for 60 s; place/weather statuses come from the last real call (no provider is called) |
| `POST /sessions` | New anonymous session |
| `POST /discovery/search` | `{lat, lon, radiusM?, query?}` → `{locations[], sources[], mode, limitations[]}`. Coordinates are rounded to 2 decimals before any external call. 503 if every live source fails |
| `POST /missions/plan` | `{prompt?, availableMinutes?, missionType?, required?, preferred?, coarseLocation?, locationIds?}` → `201 {planId, missions[], planning{constraints, parse, generation, weather, discovery, memory}}`. `memory` is `{provider, recalled, saved}` when Backboard memory is on for this person, else `null` |
| `GET /missions?page&limit&status=a,b` | Paginated `{items, page, limit, total}` |
| `GET /missions/:id` | |
| `POST /missions/:id/start\|pause\|resume\|cancel` | Optional `{clientTs, sentAt, currentStep}`. 409 on invalid transition |
| `POST /missions/:id/complete` | Optional `{completionStatus, actualMinutes (integer 0–240), rating, feedback, currentStep, clientTs, sentAt}` → `{mission, reportId}`. `actualMinutes` outside 0–240 → 400 `VALIDATION_ERROR`. Repeating it on a completed mission returns the same `reportId` (the body is ignored), rebuilding the report if a crash left it missing |
| `POST /missions/:id/observations` | `{attribute, value, opId, clientTs, sentAt?}` → 201, or 200 with `duplicate: true` on a repeated opId. Returns the updated `evidence`. 409 `MISSION_NOT_ACTIVE` if the mission is not active/paused, including when a completion wins a race with it; a 201 observation is always in the report. 429 `OBSERVATION_LIMIT` past 40 per mission or 10 per attribute (`RULES.observationLimits`) |
| `GET /missions/:id/observations` | |
| `GET /missions/:id/steps/:n/speech` | ElevenLabs MP3 of step `n` of the caller's own mission. 404 `NOT_CONFIGURED` without a key, 503 if ElevenLabs fails; the client then uses the browser voice. Planning rate limit |
| `GET /locations/:id/hourly?tz=` | Tiger Data reports at a place over the last 90 days by local hour of `tz` (IANA, default `UTC`) → `{available, timeZone, windowDays, hours[{hour, attribute, value, reports}]}`, or `{available: false, reason, hours: []}` when Tiger is off or failing |
| `POST /missions/:id/observations/parse` | `{text}` → proposed observations `{proposals, method: ai\|keywords, ...}`. **Nothing is saved, and the text is not stored** |
| `POST /sync` | `{ops: [{opId, missionId, clientTs, type, payload?}], sentAt?}` (≤ 50, applied in order; `sentAt` = the client's clock when it sent this request) → `{results: [{opId, status: applied\|duplicate\|conflict\|rejected\|retry, result?, error?}]}` |
| `GET /history?page&limit` | Completed and cancelled missions with report summaries |
| `GET /reports/:id` | Completion report. Rebuilt on read if the mission is completed but its report is missing. `actual.minutesSource` is `user` (the user's own estimate, 0–240, not checked against the clock) or `timestamps` (measured); a timestamp duration that is negative or over 240 min is `actual.minutes: null` ("actual duration unknown" in the summary). `actual.measuredMinutes` is the timestamp duration (or `null`) even when the user gave an estimate; absent on reports stored before 2026-10-11 |
| `GET /preferences`, `PUT /preferences` | PUT takes the full object (strict) |
| `GET /analytics/overview` | Counts plus `completionRate` / `averageMinutes`, which are `null` until 5 samples, with `insufficientData`. `totalMinutesOutside` and `averageMinutes` use only reports with a trusted duration (0–240 min): `minutesSampleSize` of them, `minutesUserEstimated` of which are the user's own estimates rather than measured, `minutesExcluded` left out (`null` minutes, or over-cap values stored by older versions) |
| `GET /analytics/attributes` | Per attribute: value counts, matched/differed counts, `expectationMatchRate` (`null` until 5 comparisons) |
| `GET /me/export` | All of the caller's data as JSON (without internal owner IDs) |
| `DELETE /me` | Deletes everything owned by the session and the session itself, then recomputes affected shared evidence. Also deletes the owner's Tiger Data rows and Backboard memory → `{deleted, evidenceRecomputed, tigerRowsDeleted, backboardMemoryDeleted}` |

## Sync semantics
- Each op is applied at most once per `opId`, even when requests race. Repeating an `opId` returns `duplicate` with the original result (e.g. the same `reportId`).
- State ops are validated against the current server state. Invalid ones come back as `conflict` with the server's status in `details`. Nothing is silently dropped.
- `retry` is transient: `IN_PROGRESS` (another request is applying the same opId right now) or `CONFLICT` (lost a concurrent write to the mission). Nothing is stored for it. Resend the same op later. It ends the batch: later ops get no result, so they're resent in order.
- A server error (5xx) aborts the batch and stores nothing for the failing op, so the client retries it. Ops that were already applied dedupe.
- An opId used by another session → `rejected / OPID_CONFLICT`. The other session's result is never returned.
- An observation over the per-mission cap → `rejected / OBSERVATION_LIMIT`. It's final: a resend returns `duplicate` with `originalStatus: rejected`.
- Validation is two-level. The request envelope must be valid or the whole request is 400 `VALIDATION_ERROR` and nothing is applied: `ops` is an array of 1–50, no unknown top-level keys, `sentAt` (if sent) is an ISO time, and every op has a UUID `opId`, a `missionId` (≤ 100 chars), a `type` string (≤ 20) and an ISO `clientTs`. Everything else (known `type`, `payload` shape and values such as `actualMinutes` 0–240 or an observation value) is checked per op: an invalid op comes back `rejected / VALIDATION_ERROR` with `details [{path, message}]` and the other ops are applied as usual. The refusal is stored like any other, so a resend returns `duplicate` with `originalStatus: rejected`.
- Ops are judged one at a time against the mission's current state; a refused op doesn't stop later ops of its mission in the same request. Ops that needed it are refused by the state machine themselves (e.g. an observation after a refused `start` → `conflict / MISSION_NOT_ACTIVE`), and ops that didn't (e.g. a valid observation after an invalid one) are applied. The client queue holds back a mission's *unsent* ops behind a refusal (OFFLINE_SYNC.md).
- Compatibility: clients built before 2026-10-11 may omit `sentAt` (legacy 5-minute rule, see Timestamps) and may send values today's schema refuses, such as `actualMinutes` 241–600; both are handled per op. The request schema in OpenAPI (`SyncRequest`) is unchanged and is what clients should send.

## Timestamps
- With `sentAt` (sync, transitions, observations): the server computes `offset = serverNow − sentAt` once per request and moves every `clientTs` in it by that offset, so a device clock that is hours or days off lands on the server clock. One offset per batch keeps the ops' order and spacing. The correction overstates by the request's latency (time between the client stamping `sentAt` and the server reading it, including a session renewal), so corrected times can be that much late. The result is then clamped to `[previous event, serverNow]` (previous event = the mission's last transition, or its creation; for observations, its start). Nothing is refused for being out of range after correction.
- Without `sentAt` (older clients and plain API callers): unchanged. More than 5 min ahead of the server → `CLOCK_SKEW` (in `/sync`: `rejected`, final); otherwise stored as sent, clamped to the previous event.
- Times are fixed when an op is first applied. A resend (same opId) with a later `sentAt` returns the stored result and changes nothing.
- Missing or malformed `clientTs`/`sentAt` → 400 `VALIDATION_ERROR`.

## Condition checks and provenance
`mission.conditionChecks[]` items: `{condition, required, attribute, status, confidence, estimate, provenance: unknown|user_report|aggregated, verification: unverified}`. Nothing is `verified` because no verified source is integrated. `whyItMatches[].sourceType` can be `external_map_data` (OSM/SerpApi place mapping), `user_report`, `aggregated`, `inferred` or `ai_suggestion`. `verified_external` is reserved and not emitted. Accessibility conditions (`step_free`, `bench`, `smooth_path`) always add an "unverified" line to `uncertainty`. See DOMAIN_MODEL.md.
