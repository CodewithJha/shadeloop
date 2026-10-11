# Safety and privacy

## Safety
- Every mission includes fixed safety notes: public places only, no private or closed areas, stop if unwell, no medical advice, and conditions are estimates.
- Heat, cold and precipitation notes are added from Open-Meteo data when available, with the observation time. If weather is unavailable, the mission says so.
- Candidate text mentioning trespass, climbing over or through barriers, restricted areas, or medical/therapy claims is rejected (`RULES.unsafePatterns`), whether it came from AI or not.
- A location whose *required* condition (e.g. step-free) is contradicted by field evidence is never selected. Unknown conditions are shown as unknown.
- Walking limits and step-free/seating needs from preferences are enforced by the engine.
- The app never claims a place is safe, open, accessible or shaded based on search results.
- **Accessibility honesty.** Step-free access, seating and path condition come only from anonymous field reports. Sessions are free to create and nobody's presence is checked, so a few sessions can make a place look "supported". No verified accessibility source is integrated (OSM `wheelchair` tags are not used), so nothing is labelled verified. Every accessibility condition, required or preferred, carries `verification: unverified` and an explicit line in "What we don't know" telling the user to check access themselves, even when reports agree. Place listings from OpenStreetMap are labelled "map data", not "verified".
- One session's reports count once per place and attribute, and each mission accepts at most 40 observations (10 per attribute), so one session can't flood away other reports.

## Privacy
- **Location:** opt-in only, requested once through the browser and rounded to 2 decimals (about 1 km) on the device. It is stored in IndexedDB on the device and sent only with a plan request, where the server rounds it again before calling Overpass or Open-Meteo. There is no continuous GPS. The server does not store the user's coordinates; it stores only the coordinates of public mapped places.
- **Notes and transcripts:** used only to propose observations, then discarded. Neither the API nor the client stores them. Dictation uses the browser's speech recognition, which may send audio to the browser vendor, as the UI warns.
- **Logs:** request logs contain only request id, method, URL and status (no headers, IPs or bodies). Pino redacts `authorization`, `cookie`, `token`, `apiKey`, `text`, `transcript`, `prompt`, `feedback`, `lat`, `lon`, `coords` and `coarseLocation` at any logged path (tested in `server/test/unit.test.ts`).
- **Session tokens:** 256-bit random. Only a SHA-256 hash is stored server-side. The token lives in the browser's IndexedDB.
- **Shared data:** observations linked to a public place contribute to anonymous evidence counts (no owner IDs are exposed). Feedback text and ratings are private to the session.
- **Secrets:** none in the frontend or repo. `.env` is gitignored and `.env.example` lists every variable.

## Retention
| Data | Retention |
|---|---|
| Planned missions never started or cancelled | Auto-deleted after 7 days (Mongo TTL) |
| Sync records (idempotency log) | Auto-deleted after 30 days (Mongo TTL) |
| Started missions, observations, reports, preferences | Kept until the user deletes them |
| Evidence summaries | Derived; recomputed when contributing observations are deleted |
| Discovered public places | Kept as a cache of public map data |
| Inactive anonymous sessions | Not auto-deleted yet (gap) |

## Export and deletion
- `GET /api/v1/me/export` (Settings → "Download my data") returns all session-owned data as JSON.
- `DELETE /api/v1/me` (Settings → "Delete all my data") deletes missions, observations, reports, sync records, preferences and the session, then recomputes shared evidence for affected places. The client also clears its IndexedDB.
