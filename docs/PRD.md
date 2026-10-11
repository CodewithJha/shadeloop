# PRD: ShadeLoop

## Goal
Get people outside for short, purposeful breaks, and make every outing improve what the next person knows about a place.

## Users
- People with 10–60 free minutes who want a low-effort outdoor break (office workers, students, carers).
- People with access needs who must know whether seating, step-free access or shade are actually present.

## Core value
The **field truth loop**: plan → go → observe → report → shared evidence → better plans. The differentiator is honesty. Conditions are unknown until reported, every claim shows its source, and AI suggestions are always labelled and constrained.

## In scope (implemented)
- Mission planning from free text and/or structured inputs, with AI (optional) and deterministic fallback.
- Six mission types: quiet break, nature observation, sensory exploration, neighborhood exploration, mindful walk, environmental observation.
- Constraint engine: time, walking limit, real locations, safety text, required conditions vs evidence.
- Field Mode with quick structured observations, offline queue, pause/resume/end/cancel.
- Completion reports with planned-vs-observed comparisons.
- Categorical evidence model per (location, attribute).
- Place discovery (OpenStreetMap, optional SerpApi) and weather (Open-Meteo) from coarse, opt-in location.
- History, honest analytics (insufficient-data states), preferences, data export and delete.

## Out of scope (for now)
Accounts, social features, routing and navigation, continuous GPS, gamification, medical or wellness claims.

## Success signals
Missions completed; share of observations that differ from expectations (that's the loop working); evidence summaries reaching `moderate`.
