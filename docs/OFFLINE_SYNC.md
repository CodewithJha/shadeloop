# Offline and sync

## Client storage (`web/src/store.ts`, IndexedDB via `idb`)
- `meta`: session token, cached preferences, coarse location.
- `missions`: `{id, mission, local: {status, currentStep, startedAt, completedAt, observations[], reportId}, gone?}`. `local` is the optimistic on-device progress; `gone` means the server answered 404 for the mission.
- `ops`: queue entries `{opId (crypto.randomUUID), missionId, clientTs (device clock at enqueue), type, payload, seq, state, attempts, nextAttemptAt, lastError, result}`.

## Op states
`pending` → `syncing` → `synced` | `failed` (recoverable, retried with backoff) | `conflict` (server refused; kept until the user acts).

## Ordering: per mission
Every queued op belongs to one mission (`start`, `pause`, `resume`, `complete`, `cancel`, `observation`). Nothing else goes through the queue: session creation, preferences and planning are direct online calls. So no op depends on another mission's op, and ordering is enforced **per mission**: one mission backing off or refused never stalls another.

Within a mission, ops are sent strictly in `seq` order. The first op that isn't sendable (in backoff, refused, or still `syncing` elsewhere) holds back every later op of that mission. An observation can therefore never overtake the `start` it depends on and turn into a permanent `MISSION_NOT_ACTIVE` conflict.

## Flush algorithm
1. Walk ops in `seq` order. An op is sendable if `pending`, `syncing` (left over from a crash or closed tab, see below), or `failed` with `nextAttemptAt ≤ now`, and no earlier op of its mission was held. Take up to 50 and mark them `syncing`.
2. `POST /sync {ops, sentAt}`. `sentAt` is the device clock at send time (not enqueue time); opIds and `clientTs` are sent unchanged. The server applies them in order and ends the batch at the first `retry`.
3. A network error (offline or the 180 s timeout), a malformed response (`BadResponseError`), 5xx or 429 marks every sent op `failed`, increments `attempts`, and sets `nextAttemptAt = now + max(min(2^attempts s, 5 min), Retry-After)`. Any other HTTP error marks them `conflict`. A failure to create the session (e.g. 429 on `POST /sessions`) is that HTTP error, not "offline".
4. Per-op results: `applied`, or `duplicate` of an applied op → `synced` (a `complete` op's `reportId` is copied to the cached mission). `retry`, or no result for an op (the batch ended early), → `failed` with the same backoff, never `conflict`. `conflict`/`rejected`, or a `duplicate` whose stored `originalStatus` was `conflict`/`rejected`, → `conflict`.
5. Every mission with a new refusal is refetched (see Reconciliation).
6. Synced ops are pruned after 24 h.

Retries resend the same opId, so the server's opId dedupe makes them safe even when the first attempt was applied and only the response was lost.

Triggers: app start (stuck `syncing` ops are reset to `pending` and failed ops are made due), the browser `online` event (failed ops retried immediately), after each user action, and every 15 s. No flush is attempted while `navigator.onLine` is false.

## One flush at a time
- In a tab: concurrent triggers share the in-flight flush promise.
- Across tabs and installed PWA windows: the flush runs inside `navigator.locks.request('shadeloop-sync', {ifAvailable: true})`. If another instance holds the lock this flush is skipped; the next trigger tries again. Because the lock is released when its holder dies, an op found `syncing` while holding the lock is a leftover and is sent again with the same opId.
- Without Web Locks (old browsers), tabs may flush at the same time. Server opId reservation is the backstop: the second sender gets `retry` (`IN_PROGRESS`) or `duplicate`, and the op converges to one stored result.

## Reconciliation
`cacheMission` (every server fetch of a mission) keeps local progress only while that mission has ops still headed for the server (`pending`/`syncing`/`failed`) and none refused. Otherwise the server's status, start/completion time and `reportId` replace the local ones. The local step is kept while local and server status agree, because step navigation isn't synced. Local observations are kept.

After a refusal the mission is refetched (when online):
- Server says it's completed or cancelled (or otherwise moved on): its state is adopted, so Field Mode stops offering actions and observations for it.
- 404 (planned missions expire after 7 days unstarted, deleted, or owned by an earlier session): the cached mission is marked `gone`. Mission detail, Field Mode and Completion show an explanation instead of actions.
- Network failure: nothing changes; the next fetch reconciles.

## Refused changes and recovery
A refused op and every later unsynced op of its mission stay in the queue. They are not sent again on their own, so a dead mission can't cause an endless retry or conflict loop. "Sync needs your attention" groups them per mission with the reason and three explicit actions:
- **Try again** (hidden for `gone` missions) puts the refused ops back to `pending`. A refusal the server already stored comes back the same way, so this only helps after batch-level 4xx errors.
- **Download as JSON**: the mission id, title and full ops (type, payload, clientTs, opId, error), so observations can be kept or reported by hand.
- **Discard these changes** (after a confirm) removes them from the queue and their observations from the local list.

Ops that keep failing for a recoverable reason (4+ attempts) appear in the same panel with Retry now/Dismiss. Nothing leaves the queue without user action.

## Server side
See API_SPEC.md → Sync semantics and ARCHITECTURE.md → Concurrency. Each opId is reserved atomically (a `pending` row in `sync_records`, unique `opId`, with a 30 s lease) before it is applied, so concurrent requests with the same opId apply it at most once. The others get the stored result as `duplicate`, or `retry` while the first request is still working; an expired lease is taken over. Server errors and lost optimistic-concurrency races release the reservation instead of being stored as the answer. `observations.opId` and `missions.appliedOpIds` dedupe the domain writes underneath, so a takeover never applies an op twice.

## Clock correction
Device clocks can be hours or days off. The server takes `offset = serverNow − sentAt` once per `/sync` request and adds it to every op's `clientTs`, then clamps the result to `[previous event, serverNow]` (API_SPEC.md → Timestamps). One offset per batch keeps the ops of an offline session in order with their original spacing, so durations and evidence freshness come out right. The error is the request latency (corrected times can be that much late). An op's stored times are fixed the first time it is applied: a retry carries a later `sentAt` but gets `duplicate` with the stored result. The raw `clientTs` stays in `sync_records` and `observation.clientTsRaw`. Requests without `sentAt` (a client cached before this change) keep the old rule: more than 5 min ahead is `rejected / CLOCK_SKEW`, which the queue keeps as a conflict.

Limitation: if the device clock is changed between recording an op and sending it, the offset at send time doesn't match the one at recording time. The clamp keeps such times between the previous event and now, but they can be off by the size of the change.

## Service worker
vite-plugin-pwa (Workbox `generateSW`) precaches JS, CSS, HTML and SVG and serves `index.html` for navigations (except `/api/*`). A mission opened once online can be opened, started, observed, paused and ended offline. Planning, note parsing, reports and history need a connection, and the UI says so.

## Verified
- Unit tests (`web/src/store.test.ts`, fake-indexeddb): persistence across a simulated reload, ordering, unique opIds, backoff timing, 5xx vs 4xx handling, `retry` results backed off and resent rather than turned into conflicts, per-op conflicts surfaced and only removed by dismissal, reset of stuck `syncing` ops. Ordering: a later observation is held while `start` backs off after 503/429/timeout/`retry`/missing result and both are then sent in order; other missions aren't held; a mid-batch `retry` resumes in order; a lost response is resent with the same opId without a second local observation; a stored refusal returned as `duplicate` stays a conflict; concurrent triggers and a lock held by another tab never send an op twice; an op left `syncing` in IndexedDB is resent after a reload. Reconciliation: server state adopted with nothing queued, kept with ops queued, refetched and adopted after a refusal, and a 404 marks the mission `gone`, stops sends and keeps the ops exportable.
- Concurrency tests (`server/test/concurrency.test.ts`): 10 concurrent syncs of one `complete` or `pause` op apply it once and agree on the result and `reportId`; a live lease returns `retry` and stops the batch; an expired lease is taken over; a server error leaves no reservation behind; another owner's opId stays isolated.
- API tests: batch apply, full replay → all `duplicate` with the same reportId, per-op conflicts, cross-session opId rejection, future timestamps rejected without `sentAt`. Clock correction: a device 1 h ahead, 2 h behind or 1 day behind lands within 5 s of real time with exact spacing between ops and a correct duration; a resend with a later `sentAt` changes nothing; out-of-range corrected times are clamped, not refused; malformed `clientTs`/`sentAt` → 400; legacy +4 min accepted, +6 min `CLOCK_SKEW`; direct endpoints honour `sentAt`. Evidence tests: an old report stays `stale` and a recent one stays fresh with the device clock off by +1 h / −20 days.
- Client API tests (`web/src/api.test.ts`, mocked fetch): 429/5xx/HTML 502 from `POST /sessions` are `ApiError`s, not offline; parallel first requests make one `POST /sessions`; a failed session request is retried by the next call; only a failed fetch or timeout is `NetworkError`; malformed responses are `BadResponseError` and back off in the queue; a 401 renews once and retries once, concurrent 401s share one renewal, a persistent 401 stops after 3 fetches; `/sync` carries `sentAt` with ops unchanged. Store test: a 429 `Retry-After` delays the next attempt.
- Manually in Chromium (DevTools offline emulation): recorded observations offline, reloaded offline (app shell from SW, mission from IndexedDB, queue intact), came back online, and the queue synced.
