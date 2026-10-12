<!--
DRAFT for the DEV post. Not published.
Deadline: Oct 11, 11:59 PM PDT = Oct 12, 12:29 PM IST.
Before publishing: fill every [TODO], add screenshots or a short video, and remove this comment.
Paste everything below the line into https://dev.to/new.
-->
---
title: ShadeLoop: a field journal that sends you outside and believes only what you report back
published: false
tags: devchallenge, hf26challenge, opensource, ai
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 1: Touch Grass](https://dev.to/challenges/hacktoberfest-week1-2026-10-05)*

## What I Built

**ShadeLoop** plans short outdoor missions (5–120 minutes) for people who have a gap in their day and want to spend it outside: a shady 20-minute break, a quiet bench, a slow nature walk. Then it gets out of the way.

1. **Plan.** Type "a quiet 20 minute break somewhere shady". An open-weight model (Gemma) turns that into constraints and drafts missions around real mapped places (OpenStreetMap) and live weather (Open-Meteo).
2. **Check.** A deterministic rule engine, not the model, decides what you see. It checks time, walking limits and safety text, uses real places only, and rejects any place where people have reported the opposite of what you asked for. Every plan shows a small "what ran" strip (which model read and drafted it, the engine check, which map sources answered, weather, memory), so you can see exactly what powered it.
3. **Go.** Field Mode shows one step at a time in big type, with big buttons for what you notice (shade: none, patchy or full; bench: yes or no; noise…). It works offline, and ElevenLabs can read the steps aloud so you can keep the phone in your pocket.
4. **Report.** Your observations become shared, explainable evidence for that place: `unknown → low → moderate`, or `conflicting`. The next person's plan is more honest because you went outside.

The core idea: map apps know a park exists; they don't know whether the bench is still there or whether the shade is real at 2 pm, and an AI will happily make that up. ShadeLoop treats every condition as **unknown until someone reports it** and shows where each claim comes from.

[TODO: 1–2 sentences on who you built it for and why it matters to you.]

## Demo

- Live: https://shadeloop.onrender.com (Render free plan: the first visit can take about a minute to wake up)
- [TODO: a 60–90 s video or GIF: plan → Field Mode → tap observations → report]
- [TODO: screenshots: Discover, Field Mode, Settings → Integrations]

## Code

{% github CodewithJha/shadeloop %}

## How I Built It

- **Open-weight model at the core: Gemma.** In production it's Gemma 4 (`gemma-4-26b-a4b-it`) through Google AI Studio's OpenAI-compatible endpoint. For local and offline-friendly development it's `gemma3:4b` through **Ollama**, behind the same interface. Gemma parses requests, drafts missions and turns free-text field notes into *proposed* observations that you confirm. It never writes to the database, decides safety or invents places.
- **The rule engine is the boss.** Every draft goes through `validateCandidate`: too long gets shortened or rejected, a stated duration in the text gets rejected, unknown places are dropped. If the model is slow, wrong or missing, templates take over and the UI says "Template · AI not used" with the reason. Running gemma3:4b locally showed the small model overshooting time budgets, and that's exactly the case the engine catches.
- **Offline-first PWA.** React 19 + Vite. Missions and an operation queue live in IndexedDB, so a mission opened once works with no signal and syncs idempotently later.
- **Stack:** Node + Express 5 + Zod, MongoDB Atlas, TypeScript everywhere. 121 server tests and 38 web tests; every external service is mocked in CI.


### Live run (Oct 12, on the deployed app, one throwaway session)

- `gemma-4-26b-a4b-it` parsed "a quiet 20 minute break somewhere shady with a bench" and drafted "Parkside Pause" at a real Cubbon Park spot. The rule engine accepted it (about 26 s, 2 model calls).
- On the next request the engine **refused** Gemma's draft ("walking 23 min exceeds your limit of 20 min") and used a template instead. The app says so in a field note. That's the point: the open model proposes, plain code decides.
- SerpApi returned 20 places (Overpass was down at that moment), and Backboard recalled the first request when planning the second.
- ElevenLabs read a step (1.5 s) and the finished report aloud. Tiger Data returned the time-of-day aggregate, and pgvector matched two places with the same reports.
- `DELETE /me` then removed everything: missions, observations, reports, Tiger rows and the Backboard memory.
- Open-Meteo was rate-limited (429) on Render's shared IP during the run, and the app said "weather unavailable" instead of guessing.

[TODO, optional but valuable: one real Sentry trace screenshot showing invoke_agent plan_missions → execute_tool + chat spans with tokens and latency, plus one thing it helped you find.]

## Why Does Open Innovation Matter?

- **Swap the model, keep the product.** The same code runs Gemma 4 in the cloud or gemma3:4b on a laptop with Ollama. Nothing about the app is locked to one vendor, and anyone can run the whole thing for free.
- **Privacy by construction.** Location is rounded to about 1 km on the device before it goes anywhere, and coordinates are never sent to the model. With Ollama, your requests and notes never leave your machine.
- **An open model plus an open rule engine is auditable.** Because the engine is plain code in the repo, you can read exactly why a mission was accepted or rejected. A closed "trust me" assistant can't offer that, and it matters when the claim is "this path is step-free".
- **Open data in, open data out.** Places come from OpenStreetMap and weather from Open-Meteo, both credited. Field reports build a shared evidence model that anyone can inspect.

[TODO: if you took it outside, 2–4 honest sentences on how it went: where, what you reported, what surprised you. Judges give bonus points for this.]

## My Agent Session

[TODO, optional: link or embed a DevRelay session with the agent_session tag, or remove this section.]

## Prize Categories

- **Best Use of Gemma**: the open-weight model behind request parsing, mission drafting and note parsing, in production (Gemma 4 on AI Studio) and locally (gemma3:4b on Ollama), always checked by a deterministic engine.
- **Best Use of Render**: the whole app (API + PWA) runs as a Docker web service from `render.yaml` at shadeloop.onrender.com.
- **Best Use of Sentry Agent Tracing**: each plan is traced as an agent run: `invoke_agent plan_missions`, `execute_tool` spans for weather, places and memory, `chat <model>` spans with token usage, plus attempts and fallback flags. Voice (`speak_step`, `speak_report`) and similarity search (`similar_places`) are traced as tools too. No prompts or coordinates go into spans. [TODO: attach a trace screenshot; this track asks for one.]
- **Best Use of ElevenLabs**: gives Field Mode a voice: it reads each step aloud so your eyes stay on the trail, and reads your completion report back when you finish ("Listen to report"). The browser voice is the offline fallback, and the app says which voice spoke.
- **Best Use of Tiger Data**: a TimescaleDB hypertable and a 15-minute continuous aggregate power "Reports here by time of day" for each place. **pgvector** stores a field-report fingerprint per place (the share of reports for each attribute value: shade, noise, crowding, bench…), and cosine search (`<=>`) powers "Places with similar field reports": if you liked this quiet, shady spot, here's where people reported the same. No embedding model is needed, so it's free, deterministic and explainable. Verified live on 2026-10-12.
- **Best Use of Backboard**: opt-in memory of your own earlier requests ("I need step-free paths") that future plans respect; deleted with "Delete my data".
- **Best Use of MongoDB Atlas**: the data layer behind an app built on an open-weight model: missions, observations, reports and the shared evidence model.
- **Best Use of GitHub Copilot**: CI on GitHub Actions runs lint, typecheck, 124 server and 38 web tests, the PWA build, an audit and a Docker build on every push. Copilot issue #1 (a flaky concurrency test) was fixed in commit `89b8ead`.
- **Best Use of Entire**: the agent session behind that fix is public: https://entire.io/gh/CodewithJha/shadeloop/commit/89b8eada487181a88134341db161312060d1bce4
- **Best Use of SerpApi**: grounds every plan in fresh Google Maps place results next to OpenStreetMap. In a live run on 2026-10-12, Overpass failed and SerpApi's 20 places kept the plan grounded in real places.

<!-- Solo submission. -->
