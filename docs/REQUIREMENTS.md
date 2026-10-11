# Requirements

Status: ✅ implemented and tested · 🟡 implemented, manually verified only · ❌ not implemented

## Functional
| ID | Requirement | Status |
|---|---|---|
| F1 | Plan up to 3 missions from prompt / minutes / type / conditions / coarse location | ✅ |
| F2 | AI output Zod-validated, bounded retries and timeout, deterministic fallback, `fallbackUsed` exposed | ✅ |
| F3 | Constraint engine: time ≤ available and ≤ 120 min, walking limit, real locations only, safety text, required conditions vs evidence | ✅ |
| F4 | State machine planned→active⇄paused→completed, cancel from non-terminal; invalid → 409 | ✅ |
| F5 | Structured observations, idempotent by `opId` | ✅ |
| F6 | Completion report: planned vs actual, comparisons, summary with provider metadata, evidence refs | ✅ |
| F7 | Deterministic evidence model (unknown/low/moderate/conflicting/stale) | ✅ |
| F8 | Offline Field Mode, IndexedDB op queue, idempotent batch sync with per-op conflicts | ✅ (unit and API tests) / 🟡 (browser offline and reload checked manually) |
| F9 | Discovery via Overpass, SerpApi (key), labelled fixture mode | ✅ Overpass live-verified · 🟡 SerpApi untested (no key) |
| F10 | Weather via Open-Meteo with source and timestamp, "unavailable" otherwise | ✅ live-verified |
| F11 | Integration status registry in `/health/dependencies` and Settings | ✅ |
| F12 | History and analytics computed from Mongo, insufficient data instead of invented numbers | ✅ |
| F13 | Preferences GET/PUT, data export, delete-my-data (recomputes shared evidence) | ✅ |
| F14 | Voice: browser speech recognition for notes, speech synthesis for steps | 🟡 (code present; not exercised in automated tests) |
| F15 | ElevenLabs, Sentry, Tiger Data, Mastra, Temporal, Backboard, TabPFN | ❌ (see INTEGRATIONS.md) |

## Non-functional
| ID | Requirement | Status |
|---|---|---|
| N1 | Centralized error envelope with requestId | ✅ |
| N2 | Helmet, body limit 100 kB, rate limits, env validated with Zod | ✅ |
| N3 | Structured logs with redaction (tokens, prompts, notes, coords) and no IPs/headers in request logs | ✅ (test) |
| N4 | Graceful shutdown | 🟡 |
| N5 | Anonymous isolated sessions, ownership checks, unguessable IDs | ✅ |
| N6 | Accessible semantic HTML, keyboard focus, 48px+ targets, reduced motion | 🟡 (manual) |
| N7 | Tests need no manually prepared DB | ✅ |
