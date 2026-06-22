# AI Coach MVP — Technical Overview

> A roleplay simulation platform that puts learners in live conversations with AI personas, evaluates their communication skills in real time, and delivers structured coaching feedback.

---

## Table of Contents

1. [What It Does](#1-what-it-does)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Data Model](#4-data-model)
5. [AI & ML Pipeline](#5-ai--ml-pipeline)
6. [Backend — Endpoints & Logic](#6-backend--endpoints--logic)
7. [Scoring Engine](#7-scoring-engine)
8. [Session Lifecycle](#8-session-lifecycle)
9. [Voice Call Mode](#9-voice-call-mode)
10. [Text Chat Mode](#10-text-chat-mode)
11. [Safety & Guardrails](#11-safety--guardrails)
12. [Scenario System](#12-scenario-system)
13. [GenAI Scenario Creation](#13-genai-scenario-creation)
14. [Frontend — Screens & Components](#14-frontend--screens--components)
15. [Deployment](#15-deployment)
16. [Configuration Reference](#16-configuration-reference)
17. [Key Design Decisions](#17-key-design-decisions)

---

## 1. What It Does

AI Coach is a browser-based training simulator where:

- A **learner** enters a practice scenario (e.g. cold sales call, performance review, behavioural interview)
- They interact in real time with an **AI persona** that plays the other party — staying fully in character
- The system **scores every message** against pre-defined evaluation criteria using NLI (Natural Language Inference)
- At the end, a **detailed report** is generated covering topic-by-topic scores, covered vs missed criteria, coaching tips, and an overall pass/fail verdict

Two interaction modes:
- **Text chat** — typed conversation with a live score sidebar
- **Voice call** — full video-call UI with speech recognition, AI voice synthesis, word-synced subtitles, and a session timer

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (React)                       │
│  Setup → [Briefing] → Voice Call / Text Chat → Report       │
│  ScenarioEditor (+ GenAI generation)   HistoryScreen        │
└───────────────────┬─────────────────────────────────────────┘
                    │ HTTP (REST)
┌───────────────────▼─────────────────────────────────────────┐
│                   FastAPI  (port 8000)                       │
│                                                              │
│  /session/start    /session/message    /session/end          │
│  /sessions         /sessions/{id}      /transcribe           │
│  /scenario/generate                                          │
│  /scenarios  (CRUD)                                          │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │PromptManager │  │HallucinationC│  │     Scorer       │  │
│  │(system prompt│  │(grounding via│  │(NLI cross-encoder│  │
│  │ + RAG chunks)│  │ cosine sim)  │  │ per-criterion)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │               ModelAdapter                           │   │
│  │  Bedrock (Claude) → OpenAI/Azure → Ollama → HF local │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────┐   ┌──────────────┐                    │
│  │  Kokoro TTS      │   │Faster-Whisper│                    │
│  │  (local WAV)     │   │    (STT)     │                    │
│  └──────────────────┘   └──────────────┘                    │
│                                                              │
│  SQLite (sessions + scenarios)   JSON meta files per session │
└─────────────────────────────────────────────────────────────┘
```

Every component shares a **single SentenceTransformer instance** (`all-MiniLM-L6-v2`, 384-dim). The model is ~90MB on disk but expands to ~300MB in RAM (float32 weights + tokenizer + PyTorch buffers). Loading it three times independently would cost ~900MB — sharing it saves ~600MB.

---

## 3. Technology Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.9, FastAPI, Uvicorn |
| Database | SQLite via SQLAlchemy 2.0 |
| LLM (primary) | AWS Bedrock — Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) |
| LLM (fallback 1) | Ollama — `llama3.1:8b` (local, via HTTP) |
| LLM (fallback 2) | HuggingFace `distilgpt2` (fully offline) |
| Embeddings | `sentence-transformers/all-MiniLM-L6-v2` |
| NLI Scoring | `cross-encoder/nli-MiniLM2-L6-H768` |
| TTS (primary) | Kokoro (local, `af_heart` voice, outputs WAV at 24kHz) |
| TTS (fallback) | OpenAI `tts-1-hd` (cloud) |
| STT | `faster-whisper` (`small` model, `int8` quantised, CPU) |
| Frontend | React 18, Vite, plain CSS |
| Containers | Docker + Docker Compose |
| JSON repair | `json-repair` (LLM output normalisation) |

---

## 4. Data Model

### SQLite tables

**`sessions`**
| Column | Type | Notes |
|---|---|---|
| `id` | Integer PK | Auto-increment |
| `author` | String | Learner name (e.g. "Learner") |
| `context_id` | String | Scenario ID |
| `created_at` | DateTime | UTC |
| `transcript` | JSON | List of `{speaker, text, profanity?}` turn objects |
| `report` | JSON | Full evaluation report (set on session end) |

**`scenarios`**
| Column | Type | Notes |
|---|---|---|
| `id` | String PK | e.g. `cold-call-practice` |
| `data` | JSON | Full scenario object |
| `created_at` / `updated_at` | DateTime | |

### Per-session JSON meta file

Stored at `./data/session_meta_{id}.json`. Contains all runtime state:
- `conversation_closed`, `persona_violation` flags
- `passing_marks`, `time_limit_enabled`, `conversation_duration_minutes`
- `tts_enabled`, `tts_lang`
- `ai_persona`, `evaluation_topics`, `conversation_context`
- `additional_settings` (roleplay end, time limit, short session penalty)

This dual-storage pattern (SQLite + JSON) lets the backend write small state updates cheaply to the JSON file while keeping the DB clean for structured queries.

---

## 5. AI & ML Pipeline

### 5.1 Language Model — ModelAdapter

`app/model_adapter.py` provides a single `generate(system_prompt, conversation_history, max_new_tokens, temperature)` interface with a priority chain:

```
Bedrock (Claude)  ──►  OpenAI / Azure  ──►  Ollama  ──►  HF local (distilgpt2)
```

**Bedrock path** (current production config): Raw HTTP call to `bedrock-runtime.{region}.amazonaws.com` using Bearer token auth. Sends a structured Converse API payload with the system prompt and conversation history.

**OpenAI/Azure path**: Uses the official `openai` Python SDK. Detects Azure by checking if the base URL contains `.openai.azure.com`.

**Ollama path**: Raw HTTP POST to `/api/generate` with `stream: false`. Retry logic: 1 retry on 5xx, no retry on 4xx.

**Local HF path**: `distilgpt2` loaded from disk via `transformers`. Runs on CPU. Used as last-resort fallback when all external services are unavailable.

### 5.2 Embeddings — SentenceTransformer

Model: `all-MiniLM-L6-v2` (384-dimensional, ~90MB)

Used in three places, all sharing the same instance:
1. **PromptManager** — retrieves relevant knowledge chunks via cosine similarity (RAG)
2. **HallucinationChecker** — checks AI replies against source material
3. **Scorer** (legacy compat; actual scoring now uses NLI cross-encoder)

Per-session chunk embeddings are **cached in memory** in `_chunk_emb_cache[session_id]` after the first encode. This avoids re-encoding the same documents on every message turn.

### 5.3 NLI Scoring — CrossEncoder

Model: `cross-encoder/nli-MiniLM2-L6-H768`

Given a (premise, hypothesis) pair, the model outputs probabilities for `[contradiction, neutral, entailment]`.

The scorer uses this to determine whether the learner **demonstrated** a success criterion:
- Premise = a sentence/chunk of learner speech
- Hypothesis = success criterion rewritten as past-tense declarative (e.g. `"Ask about budget"` → `"The learner asked about budget"`)
- Threshold = 0.25 entailment probability → binary covered/not-covered

Why past-tense rewrite? NLI models are trained on declarative sentence pairs (MultiNLI, SNLI). Imperative instructions score near-zero because the model was never trained to evaluate instructions as hypotheses.

### 5.4 Hallucination Checker

`app/hallucination.py` — lightweight cosine similarity grounding check.

Algorithm:
1. Extract key terms from the AI's reply (strip stopwords, min 3 chars)
2. Pre-filter sources using **cheap lexical overlap** (≥2 shared terms or numeric overlap) — avoids encoding every source
3. Batch encode the claim + eligible sources in a single `embedder.encode()` call
4. Cosine similarity threshold: 0.30 → claim is "supported"

The encoding-once-per-claim optimisation (`best_support`) was an explicit fix from an earlier bug where the claim was re-encoded once per source in a loop (N times instead of 1).

### 5.5 Speech-to-Text — Faster-Whisper

Model: `small` (English-optimised, `int8` quantised for CPU)
Endpoint: `POST /transcribe`

Lazy-loaded on first request (not on startup) to avoid blocking the server. Thread-safe via `_whisper_lock`. Accepts any audio file (WAV, WebM, MP4), writes to a temp file, transcribes, cleans up.

### 5.6 Text-to-Speech — Kokoro / OpenAI

**Kokoro (local, primary)**: Python `KPipeline` runs inference locally. Outputs 24kHz WAV. Voice: `af_heart`. Pre-warmed at startup by synthesising a short throwaway utterance. Files saved to `./data/tts/`.

**OpenAI TTS (fallback)**: `tts-1-hd`, voice `alloy`, MP3 output.

TTS is **async** — synthesis runs in a `ThreadPoolExecutor` (2 workers) so the API response returns immediately with a `tts_audio_url` pointing to a path that may not yet exist. The frontend polls via `HEAD` requests until the file is ready.

---

## 6. Backend — Endpoints & Logic

### `POST /session/start`

Creates a new roleplay session.

**Input**: Full scenario payload (persona, context, evaluation topics, settings, title)

**What happens:**
1. Validates input with Pydantic
2. Creates `Session` row in SQLite
3. Saves full config to `session_meta_{id}.json`
4. Generates AI opening greeting via LLM (persona-consistent, 1 sentence)
5. If TTS enabled (voice mode):
   - Synthesises opening TTS → `opening_tts_url`
   - Generates **briefing message** (Alice): "Hi, I am Alice, here is a brief about the session. [LLM-generated scenario summary]"
   - Synthesises briefing TTS → `briefing_tts_url`
6. Starts `threading.Timer` if time limit enabled (voice mode defers this to `POST /session/{id}/begin`)

**Returns**: `session_id`, `opening_message`, `opening_tts_url`, `briefing_tts_url`, `passing_marks`

---

### `POST /session/message`

Processes one learner turn. This is the hot path — called on every message.

**Steps:**
1. **Lock** — acquires per-session `threading.Lock` to prevent race conditions
2. **Closed check** — returns 409 if session already closed
3. **Profanity check** — `check_input(text)` via regex wordlist
   - First offense: logs warning, returns `profanity_blocked: true, offense_count: 1`
   - Second offense: closes session, builds report, returns `profanity_terminated: true`
4. **Build conversation history** — serialises transcript to `Speaker: text` format
5. **RAG retrieval** — encodes user message, cosine-similarity against cached chunk embeddings, retrieves top-K relevant chunks
6. **Persona violation check** — scans last AI reply for patterns like `"as an AI"`, `"I am just an assistant"` — flags `persona_violation` in meta permanently
7. **Prompt assembly** — `PromptManager.build_prompt()` injects persona, training areas, and retrieved chunks into system prompt
8. **LLM call** — `model.generate()` via the priority chain
9. **POV rewrite** — detects if AI reply is written in wrong POV (passive/third-person), triggers a corrective LLM call to rewrite in first person
10. **Repeat detection** — compares new reply embedding to the last 4 AI turns; if cosine similarity > 0.76, triggers a "variation" LLM call
11. **Hallucination check** — `nli.best_support()` verifies the reply against source chunks
12. **TTS synthesis** — async, in `_tts_executor` thread pool
13. **Live scoring** — `scorer.evaluate_weighted_topics()` runs NLI batch inference against all learner turns so far
14. **Auto-close check** — if `allow_ai_to_end_roleplay` and AI reply contains end signal, closes session and builds report
15. **Single DB commit** — transcript + report written in one transaction

**Returns**: `reply`, `tts_audio_url`, `checks` (grounding results), `report` (live score), `profanity_blocked`

---

### `POST /session/end`

Manual session close triggered by the learner.

- Cancels any active `threading.Timer`
- Acquires session lock
- Calls `_build_evaluation_report()`
- Sets `final_score`, `passed`, `passing_marks`
- Returns full report

---

### `POST /session/{id}/begin`

Starts the backend hard-stop timer. Called by the frontend **after Alice's briefing TTS finishes** (so the timer only counts actual interaction time, not the pre-call briefing).

---

### `GET /sessions`

History list. Returns all sessions with `id`, `created_at`, `context_id`, `transcript` length, and score. Normalises `final_score` from `evaluation_score` for legacy sessions that pre-date the `final_score` field.

---

### `GET /sessions/{id}`

Single session detail. Returns transcript + full report with the same `final_score` normalisation.

---

### `POST /transcribe`

Accepts an audio file upload. Runs Faster-Whisper. Returns `{ "text": "transcribed text" }`.

---

### `POST /scenario/generate`

GenAI scenario creation.

1. Takes a natural language `prompt` from the user
2. Sends to LLM with a structured system prompt describing the full scenario JSON schema
3. Extracts the JSON object from the raw output
4. Runs `json_repair` to fix any truncation or formatting errors from the LLM
5. Returns the complete scenario object ready to pre-fill the editor form

---

### `GET/POST/DELETE /scenarios`

Standard CRUD for the ScenarioStore table. Built-in scenarios (from `scenarios.js`) are upserted on every app load so code changes propagate automatically.

---

## 7. Scoring Engine

`app/scoring.py`

### How a score is computed

```
For each evaluation topic:
  For each success criterion in that topic:
    For each sentence unit from learner turns:
      Run NLI(learner sentence, "The learner [past-tense criterion]")
      → entailment probability

  criterion_met = max_entailment_across_sentences >= 0.25 ? 1.0 : 0.0
  topic_score_pct = mean(criterion_met) * 100

topic_contribution = topic_score_pct * (topic_weight / total_weight)
final_score = sum(topic_contributions)                    [0–100]
```

### Sentence unit construction

Multi-turn aware. For each learner turn:
1. Add the full turn text (up to 400 chars) as a unit — preserves cross-sentence context
2. Split into sentences
3. Add consecutive bigrams (sentence pairs) — catches criteria that span two sentences
4. Cap per-turn unit count at `MAX_NLI_UNITS / num_turns` to prevent early turns from dominating

### Make-or-break topics

If a topic is flagged `make_or_break: true` and its coverage ratio falls below `make_or_break_threshold` (default 0.2), the **entire session score is zeroed** and `make_or_break_failed: true` is returned. This is designed for must-cover items like compliance disclaimers, safety checks, etc.

### Short session penalty

Optional. Deducts a fixed `penalty_points` value if the session ends before `minimum_session_minutes`. Applied after the main score is computed.

### Live score (mid-session)

The same scoring function runs on every `/session/message` call. The frontend ratchets the displayed score upward only — it never shows a score going down during a session (even if a topic score drops due to accumulating context).

---

## 8. Session Lifecycle

```
POST /session/start
  │
  ├── [Voice mode] Alice briefing TTS plays in browser
  │         │                  ↑ learner timer FROZEN during this
  │         └── Audio ends → POST /session/{id}/begin
  │                 ├── Backend safety-net timer starts (2.5× wall clock)
  │                 └── Frontend learner-timer UNFREEZES
  │
  └── [Text mode] Backend safety-net timer starts immediately
                  Frontend learner-timer active from first AI reply
  
  Loop:
    POST /session/message  ─────────────────────────────────────────────┐
    │  ↑ learner timer PAUSES here (AI is working)                       │
    ├── Profanity? → warn (1st) or terminate (2nd)                       │
    ├── LLM generates reply                                              │
    ├── TTS synthesis (async)                                            │
    ├── Live NLI score                                                   │
    └── Auto-close if AI signals roleplay end ───────────────────────────┤
         ↓ AI TTS playing → learner timer PAUSED                        │
         ↓ AI finishes → learner timer RESUMES                          │
                                                                         │
  Frontend learner timer hits limit                                      │
    └── Calls POST /session/end → cancels backend timer                  │
          └── Shows "Time's up" popup → analysis ───────────────────────┤
                                                                         │
  Backend safety-net timer fires (only if browser closed mid-session)   │
    └── _on_session_time_expired()                                       │
          ├── Build report (time_expired: true)                          │
          └── Close session silently ────────────────────────────────────┤
                                                                         │
  POST /session/end (manual)                                             │
    └── Cancel backend timer → build report → return ──────────────────►┘
    
  Report screen rendered from report JSON
```

---

## 9. Voice Call Mode

### Pre-call: Alice Briefing

Before the actual roleplay begins, a **mediator persona "Alice"** speaks first:

1. Session starts → LLM generates briefing text → Kokoro synthesises it
2. VoiceCall UI shows Alice's panel (different avatar, name "Alice", role "Session Coordinator")
3. Alice's audio plays — no subtitles shown (clean, presenter-like)
4. When Alice's audio ends → **Alice panel swaps to AI persona panel** (feels like Alice dropped off and the persona joined)
5. AI persona's opening message plays with word-synced subtitles
6. Session timer starts only after this handoff

### During the call

- **Speech recognition**: Web Speech API, `lang='en-IN'` (Indian English model for better accent handling)
- Silence detection: 1400ms of quiet triggers automatic turn submission
- `Speak` button: manual press-to-talk option
- Speaking dots animate on the AI panel while TTS plays
- **Subtitles**: word-by-word, synced to audio position via `timeupdate` events. `Math.ceil(currentTime / duration * wordCount)` words revealed progressively

### Timer display

Bottom-left of the controls bar: `MM:SS / MM:SS` (elapsed / total)
- **Counts only learner active time** — freezes while AI is processing or speaking
- Neutral colour during normal operation
- **Amber** when within `warning_minutes` of the limit
- **Red** when limit is reached
- Amber 2-second toast notification fires at the warning threshold

### Hard stop

When learner time hits the limit: frontend stops mic/camera/audio, calls `POST /session/end`, shows "Time's up" popup → OK → analysis screen. The backend safety-net timer (set at 2.5× wall clock) is cancelled by this call and never fires in the normal case.

---

## 10. Text Chat Mode

- Messages displayed in a scrollable conversation list
- Live score sidebar with topic-by-topic bars, ratcheted upward only
- Session timer in the input area footer (same colour logic as voice) — counts only while `!isLoading` (AI is not processing)
- Timer pauses as soon as the learner submits a message; resumes when AI reply arrives
- Early-close warning if ending before 2 minutes
- `onTimeExpired` callback triggers `endSession` directly when learner time exhausts the limit
- Polls server every 2 seconds as fallback for backend-closed sessions (e.g. timer from another tab)

---

## 11. Safety & Guardrails

### Profanity filter (`app/moderation.py`)

Regex-based wordlist (~35 words covering strong profanity, slurs, and mild profanity).

Behaviour:
- **First offense**: message is blocked (not sent to LLM), learner sees warning popup "Please keep your language professional", session continues
- **Second offense**: session is terminated immediately, report is built and returned, learner is shown "Session Terminated" popup

The profanity flag is stored per-turn in the transcript and surfaces in the final report.

### Persona violation detection

Patterns scanned in every AI reply:
- `"as an AI"`, `"I am an AI"`, `"I am just an assistant"`, etc.

If detected, `persona_violation: true` is set permanently in session meta. This flag persists across all turns — once the AI breaks character, it's recorded for the full session. The system prompt is augmented with a guardrail instruction to reinforce character.

### Grounding / hallucination check

Every AI reply is checked against the knowledge sources (conversation context + persona background). If the reply fails the cosine similarity threshold (< 0.30) and has no lexical overlap with sources, it's flagged in the `checks` array returned to the frontend. The fallback response (`"Staying in role, I need concrete details..."`) can be substituted.

### Repeat detection

Compares new AI reply embedding to the last 4 AI turns. If similarity > 0.76, a variation LLM call is made with an explicit instruction to produce a different response. Prevents the AI from looping the same phrasing.

### POV rewrite

Certain patterns trigger detection that the AI replied in the wrong point of view (third-person, passive). A corrective LLM call rewrites the reply in first-person active voice. Pattern `\bthe user\b` was explicitly excluded from the trigger set (was causing excessive rewrites).

---

## 12. Scenario System

### Structure

Each scenario is a JSON object:

```json
{
  "id": "cold-call-practice",
  "label": "Cold Call Practice",
  "description": "One-line card description",
  "session_mode": "voice",
  "thumbnail": "base64 or URL",
  "payload": {
    "conversation_context": "Scene-setting paragraph...",
    "ai_persona": {
      "name": "Rachel",
      "role": "VP of Operations",
      "organization": "Acme Corp",
      "personality": "Direct, time-pressed, skeptical of vendors",
      "background_information": "Directive prompt for how the AI should behave...",
      "concerns": [
        {
          "concern": "Budget constraints",
          "when_it_comes_up": "When pricing is discussed",
          "how_persona_frames_it": "We froze discretionary spend last quarter",
          "good_enough_to_proceed_when": "Learner acknowledges constraints and offers flexible terms"
        }
      ]
    },
    "evaluation_topics": [
      {
        "topic": "Needs Discovery",
        "evaluation_guidelines": "Did the learner uncover the prospect's actual pain?",
        "success_criteria": [
          "Asked at least one open-ended discovery question",
          "Identified a specific business problem"
        ],
        "weight": 30,
        "make_or_break": false,
        "make_or_break_threshold": 0.2
      }
    ],
    "additional_settings": {
      "roleplay_end": {
        "allow_ai_to_end_roleplay": true,
        "end_condition": "When the learner has earned a follow-up meeting",
        "goodbye_message": "Let's schedule a proper demo next week."
      },
      "simulation_time_limit": {
        "enabled": true,
        "duration_minutes": 20,
        "warning_minutes": 3
      },
      "short_session_penalty": {
        "enabled": true,
        "minimum_session_minutes": 5,
        "penalty_points": 20
      }
    },
    "passing_marks": 65,
    "tts_enabled": true,
    "tts_lang": "en"
  }
}
```

### Storage and sync

- Built-in scenarios live in `frontend/src/scenarios.js` (shipped with the frontend)
- On app load, all built-ins are upserted via `POST /scenarios` so the DB always reflects current code
- Custom scenarios are stored only in the DB
- Both are merged and displayed together

---

## 13. GenAI Scenario Creation

`POST /scenario/generate`

Allows creators to describe a scenario in plain English and have the LLM produce a fully-structured scenario JSON.

**Flow:**
1. User clicks "Create with GenAI" button in the scenario editor (only shown when creating new)
2. A modal opens with a textarea (Cmd+Enter submits)
3. Animated loading state with bouncing orbs while generating
4. LLM generates JSON following the full schema (evaluation topics, persona, concerns, settings)
5. `json_repair` fixes any malformed output from the LLM
6. `applyJson()` is called — this pre-fills every field in the editor form
7. User can review, edit any field, then save normally

**Quality controls in the prompt:**
- Topic weights must sum to 100
- Concerns only generated for scenarios where objections are natural (sales, negotiation)
- `background_information` is prompted to be directive (tells AI how to behave, not just who they are)
- `session_mode` selection logic: voice for calls/interviews, text for chat-based scenarios
- `passing_marks` calibrated: 60–70 for beginner, 70–80 for advanced

---

## 14. Frontend — Screens & Components

### Setup screen

- Scenario card grid (thumbnail, name, description, mode badge)
- Selected scenario highlighted
- Built-in scenarios show "View" (read-only); custom scenarios show "Edit" + delete
- "Create with GenAI" button in editor topbar
- Launch button automatically sets mode (voice/text) based on scenario config

### Voice Call screen (`VoiceCall.jsx`)

Panels: AI (left) / User camera (right)

**State machine for the AI panel:**
- `isBriefing=true`: shows Alice (headset icon, "Session Coordinator")
- `isBriefing=false`: shows AI persona (initials avatar, persona name/role)

**Call status indicators:** `idle` → `listening` → `processing` → `speaking`

**TTS queue system:** `ttsQueueRef` holds pending clips sorted by index. `flushTtsQueue` plays one at a time; `handleAudioEnd` advances the queue.

**Subtitle system:** `subtitleWords[]` (full word array) + `subtitleVisible` (count revealed). The `timeupdate` event on the hidden `<audio>` element updates `subtitleVisible = ceil(progress * wordCount)` on every animation frame.

### Text Chat screen

Part of `App.jsx` render. Passes messages to `Chat.jsx` which renders the conversation list and input form. Live score panel in the left sidebar.

### Report screen

- Score badge (large number, pass/fail colour)
- Overall summary paragraph (LLM-generated)
- Per-topic cards with: score bar, explanation, covered criteria (green ticks), missed criteria (red crosses), actionable tip
- Make-or-break failure warning if applicable

### History screen (`HistoryScreen.jsx`)

Lists all past sessions with date, scenario, duration, and score. Clicking a session shows the full transcript + report.

### Scenario Editor (`ScenarioEditor.jsx`)

Scrollable form with sticky left nav:
1. **Overview** — name, description, thumbnail, session mode
2. **Context** — conversation context paragraph
3. **AI Persona** — name, role, org, personality, background, concerns
4. **Evaluation** — topics with criteria, weights, make-or-break flags
5. **Settings** — passing score, TTS language, time limit, short session penalty, AI-ended roleplay
6. **Import JSON** — paste or upload raw JSON to populate all fields

---

## 15. Deployment

Single Docker Compose service. One container runs both the FastAPI backend and serves the compiled React frontend as static files.

```bash
docker compose up --build -d   # build + start
docker compose logs -f mvp     # tail logs
```

**Port mapping**: `8000:8000`

**Persistent volumes:**
- `./data` → `/app/data` — SQLite DB + session JSON meta + TTS audio files
- `./models` → `/app/models` — local HF model weights
- `hf_cache` — HuggingFace model cache (survives rebuilds)

**Frontend dev server** (local development only):
```bash
cd frontend && npm run dev   # port 3000
```
Vite proxies all API routes (`/session`, `/scenario`, `/scenarios`, `/sessions`, `/audio`) to `localhost:8000`.

---

## 16. Configuration Reference

All configuration via environment variables in `docker-compose.yml`:

| Variable | Default | Purpose |
|---|---|---|
| `USE_BEDROCK` | `0` | Use AWS Bedrock as LLM |
| `BEDROCK_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock model ID |
| `BEDROCK_REGION` | `us-east-2` | AWS region |
| `BEDROCK_API_KEY` | — | Bearer token |
| `USE_OPENAI` | `0` | Use OpenAI / Azure as LLM |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model name |
| `OPENAI_BASE_URL` | — | Custom endpoint (Azure or proxy) |
| `USE_OLLAMA` | `0` | Use local Ollama LLM |
| `OLLAMA_MODEL` | `llama3.1:8b` | Ollama model name |
| `USE_LOCAL_TTS` | `1` | Use Kokoro for TTS |
| `TTS_LOCAL_VOICE` | `af_heart` | Kokoro voice ID |
| `TTS_MODEL` | `tts-1-hd` | OpenAI TTS model (fallback) |
| `TTS_VOICE` | `alloy` | OpenAI TTS voice (fallback) |
| `MODEL_PATH` | `/app/models/distilgpt2` | Local HF model path |
| `DATABASE_URL` | `sqlite:////app/data/ai_coach.db` | DB connection string |
| `OPENAI_TIMEOUT_S` | `60` | LLM request timeout |

---

## 17. Key Design Decisions

**NLI over keyword matching for scoring**
Early versions used embedding cosine similarity to score criteria. This caused false positives — asking "what is the read/write ratio?" would score against "separate read path from write path" because the semantic space overlaps. The NLI cross-encoder (entailment detection) is a classifier, not a similarity metric. It correctly distinguishes between mentioning a topic and demonstrating a behaviour.

**Single shared embedder**
Three components originally each loaded `all-MiniLM-L6-v2` independently. The model is ~90MB on disk but occupies ~300MB in RAM per instance (float32 parameters + tokenizer + PyTorch overhead), so three independent loads consumed ~900MB. Loading once at startup and injecting the instance via constructor saves ~600MB — textbook dependency injection.

**Learner-only time enforcement (`useLearnerElapsed`)**
The session time limit counts only the learner's active thinking and speaking time — not the time the AI spends processing or playing TTS audio. A custom `useLearnerElapsed(active)` hook accumulates time across multiple active/inactive transitions using `useEffect` cleanup to snapshot each period's duration. In voice mode, `active = callStatus === 'idle' || callStatus === 'listening'`. In text mode, `active = !isLoading`. The frontend enforces the limit directly by calling `POST /session/end` when the learner's accumulated time hits the cap. The backend `threading.Timer` is set to `2.5× wall clock` as a dead-man's switch — it only fires if the browser is closed mid-session, in which case wall clock is the best available approximation.

**Briefing before call / timer after briefing**
The mediator briefing (Alice) can take 20–40 seconds. Starting the session timer from `POST /session/start` would penalise learners for that setup time. The backend safety-net timer is deferred via `POST /session/{id}/begin`, called by the frontend when Alice's audio ends. The frontend learner timer additionally does not count during briefing (`isBriefing = true`).

**Dual storage: SQLite + JSON meta**
The SQLite `sessions` table is append-oriented (create, update report on close). The JSON meta file is the mutable runtime state that gets updated on every message (conversation_closed flag, turn count, etc.). This avoids partial column updates on a wide row and keeps DB writes minimal.

**TTS async with HEAD polling**
Kokoro synthesis on CPU takes 1–3 seconds. Returning the API response before synthesis completes and having the browser poll via `HEAD` requests decouples response latency from TTS latency. The user receives the text reply immediately; audio follows when ready.

**`en-IN` speech recognition**
Browser Web Speech API defaults to `en-US`. Switching to `en-IN` uses a Google speech model specifically trained for Indian English accents, significantly improving recognition quality for the target user base.

**json-repair for GenAI scenario generation**
LLM-generated JSON frequently has trailing commas, unclosed strings from truncation, or minor formatting errors. Rather than re-prompting (slow, expensive), `json_repair` post-processes the raw output deterministically in microseconds, handling all common LLM JSON failure modes.
