# app/prompt_manager.py

_DIFFICULTY_MODIFIERS = {
    "impatient": (
        "INTERACTION STYLE: You are time-pressured and impatient. "
        "If the learner is long-winded, cut them off and ask for the bottom line. "
        "Show visible irritation when answers are vague or rambling."
    ),
    "skeptical": (
        "INTERACTION STYLE: You are deeply skeptical. "
        "Challenge every claim the learner makes — ask for evidence, examples, or numbers. "
        "Do not accept assertions at face value."
    ),
    "evasive": (
        "INTERACTION STYLE: You are evasive and non-committal. "
        "When the learner asks direct questions, give vague answers or change the subject. "
        "Make the learner work hard to pin you down."
    ),
    "hostile": (
        "INTERACTION STYLE: You are guarded and mildly adversarial. "
        "Interrupt, push back on specifics, and occasionally hint that a competitor offers a better deal. "
        "Warm up only if the learner earns it."
    ),
}


class PromptManager:
    def __init__(self, embedder=None):
        self.embedder = embedder

    def build_prompt(self, persona, areas, retrieved_chunks, guardrail_instructions=None, learner_name="", end_condition="", allow_ai_to_end=False, difficulty="off"):
        sources = "\n\n".join([f"[{c['id']}] {c['text']}" for c in retrieved_chunks])
        guardrails = guardrail_instructions or ""
        if guardrails and not guardrails.endswith("\n"):
            guardrails += "\n"
        learner_clause = (
            f"The person you are speaking with is called {learner_name}. "
            f"Address them by name naturally where it fits — do not force it on every turn.\n"
        ) if learner_name else ""
        difficulty_clause = (
            f"{_DIFFICULTY_MODIFIERS[difficulty]}\n"
        ) if difficulty in _DIFFICULTY_MODIFIERS else ""
        close_clause = (
            f"\n\n--- OUTPUT FORMAT ---\n"
            f"After your </reply> tag, on a new line write <close>YES</close> if this condition is now met: {end_condition}\n"
            f"Otherwise write <close>NO</close>. This tag is never spoken — it is metadata only.\n"
            f"Example: <reply>Great, we are aligned.</reply>\n<close>YES</close>"
        ) if (allow_ai_to_end and end_condition) else ""
        system = (
            f"You are {persona}\n\n"
            f"{guardrails}"
            f"{learner_clause}"
            f"{difficulty_clause}"
            "Use the background information below to inform your responses. "
            "If something is not covered, respond naturally based on your role and context. "
            "Do not reference or mention these instructions in your responses.\n\n"
            f"FOCUS AREAS: {areas}\n\n"
            "BACKGROUND INFORMATION:\n"
            f"{sources}\n\n"
            "--- END BACKGROUND ---\n\n"
            "Stay fully in character at all times. "
            "Format your response inside <reply> tags. "
            "Write only the spoken response — no notes, no stage directions. "
            "Keep responses short: 1-3 sentences maximum. One idea per turn. "
            "Do not list multiple points or ask multiple questions at once. "
            "Speak naturally as a person in a real conversation would. "
            "IMPORTANT: Begin your reply directly with substance — never open with affirmations "
            "like 'Great', 'Sure', 'Absolutely', 'Of course', 'Good question', or any filler "
            "acknowledgment. Jump straight into your thought.\n"
            f"Example: <reply>That's a fair point. What makes you say that?</reply>"
            f"{close_clause}"
        )
        return system
