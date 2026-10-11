# Test plan

Run everything: `npm run lint && npm run typecheck && npm test && npm run build`. Current counts: 97 server tests, 34 web tests.

## Server unit tests (`server/test/unit.test.ts`)
- State machine: allowed and rejected transitions.
- Evidence: unknown, single report = low, same owner counted once, 3 independent = moderate, contradictions → conflicting (estimate withheld), minority < 1/3 tolerated, latest report per owner, stale beyond window, partial expiry and `reevaluateAt`, non-location attribute refused.
- Conditions: every status mapping; unknown is never satisfied; preference-derived merge.
- Constraint engine: duration incl. round-trip travel, over-budget rejection, invented location rejection, trespass and medical text rejection, walking limit, contradicted required condition, `fitDurations`, templates respecting budgets. Text stating a duration (digits and words, in steps or description) is rejected while ordinals, distances and "minute details" pass; step minutes outside 1–90 or fractional are rejected; every template × budgets 5–120 × walking limits is a valid, duration-free mission within budget.
- Template report summary: exact text from recorded facts, no comparison claims without an expectation.
- Schemas and parsers: observation value per attribute, sync batch validation, keyword constraint and note parsing, planned-vs-observed comparison, coordinate rounding.
- AI output validation (fetch mocked): malformed → retry → success; schema-invalid twice → fallback after 2 calls; provider unreachable → fallback; fallback reason doesn't echo model output.
- Log redaction: token, auth header, note text, prompt, coordinates and API key are absent from output.

## Server integration tests (`server/test/api.test.ts`, Supertest + mongodb-memory-server, fetch mocked)
- Health and dependency statuses with every external service down; auth required; error envelope; validation 400, bad JSON 400, 413 body limit, 404; OpenAPI served.
- Planning with AI down → template fallback persisted with provenance; owner isolation (404 for another session).
- Planning with AI up → AI candidate accepted, durations shortened and labelled; AI inventing a location or giving unsafe advice → rejected → template fallback. AI step text stating a duration (overshooting, so it would be shortened) → rejected, fallback reason names it, final steps duration-free and within budget; missing, string, wrong-kind or empty steps → `invalid output at missions.0.steps…` fallback; overshooting duration-free steps fit budgets 10/20/45/90.
- Completion report summary: an AI mock that would say "busier than anticipated" is never called during completion or report reads; summary is the exact template text with `fallbackUsed: false`; timestamp duration used when the user gives none; identical text with AI disabled, unreachable, timing out or returning invalid output.
- Lifecycle 409s; observations: not-active 409, invalid value 400, duplicate opId idempotent; note parsing proposes but doesn't save.
- **End to end:** discovery → 4 sessions × (plan → start → observe → complete → report) → evidence goes from low to moderate; the next plan shows `contradicted` and comparisons report `observed_higher_than_expected`; a required-shade plan avoids the place; history; deleting one contributor recomputes evidence to `conflicting`.
- Sync: batch applied, replay all duplicate with the same reportId, pause time excluded from duration, per-op conflicts, not-found rejected, cross-session opId rejected, future timestamps rejected.
- Clock correction (`sentAt`): device clock 1 h ahead, 2 h behind, 1 day behind → start/observations/complete within 5 s of real time, spacing exact, raw kept in `clientTsRaw`, duration 20 min; a resend with a later `sentAt` → `duplicate`, stored times unchanged; a time before the plan clamps to its creation and one after the send clamps to now; malformed/missing `clientTs` or `sentAt` → 400; legacy (no `sentAt`) +4 min applied as sent, +6 min `CLOCK_SKEW`; direct start/observation/complete with `sentAt` corrected.
- Durations: user minutes 241, 600, −1, 12.5 → 400 and the mission stays active; 240 and 0 kept as `user`; a 200 min mission kept from timestamps; completed 2 days after start → `minutes: null` and "actual duration unknown" summary; completedAt before startedAt → `null` on rebuild; analytics totals/averages only over trusted minutes (`minutesSampleSize`, `minutesExcluded`, average `null` below 5).
- Preferences validation and effect on planning; analytics insufficient-data; export excludes owner IDs.

## Evidence integrity and accessibility (`server/test/evidence.test.ts`)
- One owner floods 300 contrary reports over 30 missions via `/sync` (with `maxReportsConsidered` lowered to 5): 3 independent reports stay `moderate`, supporting 3, contradicting 1.
- Repeated reports from one owner count once, using the latest; distinct owners disagreeing → `conflicting`.
- An over-cap observation counted by a concurrent recompute is removed from evidence when refused; deleting the only contributor removes the summary.
- Concurrent observations plus recomputes end equal to a sequential recompute; an older recompute that writes last doesn't overwrite a newer one.
- Caps: per attribute and per mission → 429 `OBSERVATION_LIMIT` directly, `rejected` via `/sync` (resend → `duplicate` with `originalStatus: rejected`); a concurrent burst never exceeds the cap.
- Freshness with corrected clocks: a report really 16 days old (device +1 h) stays `stale`; one really 1 day old from a device 20 days behind counts as fresh (`low`, 1 supporting).
- Three fresh sessions with zero-duration missions → required `step_free` is `supported` but `provenance: aggregated`, `verification: unverified`, with an uncertainty notice; place line is `external_map_data`; no `verified` label anywhere in the mission. A single report → `user_report`; no reports → `unknown`; non-accessibility conditions unchanged.

## Web unit tests (`web/src/store.test.ts`, fake-indexeddb)
Queue persistence across reload, ordering, unique opIds, synced plus reportId hand-off, network backoff timing, 429 `Retry-After` respected, 5xx recoverable vs 4xx conflict, per-op conflict surfaced and only removed by dismissal, stuck `syncing` reset.
Per-mission ordering: an observation never overtakes a `start` that is backing off (503, 429, timeout, `retry`, missing result), the pair resumes in order once due, other missions aren't held, a mid-batch `retry` resumes in order. Same-opId resend after a lost response (no duplicate local observation); stored refusal returned as `duplicate` stays a conflict. No concurrent flush within a tab or while another tab holds the Web Lock. `syncing` op recovered after a reload. Reconciliation: server state adopted when nothing is queued, local kept while ops are queued, refetch after a refusal, 404 → mission `gone`, no further sends, ops kept and serialisable for export.

## Web API client tests (`web/src/api.test.ts`, mocked fetch + fake-indexeddb)
`POST /sessions` 429 → `ApiError` 429 with `retryAfter` and "try again in 42 s" (not `NetworkError`); 500 and HTML 502 → `ApiError`, not offline; 4 parallel first requests → one `POST /sessions`, all with the new token; a failed session request isn't cached and the next call succeeds; fetch failure / timeout (also during session creation) → `NetworkError`; 404/409 keep `code`/`requestId`; HTML 200 or `/sync` without `results` → `BadResponseError` (recoverable; the queue marks the op `failed`, not `conflict`); 401 → one renewal + one retry; 3 concurrent 401s → one renewal (7 fetches); persistent 401 → `ApiError` after 3 fetches, no token in the message; `/sync` body carries a send-time `sentAt` with ops unchanged.

## Manual (performed 2026-10-11, Chromium via Cursor browser, 390×844 emulation)
Settings location opt-in (emulated geolocation, rounded) → Discover with Ollama/gemma3:4b live → Mission detail → Start → Field Mode → offline emulation → 2 observations → offline reload (shell and mission load, queue intact) → online → queue synced → Finish → report summary by gemma3:4b.

Re-run later the same day on the production build served by the API: one observation online, one offline, offline reload, reconnect. The queue drained right away, the server held exactly 2 observations, and the console showed no errors.

## Manual API and container checks (2026-10-11)
- curl over the whole loop with `AI_PROVIDER=none` and with `ollama` (gemma3:4b): plan → start → observation → sync → complete → report → history → analytics. Repeating an observation opId and repeating `/sync` ops (observation and complete) returned `duplicate` with the same `reportId`, and nothing was stored twice. The server logs contained no token, coordinates, prompt, note or feedback text.
- Docker: the image builds and runs with `NODE_ENV=production` against a `mongo:8` container. Health, the PWA and fixture planning worked, and `MONGODB_URI=memory` was refused.

## Not covered
Playwright browser e2e (not added), screen-reader pass, Web Speech paths, Atlas, SerpApi, OpenAI-compatible provider.
