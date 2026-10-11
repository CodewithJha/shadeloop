# Test plan

Run everything: `npm run lint && npm run typecheck && npm test && npm run build`.

## Server unit tests (`server/test/unit.test.ts`)
- State machine: allowed and rejected transitions.
- Evidence: unknown, single report = low, same owner counted once, 3 independent = moderate, contradictions → conflicting (estimate withheld), minority < 1/3 tolerated, latest report per owner, stale beyond window, partial expiry and `reevaluateAt`, non-location attribute refused.
- Conditions: every status mapping; unknown is never satisfied; preference-derived merge.
- Constraint engine: duration incl. round-trip travel, over-budget rejection, invented location rejection, trespass and medical text rejection, walking limit, contradicted required condition, `fitDurations`, templates respecting budgets.
- Schemas and parsers: observation value per attribute, sync batch validation, keyword constraint and note parsing, planned-vs-observed comparison, coordinate rounding.
- AI output validation (fetch mocked): malformed → retry → success; schema-invalid twice → fallback after 2 calls; provider unreachable → fallback; fallback reason doesn't echo model output.
- Log redaction: token, auth header, note text, prompt, coordinates and API key are absent from output.

## Server integration tests (`server/test/api.test.ts`, Supertest + mongodb-memory-server, fetch mocked)
- Health and dependency statuses with every external service down; auth required; error envelope; validation 400, bad JSON 400, 413 body limit, 404; OpenAPI served.
- Planning with AI down → template fallback persisted with provenance; owner isolation (404 for another session).
- Planning with AI up → AI candidate accepted, durations shortened and labelled; AI inventing a location or giving unsafe advice → rejected → template fallback.
- Lifecycle 409s; observations: not-active 409, invalid value 400, duplicate opId idempotent; note parsing proposes but doesn't save.
- **End to end:** discovery → 4 sessions × (plan → start → observe → complete → report) → evidence goes from low to moderate; the next plan shows `contradicted` and comparisons report `observed_higher_than_expected`; a required-shade plan avoids the place; history; deleting one contributor recomputes evidence to `conflicting`.
- Sync: batch applied, replay all duplicate with the same reportId, pause time excluded from duration, per-op conflicts, not-found rejected, cross-session opId rejected, future timestamps rejected.
- Preferences validation and effect on planning; analytics insufficient-data; export excludes owner IDs.

## Web unit tests (`web/src/store.test.ts`, fake-indexeddb)
Queue persistence across reload, ordering, unique opIds, synced plus reportId hand-off, network backoff timing, 5xx recoverable vs 4xx conflict, per-op conflict surfaced and only removed by dismissal, stuck `syncing` reset.

## Manual (performed 2026-10-11, Chromium via Cursor browser, 390×844 emulation)
Settings location opt-in (emulated geolocation, rounded) → Discover with Ollama/gemma3:4b live → Mission detail → Start → Field Mode → offline emulation → 2 observations → offline reload (shell and mission load, queue intact) → online → queue synced → Finish → report summary by gemma3:4b.

Re-run later the same day on the production build served by the API: one observation online, one offline, offline reload, reconnect. The queue drained right away, the server held exactly 2 observations, and the console showed no errors.

## Manual API and container checks (2026-10-11)
- curl over the whole loop with `AI_PROVIDER=none` and with `ollama` (gemma3:4b): plan → start → observation → sync → complete → report → history → analytics. Repeating an observation opId and repeating `/sync` ops (observation and complete) returned `duplicate` with the same `reportId`, and nothing was stored twice. The server logs contained no token, coordinates, prompt, note or feedback text.
- Docker: the image builds and runs with `NODE_ENV=production` against a `mongo:8` container. Health, the PWA and fixture planning worked, and `MONGODB_URI=memory` was refused.

## Not covered
Playwright browser e2e (not added), screen-reader pass, Web Speech paths, Atlas, SerpApi, OpenAI-compatible provider.
