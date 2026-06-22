# AI Coach MVP — End-to-End Flow

A complete walkthrough of how the system works, from browser to database and back.
Written so a new engineer, product manager, or stakeholder can follow along without reading the code.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Architecture at a Glance](#2-architecture-at-a-glance)
3. [Startup: What Happens When the Server Boots](#3-startup-what-happens-when-the-server-boots)
4. [Phase 1 — Scenario Setup (Frontend)](#4-phase-1--scenario-setup-frontend)
5. [Phase 2 — Starting a Session](#5-phase-2--starting-a-session)
6. [Phase 3 — The Conversation Loop](#6-phase-3--the-conversation-loop) *(updated: optimistic LLM start, waveform indicator)*
7. [Phase 4 — Ending the Session & Generating the Report](#7-phase-4--ending-the-session--generating-the-report)
8. [Voice Mode: How Speech-to-Text and Text-to-Speech Work](#8-voice-mode-how-speech-to-text-and-text-to-speech-work)
9. [Evaluation Engine: How Scoring Works](#9-evaluation-engine-how-scoring-works)
10. [Safety & Quality Controls](#10-safety--quality-controls)
11. [Data Storage](#11-data-storage)
12. [Configuration Reference](#12-configuration-reference)
13. [Running the System](#13-running-the-system)

---

## 1. What This System Does

The AI Coach MVP is a **roleplay-based communication trainer**. A learner picks a practice scenario (e.g. a salary negotiation, a job interview, a difficult conversation), and has a conversation with an AI persona that plays the other party. At the end, an LLM judge evaluates the conversation against pre-defined success criteria and returns a scored report.

**Two interaction modes:**
- **Text (Chat):** The learner types; the AI responds as text in a chat UI.
- **Voice (Call):** The learner speaks; a real-time speech-to-text pipeline transcribes it, the AI responds, and text-to-speech plays the reply out loud — simulating a phone call.

---

## 2. Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser (React)                         │
│   Setup Screen → Chat/VoiceCall Screen → Report Screen         │
└────────────────────────────┬────────────────────────────────────┘
                             │  HTTP + Server-Sent Events (SSE)
                             │  WebSocket (voice only)
┌────────────────────────────▼────────────────────────────────────┐
│              FastAPI Backend  (app/main.py)                      │
│                                                                  │
│  /session/start      — create session, generate opening         │
│  /session/message/stream — process one turn, stream reply       │
│  /session/{id}/begin — start the hard-stop timer (voice)        │
│  /session/end        — score entire session, return report      │
│  /transcribe         — Whisper STT fallback                     │
│  /ws/transcribe/{id} — Deepgram real-time WebSocket             │
│  /scenario/generate  — LLM-generated scenario JSON              │
│  /scenarios          — CRUD for saved scenarios                 │
│  /sessions           — session history                          │
│                                                                  │
│  Components:                                                     │
│   Embedder        → OpenAI or SentenceTransformer embeddings    │
│   PromptManager   → builds the LLM system prompt per turn       │
│   ModelAdapter    → OpenAI / Azure OpenAI client + TTS          │
│   HallucinationChecker → semantic grounding check               │
│   Scorer          → LLM-as-judge, weighted topic scoring        │
│   SessionEvaluator → LLM-generated human-readable feedback      │
│   Moderation      → regex profanity filter                      │
└────────┬────────────────────────────────────────────────────────┘
         │
    ┌────▼────────┐    ┌────────────────────┐
    │  SQLite DB  │    │  data/ directory   │
    │  sessions   │    │  session_meta_*.json│
    │  scenarios  │    │  (persona, chunks, │
    └─────────────┘    │   settings per     │
                       │   session)         │
                       └────────────────────┘
```

**External services used:**
| Service | Purpose | Fallback |
|---|---|---|
| OpenAI / Azure OpenAI | LLM chat completions, embeddings | — |
| OpenAI TTS (`tts-1-hd`) | Text-to-speech audio | Kokoro (local) |
| Deepgram | Real-time voice transcription (WebSocket) | Whisper tiny (local) |

---

## 3. Startup: What Happens When the Server Boots

When Uvicorn starts `app/main.py`, the following happens **once**, before any request is served:

**Step 3.1 — Shared Embedder initialised**
An `Embedder` instance is created. It probes OpenAI/Azure embeddings with a "ping" call. If that succeeds, all embedding calls go to the API. If it fails (missing deployment, wrong key), it falls back to a local `BAAI/bge-small-en-v1.5` SentenceTransformer model loaded from disk.

**Step 3.2 — SQLite DB initialised**
`init_db()` runs SQLAlchemy's `create_all()` — creates the `sessions` and `scenarios` tables if they don't already exist.

**Step 3.3 — Components wired together**
```
PromptManager(embedder=shared_embedder)
ModelAdapter()                          ← reads OPENAI_API_KEY / OPENAI_BASE_URL
HallucinationChecker(embedder=shared_embedder)
Scorer(embedder=shared_embedder)
SessionEvaluator(model=model_adapter)
```
The single `shared_embedder` instance is injected everywhere to avoid loading the model multiple times (~900 MB RAM saving).

**Step 3.4 — Whisper warmed up in the background**
A daemon thread loads the `faster-whisper` tiny model so the first `/transcribe` request doesn't pay the cold-start penalty.

**Step 3.5 — TTS directory created**
`./data/tts/` is created if absent. The `/audio` static file route is mounted to serve any TTS files (though TTS is now returned as base64 in-memory, not files).

---

## 4. Phase 1 — Scenario Setup (Frontend)

### 4.1 Loading the Setup Screen

On first load, the React app:
1. Renders the **Setup Screen** showing a grid of scenario cards.
2. Calls `GET /scenarios` to fetch persisted scenarios from the DB.
3. Upserts all built-in scenarios from `scenarios.js` to the backend (so any code changes to built-ins are reflected immediately).
4. Merges the server response into the UI.

Each scenario card shows:
- Label and description
- Mode badge (Text / Voice)
- Sample vs. Custom badge
- **Launch** button and View/Edit/Delete controls

### 4.2 Selecting and Launching a Scenario

1. User clicks **Launch** on a scenario card.
2. A popup appears asking for the learner's name.
3. User types their name and clicks **Start**.
4. The frontend calls `POST /session/start` with the full scenario payload.

### 4.3 Creating or Generating Scenarios

**Manual creation:** The **+ Create** button opens a `ScenarioEditor` form where the author fills in:
- AI persona (name, role, organization, personality, background)
- Concerns (objections the AI persona will raise)
- Evaluation topics with success criteria and weights (must sum to 100)
- Additional settings (time limit, roleplay end condition, difficulty mode)

**AI generation:** The author types a free-text prompt (e.g. "A junior employee negotiating a raise with a skeptical manager"). The frontend calls `POST /scenario/generate`, which sends the prompt to the LLM with a strict JSON schema. The LLM returns a complete scenario object. The author can edit it before saving.

---

## 5. Phase 2 — Starting a Session

**Endpoint:** `POST /session/start`

**Request body:** Full `CreateSession` schema — persona, evaluation topics, settings, learner name.

### Step-by-step:

**Step 5.1 — Build runtime config**
`_build_runtime_from_structured_payload()` converts the request into a flat dict that is easier for runtime code to consume:
- `persona` — a single paragraph describing who the AI is
- `areas` — comma-separated topic names (used in the system prompt)
- `guardrail_instructions` — a detailed behavioural script telling the LLM how to act, what concerns to raise, and when to raise them
- `context_chunks` — a list of text chunks (conversation context, persona background, each evaluation topic) used for semantic retrieval on every turn

**Step 5.2 — Create DB row**
A `Session` row is inserted into SQLite with an empty transcript and an empty report.

**Step 5.3 — Save session metadata to disk**
All runtime config (persona, chunks, settings, timestamps) is written to `data/session_meta_{id}.json`. This JSON file is loaded on every subsequent request for that session.

**Step 5.4 — Generate opening message**
The AI persona's opening line is generated:
- If **voice mode**: the LLM is called to produce a natural, context-aware opening sentence (e.g. "Yes? What is this regarding?")
- If **text mode**: a static fallback is used ("Go ahead, I'm listening.")
The result is wrapped with a name/role intro: `"Hi, I'm Sarah, Head of Sales at Acme. Go ahead, I'm listening."`

**Step 5.5 — Save opening to transcript**
The greeting is appended to the DB transcript as `{ speaker: "AI", text: "...", opening: true, grounded: true }`.

**Step 5.6 — TTS for voice mode**
If `tts_enabled`, two audio payloads are synthesised **in parallel** via `ThreadPoolExecutor`:
- **Opening audio:** The AI persona's greeting is synthesised in their voice.
- **Briefing audio:** `_generate_briefing_message()` writes a 1-sentence summary (via LLM), then Alice (the mediator voice) synthesises it — "Hi, I'm Alice. You'll be speaking with Sarah, who has concerns about your recent project delivery."

Both are returned as base64-encoded data URIs (`wav:<b64>` for Kokoro, `mp3:<b64>` for OpenAI TTS). Parallelising these two calls saves ~1–2 s off session-start time.

**Step 5.7 — Start hard-stop timer**
If a time limit is configured and this is text mode, a `threading.Timer` is started. When it fires, the session is silently closed and scored. Voice mode defers the timer until `/session/{id}/begin` is called (when the briefing finishes and the actual call starts).

**Response:**
```json
{
  "session_id": 42,
  "opening_message": "Hi, I'm Sarah, Head of Sales at Acme. Go ahead, I'm listening.",
  "opening_tts_url": "wav:<base64...>",
  "briefing_message": "Hi, I am Alice, here is a brief about the session. You'll be speaking with Sarah...",
  "briefing_tts_url": "wav:<base64...>",
  "passing_marks": 70
}
```

---

## 6. Phase 3 — The Conversation Loop

Every learner message goes through `POST /session/message/stream`, which returns **Server-Sent Events (SSE)**.

**This endpoint runs inside a per-session threading.Lock** to prevent race conditions if two requests hit the same session simultaneously.

### Latency budget per turn

The design goal is sub-1 s perceived latency. Each turn runs an optimistic pipeline:

```
T=0 ms    Request arrives
T=~150 ms Retrieval + guardrail checks done → LLM stream starts in background thread
T=~155 ms Relevance result available (was running in parallel)
           If off-topic: abort LLM thread, yield nudge
T=~1500 ms LLM first token arrives from background thread
T=~1700 ms First sentence complete → Kokoro TTS (~150 ms) → SSE idx=0 emitted
           Frontend plays first real AI sentence
```

Meanwhile, the frontend shows an **animated waveform** (5 pulsing bars) on the AI avatar panel from the instant the learner's turn is submitted until audio starts — giving immediate visual feedback with no audio filler.

### Step-by-step for each learner turn:

---

**Step 6.1 — Moderation check**
The learner's input is checked against a regex profanity list (`app/moderation.py`).

- **First offence:** The message is blocked. A warning is returned. The session continues.
- **Second offence:** The session is immediately closed, scored (with a profanity flag), and the report is returned.

---

**Step 6.2 — Check if conversation is already closed**
If `meta["conversation_closed"]` is `True`, the endpoint returns an error immediately. This prevents any action on a timed-out or already-ended session.

---

**Step 6.3 — Parallel pre-LLM checks (~150 ms)**
Three tasks run concurrently in a `ThreadPoolExecutor(max_workers=3)`:

| Task | What it does |
|---|---|
| **Relevance check** | Skipped on turn 1. Embeds learner message, compares against context chunks and last AI turn. Returns `{relevant, nudge}`. |
| **Chunk retrieval** | `_retrieve_from_chunks()` — top-3 context chunks by cosine similarity. Chunk embeddings are cached per session. |
| **Guardrail suppression** | `_suppress_raised_concerns()` — appends "do NOT repeat this concern" for concerns the AI has already raised. |

As soon as **retrieval and guardrail** futures resolve (~150 ms), the system moves to prompt building and starts the LLM. The relevance future is awaited just after LLM start (see Step 6.6).

---

**Step 6.4 — Difficulty mode resolution**
If `difficulty_mode` is set (e.g. `"skeptical"`, `"impatient"`, `"evasive"`, `"hostile"`), the corresponding interaction-style modifier is injected into the system prompt. If `"auto"`, a heuristic runs after the learner's 3rd turn: verbose learners get an impatient AI, question-heavy learners get an evasive AI, hedging learners get a skeptical AI. The resolved difficulty is cached in `session_meta` so it's computed only once.

---

**Step 6.5 — Build the system prompt**
`PromptManager.build_prompt()` assembles the full LLM system prompt:
```
You are [persona]

[guardrail_instructions — behavioural rules, concerns to raise]
The person you are speaking with is called [learner_name].
[INTERACTION STYLE: difficulty modifier if active]

Use the background information below to inform your responses...

FOCUS AREAS: [topic names]

BACKGROUND INFORMATION:
[top-3 retrieved chunks]
--- END BACKGROUND ---

Stay fully in character at all times.
Format your response inside <reply> tags.
Write only the spoken response — no notes, no stage directions.
Keep responses short: 1-3 sentences maximum. One idea per turn.
Begin your reply directly — never open with affirmations like "Great", "Sure", "Absolutely".
[If allow_ai_to_end]: After </reply>, write <close>YES</close> if [end_condition], else <close>NO</close>.
```

---

**Step 6.6 — Optimistic LLM start + relevance gate**
Immediately after the system prompt is built, the LLM stream is launched in a background `threading.Thread` that writes tokens into a `queue.Queue`. The main thread does **not** wait — it proceeds directly to check the relevance future.

- **Off-topic:** `_llm_abort` event is set → background thread exits → a nudge message is yielded. The turn is not saved to the transcript.
- **On-topic:** The main thread begins consuming the token queue (Step 6.7 below).

By starting the LLM ~150 ms into the request (right after retrieval+guardrail), instead of after all checks complete, the first AI sentence arrives ~1.5 s after the request — with no audio filler phrase in between.

---

**Step 6.7 — Stream the LLM reply**
Tokens are drained from the `queue.Queue` fed by the background LLM thread. The server:
1. Waits for the `<reply>` opening tag before buffering anything.
2. Splits the buffer on sentence endings (`. `, `! `, `? `).
3. For each complete sentence:
   - **Voice mode:** synthesises TTS immediately and emits a `{"type":"tts","url":"...","idx":N}` SSE event. The frontend plays each sentence as it arrives — the learner hears the reply before the full response is done.
   - **Text mode:** emits a `{"type":"sentence","idx":N,"text":"..."}` SSE event for progressive display.
4. Stops buffering once `</reply>` is detected. Everything after the close tag is metadata (e.g. `<close>YES</close>`).

---

**Step 6.8 — Post-processing the reply**

After the full reply is assembled:

| Check | What it does |
|---|---|
| **Anti-repeat** | Compares the reply to the last 4 AI turns using cosine similarity. If similarity ≥ 0.76, retries the LLM up to 2 times with an explicit "don't repeat" instruction. |
| **Persona guard** | Checks for out-of-character patterns (e.g. "as an AI", "I am just an assistant"). If found, replaces the reply with a neutral fallback. Marks the turn as `persona_violation: true`. |
| **Fallback prefix strip** | If the reply starts with "I don't know beyond the provided materials" but then continues with real content, strips the prefix. |
| **POV rewrite** | If the reply uses third-person role labels (e.g. "the manager", "the customer"), rewrites it into first/second person via a short LLM call. |
| **Opener deduplication** | If the first sentence is identical or near-identical (≥ 0.90 similarity) to the previous AI turn's first sentence, strips it. |
| **Close tag parse** | Checks for `<close>YES</close>` — if the AI decides the session should end (e.g. the learner achieved the roleplay goal), sets `ai_closed=True`. |

---

**Step 6.9 — Save turn to transcript**
Both the learner turn and AI reply are appended to the DB transcript:
```json
{ "speaker": "Learner", "text": "...", "profanity": false, "speech_stats": {...} }
{ "speaker": "AI", "text": "...", "grounded": true, "checks": [...], "persona_violation": false }
```

---

**Step 6.10 — Send final SSE event**
```json
{ "type": "done", "reply": "...", "grounded": true, "checks": [...], "report": null }
```
If the AI closed the session (`ai_closed: true`), the report is built here and included.

---

## 7. Phase 4 — Ending the Session & Generating the Report

The session ends in one of four ways:

| Trigger | How |
|---|---|
| Learner clicks "End Session" | Frontend calls `POST /session/end` |
| AI emits `<close>YES</close>` | Detected inside `/session/message/stream`, report built inline |
| Profanity threshold exceeded | 2nd profanity offence triggers auto-close inside message handler |
| Time limit expires | Background `threading.Timer` fires `_on_session_time_expired()` |

### Step-by-step for `POST /session/end`:

**Step 7.1 — Check if already closed**
If the session was already closed (by the AI or timer), the existing report is returned immediately without re-scoring.

**Step 7.2 — Build evaluation report** via `_build_evaluation_report()`:

**(a) LLM topic scoring**
`Scorer.evaluate_weighted_topics_llm()` is called with all learner turns and the evaluation topics. For each topic, it submits one LLM call (parallelised via `ThreadPoolExecutor`, up to 5 concurrent). The LLM is asked:
> "For each success criterion, did the learner clearly demonstrate it? Return JSON."

The result per criterion: `{ criterion, met: true/false, reason: "...", supporting_turn: 2 }`.

**(b) Weighted score calculation**
Each topic has a weight (all weights sum to 100). Within a topic, each criterion contributes equally to the topic's share of the final score. The final score is `sum(criteria_met / criteria_total × topic_weight)`.

**(c) Make-or-break topics**
If any topic is marked `make_or_break: true` and the learner scored below its threshold (default 20%), the entire final score is forced to 0.

**(d) Short-session penalty**
If `short_session_penalty.enabled` is true and the session was shorter than `minimum_session_minutes`, `penalty_points` are deducted from the score.

**(e) Grounding adherence**
The ratio of grounded AI turns to total AI turns is computed. (Currently all AI turns are marked grounded; this is kept for future fact-checking use.)

**(f) Persona check**
If any AI turn has `persona_violation: true` in the transcript, `persona_ok: false` is set in the report.

**(g) Speech stats aggregation** (voice sessions only)
Filler words (um, uh, like, etc.) and speaking pace (words per minute) are aggregated across all learner turns that have speech stats.

**(h) LLM session explanation**
`SessionEvaluator.explain_session()` calls the LLM once per topic (parallel) to generate a 2-3 sentence human-readable explanation of what the learner did well and what they missed, plus an actionable "To improve:" tip. Then it generates an overall 2-3 sentence session summary.

**Step 7.3 — Determine pass/fail**
`passed = final_score >= passing_marks`

**Step 7.4 — Save report to DB**
The report is written to the `Session.report` JSON column in SQLite.

**Step 7.5 — Cleanup**
- Chunk embedding cache for this session is freed from memory.
- The session timer is cancelled (if one was running).
- The per-session threading lock is released.

**Response (returned to frontend):**
```json
{
  "session_id": 42,
  "final_score": 72.5,
  "passing_marks": 70,
  "passed": true,
  "report": {
    "evaluation_score": 72.5,
    "topic_breakdown": [...],
    "persona_ok": true,
    "profanity": false,
    "make_or_break_failed": false,
    "speech_stats": { "avg_pace_wpm": 145, "total_fillers": 3, ... },
    "session_explanation": {
      "summary": "...",
      "topic_explanations": [...],
      "strong_topics": ["Objection Handling"],
      "weak_topics": ["Closing"]
    }
  }
}
```

**Frontend** shows the **Report Screen**:
- Score badge (pass/fail)
- Overall summary paragraph
- Per-topic bars with explanation, criterion checklist, and "To improve" tips
- Speaking analysis stats (voice sessions only)

---

## 8. Voice Mode: How Speech-to-Text and Text-to-Speech Work

### Speech-to-Text (STT): Two paths

**Path A — Deepgram (primary, real-time)**
Used when `DEEPGRAM_API_KEY` is set. The frontend opens a WebSocket to `/ws/transcribe/{session_id}`. It streams raw audio bytes from the browser's microphone. The server forwards each chunk to Deepgram's LiveTranscription API (model `nova-2`). Deepgram returns:
- `speech_started` — microphone captured sound
- `transcript` (interim) — live text as the person speaks
- `transcript` (final + `speech_final`) — a finalised sentence
- `utterance_end` — end of utterance detected (silence after speech)

On `utterance_end`, the server computes speech stats (filler words, pace) from word-level timing data and sends them to the client along with the final transcript text.

**Path B — Whisper (fallback)**
If Deepgram is not configured, the frontend records an audio clip and posts it to `POST /transcribe`. The server transcribes it using `faster-whisper` (tiny model, CPU, int8 quantised). No word-level timing — no speech stats in this path.

### Text-to-Speech (TTS): Two paths

**Path A — Kokoro (local, if `USE_LOCAL_TTS=1`)**
Uses the local `kokoro` library (voice `af_heart` by default). Audio is synthesised in-memory, concatenated, and returned as a base64-encoded WAV: `"wav:<base64>"`.

**Path B — OpenAI TTS (default)**
Calls `openai.audio.speech.create(model="tts-1-hd", voice="alloy")`. Audio is streamed into a buffer and returned as base64 MP3: `"mp3:<base64>"`.

TTS is synthesised **per sentence** during streaming so the frontend can start playing the first sentence while the rest is still generating. The first sentence typically arrives ~1.5 s after the learner finishes speaking.

Alice (the briefing mediator) always uses the local voice `af_bella` to sound distinct from the AI persona.

### Frontend visual feedback during AI processing

While the backend LLM is generating (before any audio arrives), the AI avatar panel shows an **animated waveform**: five vertical bars that pulse up and down with staggered timing — visually signalling that the AI is actively thinking. Once the first TTS audio plays, the waveform gives way to the speaking animation (three bouncing dots). This eliminates the perception of silence with no feedback.

---

## 9. Evaluation Engine: How Scoring Works

### Embeddings

All semantic similarity in the system uses the same `Embedder` instance:
- Chunk retrieval (finding relevant background for the LLM prompt)
- Hallucination checking (grounding AI replies against source text)
- Relevance checking (is the learner's message on topic?)
- Anti-repeat checking (is the AI reply semantically duplicate?)

Embeddings are L2-normalised vectors. Similarity is computed as dot product (= cosine similarity for unit vectors).

### LLM-as-Judge Scoring

Each evaluation topic is scored independently via one LLM call. The prompt is:
- Topic name and evaluation guidelines
- All success criteria (numbered list)
- All learner turns (in order)
- Instruction to return JSON: `{ criteria_results: [{ criterion, met, reason, supporting_turn }] }`

Up to 5 topics are scored in parallel. The score per criterion is binary: fully met or not met.

### Weighted Score Formula

```
For each topic:
  topic_weight_points = (topic.weight / total_weight) × 100
  criterion_weight    = topic_weight_points / criteria_count
  topic_contribution  = sum(criterion_weight for each met criterion)

final_score = sum(topic_contribution for all topics)       [clamped 0-100]
```

If any make-or-break topic's `pass_ratio < threshold` → `final_score = 0`.

### Example

| Topic | Weight | Criteria Met | Score |
|---|---|---|---|
| Objection Handling | 40% | 3 of 4 | 30/40 pts |
| Closing | 30% | 1 of 3 | 10/30 pts |
| Rapport Building | 30% | 2 of 2 | 30/30 pts |
| **Total** | **100%** | | **70/100** |

---

## 10. Safety & Quality Controls

### Profanity Filter (`app/moderation.py`)
Simple regex match against a curated word list. Runs before any LLM call. Two-strike policy: warn, then terminate.

### Persona Guard
After every AI reply, the text is checked against patterns like `\bas an ai\b`, `\bi am just an assistant\b`. If triggered, the reply is replaced with a neutral fallback. The turn is marked `persona_violation: true` and carries through to the final report.

### Anti-Repeat
The last 4 AI turns are kept in memory for comparison. If the new reply has cosine similarity ≥ 0.76 with any of them, the LLM is retried up to 2 more times with explicit "avoid these previous responses" instructions.

### Relevance Gate
Off-topic or keyword-stuffed messages get a nudge instead of an AI reply. The turn is not recorded in the transcript, so it doesn't penalise scoring. The learner must stay on topic to progress.

### POV Rewrite
If the AI slips into narrating the conversation in third person ("the manager should…"), a quick LLM rewrite call restores first/second person POV. Triggered only when specific role-word patterns are detected.

### Concern Suppression
If the AI has already raised a scripted concern and the learner has responded, the LLM is instructed not to raise it again. Prevents the AI from looping on the same objection.

### Per-Session Threading Lock
Every session has a `threading.Lock`. All three exit paths (manual end, AI close, time expiry) acquire this lock before writing `conversation_closed`. This prevents a race where two simultaneous requests both try to finalise the session.

---

## 11. Data Storage

### SQLite Database (`data/ai_coach.db`)

**`sessions` table:**
| Column | Type | Notes |
|---|---|---|
| id | Integer PK | Auto-incremented session ID |
| author | String | From session payload |
| context_id | String | UUID, unused externally |
| created_at | DateTime | UTC |
| transcript | JSON | List of turn dicts |
| report | JSON | Final evaluation report (populated on session end) |

**`scenarios` table:**
| Column | Type | Notes |
|---|---|---|
| id | String PK | e.g. `"salary-negotiation"` |
| data | JSON | Full scenario object |
| created_at | DateTime | |
| updated_at | DateTime | |

### Session Metadata (`data/session_meta_{id}.json`)

Heavy per-session config that would be expensive to store in the DB (large chunks, guardrail text):
- `persona`, `areas`, `guardrail_instructions`
- `context_chunks` — list of `{ id, text }` dicts
- `evaluation_topics` — full topic objects with criteria
- `conversation_closed`, `started_at_utc`
- `passing_marks`, `tts_enabled`, `learner_name`
- `time_limit_enabled`, `conversation_duration_minutes`
- `short_session_penalty_enabled`, etc.
- `profanity_offense_count`
- `active_difficulty` — cached difficulty resolution

---

## 12. Configuration Reference

All configuration is via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | required | OpenAI or Azure OpenAI key |
| `OPENAI_BASE_URL` | — | Custom base URL (e.g. Azure endpoint) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat completion model |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | Embedding model |
| `OPENAI_API_VERSION` | `2024-02-01` | Azure API version |
| `OPENAI_TIMEOUT_S` | `60` | Request timeout in seconds |
| `TTS_MODEL` | `tts-1-hd` | OpenAI TTS model |
| `TTS_VOICE` | `alloy` | OpenAI TTS voice for the AI persona |
| `USE_LOCAL_TTS` | `0` | Set to `1` to use Kokoro local TTS |
| `TTS_LOCAL_VOICE` | `af_heart` | Kokoro voice ID |
| `DEEPGRAM_API_KEY` | — | Enables real-time WebSocket STT |
| `DATABASE_URL` | `sqlite:////app/data/ai_coach.db` | SQLAlchemy database URL |

**Reasoning model detection:** If `OPENAI_MODEL` starts with `o1`, `o3`, or `o4`, the adapter automatically switches to `max_completion_tokens` ≥ 8000 and removes `temperature` (unsupported for reasoning models).

---

## 13. Running the System

### With Docker (recommended)

```bash
# Copy and fill in your keys
cp .env.example .env

# Build and start
docker compose up --build

# Backend: http://localhost:8000
# Frontend: served as static files from /app/frontend/dist
```

### Locally (development)

```bash
# 1. Install Python dependencies
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Set env vars (or use .env)
export OPENAI_API_KEY=sk-...

# 3. Start backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 4. Start frontend (separate terminal)
cd frontend
npm install
npm run dev       # Vite dev server at http://localhost:5173
```

The Vite dev server proxies `/session/*`, `/scenarios`, `/transcribe`, `/ws/*` to `http://localhost:8000` (configured in `vite.config.js`).

---

## Complete Request Flow Diagram

```
Browser                      FastAPI                       External
──────                       ───────                       ────────

[Setup Screen]
     │
     ├─ GET /scenarios ──────────────→ SQLite DB
     │                                     │
     │◄──────────────────── scenario list ─┘
     │
     │  User clicks Launch + enters name
     │
     ├─ POST /session/start ─────────→ Build runtime config
     │                                 Create DB row
     │                                 Write session_meta_{id}.json
     │                                 Generate opening (LLM call)
     │                                 Synthesise TTS (if voice mode)
     │                                 Start hard-stop timer (if text mode)
     │                                     │
     │◄─── { session_id, opening_message, briefing_tts_url } ──────────┘
     │
     │  [Voice] Play briefing audio, then POST /session/{id}/begin → start timer
     │
     │  User speaks/types their first message
     │
     ├─ POST /session/message/stream ─→ Moderation check
     │   (Server-Sent Events)           │
     │                                  ├─[parallel]─ Relevance check
     │   Frontend shows waveform ◄───── ├─[parallel]─ Retrieve top-3 chunks
     │   animation immediately          └─[parallel]─ Suppress repeated concerns
     │                                  │
     │                                  retrieval + guardrail done (~150 ms)
     │                                  Build system prompt
     │                                  Start LLM thread → queue ──→ OpenAI
     │                                  Await relevance result        │
     │                                  (on-topic → consume queue)    │
     │◄─── SSE: { type:"tts", url:"wav:...", idx:0 }  ◄──────────────┘
     │     [~1.5 s — Frontend plays first AI sentence, waveform → speaking dots]
     │◄─── SSE: { type:"tts", url:"wav:...", idx:1 }
     │◄─── SSE: { type:"done", reply:"...", grounded:true }
     │
     │  [Repeat conversation loop until session ends]
     │
     │  User clicks End Session (or AI emits <close>YES)
     │
     ├─ POST /session/end ───────────→ Score all learner turns via LLM (parallel)
     │                                 Compute weighted final score
     │                                 Apply penalties if configured
     │                                 Generate LLM topic explanations (parallel)
     │                                 Generate LLM session summary
     │                                 Write report to DB
     │                                 Clean up session resources
     │◄────── { final_score, passed, report } ──────────────────────────┘
     │
     [Report Screen: score badge, summary, topic breakdown, speech stats]
```
