# Decisions

Short log of choices that shape the code. Newest last.

0. **Repository location.** The requested path `~/.cursor/skills-cursor/canvas/ShadeLoop` lives inside a Cursor-managed skills folder that Cursor re-syncs every few minutes, which deleted the project twice (including `.git`). The repo therefore lives at `~/ShadeLoop`.
1. **npm workspaces, three packages** (`shared`, `server`, `web`). `shared` holds only Zod schemas, enums and API types, so client and server validate input the same way. Business rules (constraint engine, evidence, state machine) live only in `server`.
2. **No server build step.** The server runs `.ts` directly through Node's built-in type stripping (Node ≥ 23.6, tested on 26). Code uses erasable TS syntax only (`erasableSyntaxOnly`). Upgrade path: add `tsc`/esbuild emit if a host can't run modern Node.
3. **MongoDB official driver, no ODM.** Indexes are created at startup. Local dev and tests use `mongodb-memory-server` (`MONGODB_URI=memory`), so no DB has to be set up by hand. Production refuses `memory`.
4. **Anonymous sessions via bearer token.** `POST /api/v1/sessions` returns a random 256-bit token. Only its SHA-256 hash is stored. A bearer header was chosen over cookies, so no CSRF surface. There is no full auth.
5. **Mission session is embedded in the mission document** (`mission.session`). State changes are a single conditional update (optimistic `version`), so status and timing can't diverge.
6. **The evidence model is categorical, not numeric.** Values are `unknown | low | moderate | conflicting | stale`, and independence means distinct anonymous owners. See DOMAIN_MODEL.md.
7. **AI is optional and advisory.** Every AI call is Zod-validated, has bounded retries and a timeout, and falls back to deterministic templates or keyword parsers. AI output goes through the constraint engine and a safety-text check before anything is saved.
8. **One sync path.** Field Mode queues every state change and observation in IndexedDB and sends it through `POST /sync`, both online and offline. Idempotency comes from unique `opId` indexes on sync records and observations, plus a per-mission list of applied op IDs.
9. **Paused → completed is allowed.** Ending a paused mission is natural in the field, so you don't have to resume first.
10. **Discovery results are facts about a map entry, never about conditions.** OSM/SerpApi results set name, category and coordinates only. Shade, safety, access and opening hours stay unknown until people report them.
11. **Temperature feel is not stored as location evidence.** It's relative to the forecast at that moment, so it appears only in completion reports.
12. **AI step durations may be shortened deterministically** to fit the time budget (proportional, each step ≥ 1 min). When that happens the mission's uncertainty list says so. Mission text must not state durations (it would contradict the shortened minutes), so such candidates are rejected. Gemma 3 4B often overshoots the budget in local tests.
