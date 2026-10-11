# Domain model

Types live in `shared/src/index.ts`; rules live in `server/src/domain.ts` and `server/src/config.ts` (`RULES`).

## Entities
- **Owner**: anonymous session. `{_id: uuid, tokenHash: sha256(token), createdAt, lastSeenAt}`.
- **UserPreferences**: `missionTypes[], defaultMinutes, timeOfDay, maxWalkMinutes, walkingPace, accessibility{stepFreeRequired, needsSeating, avoidCrowds}, language('en'), voice{readStepsAloud, voiceNotes}, privacy{useCoarseLocation}`, plus timestamps. `stepFreeRequired` makes `step_free` required, `needsSeating` makes `bench` required, `avoidCrowds` makes `not_crowded` preferred. `timeOfDay` is only a hint to the AI.
- **Mission**: id, title, description, type, objective, availableMinutes, estimatedMinutes, walkingMinutes, constraints{required, preferred}, conditionChecks, candidateLocations, selectedLocation, travel (straight-line, approximate), `route: null` (no routing), steps[{text, minutes, kind: walk|still|observe}], observationPrompts, safetyNotes, expectations, weather, whyItMatches[{text, sourceType}], provenance{generator, provider, model, fallbackUsed, fallbackReason}, uncertainty[], status, session, reportId, createdAt, version.
- **MissionSession** (embedded as `mission.session`): id, startedAt, pausedAt, totalPausedMs, completedAt, cancelledAt, currentStep, completionStatus (completed|partial), userMinutes, lastEventAt. Sync state lives on the client queue.
- **Location**: `{_id: "osm:way/123" | "serpapi:<place_id>" | "fixture:N", name, category, coords (from source; null for fixtures), source, isFixture, externalId, attribution, retrievedAt, lastCheckedAt}`. Discovery facts only, never conditions.
- **Observation**: id, opId (unique), ownerId, missionId, sessionId, attribute, value, `sourceType: user_report`, clientTs (validated, clamped), serverTs, locationId, `verificationStatus: unverified`, privacy (`location_linked` | `mission_only`).
- **EvidenceSummary**: unique (locationId, attribute). Fields: estimate, confidence, supporting, contradicting, valueCounts, sources, `sourceType: aggregated`, lastObservedAt, expiresAt, reevaluateAt.
- **CompletionReport**: planned{title, estimatedMinutes, availableMinutes, stepCount, location, expectations}, actual{minutes, minutesSource, stepsReached, observations}, comparisons, feedback{rating, text}, summary{text, generator, provider, model, fallbackUsed, fallbackReason}, evidenceRefs.
- **SyncRecord**: opId (unique), ownerId, entityType, entityId, opType, clientTs, serverTs, status (applied|conflict|rejected), result, error. TTL 30 days.

## Attributes (value order low → high)
`bench_availability` not_found<found · `shade_quality` none<partial<good · `noise_level` quiet<moderate<loud · `crowding` empty<some_people<busy · `path_condition` blocked<uneven<good · `step_free_access` no<yes · `temperature_feel` cooler_than_expected<as_expected<hotter_than_expected (report-only, not location evidence).

## Source types
`verified_external`: fetched from an attributed external API at a recorded time (OSM mapping, Open-Meteo). This means "the source says so", not field-verified. `user_report`: one person's observation. `aggregated`: an evidence summary over user reports. `inferred`: a deterministic rule (duration fit, "no reports yet"). `ai_suggestion`: model-written text, never treated as fact.

## Evidence rules (deterministic)
Freshness windows: bench 90 d, shade 21 d, noise 14 d, crowding 3 d, path 30 d, step-free 180 d.
1. No reports → **unknown**.
2. Reports exist but all are older than the window → **stale** (last value shown, not relied on).
3. Only each owner's *latest fresh* report counts. Independence means distinct anonymous owners.
4. If the top two values tie, or the minority share is ≥ 1/3 → **conflicting**, and the estimate is withheld.
5. If the top value is backed by ≥ 3 independent owners → **moderate**; otherwise **low**. A single report is therefore never above low.
6. Summaries are recomputed on every write and again on read once `reevaluateAt` (oldest counted report + window) has passed.
There are no numeric scores.

## Condition checks
Each condition maps to an attribute and accepted values (e.g. `shade` → shade_quality ∈ {good, partial}). Status: supported (moderate + accepted), weak_support (low + accepted), weak_against (low + not accepted), contradicted (moderate + not accepted), conflicting, stale, unknown. A **required** condition that is *contradicted* excludes the location. Every other non-supported status is listed in `uncertainty`; none is silently treated as satisfied.

## Constraint engine (`validateCandidate`)
Rejects: estimated (steps + round-trip travel) > min(available, 120) or < 5; walking (travel + walk steps) > maxWalkMinutes; locationId not among supplied candidates; unsafe text (trespass, climbing over, restricted areas, medical/therapy wording); a required condition contradicted. AI text cannot change any of these, and safety notes are added by the server, not the AI.

## State machine
planned→active (start); active→paused (pause); paused→active (resume); active|paused→completed (complete); planned|active|paused→cancelled (cancel). Anything else → 409 `INVALID_TRANSITION`. Client timestamps more than 5 min in the future are rejected; earlier ones are clamped so they never precede the previous event.
