# app/main.py
import json
import os
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Annotated

import tempfile

import numpy as np
import asyncio
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from app.embedder import Embedder

from app.db import init_db, SessionLocal, Session, ScenarioStore
from app.hallucination import HallucinationChecker
from app.model_adapter import ModelAdapter
from app.moderation import check_input
from app.prompt_manager import PromptManager
from app.scoring import Scorer
from app.evaluator import SessionEvaluator

# ---------------------------------------------------------------------------
# Shared embedder — single instance, injected into all components.
# ---------------------------------------------------------------------------
_shared_embedder = Embedder()

# init DB + components
init_db()
pm = PromptManager(embedder=_shared_embedder)
model = ModelAdapter()
nli = HallucinationChecker(embedder=_shared_embedder)
scorer = Scorer(embedder=_shared_embedder)
evaluator = SessionEvaluator(model=model)

app = FastAPI(title="AI-COACH MVP")
TTS_DIR = "./data/tts"
os.makedirs(TTS_DIR, exist_ok=True)
app.mount("/audio", StaticFiles(directory=TTS_DIR), name="audio")

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "").strip()

# Whisper STT — loaded once at startup in a background thread so the first
# /transcribe request doesn't pay the download/load penalty.
_whisper_model = None
_whisper_lock = threading.Lock()

def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel
                _whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
    return _whisper_model

def _warmup_whisper():
    try:
        _get_whisper_model()
        print("[Whisper] model ready")
    except Exception as e:
        print(f"[Whisper] warmup failed: {e}")

threading.Thread(target=_warmup_whisper, daemon=True).start()

# ---------------------------------------------------------------------------
# Per-session chunk embedding cache.
# Fixes: chunk embeddings re-computed on every /session/message call.
# chunks are static per session — encode once, reuse forever.
# ---------------------------------------------------------------------------
_chunk_emb_cache: dict = {}  # session_id -> {"texts": list[str], "embeddings": np.ndarray}

# ---------------------------------------------------------------------------
# Per-session locks — prevent race condition on conversation_closed flag.
# ---------------------------------------------------------------------------
_session_locks: dict = {}
_session_locks_mutex = threading.Lock()


def _get_session_lock(session_id: int) -> threading.Lock:
    with _session_locks_mutex:
        if session_id not in _session_locks:
            _session_locks[session_id] = threading.Lock()
        return _session_locks[session_id]


def _release_session_lock(session_id: int) -> None:
    with _session_locks_mutex:
        _session_locks.pop(session_id, None)


# ---------------------------------------------------------------------------
# Per-session background timers — hard stop when time limit expires.
# ---------------------------------------------------------------------------
_session_timers: dict[int, threading.Timer] = {}
_session_timers_mutex = threading.Lock()


def _cancel_session_timer(session_id: int) -> None:
    with _session_timers_mutex:
        t = _session_timers.pop(session_id, None)
    if t:
        t.cancel()


def _cleanup_session_resources(session_id: int, cancel_timer: bool = False) -> None:
    if cancel_timer:
        _cancel_session_timer(session_id)
    _chunk_emb_cache.pop(session_id, None)
    _cleanup_tts_files(session_id)


def _on_session_time_expired(session_id: int) -> None:
    """Background timer callback — closes the session silently and marks it time_expired."""
    lock = _get_session_lock(session_id)
    with lock:
        db = SessionLocal()
        try:
            s = db.get(Session, session_id)
            if not s:
                return
            meta = _load_session_meta(session_id)
            if bool(meta.get("conversation_closed", False)):
                return  # already closed by another path

            passing_marks_val = float(meta.get("passing_marks", 70.0))
            report = _build_evaluation_report(
                meta, s.transcript,
                profanity_flag=False,
                skip_short_session_penalty=True,
                session_id=session_id,
            )
            report["final_score"] = float(report.get("evaluation_score", 0.0))
            report["passing_marks"] = passing_marks_val
            report["passed"] = report["final_score"] >= passing_marks_val
            report["time_expired"] = True

            s.report = report
            db.add(s)
            db.commit()

            meta["conversation_closed"] = True
            _save_session_meta(session_id, meta)
            _cleanup_session_resources(session_id)
        except Exception:
            pass
        finally:
            db.close()

    with _session_timers_mutex:
        _session_timers.pop(session_id, None)
    _release_session_lock(session_id)


def _start_session_timer(session_id: int, duration_seconds: float) -> None:
    _cancel_session_timer(session_id)  # clear any existing timer
    t = threading.Timer(duration_seconds, _on_session_time_expired, args=(session_id,))
    t.daemon = True
    t.start()
    with _session_timers_mutex:
        _session_timers[session_id] = t


STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "does", "for",
    "from", "has", "have", "how", "if", "in", "include", "is", "it", "its", "of",
    "on", "or", "our", "that", "the", "their", "there", "this", "to", "was", "we",
    "what", "when", "where", "which", "who", "why", "with", "you", "your"
}

DEFAULT_ROLE_VIOLATION_PATTERNS = [
    r"\bas an ai\b",
    r"\bi am an ai\b",
    r"\bi can help you choose\b",
    r"\bi am just an assistant\b",
]

DEFAULT_GUARDRAIL_FALLBACK_RESPONSE = (
    "Staying in role, I need concrete details and evidence from the provided sources before proceeding."
)
UNSUPPORTED_FALLBACK_TEXT = "I don't know beyond the provided materials."
DEFAULT_OVERALL_GROUNDING_THRESHOLD = 0.2
DEFAULT_TIME_WARNING_MINUTES = 5

DEFAULT_ROLEPLAY_END_MESSAGE = "Thank you for the discussion. I appreciate your time. Goodbye."
HISTORY_MAX_TURNS = 0  # 0 means full transcript (no truncation)
REPEATED_OPENER_SIM_THRESHOLD = 0.9
REPEATED_REPLY_SIM_THRESHOLD = 0.76
REPEAT_LOOKBACK_AI_TURNS = 4

NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


def _normalize_embeddings(arr: np.ndarray) -> np.ndarray:
    return arr / (np.linalg.norm(arr, axis=1, keepdims=True) + 1e-10)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_utc(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _save_session_meta(session_id: int, meta: dict) -> None:
    with open(f"./data/session_meta_{session_id}.json", "w", encoding="utf8") as f:
        json.dump(meta, f)


def _load_session_meta(session_id: int) -> dict:
    # Fix: use context manager to ensure file handle is always closed.
    with open(f"./data/session_meta_{session_id}.json", "r", encoding="utf8") as f:
        return json.load(f)


def _append_transcript_turns(session_obj: Session, turns: list[dict]) -> None:
    # Reassign JSON field to ensure SQLAlchemy persists list changes.
    transcript = list(session_obj.transcript or [])
    transcript.extend(turns)
    session_obj.transcript = transcript


_TTS_MAX_SENTENCES = 20  # synthesize up to N sentences per reply


def _truncate_for_tts(text: str) -> str:
    """Return the first _TTS_MAX_SENTENCES sentences of text for faster synthesis."""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return " ".join(parts[:_TTS_MAX_SENTENCES]) if parts else text


ALICE_VOICE = "af_bella"


def _synthesize_tts(reply_text: str, session_id: int = 0, voice: str | None = None) -> str | None:
    """
    Synthesizes TTS in-memory and returns a base64-encoded audio data URI.
    Format: 'wav:<b64>' for Kokoro, 'mp3:<b64>' for OpenAI TTS.
    Returns None on failure.
    """
    import io, base64
    from app.model_adapter import TTS_LOCAL_VOICE, TTS_MODEL, TTS_VOICE
    text = _truncate_for_tts((reply_text or "").strip())
    if not text:
        return None
    try:
        if model._kokoro is not None:
            import soundfile as sf
            chunks = [audio for _, _, audio in model._kokoro(text, voice=voice or TTS_LOCAL_VOICE, speed=1.0)]
            buf = io.BytesIO()
            sf.write(buf, np.concatenate(chunks), 24000, format='WAV')
            b64 = base64.b64encode(buf.getvalue()).decode('ascii')
            return f"wav:{b64}"
        else:
            response = model.openai_client.audio.speech.create(
                model=TTS_MODEL,
                voice=voice or TTS_VOICE,
                input=text,
                response_format="mp3",
            )
            buf = io.BytesIO()
            for chunk in response.iter_bytes():
                buf.write(chunk)
            b64 = base64.b64encode(buf.getvalue()).decode('ascii')
            return f"mp3:{b64}"
    except Exception as exc:
        print(f"[TTS] synthesis failed: {exc}")
        return None


def _cleanup_tts_files(session_id: int) -> None:
    """No-op — TTS is now in-memory (base64), no files written."""
    pass



def _timing_state(meta: dict) -> dict:
    if not bool(meta.get("time_limit_enabled", False)):
        return {"enabled": False}
    duration_mins = meta.get("conversation_duration_minutes")
    if not duration_mins:
        return {"enabled": False}
    started_at = meta.get("started_at_utc")
    if not started_at:
        return {"enabled": False}

    start_dt = _parse_iso_utc(started_at)
    elapsed = (datetime.now(timezone.utc) - start_dt).total_seconds() / 60.0
    remaining = float(duration_mins) - elapsed
    return {
        "enabled": True,
        "remaining_minutes": remaining,
    }


def _elapsed_minutes(meta: dict) -> float:
    started_at = meta.get("started_at_utc")
    if not started_at:
        return 0.0
    start_dt = _parse_iso_utc(started_at)
    return max(0.0, (datetime.now(timezone.utc) - start_dt).total_seconds() / 60.0)


def _similarity(a: str, b: str) -> float:
    if not (a and b):
        return 0.0
    vecs = _shared_embedder.encode([a, b], convert_to_numpy=True, show_progress_bar=False)
    vecs = _normalize_embeddings(vecs)
    return float(vecs[0] @ vecs[1])


_RELEVANCE_THRESHOLD = 0.30   # meaningful similarity required
_MIN_WORDS_FOR_RELEVANCE = 25  # skip check for short acks, closers, one-liners
_COHERENCE_RATIO = 0.4         # unique words / total words — below this = keyword spam

def _check_learner_relevance(text: str, context_chunks: list[dict], last_ai_turn: str = "") -> dict:
    """
    Returns {"relevant": True} if the learner's message is on-topic,
    or {"relevant": False, "nudge": "..."} if it's off-topic.

    Compares against scenario context AND the AI's last message.
    A direct response to the AI's question is always on-topic even if
    the domain vocabulary doesn't appear in the scenario metadata.
    Short acknowledgements are always allowed (< _MIN_WORDS_FOR_RELEVANCE words).
    Also detects keyword stuffing via unique-word ratio.
    """
    words = text.strip().split()
    if len(words) < _MIN_WORDS_FOR_RELEVANCE:
        return {"relevant": True}

    # Keyword stuffing detection — repeated words with no real sentence structure
    unique_ratio = len(set(w.lower() for w in words)) / len(words)
    if unique_ratio < _COHERENCE_RATIO:
        return {
            "relevant": False,
            "nudge": "Please respond with a clear, complete sentence rather than a list of keywords.",
        }

    if not context_chunks and not last_ai_turn:
        return {"relevant": True}

    # Relevant if similar to scenario context OR the AI's last message
    if context_chunks:
        context = " ".join(c.get("text", "") for c in context_chunks)
        if _similarity(text, context) >= _RELEVANCE_THRESHOLD:
            return {"relevant": True}

    if last_ai_turn and _similarity(text, last_ai_turn) >= _RELEVANCE_THRESHOLD:
        return {"relevant": True}

    return {
        "relevant": False,
        "nudge": (
            "That doesn't seem related to the current scenario. "
            "Try to stay in context — focus on the conversation at hand."
        ),
    }



def _build_evaluation_report(
    meta: dict,
    transcript: list[dict],
    profanity_flag: bool,
    skip_short_session_penalty: bool = False,
    session_id: int = None,
):
    # Pass learner turns individually so the scorer evaluates each turn as a
    # separate unit. This prevents later turns from being silently dropped when
    # the concatenated transcript exceeds the sentence-unit cap.
    learner_turns = [t["text"] for t in transcript if t.get("speaker") != "AI" and t.get("text")]
    evaluation = scorer.evaluate_weighted_topics_llm(
        learner_turns,
        meta.get("evaluation_topics", []),
        model,
    )
    base_score = float(evaluation["score"])
    elapsed = _elapsed_minutes(meta)
    adjusted_score, short_penalty_applied, penalty_points = scorer.apply_short_session_penalty(
        base_score,
        elapsed,
        bool(meta.get("short_session_penalty_enabled", False)) and (not skip_short_session_penalty),
        meta.get("short_session_minimum_minutes"),
        meta.get("short_session_penalty_points"),
    )
    passing_marks = float(meta.get("passing_marks", 70.0))

    ai_turns = [t for t in transcript if t.get("speaker") == "AI" and not t.get("opening")]
    grounded_turns = [t for t in ai_turns if t.get("grounded")]
    adherence_pct = len(grounded_turns) / max(1, len(ai_turns))

    # Fix: persona_ok tracks ALL turns, not just the most recent one.
    persona_ok = not any(t.get("persona_violation") for t in transcript if t.get("speaker") == "AI")

    session_explanation = evaluator.explain_session(evaluation["topic_breakdown"])

    # Aggregate per-turn speech stats (voice sessions only — text sessions have none)
    _stat_entries = [
        t["speech_stats"] for t in transcript
        if t.get("speaker") != "AI" and isinstance(t.get("speech_stats"), dict)
    ]
    if _stat_entries:
        _total_fillers = sum(e.get("filler_count", 0) for e in _stat_entries)
        _filler_breakdown: dict[str, int] = {}
        for e in _stat_entries:
            for word, count in e.get("filler_words", {}).items():
                _filler_breakdown[word] = _filler_breakdown.get(word, 0) + count
        _pace_pairs = [
            (e["pace_wpm"], e["word_count"])
            for e in _stat_entries
            if e.get("pace_wpm") and e.get("word_count")
        ]
        _total_words = sum(e.get("word_count", 0) for e in _stat_entries)
        if _pace_pairs:
            _weighted_words = sum(wc for _, wc in _pace_pairs)
            _avg_pace = round(sum(p * wc for p, wc in _pace_pairs) / _weighted_words) if _weighted_words else None
        else:
            _avg_pace = None
        speech_stats = {
            "total_fillers": _total_fillers,
            "filler_breakdown": _filler_breakdown,
            "avg_pace_wpm": _avg_pace,
            "total_words": _total_words,
            "turns_analysed": len(_stat_entries),
        }
    else:
        speech_stats = None

    return {
        "adherence_pct": adherence_pct,
        "profanity": bool(profanity_flag),
        "persona_ok": bool(persona_ok),
        "state_conflict": False,
        "current_state": {},
        "evaluation_score": float(adjusted_score),
        "base_evaluation_score": float(base_score),
        "topic_breakdown": evaluation["topic_breakdown"],
        "make_or_break_failed": bool(evaluation["make_or_break_failed"]),
        "criteria_covered": float(evaluation["criteria_covered"]),
        "criteria_total": int(evaluation["criteria_total"]),
        "weights_total": float(evaluation["weights_total"]),
        "short_session_penalty_applied": bool(short_penalty_applied),
        "short_session_penalty_points": float(penalty_points if short_penalty_applied else 0.0),
        "elapsed_minutes": float(elapsed),
        "passing_marks": passing_marks,
        "passed": float(adjusted_score) >= passing_marks,
        "running_score": float(adjusted_score),
        "learner_turns": learner_turns,
        "session_explanation": session_explanation,
        "speech_stats": speech_stats,
    }




def _retrieve_from_chunks(query: str, chunks: list[dict], session_id: int, k: int = 3) -> list[dict]:
    """
    Retrieve top-k chunks by semantic similarity.
    Fix: chunk embeddings are cached per session_id — encoded only on first call.
    """
    if not chunks:
        return []
    texts = [c.get("text", "") for c in chunks]

    cached = _chunk_emb_cache.get(session_id)
    if cached is not None and cached["texts"] == texts:
        c_embs = cached["embeddings"]
    else:
        c_embs = _shared_embedder.encode(texts, convert_to_numpy=True, show_progress_bar=False)
        c_embs = _normalize_embeddings(c_embs)
        _chunk_emb_cache[session_id] = {"texts": texts, "embeddings": c_embs}

    q_emb = _shared_embedder.encode([query], is_query=True)
    q_emb = _normalize_embeddings(q_emb)
    sims = (q_emb @ c_embs.T)[0]
    top_idx = np.argsort(-sims)[: min(k, len(chunks))]
    return [chunks[int(i)] for i in top_idx]


def _is_persona_response(reply: str, violation_patterns: list[str]) -> bool:
    text = (reply or "").lower()
    for pat in violation_patterns:
        if re.search(pat, text):
            return False
    return True


_FALLBACK_PREFIX_RE = re.compile(
    r"^I don't know beyond the provided materials[.,;]?\s*",
    re.IGNORECASE,
)


def _strip_fallback_prefix_if_supported(reply: str) -> str:
    text = (reply or "").strip()
    if not text:
        return text
    m = _FALLBACK_PREFIX_RE.match(text)
    if not m:
        return text
    rest = text[m.end():].strip()
    return rest if rest else text


def _extract_reply(text: str) -> str:
    """
    Extract the in-character reply from the model's output.

    Primary path: pull content from <reply>...</reply> tags.
    Anything the model wrote outside the tags (meta-commentary, internal notes,
    stage directions, etc.) is automatically discarded — no pattern matching needed.

    Fallback: if the model forgot the tags, use the full text.

    Either way, apply only content-agnostic structural cleanup:
      - strip trailing --- separators
      - remove intra-reply duplicate paragraphs (Ollama loop artifact)
    """
    t = (text or "").strip()
    if not t:
        return t

    # ── Primary: extract from <reply> tag ────────────────────────────────────
    # Handle variants: <reply>, <reply:reply>, <reply type="...">, etc.
    m = re.search(r"<reply[^>]*>(.*?)</reply>", t, re.DOTALL | re.IGNORECASE)
    if m:
        t = m.group(1).strip()
    # else: fallback — use full text as-is (structural cleanup still applies)

    # Strip any orphan opening or closing reply tags the model appended.
    t = re.sub(r"</?reply[^>]*>", "", t, flags=re.IGNORECASE).strip()

    # Strip parenthetical-only lines (structural, locale-safe).
    # Lines that are nothing but (...) are almost never in-character dialogue.
    t = re.sub(r"^\s*\([^)]*\)\s*$", "", t, flags=re.MULTILINE).strip()

    # ── Structural cleanup (content-agnostic) ────────────────────────────────
    # Strip trailing "---" separators the model sometimes appends.
    t = re.sub(r"\n\s*-{3,}\s*$", "", t).strip()

    # Intra-reply deduplication: drop repeated paragraphs within a single
    # generation (Ollama looping at high context lengths).
    paragraphs = re.split(r"\n{2,}", t)
    seen_paras: list[str] = []
    for para in paragraphs:
        norm = re.sub(r"\s+", " ", para.strip().lower())
        if not norm:
            continue
        if any(
            norm == re.sub(r"\s+", " ", s.strip().lower())
            or (len(norm) > 60 and norm[:60] == re.sub(r"\s+", " ", s.strip().lower())[:60])
            for s in seen_paras
        ):
            continue
        seen_paras.append(para)
    t = "\n\n".join(seen_paras).strip()

    return t


# Keep old name as alias so call sites don't need updating.
_sanitize_model_reply = _extract_reply


def _suppress_raised_concerns(guardrail_instructions: str, transcript: list, lookback: int = 6) -> str:
    """
    For each concern in the guardrail instructions, check whether:
      1. The AI persona has already raised it (it appears in any AI turn), AND
      2. The learner has replied at least once after that AI turn.
    If both are true, append an explicit suppression instruction so the LLM
    does not loop on the same objection.
    """
    if not transcript:
        return guardrail_instructions

    # Build ordered list of (speaker, text) for the recent window.
    recent = [(t.get("speaker", ""), t.get("text", "")) for t in transcript[-(lookback * 2):]]

    # All AI turns and all learner turns (anything not AI).
    ai_texts = " ".join(txt for spk, txt in recent if spk == "AI").lower()

    # Only suppress if the learner has actually said something after the concern was raised.
    # Proxy: there is at least one learner turn in the window.
    learner_has_replied = any(spk != "AI" for spk, _ in recent)
    if not learner_has_replied:
        return guardrail_instructions

    already_raised = []
    for line in guardrail_instructions.splitlines():
        m = re.search(r"raise concern about:\s*([^.]+)", line, re.IGNORECASE)
        if not m:
            continue
        concern_name = m.group(1).strip()
        # Check if any meaningful word from the concern name appears in recent AI text.
        key_words = [w for w in concern_name.lower().split() if len(w) > 3]
        if key_words and any(w in ai_texts for w in key_words):
            already_raised.append(concern_name)

    if already_raised:
        return guardrail_instructions + (
            "\nThe following concerns have already been raised in this conversation — "
            "do NOT repeat them. Acknowledge any new response and move forward: "
            + "; ".join(already_raised) + "."
        )
    return guardrail_instructions


_FILLER_WORDS = {
    "um", "uh", "umm", "uhh", "hmm", "like", "basically",
    "literally", "actually", "right", "okay", "so",
}


def _compute_speech_stats(words: list[dict]) -> dict:
    """
    Compute filler-word counts and speaking pace from Deepgram word objects.
    Each word is {"word": str, "start": float, "end": float}.
    Returns a dict safe to store in the transcript and aggregate in the report.
    """
    if not words:
        return {
            "filler_count": 0, "filler_words": {},
            "pace_wpm": None, "word_count": 0, "duration_s": 0.0,
        }
    filler_counts: dict[str, int] = {}
    for w in words:
        token = w.get("word", "").lower().strip(".,!?;:")
        if token in _FILLER_WORDS:
            filler_counts[token] = filler_counts.get(token, 0) + 1
    duration_s = round(float(words[-1]["end"]) - float(words[0]["start"]), 2)
    word_count = len(words)
    pace_wpm = round((word_count / duration_s) * 60) if duration_s >= 1.0 else None
    return {
        "filler_count": sum(filler_counts.values()),
        "filler_words": filler_counts,
        "pace_wpm": pace_wpm,
        "word_count": word_count,
        "duration_s": duration_s,
    }


def _detect_learner_style(learner_turns: list[str]) -> str:
    """
    Heuristic style detection — zero LLM calls.
    Analyses the first 4 learner turns and returns the counter-difficulty preset
    that will challenge them most.
    """
    if len(learner_turns) < 3:
        return "normal"
    sample = learner_turns[:4]
    avg_words = sum(len(t.split()) for t in sample) / len(sample)
    question_rate = sum(t.count("?") for t in sample) / len(sample)
    hedge_words = {"maybe", "perhaps", "i think", "i feel", "sort of", "kind of", "i'm not sure", "not sure"}
    hedge_rate = sum(1 for t in sample for w in hedge_words if w in t.lower()) / len(sample)
    if avg_words > 40:
        return "impatient"      # verbose learner — AI becomes impatient
    if question_rate > 1.5:
        return "evasive"        # question-heavy — AI deflects
    if hedge_rate > 0.6:
        return "skeptical"      # hedging — AI challenges confidence
    return "normal"


def _resolve_difficulty(mode: str, learner_turns: list[str], model_adapter) -> str:
    """
    Resolve the effective difficulty preset.
    - Preset modes are returned immediately (zero extra cost).
    - "auto" runs heuristic; falls back to a single max_tokens=5 LLM call only
      when heuristic is inconclusive. Result should be cached in session_meta.
    """
    if mode in ("off", ""):
        return "off"
    if mode in ("impatient", "skeptical", "evasive", "hostile"):
        return mode
    if mode == "auto":
        if len(learner_turns) < 3:
            return "off"
        heuristic = _detect_learner_style(learner_turns)
        if heuristic != "normal":
            return heuristic
        # One-shot LLM fallback — called at most once per session
        try:
            sample = "\n".join(f"Turn {i+1}: {t}" for i, t in enumerate(learner_turns[:4]))
            raw = model_adapter.judge(
                "Classify this learner's communication style as exactly ONE word: "
                "verbose, questioning, hedging, assertive, or balanced.",
                f"Learner turns:\n{sample}",
                max_tokens=5,
            )
            style = (raw or "").strip().lower().split()[0]
            return {
                "verbose": "impatient",
                "questioning": "evasive",
                "hedging": "skeptical",
                "assertive": "hostile",
            }.get(style, "off")
        except Exception:
            return "off"
    return "off"


def _split_first_sentence(text: str) -> tuple[str, str]:
    t = (text or "").strip()
    if not t:
        return "", ""
    parts = re.split(r"(?<=[.!?])\s+", t, maxsplit=1)
    first = parts[0].strip()
    rest = parts[1].strip() if len(parts) > 1 else ""
    return first, rest


def _build_recent_history(transcript: list[dict], user: str, user_text: str, max_turns: int = HISTORY_MAX_TURNS) -> str:
    # Keep full history by default to preserve conversational continuity.
    turns = transcript[-max_turns:] if (max_turns and max_turns > 0 and len(transcript) > max_turns) else transcript
    lines = [f"{t.get('speaker', 'User')}: {t.get('text', '')}" for t in turns if t.get("text")]
    lines.append(f"{user}: {user_text}")
    return "\n".join(lines) + "\n"


def _dedupe_repeated_opener(reply: str, transcript: list[dict]) -> str:
    text = (reply or "").strip()
    if not text:
        return text

    last_ai_text = ""
    for turn in reversed(transcript):
        if turn.get("speaker") == "AI" and turn.get("text") and not turn.get("opening"):
            last_ai_text = turn["text"]
            break
    if not last_ai_text:
        return text

    curr_first, curr_rest = _split_first_sentence(text)
    prev_first, _ = _split_first_sentence(last_ai_text)
    if not curr_first or not prev_first:
        return text

    curr_norm = re.sub(r"\W+", " ", curr_first.lower()).strip()
    prev_norm = re.sub(r"\W+", " ", prev_first.lower()).strip()
    if not curr_norm or not prev_norm:
        return text

    repeated = curr_norm == prev_norm
    if not repeated:
        curr_tokens = curr_norm.split()
        prev_tokens = prev_norm.split()
        if len(curr_tokens) >= 3 and len(prev_tokens) >= 3:
            repeated = _similarity(curr_norm, prev_norm) >= REPEATED_OPENER_SIM_THRESHOLD

    if repeated and curr_rest:
        return curr_rest
    return text


def _is_semantic_repeat(curr: str, prev: str, threshold: float = REPEATED_REPLY_SIM_THRESHOLD) -> bool:
    c = (curr or "").strip()
    p = (prev or "").strip()
    if not c or not p:
        return False
    return _similarity(c, p) >= threshold


def _recent_ai_replies(transcript: list[dict], limit: int = REPEAT_LOOKBACK_AI_TURNS) -> list[str]:
    replies: list[str] = []
    for turn in reversed(transcript):
        if turn.get("speaker") == "AI" and turn.get("text") and not turn.get("opening"):
            replies.append(str(turn["text"]).strip())
            if len(replies) >= limit:
                break
    return replies


def _is_semantic_repeat_any(curr: str, prev_replies: list[str], threshold: float = REPEATED_REPLY_SIM_THRESHOLD) -> bool:
    for prev in prev_replies:
        if _is_semantic_repeat(curr, prev, threshold=threshold):
            return True
    return False


def _enforce_conversational_pov(reply: str, persona_text: str) -> str:
    """
    Rewrite into direct first/second-person dialogue style without role labels.
    This is scenario-agnostic and avoids hardcoding role words (e.g., manager/employee).
    """
    if not (reply or "").strip():
        return reply
    system_prompt = (
        "SYSTEM: Rewrite the response while preserving meaning and tone.\n"
        "Constraints:\n"
        "- Use direct conversational POV with first/second-person terms (I, me, my, we, us, you, your).\n"
        "- Avoid third-person role labels/titles for the participants.\n"
        "- Keep it concise and natural.\n"
        "- Do not add or remove factual content.\n"
        "- Return only the rewritten response text.\n"
    )
    convo = (
        f"Persona context: {persona_text}\n\n"
        f"Original response:\n{reply}\n\n"
        "Rewritten response:"
    )
    try:
        rewritten = model.generate(system_prompt, convo, max_new_tokens=180, temperature=0.0)
        rewritten = rewritten.strip()
        if rewritten:
            return rewritten
    except Exception:
        pass
    return reply


def _needs_pov_rewrite(reply: str) -> bool:
    text = (reply or "").lower()
    if not text:
        return False
    # Fix: removed `\bthe user\b` — triggers on nearly every AI response ("the user needs...")
    # causing unnecessary extra LLM calls.
    third_person_role_patterns = [
        r"\bthe manager\b",
        r"\bthe employee\b",
        r"\bthe learner\b",
        r"\bthe trainee\b",
        r"\bthe candidate\b",
        r"\bthe interviewer\b",
        r"\bthe interviewee\b",
        r"\bthe customer\b",
        r"\bthe client\b",
        r"\bthe seller\b",
        r"\bthe buyer\b",
    ]
    return any(re.search(pat, text) for pat in third_person_role_patterns)


def _llm_opening_message(
    ai_persona: dict,
    conversation_context: str = "",
    use_llm: bool = False,
    learner_name: str = "",
) -> str:
    name = str(ai_persona.get("name", "")).strip()
    role = str(ai_persona.get("role", "")).strip()
    organization = str(ai_persona.get("organization") or "").strip()
    personality = str(ai_persona.get("personality") or "").strip()
    background = str(ai_persona.get("background_information") or "").strip()

    if use_llm:
        org_clause = f" at {organization}" if organization else ""
        learner_clause = f"The person you are speaking with is called {learner_name}. You may use their name in your opening if it fits naturally.\n" if learner_name else ""
        system = (
            f"You are {name}, {role}{org_clause}.\n"
            + (f"Personality: {personality}\n" if personality else "")
            + (f"Background: {background}\n" if background else "")
            + (f"Context: {conversation_context}\n" if conversation_context else "")
            + learner_clause
            + "\nA call is just starting. Write exactly one short sentence — your opening line after the greeting.\n"
            "Skip any self-introduction — that will be prepended separately.\n"
            "Speak as this person would naturally continue after saying their name.\n"
            "Examples by situation:\n"
            "  - Receiving a cold call: 'Yes? What is this regarding?'\n"
            "  - Starting an interview: 'Thanks for making the time — let's dive in.'\n"
            "  - Performance review: 'Glad we could finally sit down for this.'\n"
            "  - Busy executive: 'I've got about five minutes — make it count.'\n"
            "Write a fresh line suited to this specific context. Output only that one sentence."
        )
        try:
            result = model.generate(system, "", max_new_tokens=80, temperature=0.3)
            result = _sanitize_model_reply(result).strip()
            # Keep only the first two sentences
            sentences = re.split(r'(?<=[.!?])\s+', result)
            two = ' '.join(s.strip() for s in sentences[:2] if s.strip())
            if two:
                return two
        except Exception as e:
            pass

    # Static fallback — no self-intro, Alice already covered that
    return "Go ahead, I'm listening."


def _generate_briefing_message(ai_persona: dict, conversation_context: str = "") -> str:
    """
    Generate a short mediator briefing (2 sentences) describing who the learner
    will speak with and what their concern is. No eval criteria. No session advice.
    """
    name = str(ai_persona.get("name", "")).strip()
    role = str(ai_persona.get("role", "")).strip()
    organization = str(ai_persona.get("organization") or "").strip()
    personality = str(ai_persona.get("personality") or "").strip()
    background = str(ai_persona.get("background_information") or "").strip()

    system = (
        "You are Alice, a session coordinator. Write two short sentences to introduce an upcoming call:\n"
        "1. Name and role of the person the learner will speak with.\n"
        "2. The main topic or concern that person has — one specific point, plain language.\n"
        "Skip evaluation criteria, advice, and meta-commentary. Output only those two sentences.\n\n"
        f"Name: {name}\n"
        f"Role: {role}\n"
        + (f"Organization: {organization}\n" if organization else "")
        + (f"Personality: {personality}\n" if personality else "")
        + (f"Background: {background}\n" if background else "")
        + (f"Call context: {conversation_context[:400]}\n" if conversation_context else "")
    )
    try:
        result = model.generate(system, "", max_new_tokens=80, temperature=0.2)
        result = _sanitize_model_reply(result).strip()
        sentences = re.split(r'(?<=[.!?])\s+', result)
        two = ' '.join(s.strip() for s in sentences[:2] if s.strip())
        if two:
            return two
    except Exception:
        pass

    # Static fallback
    role_str = f", {role}" if role else ""
    org_str = f" at {organization}" if organization else ""
    ctx_short = conversation_context[:120].rstrip('.') if conversation_context else ""
    if ctx_short:
        return f"You'll be speaking with {name}{role_str}{org_str}. {ctx_short}."
    return f"You'll be speaking with {name}{role_str}{org_str}."



def _text_mode_intro(ai_persona: dict, opening_message: str) -> str:
    name = str(ai_persona.get("name", "")).strip() or "your coach"
    role = str(ai_persona.get("role", "")).strip()
    organization = str(ai_persona.get("organization") or "").strip()

    intro = f"Hi, I'm {name}"
    if role:
        intro += f", {role}"
        if organization:
            intro += f" at {organization}"
    intro += "."

    opening = (opening_message or "").strip()
    if not opening:
        return intro

    opening_lower = opening.lower()
    if name.lower() in opening_lower and ("i'm" in opening_lower or "i am" in opening_lower):
        return opening
    return f"{intro} {opening}"


class ConcernItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    concern: NonEmptyStr
    when_it_comes_up: str | None = None
    how_persona_frames_it: str | None = None
    good_enough_to_proceed_when: str | None = None


class EndConversationGuidelines(BaseModel):
    model_config = ConfigDict(extra="forbid")
    when_to_end: str | None = None
    what_to_say: str | None = None


class AIPersonaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: NonEmptyStr
    organization: str | None = None
    role: NonEmptyStr
    voice: str | None = None
    personality: str | None = None
    background_information: NonEmptyStr
    concerns: list[ConcernItem] = Field(default_factory=list)
    persona_opener: str | None = None
    end_conversation_guidelines: EndConversationGuidelines | None = None


class ResourceItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = None
    url: NonEmptyStr


class EvaluationTopicPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: NonEmptyStr
    evaluation_guidelines: NonEmptyStr
    success_criteria: list[NonEmptyStr] = Field(default_factory=list)
    weight: float = Field(gt=0, le=100)
    example_videos: list[ResourceItem] = Field(default_factory=list)
    helpful_links: list[ResourceItem] = Field(default_factory=list)
    make_or_break: bool = False
    make_or_break_threshold: float = Field(default=0.2, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def fill_success_criteria_from_guidelines(self):
        if self.success_criteria:
            return self
        lines = []
        for raw in self.evaluation_guidelines.splitlines():
            line = raw.strip()
            if not line:
                continue
            line = line.lstrip("-").lstrip("•").strip()
            if line:
                lines.append(line)
        filtered = [l for l in lines if "trainee needs to" not in l.lower()]
        self.success_criteria = filtered
        if not self.success_criteria:
            raise ValueError("Provide success_criteria or bullet points in evaluation_guidelines.")
        return self


class RoleplayEndSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allow_ai_to_end_roleplay: bool = False
    end_condition: str | None = None
    goodbye_message: str | None = None

    @model_validator(mode="after")
    def validate_condition(self):
        if self.allow_ai_to_end_roleplay and not (self.end_condition and self.end_condition.strip()):
            raise ValueError("end_condition is required when allow_ai_to_end_roleplay is true.")
        return self


class SimulationTimeLimitSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    duration_minutes: int | None = Field(default=None, ge=1, le=59)
    warning_minutes: int = Field(default=5, ge=0, le=58)

    @model_validator(mode="after")
    def validate_time_limit(self):
        if self.enabled and self.duration_minutes is None:
            raise ValueError("duration_minutes is required when simulation_time_limit.enabled is true.")
        if self.enabled and self.duration_minutes is not None and self.warning_minutes >= self.duration_minutes:
            raise ValueError("warning_minutes must be less than duration_minutes.")
        return self


class ShortSessionPenaltySettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    minimum_session_minutes: int | None = Field(default=None, ge=1, le=59)
    penalty_points: float | None = Field(default=None, ge=1, le=100)

    @model_validator(mode="after")
    def validate_short_penalty(self):
        if self.enabled and (self.minimum_session_minutes is None or self.penalty_points is None):
            raise ValueError(
                "minimum_session_minutes and penalty_points are required when short_session_penalty.enabled is true."
            )
        return self


_VALID_DIFFICULTY_MODES = {"off", "impatient", "skeptical", "evasive", "hostile", "auto"}


class AdditionalSettingsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    roleplay_end: RoleplayEndSettings = Field(default_factory=RoleplayEndSettings)
    simulation_time_limit: SimulationTimeLimitSettings = Field(default_factory=SimulationTimeLimitSettings)
    short_session_penalty: ShortSessionPenaltySettings = Field(default_factory=ShortSessionPenaltySettings)
    difficulty_mode: str = Field(default="off")

    @model_validator(mode="after")
    def validate_difficulty(self):
        if self.difficulty_mode not in _VALID_DIFFICULTY_MODES:
            raise ValueError(f"difficulty_mode must be one of {_VALID_DIFFICULTY_MODES}")
        return self


def _build_runtime_from_structured_payload(payload: "CreateSession") -> dict:
    p = payload.ai_persona
    topic_names = [t.topic for t in payload.evaluation_topics]
    areas = ", ".join(topic_names) if topic_names else "roleplay conversation"

    persona_parts = [f"{p.name}, {p.role}."]
    if p.organization:
        persona_parts.append(f"Organization: {p.organization}.")
    if p.personality:
        persona_parts.append(f"Personality: {p.personality}.")
    persona_parts.append(p.background_information.strip())
    persona = " ".join(persona_parts).strip()

    guardrail_instructions = (
        f"You are {p.name}, {p.role}.\n"
        f"Conversation context: {payload.conversation_context}\n"
        f"Personality style: {p.personality or 'neutral and realistic'}.\n"
        "Respond naturally as this person. Avoid generic, assistant-style answers.\n"
        "Your role in this conversation is set by the context above:\n"
        "- If you are conducting or leading the session, drive the conversation. "
        "Present the topic or challenge yourself — do not ask the other person to define it.\n"
        "- If you are responding to the other person (e.g. being pitched to, interviewed, or supported), "
        "listen and react to what they say.\n"
        "Maintain your role consistently throughout."
    )

    chunks = [
        {"id": "conversation_context", "text": payload.conversation_context},
        {"id": "persona_background", "text": p.background_information},
    ]

    # Concerns are behavioural instructions, not source facts — inject into
    # guardrail_instructions so the LLM follows them without quoting them verbatim.
    if p.concerns:
        concern_lines = []
        for c in p.concerns:
            line = f"- When {c.when_it_comes_up or 'relevant'}, raise concern about: {c.concern}."
            if c.how_persona_frames_it:
                line += f" Express it naturally in your own words (e.g. the concern is about: {c.how_persona_frames_it})."
            if c.good_enough_to_proceed_when:
                line += f" Drop this concern once: {c.good_enough_to_proceed_when}."
            concern_lines.append(line)
        guardrail_instructions += (
            "\nTopics to bring up naturally during the conversation"
            " (express in your own words, do not quote verbatim):\n"
            + "\n".join(concern_lines)
            + "\nRaise each topic once. After the other person responds, move the conversation forward."
        )
    normalized_topics = [t.model_dump() for t in payload.evaluation_topics]
    for idx, t in enumerate(normalized_topics, start=1):
        topic_text = (
            f"Evaluation topic: {t['topic']}. "
            f"Guidelines: {t['evaluation_guidelines']}. "
            f"Success criteria: {'; '.join(t['success_criteria'])}. "
            f"Weight: {t['weight']}%. "
            f"Make or break: {t['make_or_break']}. "
            f"Make or break threshold: {t['make_or_break_threshold']}."
        )
        chunks.append({"id": f"evaluation_{idx}", "text": topic_text})

    additional = payload.additional_settings
    roleplay_end = additional.roleplay_end

    return {
        "author": payload.author or "unknown",
        "persona": persona,
        "areas": areas,
        "evaluation_topics": normalized_topics,
        "guardrail_instructions": guardrail_instructions,
        "context_chunks": chunks,
        "allow_ai_to_end_roleplay": roleplay_end.allow_ai_to_end_roleplay,
        "roleplay_end_condition": roleplay_end.end_condition,
        "time_limit_enabled": additional.simulation_time_limit.enabled,
        "conversation_duration_minutes": additional.simulation_time_limit.duration_minutes,
        "time_warning_minutes": additional.simulation_time_limit.warning_minutes,
        "short_session_penalty_enabled": additional.short_session_penalty.enabled,
        "short_session_minimum_minutes": additional.short_session_penalty.minimum_session_minutes,
        "short_session_penalty_points": additional.short_session_penalty.penalty_points,
        "difficulty_mode": additional.difficulty_mode,
    }


class CreateSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    author: str = "unknown"
    title: str | None = None
    learner_name: NonEmptyStr
    conversation_context: NonEmptyStr
    ai_persona: AIPersonaPayload
    evaluation_topics: list[EvaluationTopicPayload] = Field(min_length=1)
    additional_settings: AdditionalSettingsPayload = Field(default_factory=AdditionalSettingsPayload)
    passing_marks: float = Field(default=70.0, ge=0.0, le=100.0)
    tts_enabled: bool = False
    tts_lang: str = "en"


class SpeechStatsIn(BaseModel):
    model_config = ConfigDict(extra="allow")
    filler_count: int = 0
    filler_words: dict = Field(default_factory=dict)
    pace_wpm: float | None = None
    word_count: int = 0
    duration_s: float = 0.0


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: int
    user: str
    text: NonEmptyStr
    skip_tts: bool = False
    speech_stats: SpeechStatsIn | None = None


@app.post("/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """Transcribe uploaded audio using Whisper small. Accepts webm/wav/mp4."""
    content = await audio.read()
    suffix = ".webm"
    ct = audio.content_type or ""
    if "wav" in ct:
        suffix = ".wav"
    elif "mp4" in ct or "m4a" in ct:
        suffix = ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(content)
        tmp_path = f.name
    try:
        whisper = _get_whisper_model()
        segments, _ = whisper.transcribe(
            tmp_path,
            language="en",
            beam_size=1,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return {"text": text}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@app.websocket("/ws/transcribe/{session_id}")
async def ws_transcribe(websocket: WebSocket, session_id: int):
    """
    WebSocket endpoint for real-time Deepgram transcription.
    Client streams raw audio chunks; server forwards to Deepgram and
    returns transcript events as JSON.
    Falls back gracefully if Deepgram is not configured.
    """
    await websocket.accept()

    if not DEEPGRAM_API_KEY:
        await websocket.send_json({"type": "error", "detail": "Deepgram not configured — use /transcribe fallback"})
        await websocket.close()
        return

    try:
        from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions
    except ImportError:
        await websocket.send_json({"type": "error", "detail": "deepgram-sdk not installed"})
        await websocket.close()
        return

    dg = DeepgramClient(DEEPGRAM_API_KEY)
    dg_conn = dg.listen.asynclive.v("1")

    send_queue: asyncio.Queue = asyncio.Queue()
    _utterance_sent = False  # dedup: speech_final and UtteranceEnd can both fire
    _pending_words: list[dict] = []   # word objects accumulated across is_final segments

    async def on_transcript(*args, **kwargs):
        nonlocal _utterance_sent
        try:
            result = kwargs.get("result") or (args[1] if len(args) > 1 else args[0])
            alt = result.channel.alternatives[0]
            if alt.transcript:
                # Accumulate word-level timing from every finalised segment
                if result.is_final and hasattr(alt, "words") and alt.words:
                    _pending_words.extend(
                        {"word": w.word, "start": w.start, "end": w.end}
                        for w in alt.words
                    )
                await send_queue.put({
                    "type": "transcript",
                    "text": alt.transcript,
                    "is_final": result.is_final,
                    "speech_final": result.speech_final,
                })
            if result.speech_final and not _utterance_sent:
                _utterance_sent = True
                stats = _compute_speech_stats(_pending_words)
                _pending_words.clear()
                await send_queue.put({"type": "utterance_end", **stats})
        except Exception as exc:
            print(f"[WS Transcribe] on_transcript error: {exc}")

    async def on_speech_started(*args, **kwargs):
        nonlocal _utterance_sent
        _utterance_sent = False
        _pending_words.clear()
        await send_queue.put({"type": "speech_started"})

    async def on_utterance_end(*args, **kwargs):
        nonlocal _utterance_sent
        if not _utterance_sent:
            _utterance_sent = True
            stats = _compute_speech_stats(_pending_words)
            _pending_words.clear()
            await send_queue.put({"type": "utterance_end", **stats})

    async def on_error(*args, **kwargs):
        error = kwargs.get("error") or (args[1] if len(args) > 1 else args[0])
        err_str = str(error)
        # Timeout errors (net0001) are caused by silence gaps and are non-fatal —
        # suppress them from the client; keepalive prevents recurrence.
        if "net0001" in err_str or "timeout" in err_str.lower() or "did not receive" in err_str.lower():
            print(f"[WS Transcribe] Deepgram idle timeout (suppressed): {err_str}")
            return
        await send_queue.put({"type": "error", "detail": err_str})

    dg_conn.on(LiveTranscriptionEvents.Transcript, on_transcript)
    dg_conn.on(LiveTranscriptionEvents.SpeechStarted, on_speech_started)
    dg_conn.on(LiveTranscriptionEvents.UtteranceEnd, on_utterance_end)
    dg_conn.on(LiveTranscriptionEvents.Error, on_error)

    options = LiveOptions(
        model="nova-2",
        language="en-US",
        smart_format=True,
        interim_results=True,
        utterance_end_ms="1500",
        vad_events=True,
        endpointing=1200,
    )

    await dg_conn.start(options)

    async def sender():
        while True:
            msg = await send_queue.get()
            try:
                await websocket.send_json(msg)
            except Exception:
                break

    sender_task = asyncio.create_task(sender())

    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if "bytes" in msg and msg["bytes"]:
                await dg_conn.send(msg["bytes"])
            elif "text" in msg and msg["text"]:
                # Forward keepalive and other control messages as-is
                await dg_conn.send(msg["text"])
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[WS Transcribe] error: {exc}")
    finally:
        sender_task.cancel()
        await dg_conn.finish()


@app.post("/session/start")
def start_session(payload: CreateSession):
    db = SessionLocal()
    try:
        structured = _build_runtime_from_structured_payload(payload)
        author = structured["author"]
        persona = structured["persona"]
        areas = structured["areas"]
        evaluation_topics = structured["evaluation_topics"]
        guardrail_instructions = structured["guardrail_instructions"]
        context_chunks = structured["context_chunks"]
        s = Session(
            author=author,
            context_id=str(uuid.uuid4()),
            transcript=[],
            report={}
        )
        db.add(s)
        db.commit()
        db.refresh(s)

        # Store persona metadata
        meta = {
            "persona": persona,
            "areas": areas,
            "evaluation_topics": evaluation_topics,
            "guardrail_instructions": guardrail_instructions,
            "context_chunks": context_chunks,
            "overall_grounding_threshold": DEFAULT_OVERALL_GROUNDING_THRESHOLD,
            "enforce_conversational_pov": True,
            "allow_ai_to_end_roleplay": structured["allow_ai_to_end_roleplay"],
            "roleplay_end_condition": structured["roleplay_end_condition"],
            "time_limit_enabled": structured["time_limit_enabled"],
            "conversation_duration_minutes": structured["conversation_duration_minutes"],
            "short_session_penalty_enabled": structured["short_session_penalty_enabled"],
            "short_session_minimum_minutes": structured["short_session_minimum_minutes"],
            "short_session_penalty_points": structured["short_session_penalty_points"],
            "conversation_closed": False,
            "started_at_utc": _utc_now_iso(),
            "passing_marks": float(payload.passing_marks),
            "tts_enabled": payload.tts_enabled,
            "tts_lang": payload.tts_lang,
            "ai_persona_name": str(payload.ai_persona.name or "").strip(),
            "session_title": str(payload.title or "").strip(),
            "learner_name": str(payload.learner_name).strip(),
        }
        _save_session_meta(s.id, meta)

        greeting = _llm_opening_message(
            payload.ai_persona.model_dump(),
            conversation_context=str(payload.conversation_context or ""),
            use_llm=bool(payload.tts_enabled),
        )
        greeting = _text_mode_intro(payload.ai_persona.model_dump(), greeting)

        _append_transcript_turns(
            s,
            [
                {
                    "speaker": "AI",
                    "text": greeting,
                    "grounded": True,
                    "opening": True,
                }
            ],
        )

        db.add(s)
        db.commit()

        opening_tts_url = None
        briefing_message = None
        briefing_tts_url = None
        has_briefing = False

        _tts_on = bool(meta.get("tts_enabled", False))
        _persona_voice = payload.ai_persona.voice or None if _tts_on else None
        with ThreadPoolExecutor(max_workers=2) as _sp:
            _f_opening_tts = _sp.submit(_synthesize_tts, greeting, s.id, _persona_voice) if _tts_on else None
            _f_briefing    = _sp.submit(
                _generate_briefing_message,
                payload.ai_persona.model_dump(),
                str(payload.conversation_context or ""),
            ) if _tts_on else None

        if _tts_on:
            opening_tts_url = _f_opening_tts.result()
            briefing_raw    = _f_briefing.result()
            briefing_message = f"Hi, I am Alice, here is a brief about the session. {briefing_raw}"
            briefing_tts_url = _synthesize_tts(briefing_message, s.id, voice=ALICE_VOICE)
            has_briefing = True

        # For voice mode with briefing, defer timer start until frontend signals
        # briefing is done (/session/{id}/begin). For text mode, start immediately.
        if meta.get("time_limit_enabled") and meta.get("conversation_duration_minutes") and not has_briefing:
            # 2.5x wall-clock safety net — frontend enforces learner-time limit precisely
            _start_session_timer(s.id, float(meta["conversation_duration_minutes"]) * 60 * 2.5)

        return {
            "session_id": s.id,
            "opening_message": greeting,
            "opening_tts_url": opening_tts_url,
            "briefing_message": briefing_message,
            "briefing_tts_url": briefing_tts_url,
            "passing_marks": float(payload.passing_marks),
        }
    finally:
        db.close()


@app.post("/session/{session_id}/begin")
def begin_session(session_id: int):
    """Called by the frontend when the mediator briefing ends and the actual call begins.
    Starts the hard-stop timer so it counts from the moment the learner starts talking."""
    db = SessionLocal()
    try:
        s = db.get(Session, session_id)
        if not s:
            raise HTTPException(status_code=404)
        meta = _load_session_meta(session_id)
        if meta.get("time_limit_enabled") and meta.get("conversation_duration_minutes"):
            if session_id not in _session_timers:
                # 2.5x wall-clock safety net — frontend enforces learner-time limit precisely
                _start_session_timer(session_id, float(meta["conversation_duration_minutes"]) * 60 * 2.5)
        return {"ok": True}
    finally:
        db.close()




@app.post("/session/message/stream")
def session_message_stream(msg: MessageIn):
    """
    Streaming variant of /session/message.
    Sends Server-Sent Events:
      - data: {"type":"tts","url":"...","idx":0}   — one per sentence as TTS is ready
      - data: {"type":"done","reply":"...","checks":[...],"report":{...}}
      - data: {"type":"error","detail":"..."}
    """
    lock = _get_session_lock(msg.session_id)

    def event_stream():
        session_closed = False
        try:
            with lock:
                db = SessionLocal()
                meta = None  # initialise so except block can reference it safely
                try:
                    s = db.get(Session, msg.session_id)
                    if not s:
                        yield f"data: {json.dumps({'type':'error','detail':'session not found'})}\n\n"
                        return

                    mod = check_input(msg.text)
                    meta = _load_session_meta(s.id)

                    if bool(meta.get("conversation_closed", False)):
                        yield f"data: {json.dumps({'type':'error','detail':'conversation already closed'})}\n\n"
                        return

                    if mod["blocked"]:
                        offense_count = int(meta.get("profanity_offense_count", 0)) + 1
                        meta["profanity_offense_count"] = offense_count
                        if offense_count >= 2:
                            meta["conversation_closed"] = True
                            report = _build_evaluation_report(meta, s.transcript, profanity_flag=True,
                                                              skip_short_session_penalty=True, session_id=s.id)
                            report["final_score"] = float(report.get("evaluation_score", 0.0))
                            report["passing_marks"] = float(meta.get("passing_marks", 70.0))
                            report["passed"] = report["final_score"] >= report["passing_marks"]
                            report["terminated_for_profanity"] = True
                            s.report = report
                            db.add(s); db.commit()
                            _save_session_meta(s.id, meta)
                            _cleanup_session_resources(s.id, cancel_timer=True)
                            session_closed = True
                            yield f"data: {json.dumps({'type':'done','profanity_blocked':True,'profanity_terminated':True,'offense_count':offense_count,'report':report})}\n\n"
                        else:
                            _save_session_meta(s.id, meta)
                            yield f"data: {json.dumps({'type':'done','profanity_blocked':True,'profanity_terminated':False,'offense_count':offense_count})}\n\n"
                        return

                    profanity_flag = False
                    _timing_state(meta)

                    _recent_context = " ".join(t.get("text","") for t in s.transcript[-6:] if t.get("text"))
                    _learner_turn_count = sum(1 for t in s.transcript if t.get("speaker") != "AI")

                    session_chunks = meta.get("context_chunks") or []
                    if not session_chunks:
                        yield f"data: {json.dumps({'type':'error','detail':'Session missing context chunks.'})}\n\n"
                        return

                    # ── Pre-LLM checks in parallel, then optimistic LLM start ──────
                    # Run relevance/retrieval/suppression concurrently.
                    # Start the LLM stream as soon as retrieval+guardrail are ready
                    # (typically ~150 ms), without waiting for the relevance check.
                    # If relevance comes back off-topic we abort the LLM thread early.
                    import time as _time
                    import queue as _queue
                    tts_enabled = bool(meta.get("tts_enabled", False)) and not msg.skip_tts

                    _t0 = _time.monotonic()
                    _skip_relevance = _learner_turn_count == 0
                    _guardrail_instr = meta.get("guardrail_instructions", "")

                    def _relevance_task():
                        if _skip_relevance:
                            return {"relevant": True}
                        return _check_learner_relevance(msg.text, session_chunks, last_ai_turn=_recent_context)

                    with ThreadPoolExecutor(max_workers=3) as _ex:
                        _f_relevance = _ex.submit(_relevance_task)
                        _f_retrieved = _ex.submit(_retrieve_from_chunks, msg.text, session_chunks, s.id, 3)
                        _f_guardrail = _ex.submit(_suppress_raised_concerns, _guardrail_instr, s.transcript)

                    retrieved = _f_retrieved.result()
                    guardrail = _f_guardrail.result()
                    print(f"[latency] retrieval+guardrail {(_time.monotonic()-_t0)*1000:.0f}ms", flush=True)

                    # ── Difficulty mode resolution ──────────────────────────────
                    # Preset modes are free (no LLM call). Auto-detect fires once
                    # at turn 4 (heuristic first, one-shot 5-token LLM fallback),
                    # then caches the result in session_meta for all subsequent turns.
                    _difficulty_mode = meta.get("difficulty_mode", "off")
                    _active_difficulty = meta.get("active_difficulty")
                    if not _active_difficulty:
                        if _difficulty_mode == "auto":
                            _learner_turns_so_far = [
                                t["text"] for t in s.transcript
                                if t.get("speaker") != "AI" and t.get("text")
                            ]
                            if len(_learner_turns_so_far) >= 3:
                                _active_difficulty = _resolve_difficulty("auto", _learner_turns_so_far, model)
                                meta["active_difficulty"] = _active_difficulty
                                _save_session_meta(s.id, meta)
                        else:
                            _active_difficulty = _resolve_difficulty(_difficulty_mode, [], model)

                    system_prompt = pm.build_prompt(
                        meta["persona"], meta["areas"], retrieved,
                        guardrail_instructions=guardrail,
                        learner_name=meta.get("learner_name", ""),
                        end_condition=meta.get("roleplay_end_condition", ""),
                        allow_ai_to_end=bool(meta.get("allow_ai_to_end_roleplay", False)),
                        difficulty=_active_difficulty or "off",
                    )
                    history = _build_recent_history(s.transcript, msg.user, msg.text)

                    # Start LLM in a background thread, buffering tokens into a queue.
                    # This runs while we wait for the relevance result (already in-flight).
                    _llm_queue: _queue.Queue = _queue.Queue()
                    _llm_abort = threading.Event()

                    def _stream_to_queue():
                        try:
                            for _chunk in model.generate_stream(system_prompt, history, max_new_tokens=180):
                                if _llm_abort.is_set():
                                    return
                                _llm_queue.put(_chunk)
                        except Exception as _exc:
                            _llm_queue.put(_exc)
                        finally:
                            _llm_queue.put(None)  # sentinel

                    _llm_thread = threading.Thread(target=_stream_to_queue, daemon=True)
                    _llm_thread.start()
                    print(f"[latency] LLM start {(_time.monotonic()-_t0)*1000:.0f}ms", flush=True)

                    # Now collect relevance (usually already done by the time we get here)
                    relevance = _f_relevance.result()
                    print(f"[latency] relevance {(_time.monotonic()-_t0)*1000:.0f}ms", flush=True)

                    if not relevance["relevant"]:
                        _llm_abort.set()
                        nudge = relevance["nudge"]
                        _nudge_tts = bool(meta.get("tts_enabled")) and not msg.skip_tts
                        tts_url = _synthesize_tts(nudge, s.id) if _nudge_tts else None
                        if tts_url:
                            yield f"data: {json.dumps({'type':'tts','url':tts_url,'idx':0})}\n\n"
                        else:
                            yield f"data: {json.dumps({'type':'sentence','idx':0,'text':nudge})}\n\n"
                        yield f"data: {json.dumps({'type':'done','reply':nudge,'off_topic':True,'checks':[{'claim_type':'off_topic','ok':False}],'report':None})}\n\n"
                        return

                    # ── Stream LLM tokens, accumulate sentences, synthesize TTS per sentence ──
                    sentence_buf = ""
                    full_reply = ""
                    tts_idx = 0
                    sentence_endings = re.compile(r'(?<=[.!?,;])\s+')
                    _tag_re = re.compile(r"</?reply[^>]*>", re.IGNORECASE)
                    # Track whether we've seen the opening <reply> tag yet — skip until then
                    _in_reply = False
                    _reply_open = re.compile(r"<reply[^>]*>", re.IGNORECASE)
                    _reply_close = re.compile(r"</reply>", re.IGNORECASE)

                    def _flush_sentence(text, idx):
                        clean = _tag_re.sub("", text).strip()
                        if not clean:
                            return None
                        if tts_enabled:
                            url = _synthesize_tts(clean, s.id)
                            if url:
                                return f"data: {json.dumps({'type':'tts','url':url,'idx':idx,'text':clean})}\n\n"
                            return None
                        # TTS skipped — emit text-only sentence event for progressive display
                        return f"data: {json.dumps({'type':'sentence','idx':idx,'text':clean})}\n\n"

                    def _llm_chunks():
                        while True:
                            item = _llm_queue.get()
                            if item is None:
                                break
                            if isinstance(item, BaseException):
                                raise item
                            yield item

                    _pre_tag_buf = ""  # accumulates chunks before <reply> tag is seen
                    _reply_done = False  # set True once </reply> is consumed — stops flushing post-reply tokens
                    for chunk in _llm_chunks():
                        full_reply += chunk
                        if _reply_done:
                            continue
                        if not _in_reply:
                            _pre_tag_buf += chunk
                            if _reply_open.search(_pre_tag_buf):
                                _in_reply = True
                                # Start sentence_buf from content after the opening tag only
                                sentence_buf = _reply_open.split(_pre_tag_buf, maxsplit=1)[-1]
                                _pre_tag_buf = ""
                            # Don't buffer anything into sentence_buf until tag is seen
                            # If no tag at all by end, full_reply fallback handles it
                        else:
                            sentence_buf += chunk

                        # Stop buffering after </reply>
                        if _reply_close.search(sentence_buf):
                            sentence_buf = _reply_close.split(sentence_buf)[0]
                            _reply_done = True

                        parts = sentence_endings.split(sentence_buf)
                        while len(parts) > 1:
                            complete = parts.pop(0)
                            sentence_buf = " ".join(parts)
                            parts = [sentence_buf]
                            ev = _flush_sentence(complete, tts_idx)
                            if ev:
                                yield ev
                                tts_idx += 1
                        # Force-flush if buffer exceeds ~200 chars with no sentence boundary
                        if len(sentence_buf) > 200:
                            ev = _flush_sentence(sentence_buf, tts_idx)
                            if ev:
                                yield ev
                                tts_idx += 1
                                sentence_buf = ""

                    # Flush any remainder
                    # If no <reply> tag was ever seen, fall back to full_reply stripped of tags
                    if not _in_reply and _pre_tag_buf.strip():
                        sentence_buf = _tag_re.sub("", _pre_tag_buf).strip()
                    if sentence_buf.strip():
                        ev = _flush_sentence(sentence_buf, tts_idx)
                        if ev:
                            yield ev

                    raw_full_reply = full_reply.strip()
                    _close_tag_re = re.compile(r"<close>(YES|NO)</close>", re.IGNORECASE)
                    _close_match = _close_tag_re.search(raw_full_reply)
                    _model_says_close = bool(_close_match and _close_match.group(1).upper() == "YES")

                    full_reply = _sanitize_model_reply(raw_full_reply)
                    original_reply = full_reply

                    # Anti-repeat check (non-streaming retry if needed)
                    recent_ai_replies = _recent_ai_replies(s.transcript, limit=REPEAT_LOOKBACK_AI_TURNS)
                    if _is_semantic_repeat_any(full_reply, recent_ai_replies):
                        previous_ai_block = "\n".join([f"- {r[:300]}" for r in recent_ai_replies])
                        anti_repeat_prompt = (
                            f"{system_prompt}\n\nADDITIONAL RESPONSE RULES:\n"
                            "- Do not repeat previously asked questions.\n"
                            "- Acknowledge confirmed details and move forward.\n"
                            f"- Avoid: {previous_ai_block}\n"
                        )
                        for _ in range(2):
                            retry = model.generate(anti_repeat_prompt, history, max_new_tokens=400, temperature=0.35)
                            retry = _sanitize_model_reply(retry)
                            if retry and not _is_semantic_repeat_any(retry, recent_ai_replies):
                                full_reply = retry
                                original_reply = retry
                                break

                    persona_ok = _is_persona_response(full_reply, DEFAULT_ROLE_VIOLATION_PATTERNS)
                    if not persona_ok:
                        full_reply = DEFAULT_GUARDRAIL_FALLBACK_RESPONSE

                    full_reply = _strip_fallback_prefix_if_supported(full_reply)
                    if bool(meta.get("enforce_conversational_pov", True)) and _needs_pov_rewrite(full_reply):
                        full_reply = _enforce_conversational_pov(full_reply, meta.get("persona",""))
                        full_reply = _strip_fallback_prefix_if_supported(full_reply)
                    full_reply = _dedupe_repeated_opener(full_reply, s.transcript)

                    # The close tag is emitted outside </reply>, so it must be
                    # parsed from the raw model output before reply extraction.
                    full_reply = _close_tag_re.sub("", full_reply).strip()
                    original_reply = _close_tag_re.sub("", original_reply).strip()

                    supported = True
                    details = [{"claim": full_reply, "claim_type": "overall", "ok": True}]

                    _allow_end = bool(meta.get("allow_ai_to_end_roleplay", False)) and bool(meta.get("roleplay_end_condition", "").strip())
                    ai_end_check = (
                        {"matched": _model_says_close, "reason": "inline_close_tag"}
                        if _allow_end
                        else {"matched": False, "reason": None}
                    )

                    if ai_end_check.get("matched"):
                        _learner_turn = {"speaker": msg.user, "text": msg.text, "profanity": profanity_flag}
                        if msg.speech_stats:
                            _learner_turn["speech_stats"] = msg.speech_stats.model_dump()
                        _append_transcript_turns(s, [
                            _learner_turn,
                            {"speaker": "AI", "text": full_reply, "grounded": supported, "checks": details},
                        ])
                        report = _build_evaluation_report(meta, s.transcript, profanity_flag=profanity_flag,
                                                          skip_short_session_penalty=True, session_id=s.id)
                        report["final_score"] = float(report.get("evaluation_score", 0.0))
                        report["passing_marks"] = float(meta.get("passing_marks", 70.0))
                        report["passed"] = report["final_score"] >= report["passing_marks"]
                        s.report = report
                        db.add(s); db.commit()
                        meta["conversation_closed"] = True
                        _save_session_meta(s.id, meta)
                        _cleanup_session_resources(s.id, cancel_timer=True)
                        session_closed = True
                        yield f"data: {json.dumps({'type':'done','reply':full_reply,'grounded':supported,'checks':details,'report':None,'ai_closed':True,'originalReply':original_reply})}\n\n"
                        return

                    _learner_turn = {"speaker": msg.user, "text": msg.text, "profanity": profanity_flag}
                    if msg.speech_stats:
                        _learner_turn["speech_stats"] = msg.speech_stats.model_dump()
                    _append_transcript_turns(s, [
                        _learner_turn,
                        {"speaker": "AI", "text": full_reply, "grounded": supported, "checks": details, "persona_violation": not persona_ok},
                    ])
                    db.add(s); db.commit()

                    yield f"data: {json.dumps({'type':'done','reply':full_reply,'grounded':supported,'checks':details,'report':None,'originalReply':original_reply})}\n\n"

                except Exception as exc:
                    exc_str = str(exc)
                    _is_cf = (
                        "content_filter" in exc_str
                        or "content management policy" in exc_str.lower()
                        or "ResponsibleAI" in exc_str
                        or "content_filter_result" in exc_str
                    )
                    if _is_cf and meta is not None:
                        # Azure OpenAI content policy triggered — mirror the local profanity flow
                        print(f"[LLM] Azure content filter triggered: {exc_str[:300]}", flush=True)
                        _offense = int(meta.get("profanity_offense_count", 0)) + 1
                        meta["profanity_offense_count"] = _offense
                        if _offense >= 2:
                            meta["conversation_closed"] = True
                            _save_session_meta(s.id, meta)
                            yield f"data: {json.dumps({'type':'done','profanity_blocked':True,'profanity_terminated':True,'offense_count':_offense,'report':None})}\n\n"
                        else:
                            _save_session_meta(s.id, meta)
                            yield f"data: {json.dumps({'type':'done','profanity_blocked':True,'profanity_terminated':False,'offense_count':_offense})}\n\n"
                    else:
                        print(f"[LLM] Unhandled stream exception: {exc_str}", flush=True)
                        yield f"data: {json.dumps({'type':'error','detail':str(exc)})}\n\n"
                finally:
                    db.close()
        finally:
            if session_closed:
                _release_session_lock(msg.session_id)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/session/end")
def end_session(session_id: int):
    db = SessionLocal()
    try:
        s = db.get(Session, session_id)
        if not s:
            raise HTTPException(status_code=404)

        # Fix: use context manager to close file handle after read.
        meta = _load_session_meta(s.id)
        passing_marks = float(meta.get("passing_marks", 70.0))
        if bool(meta.get("conversation_closed", False)) and isinstance(s.report, dict) and s.report:
            report = dict(s.report)
            if "final_score" not in report:
                report["final_score"] = float(report.get("evaluation_score", 0.0))
            report["passing_marks"] = passing_marks
            report["passed"] = float(report["final_score"]) >= passing_marks
            s.report = report
            db.add(s)
            db.commit()
            # Fix: free cached embeddings for this session on close.
            _cleanup_session_resources(session_id)
            _release_session_lock(session_id)
            return {
                "session_id": s.id,
                "final_score": float(report["final_score"]),
                "passing_marks": passing_marks,
                "passed": bool(report["passed"]),
                "report": s.report,
            }

        profanity_seen = (
            any(t.get("profanity") for t in s.transcript if t.get("speaker") != "AI")
            or int(meta.get("profanity_offense_count", 0)) > 0
        )
        report = _build_evaluation_report(
            meta,
            s.transcript,
            profanity_flag=profanity_seen,
            session_id=session_id,
        )
        report["final_score"] = float(report["evaluation_score"])
        report["passing_marks"] = passing_marks
        report["passed"] = float(report["final_score"]) >= passing_marks
        s.report = report
        db.add(s)
        db.commit()
        meta["conversation_closed"] = True
        _save_session_meta(s.id, meta)
        _cleanup_session_resources(session_id, cancel_timer=True)
        _release_session_lock(session_id)
        return {
            "session_id": s.id,
            "final_score": float(report["final_score"]),
            "passing_marks": passing_marks,
            "passed": bool(report["passed"]),
            "report": s.report,
        }
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Scenario persistence
# ---------------------------------------------------------------------------

class ScenarioUpsert(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    label: str
    description: str = ""


@app.post("/scenario/generate")
def generate_scenario(body: dict):
    """Generate a complete scenario JSON from a natural language prompt."""
    prompt_text = str(body.get("prompt", "")).strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="prompt is required")

    system = (
        "You are a scenario designer for an AI roleplay coaching platform.\n"
        "Given a user description, generate a complete scenario JSON with EXACTLY this structure:\n\n"
        '{\n'
        '  "label": "Short scenario name",\n'
        '  "description": "One-line description for the card",\n'
        '  "session_mode": "voice",\n'
        '  "payload": {\n'
        '    "conversation_context": "Detailed scene-setting paragraph...",\n'
        '    "ai_persona": {\n'
        '      "name": "First name only",\n'
        '      "role": "Job title",\n'
        '      "organization": "Company name",\n'
        '      "personality": "Tone and communication style",\n'
        '      "background_information": "What this persona knows, cares about, and exactly how they should behave in this call. Be specific and directive.",\n'
        '      "concerns": [\n'
        '        {\n'
        '          "concern": "A specific hesitation or objection",\n'
        '          "when_it_comes_up": "Trigger condition",\n'
        '          "how_persona_frames_it": "Exact phrasing they use to raise it",\n'
        '          "good_enough_to_proceed_when": "What resolves the concern"\n'
        '        }\n'
        '      ]\n'
        '    },\n'
        '    "evaluation_topics": [\n'
        '      {\n'
        '        "topic": "Topic name",\n'
        '        "evaluation_guidelines": "What the evaluator checks for",\n'
        '        "success_criteria": ["Observable behaviour 1", "Observable behaviour 2"],\n'
        '        "weight": 25,\n'
        '        "make_or_break": false\n'
        '      }\n'
        '    ],\n'
        '    "additional_settings": {\n'
        '      "roleplay_end": {\n'
        '        "allow_ai_to_end_roleplay": true,\n'
        '        "end_condition": "When the AI persona is satisfied or the goal is reached"\n'
        '      },\n'
        '      "simulation_time_limit": { "enabled": false },\n'
        '      "short_session_penalty": { "enabled": false }\n'
        '    },\n'
        '    "passing_marks": 65,\n'
        '    "tts_enabled": true,\n'
        '    "tts_lang": "en"\n'
        '  }\n'
        '}\n\n'
        "Rules:\n"
        "- evaluation_topics weights must sum to exactly 100. Use 3-4 topics.\n"
        "- Add 1-3 concerns only when the persona would naturally have objections (sales, negotiation, etc.).\n"
        "- background_information must be directive — tell the AI exactly how to behave and what to probe.\n"
        "- session_mode: use 'voice' for calls/interviews, 'text' for chat-based scenarios.\n"
        "- passing_marks: 60-70 for beginner scenarios, 70-80 for advanced.\n"
        "- CRITICAL: evaluation_topics must evaluate the LEARNER's behaviour only, not the AI persona's.\n"
        "  Infer who the learner is from the scenario description. If the learner is an employee, candidate,\n"
        "  or junior party, criteria should measure skills like self-advocacy, asking the right questions,\n"
        "  negotiating support, and staying professional under pressure — not manager or facilitator skills.\n"
        "  If the learner is a salesperson or interviewer, criteria should measure pitch, objection handling,\n"
        "  and closing. Always write criteria from the learner's active perspective.\n"
        "- Return ONLY valid JSON. No markdown, no code fences, no explanation.\n"
    )

    try:
        from json_repair import repair_json
        raw = model.judge(system, prompt_text, max_tokens=2000)
        raw = raw.strip()
        # Extract the outermost JSON object
        start = raw.find('{')
        if start < 0:
            raise ValueError("No JSON object found in model output")
        raw = raw[start:]
        # repair_json fixes trailing commas, unclosed brackets, truncation, etc.
        repaired = repair_json(raw, return_objects=True)
        if not isinstance(repaired, dict):
            raise ValueError("Repaired output is not a JSON object")
        return repaired
    except ValueError as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")


@app.get("/scenarios")
def list_scenarios():
    db = SessionLocal()
    try:
        rows = db.query(ScenarioStore).order_by(ScenarioStore.created_at).all()
        return [row.data for row in rows]
    finally:
        db.close()


@app.post("/scenarios")
def upsert_scenario(body: dict):
    sid = str(body.get("id") or "").strip()
    if not sid:
        raise HTTPException(status_code=422, detail="id is required")
    db = SessionLocal()
    try:
        import datetime as _dt
        row = db.query(ScenarioStore).filter(ScenarioStore.id == sid).first()
        if row:
            row.data = body
            row.updated_at = _dt.datetime.utcnow()
        else:
            row = ScenarioStore(id=sid, data=body)
            db.add(row)
        db.commit()
        return {"ok": True, "id": sid}
    finally:
        db.close()


@app.delete("/scenarios/{scenario_id}")
def delete_scenario(scenario_id: str):
    db = SessionLocal()
    try:
        row = db.query(ScenarioStore).filter(ScenarioStore.id == scenario_id).first()
        if row:
            db.delete(row)
            db.commit()
        return {"ok": True}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Session history
# ---------------------------------------------------------------------------

@app.get("/sessions")
def list_sessions():
    db = SessionLocal()
    try:
        rows = db.query(Session).order_by(Session.created_at.desc()).limit(100).all()
        results = []
        for s in rows:
            meta: dict = {}
            try:
                meta = _load_session_meta(s.id)
            except Exception:
                pass
            report = s.report or {}
            score = report.get("final_score") or report.get("evaluation_score")
            results.append({
                "id": s.id,
                "title": meta.get("session_title") or f"Session {s.id}",
                "persona_name": meta.get("ai_persona_name", ""),
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "score": score,
                "passed": report.get("passed"),
                "passing_marks": report.get("passing_marks", meta.get("passing_marks")),
                "closed": bool(meta.get("conversation_closed", False)),
            })
        return results
    finally:
        db.close()


@app.get("/sessions/{session_id}")
def get_session(session_id: int):
    db = SessionLocal()
    try:
        s = db.query(Session).filter(Session.id == session_id).first()
        if not s:
            raise HTTPException(status_code=404)
        meta: dict = {}
        try:
            meta = _load_session_meta(s.id)
        except Exception:
            pass
        transcript = s.transcript or []
        formatted = [
            {"speaker": t.get("speaker", ""), "text": t.get("text", ""), "ts": t.get("ts")}
            for t in transcript
        ]
        report = s.report or {}
        if report and "final_score" not in report and "evaluation_score" in report:
            passing_marks_val = float(report.get("passing_marks") or meta.get("passing_marks") or 70.0)
            report = dict(report)
            report["final_score"] = float(report["evaluation_score"])
            if "passing_marks" not in report:
                report["passing_marks"] = passing_marks_val
            if "passed" not in report:
                report["passed"] = report["final_score"] >= passing_marks_val
        return {
            "id": s.id,
            "title": meta.get("session_title") or f"Session {s.id}",
            "persona_name": meta.get("ai_persona_name", ""),
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "closed": bool(meta.get("conversation_closed", False)),
            "report": report,
            "transcript": formatted,
        }
    finally:
        db.close()
