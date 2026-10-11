# API (v1)

Base path: `/api/v1`. The machine-readable OpenAPI 3.1 document is served at `GET /api/v1/openapi.json`, and a snapshot lives in `docs/openapi.json` (regenerate with `npm run openapi`). Request schemas are generated from `shared/src/index.ts`.

## Auth
Anonymous sessions only. `POST /sessions` → `201 {token}`. Send `Authorization: Bearer <token>` on every other endpoint except health and openapi. All resources are scoped to the session; other sessions' IDs return 404. There are no accounts and no full auth.

## Errors
`{ "error": { "code", "message", "details"?, "requestId" } }`. Every response also carries an `x-request-id` header.
Codes: `VALIDATION_ERROR` 400, `INVALID_JSON` 400, `CLOCK_SKEW` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `INVALID_TRANSITION` / `MISSION_NOT_ACTIVE` / `CONFLICT` / `OPID_CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `NO_FEASIBLE_MISSION` 422, `RATE_LIMITED` 429, `INTERNAL` 500, `DEPENDENCY_UNAVAILABLE` 503.

## Endpoints
| Method & path | Notes |
|---|---|
| `GET /health` | Liveness |
| `GET /health/dependencies` | Integration registry: `{status, dependencies[{name, role, status, detail, lastCall}], notImplemented[]}`. 503 if Mongo is down |
| `POST /sessions` | New anonymous session |
| `POST /discovery/search` | `{lat, lon, radiusM?, query?}` → `{locations[], sources[], mode, limitations[]}`. Coordinates are rounded to 2 decimals before any external call. 503 if every live source fails |
| `POST /missions/plan` | `{prompt?, availableMinutes?, missionType?, required?, preferred?, coarseLocation?, locationIds?}` → `201 {planId, missions[], planning{constraints, parse, generation, weather, discovery}}` |
| `GET /missions?page&limit&status=a,b` | Paginated `{items, page, limit, total}` |
| `GET /missions/:id` | |
| `POST /missions/:id/start\|pause\|resume\|cancel` | Optional `{clientTs, currentStep}`. 409 on invalid transition |
| `POST /missions/:id/complete` | Optional `{completionStatus, actualMinutes, rating, feedback, currentStep, clientTs}` → `{mission, reportId}`. Repeating it on a completed mission returns the same `reportId` (the body is ignored), rebuilding the report if a crash left it missing |
| `POST /missions/:id/observations` | `{attribute, value, opId, clientTs}` → 201, or 200 with `duplicate: true` on a repeated opId. Returns the updated `evidence`. 409 `MISSION_NOT_ACTIVE` if the mission is not active/paused, including when a completion wins a race with it; a 201 observation is always in the report |
| `GET /missions/:id/observations` | |
| `POST /missions/:id/observations/parse` | `{text}` → proposed observations `{proposals, method: ai\|keywords, ...}`. **Nothing is saved, and the text is not stored** |
| `POST /sync` | `{ops: [{opId, missionId, clientTs, type, payload?}]}` (≤ 50, applied in order) → `{results: [{opId, status: applied\|duplicate\|conflict\|rejected\|retry, result?, error?}]}` |
| `GET /history?page&limit` | Completed and cancelled missions with report summaries |
| `GET /reports/:id` | Completion report. Rebuilt on read if the mission is completed but its report is missing |
| `GET /preferences`, `PUT /preferences` | PUT takes the full object (strict) |
| `GET /analytics/overview` | Counts plus `completionRate` / `averageMinutes`, which are `null` until 5 samples, with `insufficientData` |
| `GET /analytics/attributes` | Per attribute: value counts, matched/differed counts, `expectationMatchRate` (`null` until 5 comparisons) |
| `GET /me/export` | All of the caller's data as JSON (without internal owner IDs) |
| `DELETE /me` | Deletes everything owned by the session and the session itself, then recomputes affected shared evidence |

## Sync semantics
- Each op is applied at most once per `opId`, even when requests race. Repeating an `opId` returns `duplicate` with the original result (e.g. the same `reportId`).
- State ops are validated against the current server state. Invalid ones come back as `conflict` with the server's status in `details`. Nothing is silently dropped.
- `retry` is transient: `IN_PROGRESS` (another request is applying the same opId right now) or `CONFLICT` (lost a concurrent write to the mission). Nothing is stored for it. Resend the same op later. It ends the batch: later ops get no result, so they're resent in order.
- A server error (5xx) aborts the batch and stores nothing for the failing op, so the client retries it. Ops that were already applied dedupe.
- An opId used by another session → `rejected / OPID_CONFLICT`. The other session's result is never returned.
