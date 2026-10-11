# Offline and sync

## Client storage (`web/src/store.ts`, IndexedDB via `idb`)
- `meta`: session token, cached preferences, coarse location.
- `missions`: `{id, mission, local: {status, currentStep, startedAt, completedAt, observations[], reportId}}`. `local` is the optimistic on-device progress.
- `ops`: queue entries `{opId (crypto.randomUUID), missionId, clientTs, type, payload, seq, state, attempts, nextAttemptAt, lastError, result}`.

## Op states
`pending` → `syncing` → `synced` | `failed` (recoverable, retried with backoff) | `conflict` (server refused; shown until the user dismisses it).

## Flush algorithm
1. Take up to 50 ops in `seq` order that are `pending`, or `failed` with `nextAttemptAt ≤ now`. Mark them `syncing`.
2. `POST /sync`.
3. A network error, 5xx or 429 marks every op `failed`, increments `attempts`, and sets `nextAttemptAt = now + min(2^attempts s, 5 min)`.
4. Any other HTTP error marks every op `conflict` with the message.
5. Per-op results: `applied`/`duplicate` → `synced` (a `complete` op's `reportId` is copied to the cached mission); `retry`, or no result for an op, → `failed` with the same backoff; `conflict`/`rejected` → `conflict`.
6. Synced ops are pruned after 24 h.

Triggers: app start (stuck `syncing` ops are first reset to `pending`, and failed ops are made due), the browser `online` event (failed ops retried immediately), after each user action, and every 15 s. No flush is attempted while `navigator.onLine` is false.

Conflicts and repeatedly failing ops appear in a "Sync needs your attention" panel with Retry/Dismiss. Nothing is dropped without user action.

## Server side
See API_SPEC.md → Sync semantics and ARCHITECTURE.md → Concurrency. Each opId is reserved atomically (a `pending` row in `sync_records`, unique `opId`, with a 30 s lease) before it is applied, so concurrent requests with the same opId apply it at most once. The others get the stored result as `duplicate`, or `retry` while the first request is still working; an expired lease is taken over. Server errors and lost optimistic-concurrency races release the reservation instead of being stored as the answer. `observations.opId` and `missions.appliedOpIds` dedupe the domain writes underneath, so a takeover never applies an op twice. Client timestamps are validated (no more than 5 min in the future) and clamped to never precede the previous event, so offline ordering yields sane durations.

## Service worker
vite-plugin-pwa (Workbox `generateSW`) precaches JS, CSS, HTML and SVG and serves `index.html` for navigations (except `/api/*`). A mission opened once online can be opened, started, observed, paused and ended offline. Planning, note parsing, reports and history need a connection, and the UI says so.

## Verified
- Unit tests (`web/src/store.test.ts`, fake-indexeddb): persistence across a simulated reload, ordering, unique opIds, backoff timing, 5xx vs 4xx handling, `retry` results backed off and resent rather than turned into conflicts, per-op conflicts surfaced and only removed by dismissal, reset of stuck `syncing` ops.
- Concurrency tests (`server/test/concurrency.test.ts`): 10 concurrent syncs of one `complete` or `pause` op apply it once and agree on the result and `reportId`; a live lease returns `retry` and stops the batch; an expired lease is taken over; a server error leaves no reservation behind; another owner's opId stays isolated.
- API tests: batch apply, full replay → all `duplicate` with the same reportId, per-op conflicts, cross-session opId rejection, future timestamps rejected.
- Manually in Chromium (DevTools offline emulation): recorded observations offline, reloaded offline (app shell from SW, mission from IndexedDB, queue intact), came back online, and the queue synced.
