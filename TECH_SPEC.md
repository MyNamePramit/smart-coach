# AI Coach MVP - Technical Specification

Last updated: 2026-03-13

## 1) Overview

This service is a FastAPI-based roleplay coaching backend for manager/learner simulations.
It supports:

- Session-based scenario setup
- Persona-constrained AI responses
- Source-grounded response validation
- Learner scoring and reporting
- Time-bound conversations with optional AI-led closure
- Optional text-to-speech (TTS) generation for AI turns
- Declarative scenario customization at session start

Primary app entrypoint: `app/main.py`.

## 2) High-Level Architecture

- API layer: FastAPI endpoints in `app/main.py`
- Persistence:
  - Session transcript/report in SQLite (`app/db.py`)
  - Session scenario metadata in `data/session_meta_<id>.json`
- Retrieval:
  - Semantic retrieval via SentenceTransformers cosine similarity (`app/main.py`)
  - Session-local retrieval corpus derived from structured scenario payload
- Generation:
  - Priority 1: OpenAI (when enabled/key present) via `app/model_adapter.py`
  - Priority 2: Ollama (`/api/generate`) via `app/model_adapter.py`
  - Priority 3: local Hugging Face model fallback
- Grounding:
- Similarity-based support check (`app/hallucination.py`)
- Fixed overall-response evaluation mode
- Scoring:
  - Weighted evaluation-topic scoring via embedding similarity (`app/scoring.py`)
  - Optional short-session penalty

## 3) Runtime Configuration

Configured via `docker-compose.yml` and env vars:

- `USE_OPENAI` (enabled if explicitly set, or auto-enabled when `OPENAI_API_KEY` exists)
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `OPENAI_BASE_URL` (optional for OpenAI-compatible endpoints)
- `OPENAI_TIMEOUT_S`
- `USE_OLLAMA` (default enabled)
- `OLLAMA_BASE_URL` (e.g., `http://host.docker.internal:11434`)
- `OLLAMA_MODEL` (e.g., `llama3.1:8b`)
- `OLLAMA_TIMEOUT_S`
- `MODEL_PATH` (HF local fallback)
- `DATABASE_URL` (default sqlite path in `/app/data`)
- Audio files are served from `/audio/*` and stored in `data/tts`

### 3.1) Configurable Parameters (Complete Reference)

#### Environment Variables

| Parameter | Default | Used In | Description |
|---|---|---|---|
| `USE_OPENAI` | unset (auto via key) | `app/model_adapter.py` | Enables OpenAI backend; if unset, OpenAI is used when `OPENAI_API_KEY` is present. |
| `OPENAI_API_KEY` | unset | `app/model_adapter.py` | API key for OpenAI backend. |
| `OPENAI_MODEL` | `gpt-4o-mini` | `app/model_adapter.py` | OpenAI model used for generation. |
| `OPENAI_BASE_URL` | unset | `app/model_adapter.py` | Optional OpenAI-compatible base URL override. |
| `OPENAI_TIMEOUT_S` | `60` | `app/model_adapter.py` | Timeout for OpenAI requests. |
| `USE_OLLAMA` | `1` | `app/model_adapter.py` | Enables Ollama HTTP generation backend. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | `app/model_adapter.py` | Ollama base URL. |
| `OLLAMA_MODEL` | `llama3.1:8b` | `app/model_adapter.py` | Model name for `/api/generate`. |
| `OLLAMA_TIMEOUT_S` | `120` | `app/model_adapter.py` | Timeout for Ollama requests. |
| `MODEL_PATH` | unset | `app/model_adapter.py` | Optional local HF model path (fallback mode). |
| `DATABASE_URL` | `sqlite:////app/data/ai_coach.db` | `app/db.py` | SQLAlchemy DB URL. |

#### `/session/start` Request Fields

Validation note: request models are strict (`extra="forbid"`). Unknown/legacy keys are rejected with `422`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `author` | string | `"unknown"` | Session owner/creator. |
| `title` | string/null | `null` | Deprecated; accepted for backward compatibility and ignored at runtime. |
| `conversation_context` | string | required | Conversation background and purpose for the roleplay. |
| `ai_persona` | object | required | Persona definition (name, role, personality, background, concerns, end guidelines). |
| `evaluation_topics` | object[] | required | Evaluation/scoring topics with per-topic weight and make-or-break control. |
| `additional_settings` | object | `{...}` | Roleplay end behavior, simulation time limit, short-session penalty. |
| `passing_marks` | float | `70.0` | Pass threshold (`0-100`) used to determine pass/fail at session close. |
| `tts_enabled` | bool | `false` | Enables MP3 generation for AI outputs. |
| `tts_lang` | string | `en` | gTTS language code for generated audio. |

#### `/session/start.ai_persona` Object Fields

| Parameter | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Persona name. |
| `organization` | string/null | `null` | Persona organization/company context. |
| `role` | string | required | Persona role in the scenario. |
| `voice` | string/null | `null` | Optional voice label (metadata only). |
| `personality` | string/null | `null` | Persona style (e.g., skeptical, analytical). |
| `background_information` | string | required | Persona background and motivations. |
| `concerns` | object[] | `[]` | Persona concern definitions used for behavior grounding. |
| `persona_opener` | string/null | `null` | Deprecated; accepted for backward compatibility and ignored at runtime. |
| `end_conversation_guidelines` | object/null | `null` | Optional closure behavior (`what_to_say`). |

`end_conversation_guidelines.when_to_end` is also accepted for backward compatibility and ignored at runtime.

#### `/session/start.ai_persona.concerns[]` Object Fields

| Parameter | Type | Default | Description |
|---|---|---|---|
| `concern` | string | required | Concern statement. |
| `when_it_comes_up` | string/null | `null` | Trigger timing in conversation flow. |
| `how_persona_frames_it` | string/null | `null` | Persona’s framing style for this concern. |
| `good_enough_to_proceed_when` | string/null | `null` | What response quality allows progression. |

#### `/session/start.evaluation_topics[]` Object Fields

| Parameter | Type | Default | Description |
|---|---|---|---|
| `topic` | string | required | Topic label (e.g., rapport, objection handling). |
| `evaluation_guidelines` | string | required | Full guidelines text for this topic. |
| `success_criteria` | string[] | `[]` | Criterion list used for scoring; if omitted, inferred from guideline bullet lines. |
| `weight` | float | required | Topic weight in percentage points (normalized internally). |
| `example_videos` | object[] | `[]` | Learning resource entries (`title`, `url`) shown in analysis output. |
| `helpful_links` | object[] | `[]` | Helpful-link entries (`title`, `url`) shown in analysis output. |
| `make_or_break` | bool | `false` | Marks a critical topic; if below threshold, final score is forced to 0. |
| `make_or_break_threshold` | float | `0.2` | Pass-ratio threshold (`0-1`) used when `make_or_break=true`. |

#### `/session/start.additional_settings` Object Fields

| Parameter | Type | Default | Description |
|---|---|---|---|
| `roleplay_end` | object | `{allow_ai_to_end_roleplay:false,...}` | Enables AI-driven end condition and goodbye text. |
| `simulation_time_limit` | object | `{enabled:false,...}` | Time-boxes the simulation and triggers warning/end behavior. |
| `short_session_penalty` | object | `{enabled:false,...}` | Deducts score if session ends before minimum duration. |

#### `/session/start.additional_settings.roleplay_end` Object Fields

| Parameter | Type | Default | Description |
|---|---|---|---|
| `allow_ai_to_end_roleplay` | bool | `false` | Enables conditional AI-led roleplay termination. |
| `end_condition` | string/null | `null` | Natural-language condition that should trigger ending behavior. |
| `goodbye_message` | string/null | `null` | Optional custom closing line used when ending the roleplay. |

#### `/session/start.additional_settings.simulation_time_limit` Object Fields

| Parameter | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enables simulation time limits. |
| `duration_minutes` | int/null | `null` | Total simulation duration (1-59). |
| `warning_minutes` | int | `5` | Warning window before hard end. Must be `< duration_minutes` when enabled. |

#### `/session/start.additional_settings.short_session_penalty` Object Fields

| Parameter | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `false` | Enables short-session score deduction. |
| `minimum_session_minutes` | int/null | `null` | Minimum expected session duration. |
| `penalty_points` | float/null | `null` | Points deducted if session ends before minimum duration. |

#### Server-Managed Session Metadata Fields

Stored in `data/session_meta_<id>.json`:

- `started_at_utc`
- `timing_warning_sent`
- `conversation_closed`
- `evaluation_topics`
- `context_chunks` (derived from `conversation_context`, `ai_persona`, and `evaluation_topics`)
- `passing_marks`

## 4) Data Model

SQLAlchemy model (`Session`):

- `id` (int primary key)
- `author` (str)
- `context_id` (uuid string)
- `created_at` (datetime)
- `transcript` (JSON list of turns)
- `report` (JSON)

Session metadata JSON (`data/session_meta_<id>.json`) includes persona/scenario settings and timing state.

## 5) API Endpoints

### `POST /session/start`

Creates a new session, stores scenario metadata, and adds an opening AI turn.

Core fields:

- `author`
- `conversation_context`
- `ai_persona`
- `evaluation_topics`

Additional settings fields:

- `additional_settings.roleplay_end`
- `additional_settings.simulation_time_limit`
- `additional_settings.short_session_penalty`

TTS fields:

- `tts_enabled` (bool, default `false`)
- `tts_lang` (string, default `en`)

Response:

- `session_id`
- `opening_message` (deterministic template opener from `ai_persona.name/organization/role`)
- `opening_tts_url` (nullable, when TTS enabled)
- `passing_marks`

### `POST /session/message`

Processes a learner message and returns AI response + checks + report.

Flow:

1. Load session + metadata
2. Moderate input
3. Retrieve relevant sources from session-derived `context_chunks`
4. Build system prompt with persona + guardrails + sources
5. Generate response
6. Persona guard check (regex violations)
7. Optional POV rewrite (only when violation patterns like "the manager" detected)
8. State consistency check (constraint-aware; rewrite once on conflict, fallback if still conflicting)
9. Grounding check:
   - evaluate full response against retrieved sources
10. Apply fallback response if unsupported
11. Apply timing warning behavior and optional roleplay-end rules
12. Append transcript + compute report
13. Optionally synthesize TTS and return audio URL

Response includes:

- `reply`
- `grounded`
- `checks`
- `report`
- `originalReply`
- `tts_audio_url` (nullable, when TTS enabled)

### `POST /session/end?session_id=<id>`

Computes final score and returns final report.

Response includes:

- `session_id`
- `final_score`
- `passing_marks`
- `passed` (`true` if `final_score >= passing_marks`)
- `report` (also includes `passing_marks` and `passed`)

## 6) Prompting and Role Control

Prompt construction (`app/prompt_manager.py`):

- Persona + evaluation-topic-derived training areas are injected into system prompt
- Retrieved source chunks are provided as evidence
- Guardrail instructions are included per session
- Unsupported-answer fallback instruction is always included

Role controls:

- Regex-based role violation detection
- Optional LLM rewrite to direct conversational POV
- Declarative guardrails per session to support many roleplay scenarios
- Opening-message generation is deterministic and template-based, using only `ai_persona.name`, `ai_persona.organization`, and `ai_persona.role`

## 7) Grounding Logic

Grounding engine (`app/hallucination.py`):

- Sentence embedding similarity
- Fact overlap gate (lexical/numeric overlap) to reduce spurious matches
- Low-information suppression

Mode (`app/main.py`):

- `overall` only:
  - single holistic support check on full response
  - uses internal threshold default (`0.2`)

## 8) Scoring and Reporting

Weighted topic scoring (`app/scoring.py`):

- Embeds cumulative learner text + sentence splits
- For each topic criterion, takes best semantic similarity vs learner text
- Criterion contribution = `best_similarity * criterion_weight`
- `criterion_weight = (normalized_topic_weight_points) / criteria_in_topic`
- Topic contribution is the sum of its criterion contributions
- Final score is the sum of all weighted criterion contributions (0-100)
- Topic pass ratio = average best similarity of topic criteria
- If `make_or_break=true` and pass ratio < `make_or_break_threshold` (default `0.2`), final score is forced to `0`

Short-session penalty:

- If `additional_settings.short_session_penalty.enabled=true` and elapsed minutes < `minimum_session_minutes`, subtract `penalty_points` from score (floor at 0)

Notes:

- `adherence_pct`, `profanity`, `persona_ok` remain in report for analytics
- Final learner score is computed only from weighted evaluation topics (+ optional short-session penalty)

## 9) Timing Behavior

Enabled only if:

- `additional_settings.simulation_time_limit.enabled = true`
- `additional_settings.simulation_time_limit.duration_minutes` set

Behavior:

- When remaining time <= warning window and warning not yet sent:
  - append warning sentence once
- Time limit does not auto-close the conversation
- Auto-close is driven only by `additional_settings.roleplay_end` (`allow_ai_to_end_roleplay=true` + `end_condition` similarity match)

## 10) Known Current Constraints

- Session metadata is stored in JSON files, not normalized DB tables
- Grounding quality depends on context quality and similarity thresholds
- Optional POV rewrite adds one extra model call when triggered
- TTS uses gTTS (network-dependent); synthesis can fail in restricted/offline environments

## 11) Documentation Maintenance Policy

This file must be updated with every feature change affecting:

- API schema
- runtime env/config
- prompting/guardrails
- grounding/scoring logic
- timing/session state behavior
- storage/data model

Required update checklist for each feature PR/patch:

1. Update relevant section(s) above
2. Add an entry in the changelog below
3. Update `Last updated` date at top

## 12) Changelog

- 2026-03-11:
  - Cleanup: removed unused state-machine runtime paths and related session-meta fields from active code path
  - Kept backward compatibility for legacy session-start fields (`title`, `ai_persona.persona_opener`, `end_conversation_guidelines.when_to_end`) as accepted-but-ignored
  - Replaced LLM-generated opener with deterministic template opener from only `ai_persona.name/organization/role`
  - Added roleplay-end diagnostics in `/session/message.checks` (`reason`, `similarity`, `threshold`) when auto-ended by end condition similarity
  - Roleplay end-condition matching now evaluates similarity against cumulative learner transcript (all learner turns so far + current message), not just the latest message
  - Auto-close is now driven only by roleplay end-condition match (removed learner-goodbye/time-expiry auto-close paths)
  - Short-session penalty is skipped when conversation auto-ends by roleplay end-condition match
  - Reintroduced make-or-break hard fail with per-topic `make_or_break_threshold` (default `0.2`)
  - Switched evaluation scoring to continuous weighted scoring (`similarity * criterion_weight`) and removed threshold-based criterion blocking
  - Removed `additional_settings.scoring` from API schema and runtime metadata
  - `/session/start` is now structured-only; legacy payload fields (`persona`, `areas`, `required_pitch_points`, direct `context_chunks`) were removed from the API contract
  - Structured scenario payload mapping is now the only supported path (`conversation_context`, `ai_persona`, `evaluation_topics`)
  - Enforced structured validation: `conversation_context` required, `evaluation_topics` required, and each topic must include at least one non-empty success criterion
  - Enabled strict schema validation (`extra="forbid"`) so legacy/unknown payload fields are rejected
  - Removed legacy global-context fallback path in `/session/message`; retrieval now requires session-derived scenario chunks
  - Removed unused FAISS/global-index retrieval path and `faiss-cpu` runtime dependency
  - Replaced pitch-point scoring with weighted evaluation-topic scoring (`evaluation_guidelines`, `success_criteria`, `weight`, `make_or_break`, resources)
  - Added `additional_settings` modeling for roleplay-end behavior, simulation time limits, and short-session penalty
  - Removed session-start customization knobs for guardrails, grounding thresholds, and state-machine rules; these now run with internal defaults only
- 2026-03-10:
  - Added full configurable-parameters reference section to this document
  - Added declarative scenario state machine controls (`state_schema`, `initial_state`, `state_update_rules`, `state_constraints`, `state_conflict_response`)
- 2026-03-09:
  - Added declarative scenario configuration at `/session/start`
  - Added session-local `context_chunks` retrieval path
  - Added `grounding_mode` (`balanced_per_claim` and `overall`)
  - Added overall grounding threshold control
  - Added LLM-generated opening message
  - Added optional conversational POV rewrite with conditional trigger
  - Added authority-only conversation timing controls (warning + end-of-time behavior)
  - Updated scoring to exclude adherence from final score
  - Added optional TTS generation (`tts_enabled`, `tts_lang`) with `opening_tts_url` and `tts_audio_url`
