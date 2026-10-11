# Domain model

Types live in `shared/src/index.ts`; rules live in `server/src/domain.ts` and `server/src/config.ts` (`RULES`).

## Entities
- **Owner**: anonymous session. `{_id: uuid, tokenHash: sha256(token), createdAt, lastSeenAt}`. `lastSeenAt` is updated at most once an hour. Owners never expire (ARCHITECTURE.md → Indexes).
- **UserPreferences**: `missionTypes[], defaultMinutes, timeOfDay, maxWalkMinutes, walkingPace, accessibility{stepFreeRequired, needsSeating, avoidCrowds}, language('en'), voice{readStepsAloud, voiceNotes}, privacy{useCoarseLocation}`, plus timestamps. `stepFreeRequired` makes `step_free` required, `needsSeating` makes `bench` required, `avoidCrowds` makes `not_crowded` preferred. `timeOfDay` is only a hint to the AI.
- **Mission**: id, title, description, type, objective, availableMinutes, estimatedMinutes, walkingMinutes, constraints{required, preferred}, conditionChecks, candidateLocations, selectedLocation, travel (straight-line, approximate), `route: null` (no routing), steps[{text, minutes, kind: walk|still|observe}] (the duration is only in `minutes`; mission text never states one), observationPrompts, safetyNotes, expectations, weather, whyItMatches[{text, sourceType}], provenance{generator, provider, model, fallbackUsed, fallbackReason}, uncertainty[], status, session, reportId, createdAt, version. `reportId` is generated and stored by the completion update itself, before the report exists. Internal (not in API responses): `appliedOpIds` (last 100 applied opIds) and `feedback{rating, text}` (saved at completion so the report can be rebuilt).
- **MissionSession** (embedded as `mission.session`): id, startedAt, pausedAt, totalPausedMs, completedAt, cancelledAt, currentStep, completionStatus (completed|partial), userMinutes, lastEventAt. Every time here is an event time (see Timestamps). Sync state lives on the client queue.
- **Location**: `{_id: "osm:way/123" | "serpapi:<place_id>" | "fixture:N", name, category, coords (from source; null for fixtures), source, isFixture, externalId, attribution, retrievedAt, lastCheckedAt}`. Discovery facts only, never conditions.
- **Observation**: id, opId (unique), ownerId, missionId, sessionId, attribute, value, `sourceType: user_report`, clientTs (event time: corrected and clamped), clientTsRaw (as the client sent it; absent on rows stored before 2026-10-11), serverTs (receipt), locationId, `verificationStatus: unverified`, privacy (`location_linked` | `mission_only`).
- **EvidenceSummary**: unique (locationId, attribute). Fields: estimate, confidence, supporting, contradicting, valueCounts, sources, `sourceType: aggregated`, lastObservedAt, expiresAt, reevaluateAt. Internal: `computedAt` (when the recompute that wrote it started; see Concurrency below).
- **CompletionReport**: id (= the mission's `reportId`), unique per mission. planned{title, estimatedMinutes, availableMinutes, stepCount, location, expectations}, actual{minutes (number or null, see Durations), minutesSource (user|timestamps), stepsReached, observations}, comparisons, feedback{rating, text}, summary{text, generator, provider, model, fallbackUsed, fallbackReason}, evidenceRefs. Built once, after the mission is completed, from the persisted observations. The summary is the authoritative deterministic template (`generator: template`, `provider/model: null`, `fallbackUsed: false`, `fallbackReason: null`; reports stored before 2026-10-11 may carry `fallbackUsed: true` with a reason). There is no AI narration field. Internal: `observationIds` (rows the report was built from).
- **SyncRecord**: opId (unique), ownerId, entityType, entityId, opType, clientTs (raw, as sent), serverTs, status (pending|applied|conflict|rejected), result, error; `lease` and `leaseUntil` while pending. TTL 30 days.

## Timestamps
- **Raw client time**: `clientTs` exactly as the device sent it. Kept as `observation.clientTsRaw` and `sync_records.clientTs`.
- **Event time**: the raw time moved onto the server clock by the request's offset (`serverNow − sentAt`, see API_SPEC.md → Timestamps), clamped to `[previous event, serverNow]`. Stored as `observation.clientTs` (the field name predates the correction) and as the mission session times. Requests without `sentAt` keep the old rule: refused if > 5 min ahead, otherwise raw, clamped to the previous event. Fixed when the op is first applied.
- **Server receipt**: `observation.serverTs`, `sync_records.serverTs`.

Evidence freshness, report observation times and durations use the event time. "Latest report per owner" uses server receipt, so a device clock can't make an old report win.

## Durations
`MAX_ACTUAL_MINUTES` = 240 (`shared/src/index.ts`, `RULES.maxActualMinutes`), the longest plan budget.
- User-entered `actualMinutes`: integer 0–240, otherwise 400 `VALIDATION_ERROR` (via `/sync`: that op alone is `rejected / VALIDATION_ERROR`). Used as given (`minutesSource: user`), labelled "your estimate" in the UI.
- Otherwise from timestamps: completedAt − startedAt − paused time, all event times. Below 0 or above 240 (e.g. left running and completed days later, or inconsistent stored times) → `minutes: null`, still `minutesSource: timestamps`, and the summary says "actual duration unknown".
- `measuredMinutes` keeps the timestamp duration (or `null`) on every report, so an estimate is shown next to what was measured ("12 (your estimate; measured 30)"). The estimate is not replaced or flagged: people enter minutes exactly when the timestamps are wrong (forgot to end the mission), so neither value is assumed right.
- Analytics totals and averages count only reports with minutes in 0–240 and report how many were excluded and how many of the counted ones are user estimates (`minutesUserEstimated`); the average stays `null` below 5 such reports.

## Attributes (value order low → high)
`bench_availability` not_found<found · `shade_quality` none<partial<good · `noise_level` quiet<moderate<loud · `crowding` empty<some_people<busy · `path_condition` blocked<uneven<good · `step_free_access` no<yes · `temperature_feel` cooler_than_expected<as_expected<hotter_than_expected (report-only, not location evidence).

## Source types
- `verified_external`: reserved for a validated source (official dataset, moderated record). **None is integrated, so nothing is labelled verified today.**
- `external_map_data`: third-party, crowd-sourced map data with attribution, e.g. "Test Park is mapped as a park (© OpenStreetMap contributors)". It says the source maps the place, not that it is verified. OSM accessibility tags such as `wheelchair=*` are **not** fetched or used.
- `user_report`: one anonymous session's observation.
- `aggregated`: an evidence summary over anonymous user reports from several sessions.
- `inferred`: a deterministic rule (duration fit, "no reports yet").
- `ai_suggestion`: model-written text, never treated as fact.

Weather lines name Open-Meteo and the observation time in the text.

## Evidence rules (deterministic)
Freshness windows: bench 90 d, shade 21 d, noise 14 d, crowding 3 d, path 30 d, step-free 180 d.
1. No reports → **unknown**.
2. Reports exist but all are older than the window → **stale** (last value shown, not relied on).
3. Only each owner's latest report counts (latest by server receipt time `serverTs`, not the client clock), and it counts only while fresh by its event time `clientTs` (corrected to the server clock when the client sent `sentAt`). One owner counts once however many reports or missions they send. "Independent" means distinct anonymous sessions, which are free to create, so it is not proof of distinct people.
4. If the top two values tie, or the minority share is ≥ 1/3 → **conflicting**, and the estimate is withheld.
5. If the top value is backed by ≥ 3 independent owners → **moderate**; otherwise **low**. A single report is therefore never above low.
6. Summaries are fully recomputed from source observations on every write, after an observation is deleted or refused, after `DELETE /me`, and again on read once `reevaluateAt` (oldest counted report + window) has passed. Nothing is incremented or decremented.
There are no numeric scores.

**Query.** `$match {locationId, attribute}` → `$sort {ownerId, serverTs desc, _id desc}` → `$group` by owner taking the first (latest) report → `$sort {serverTs desc}` → `$limit RULES.evidence.maxReportsConsidered` (500 owners). Dedupe happens before the limit, so one owner's flood can't push other owners out of the window. Index: `observations {locationId, attribute, ownerId, serverTs: -1, _id: -1}`.

**Concurrency.** Each recompute records `computedAt` (high-resolution time when it started reading) and upserts with the filter `computedAt` not ≥ its own. A recompute that started later has seen every observation committed before it started, so if it has already written, the older one's write is dropped (duplicate-key on upsert) and it returns the stored newer summary. When no observations remain, the summary is deleted. A recompute that wrote just after such a delete re-checks that observations still exist and removes its own write if they don't. Limitation: `computedAt` uses each server's clock, so with several instances, clock skew could reorder recomputes that start within the skew.

## Observation limits
Per mission (`RULES.observationLimits`): at most 40 observations in total and 10 per attribute. After its insert, an observation counts the mission's rows. Over either cap, it is deleted, evidence is recomputed, and the request gets 429 `OBSERVATION_LIMIT` (in `/sync`: `rejected`, final; the client keeps it as a conflict until dismissed). Accepted rows are never removed by this check, so the request that counted last saw every accepted row: concurrent submissions can't exceed the cap. They may all be refused right at the boundary, and the user can send another. One exception: if a completion raced the observation and the report already contains it, it is kept, as for `MISSION_NOT_ACTIVE`. A repeated opId is answered as a duplicate and not counted again. The caps also bound `GET /missions/:id/observations` and reports.

## Condition checks
Each condition maps to an attribute and accepted values (e.g. `shade` → shade_quality ∈ {good, partial}). Status: supported (moderate + accepted), weak_support (low + accepted), weak_against (low + not accepted), contradicted (moderate + not accepted), conflicting, stale, unknown. A **required** condition that is *contradicted* excludes the location. Every other non-supported status is listed in `uncertainty`; none is silently treated as satisfied.

Every check also carries:
- `provenance`: `unknown` (no reports), `user_report` (one session), or `aggregated` (several sessions). This field also accepts `verified_external` and `external_map_data`, so a future verified source can plug in without a schema change.
- `verification`: `verified` only when backed by a `verified_external` source. None exists, so every check is `unverified`.

**Accessibility conditions** (`RULES.accessibilityConditions`: `step_free`, `bench`, `smooth_path`) always add an `uncertainty` line, required or preferred, even when `supported`: *"Required accessibility condition "step_free" is unverified (supported): it rests only on anonymous reports, if any. Check access yourself before relying on it."* Their "why it fits" line adds "(anonymous, not verified)". Planning is not blocked; the user decides. Step-free access is never inferred from a place existing or from its map category.

No eligibility rules (minimum session age or mission duration) are applied to reports. Both are cheap to wait out with pre-made sessions, so they would only delay abuse. The honest labelling above is the mitigation, and the gap is listed in the README.

## Constraint engine (`validateCandidate`)
Rejects: estimated (steps + round-trip travel) > min(available, 120) or < 5; walking (travel + walk steps) > maxWalkMinutes; locationId not among supplied candidates; unsafe text (trespass, climbing over, restricted areas, medical/therapy wording); a required condition contradicted. AI text cannot change any of these, and safety notes are added by the server, not the AI.

## State machine
planned→active (start); active→paused (pause); paused→active (resume); active|paused→completed (complete); planned|active|paused→cancelled (cancel). `complete` on a completed mission is idempotent and returns the existing report. Anything else → 409 `INVALID_TRANSITION`. Observations are accepted only while a mission is active or paused; one that races a completion is either in the report or rejected with 409 `MISSION_NOT_ACTIVE` (see ARCHITECTURE.md → Concurrency). Client timestamps are corrected and clamped as described in Timestamps; only requests without `sentAt` can be refused (`CLOCK_SKEW`, more than 5 min ahead).
