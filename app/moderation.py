# app/moderation.py
import re

PROFANITY = [
    # Strong profanity
    "fuck", "fucker", "fucking", "fucked", "motherfucker", "motherfucking",
    "shit", "shitty", "bullshit", "horseshit",
    "cunt", "twat",
    "cock", "dickhead", "dick",
    "pussy", "asshole", "arsehole", "ass", "arse",
    "bastard", "bitch", "bitchy",
    "prick", "wanker", "tosser", "bellend",
    "damn", "goddamn", "goddammit", "dammit",
    "crap", "jackass", "dumbass", "dumbfuck",
    "whore", "slut", "skank",
    "nigger", "nigga", "faggot", "fag", "retard",
    "piss", "pissed",
]

_prof_re = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in PROFANITY) + r")\b",
    re.IGNORECASE,
)


def check_input(text: str) -> dict:
    m = _prof_re.search(text)
    if m:
        return {"blocked": True, "word": m.group(0)}
    return {"blocked": False}
