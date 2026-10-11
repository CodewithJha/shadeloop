# Development plan

## Done
1. Docs skeleton and decisions.
2. Foundation: workspaces, env validation, Mongo adapter and indexes, error envelope, logging with redaction, health.
3. Core loop with persistence: plan (AI or fallback) → engine → save → start → observe → complete → report → evidence → history.
4. Offline Field Mode, IndexedDB queue, idempotent `/sync`, service worker.
5. Live discovery (Overpass; SerpApi wired) and Open-Meteo.
6. Render, Docker and CI config; docs finalized.

## Next (priority order)
1. **Real accounts or passkeys** so data survives device changes, and per-person (not per-session) evidence independence to resist skew.
2. **Atlas deployment and verification**, plus Sentry with a redacting `beforeSend` and an inactive-session retention job.
3. **Playwright e2e** of the offline flow in CI, and an accessibility audit with a screen reader.

## Later
Routing/isochrones for honest travel times; ElevenLabs voice capture where browser speech is unavailable; multilingual UI; per-attribute evidence decay tuning from real data.
