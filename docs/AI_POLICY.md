# AI policy

## What AI does
1. Parse a free-text request into `{missionType, availableMinutes, preferred conditions}`.
2. Propose up to 3 missions as structured JSON.
3. Turn a typed or dictated note into *proposed* observations, which the user confirms one by one.

Completion report summaries are not AI-written. The report's summary is the authoritative template summary built from recorded facts: planned vs actual minutes (`actual.minutesSource` says whether the user entered them or they came from timestamps), the observation count, and differences only for attributes that had a planned expectation. It is labelled `generator: template`, `provider/model: null`, and `fallbackUsed: false, fallbackReason: null`, because it is the designed path, not a stand-in for a failed AI call. No model is called while completing a mission or building, rebuilding or reading its report, so retries and recovery always produce the same text.

AI narration of reports is intentionally absent. It would add a model's wording on top of facts the report already states. If it is added later, it must be a separate field (e.g. `aiNarrative{text, sourceType: ai_suggestion, provider, model}`) generated outside the completion path, labelled "AI-generated, may be inaccurate", and must never replace or edit `summary`.

## What AI never does
- Write to the database. Only server code writes, after validation.
- Decide safety. Safety notes and unsafe-text rejection are deterministic (`RULES.unsafePatterns`, `RULES.baseSafetyNotes`).
- Invent places. `locationId` must be one of the supplied candidates or null, otherwise the candidate is rejected.
- Invent weather or conditions. Weather comes from Open-Meteo, and conditions come from the evidence model. The evidence the model sees is labelled as unverified anonymous reports with their count (e.g. `yes (moderate, 3 unverified anonymous reports)`). Whatever the model writes, the server adds the accessibility "unverified" notices itself.
- Override the constraint engine. Every AI candidate goes through `validateCandidate`. The only adjustment the engine makes is shortening step minutes proportionally to fit the time budget, which is reported in `uncertainty`. Validation runs on the final candidate after that shortening: total ≤ available time and ≤ `RULES.maxMissionMinutes`, each step 1–`RULES.maxStepMinutes` whole minutes, walking within the limit.
- State durations in text. A step's duration lives only in its `minutes` field, which the UI shows as "N min". The prompt and the step schema say so, and any title, description, objective or step text that states a duration (`RULES.durationPattern`: "10 minutes", "ten-minute", "half an hour", "a quarter hour", "30 seconds"…) is rejected, because shortened minutes would contradict it. If every AI candidate is rejected, templates are used and `fallbackReason` names the reason. Templates pass the same checks (tested for every type and several budgets).

## Mechanics (`server/src/ai.ts`)
- Providers: Ollama `/api/chat` (JSON Schema passed as `format`) or OpenAI-compatible `/chat/completions` (`response_format: json_object`).
- Every response is parsed with `JSON.parse` and validated with Zod. Malformed or invalid output is retried (`AI_MAX_RETRIES`, default 1, so 2 attempts), each with an `AI_TIMEOUT_MS` timeout.
- On failure, callers get `data: null` with `fallbackReason` and use deterministic code: templates or keyword parsers.
- Fallback reasons never echo model output (JSON syntax errors become "malformed JSON").

## Labelling
Every mission carries `provenance{generator: ai|template, provider, model, fallbackUsed, fallbackReason}`. Every "why it fits" line carries a `sourceType`, and AI text is always `ai_suggestion`. Place-mapping lines are `external_map_data`, never `verified_external`. Reports label the summary generator. The UI shows these labels on every card.

## Known behaviour (observed locally with gemma3:4b)
- It often overshoots the time budget (e.g. 34 min for a 25 min request). The engine shortens or rejects it, then falls back to templates.
- It wrote step text such as "sit for 10 minutes" that contradicted shortened minutes. Such candidates are now rejected (see above). This was not re-run against a live model after the change.
- When reports still had AI summaries, they sometimes overstated (e.g. "busier than anticipated" when there was no prior expectation). That is why summaries are template-only. Reports stored before that change may still have `generator: ai`; the UI labels them "may be inaccurate".
