"""
app/evaluator.py
~~~~~~~~~~~~~~~~
Generates human-readable per-topic explanations and overall session summaries
from the raw NLI scoring results produced by Scorer.evaluate_weighted_topics().

Uses the LLM (via ModelAdapter) to generate professional-sounding feedback.
Falls back to template-based text if the model is unavailable.
"""

import logging

log = logging.getLogger(__name__)

_TOPIC_SYSTEM = (
    "You are an expert performance coach providing concise, specific feedback on a learner's "
    "roleplay session. Write in second person (\"You...\"). Be direct, professional, and constructive. "
    "Do not use bullet points. Do not repeat the criteria verbatim. "
    "Keep the response to 2-3 sentences."
)

_SESSION_SYSTEM = (
    "You are an expert performance coach summarising a learner's overall roleplay session. "
    "Write in second person (\"You...\"). Be direct and encouraging but honest. "
    "Highlight the strongest area and the single most important improvement. "
    "Keep the response to 2-3 sentences. Do not use bullet points."
)


class SessionEvaluator:
    """
    Converts raw topic_breakdown dicts into LLM-generated explanations.
    Pass a ModelAdapter instance to enable LLM feedback; omit for template fallback.
    """

    def __init__(self, model=None):
        self.model = model

    # ── LLM helpers ──────────────────────────────────────────────────────────

    def _llm(self, system: str, user_prompt: str, max_tokens: int = 180):
        if not self.model:
            return None
        try:
            # generate() expects conversation_history as a plain string
            return self.model.generate(
                system,
                user_prompt,
                max_new_tokens=max_tokens,
                temperature=0.4,
            ).strip()
        except Exception as exc:
            log.warning("SessionEvaluator LLM call failed: %s", exc)
            return None

    # ── Per-topic ────────────────────────────────────────────────────────────

    def explain_topic(self, topic: dict) -> dict:
        criteria    = topic.get("criteria", [])
        covered     = [c["criterion"] for c in criteria if c.get("criterion_score", 0) > 0]
        missed      = [c["criterion"] for c in criteria if c.get("criterion_score", 0) == 0]
        score_pct   = float(topic.get("topic_score_pct", 0))
        mob_failed  = bool(topic.get("make_or_break_failed", False))
        guidelines  = topic.get("evaluation_guidelines", "")

        explanation = self._llm_topic_explanation(
            topic_name=topic.get("topic", ""),
            score_pct=score_pct,
            covered=covered,
            missed=missed,
            guidelines=guidelines,
            mob_failed=mob_failed,
        )
        gap = self._llm_gap(topic.get("topic", ""), missed) if missed else None

        return {
            "topic":                topic.get("topic", ""),
            "score_pct":            round(score_pct, 1),
            "covered_criteria":     covered,
            "missed_criteria":      missed,
            "explanation":          explanation,
            "gap":                  gap,
            "make_or_break_failed": mob_failed,
        }

    def _llm_topic_explanation(
        self, topic_name, score_pct, covered, missed, guidelines, mob_failed
    ) -> str:
        covered_str = "; ".join(covered) if covered else "none"
        missed_str  = "; ".join(missed)  if missed  else "none"
        prompt = (
            f"Topic: {topic_name}\n"
            f"Score: {round(score_pct)}%\n"
            f"Evaluation focus: {guidelines}\n"
            f"Criteria the learner met: {covered_str}\n"
            f"Criteria the learner missed: {missed_str}\n"
        )
        if mob_failed:
            prompt += "Note: this was a make-or-break topic — failing it sets the overall score to 0.\n"
        prompt += "\nProvide feedback for the learner on this topic."

        result = self._llm(_TOPIC_SYSTEM, prompt)
        return result or self._fallback_topic(covered, missed, mob_failed)

    def _llm_gap(self, topic_name: str, missed: list) -> str:
        missed_str = "; ".join(missed)
        prompt = (
            f"Topic: {topic_name}\n"
            f"Criteria not demonstrated: {missed_str}\n"
            "Write one specific, actionable sentence telling the learner exactly what to practise "
            "to close this gap. Start with 'To improve:'"
        )
        result = self._llm(_TOPIC_SYSTEM, prompt, max_tokens=80)
        return result or self._fallback_gap(missed)

    # ── Full session ─────────────────────────────────────────────────────────

    def explain_session(self, topic_breakdown: list) -> dict:
        topic_explanations = [self.explain_topic(t) for t in topic_breakdown]

        total_covered  = sum(len(e["covered_criteria"]) for e in topic_explanations)
        total_criteria = sum(
            len(e["covered_criteria"]) + len(e["missed_criteria"])
            for e in topic_explanations
        )

        strong_topics  = [e["topic"] for e in topic_explanations if e["score_pct"] >= 66]
        weak_topics    = [e["topic"] for e in topic_explanations if e["score_pct"] < 33]
        partial_topics = [e["topic"] for e in topic_explanations if 33 <= e["score_pct"] < 66]

        summary = self._llm_session_summary(topic_explanations, strong_topics, weak_topics)

        return {
            "topic_explanations": topic_explanations,
            "summary":            summary,
            "strong_topics":      strong_topics,
            "weak_topics":        weak_topics,
            "partial_topics":     partial_topics,
            "criteria_covered":   total_covered,
            "criteria_total":     total_criteria,
        }

    def _llm_session_summary(
        self, topic_explanations: list, strong_topics: list, weak_topics: list
    ) -> str:
        lines = []
        for e in topic_explanations:
            lines.append(
                f"- {e['topic']}: {round(e['score_pct'])}% "
                f"({len(e['covered_criteria'])} met, {len(e['missed_criteria'])} missed)"
            )
        breakdown_str = "\n".join(lines)
        strong_str = ", ".join(strong_topics) if strong_topics else "none"
        weak_str   = ", ".join(weak_topics)   if weak_topics   else "none"

        prompt = (
            f"Session topic breakdown:\n{breakdown_str}\n"
            f"Strong areas: {strong_str}\n"
            f"Areas needing improvement: {weak_str}\n"
            "Write a 2-3 sentence overall session summary for the learner."
        )

        result = self._llm(_SESSION_SYSTEM, prompt, max_tokens=150)
        return result or self._fallback_summary(strong_topics, weak_topics)

    # ── Template fallbacks ───────────────────────────────────────────────────

    @staticmethod
    def _fallback_topic(covered, missed, mob_failed) -> str:
        parts = []
        if covered:
            parts.append(f"You demonstrated {len(covered)} of {len(covered) + len(missed)} required criteria.")
        else:
            parts.append("None of the required criteria were clearly demonstrated.")
        if missed:
            parts.append(f"Missing: {'; '.join(missed)}.")
        if mob_failed:
            parts.append("This make-or-break topic failure sets your overall score to 0.")
        return " ".join(parts)

    @staticmethod
    def _fallback_gap(missed) -> str:
        if len(missed) == 1:
            return f"To improve: {missed[0].rstrip('.')}."
        items = [m.rstrip(".") for m in missed]
        return "To improve, focus on: " + ", ".join(items[:-1]) + f", and {items[-1]}."

    @staticmethod
    def _fallback_summary(strong_topics, weak_topics) -> str:
        parts = []
        if strong_topics:
            parts.append(f"Strong areas: {', '.join(strong_topics)}.")
        if weak_topics:
            parts.append(f"Areas needing most improvement: {', '.join(weak_topics)}.")
        return " ".join(parts) or "Session complete."
