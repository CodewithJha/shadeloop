# AI policy

## What AI does
1. Parse a free-text request into `{missionType, availableMinutes, preferred conditions}`.
2. Propose up to 3 missions as structured JSON.
3. Turn a typed or dictated note into *proposed* observations, which the user confirms one by one.

Completion report summaries are not AI-written: completion must not wait on a model, so the report uses the deterministic template summary built from recorded facts (`summary.generator: template`). AI narration of reports may come back later as a separate, non-blocking step.

## What AI never does
- Write to the database. Only server code writes, after validation.
- Decide safety. Safety notes and unsafe-text rejection are deterministic (`RULES.unsafePatterns`, `RULES.baseSafetyNotes`).
- Invent places. `locationId` must be one of the supplied candidates or null, otherwise the candidate is rejected.
- Invent weather or conditions. Weather comes from Open-Meteo, and conditions come from the evidence model.
- Override the constraint engine. Every AI candidate goes through `validateCandidate`. The only adjustment the engine makes is shortening step minutes proportionally to fit the time budget, which is reported in `uncertainty`.

## Mechanics (`server/src/ai.ts`)
- Providers: Ollama `/api/chat` (JSON Schema passed as `format`) or OpenAI-compatible `/chat/completions` (`response_format: json_object`).
- Every response is parsed with `JSON.parse` and validated with Zod. Malformed or invalid output is retried (`AI_MAX_RETRIES`, default 1, so 2 attempts), each with an `AI_TIMEOUT_MS` timeout.
- On failure, callers get `data: null` with `fallbackReason` and use deterministic code: templates or keyword parsers.
- Fallback reasons never echo model output (JSON syntax errors become "malformed JSON").

## Labelling
Every mission carries `provenance{generator: ai|template, provider, model, fallbackUsed, fallbackReason}`. Every "why it fits" line carries a `sourceType`, and AI text is always `ai_suggestion`. Reports label the summary generator. The UI shows these labels on every card.

## Known behaviour (observed locally with gemma3:4b)
- It often overshoots the time budget (e.g. 34 min for a 25 min request). The engine shortens or rejects it, then falls back to templates.
- When reports still had AI summaries, they sometimes overstated (e.g. "busier than anticipated" when there was no prior expectation). The comparison table in the report is the deterministic record.
