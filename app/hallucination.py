# app/hallucination.py
import numpy as np
import re

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do",
    "for", "from", "have", "i", "in", "is", "it", "its", "me", "my", "not", "of",
    "on", "or", "our", "please", "the", "this", "to", "we", "with", "you", "your"
}

class HallucinationChecker:
    def __init__(self, threshold=0.30, embedder=None):
        self.embedder = embedder
        self.threshold = threshold

    def _embed(self, texts):
        embs = self.embedder.encode(texts, convert_to_numpy=True, show_progress_bar=False)
        # normalize to unit vectors
        norms = np.linalg.norm(embs, axis=1, keepdims=True) + 1e-10
        return embs / norms

    def _key_terms(self, text):
        tokens = re.findall(r"[a-z0-9]+", (text or "").lower())
        return [t for t in tokens if len(t) >= 3 and t not in STOPWORDS]

    def _is_low_information(self, text):
        terms = self._key_terms(text)
        if not terms:
            return True
        unique_ratio = len(set(terms)) / max(1, len(terms))
        return len(terms) >= 12 and unique_ratio < 0.35

    def _has_fact_overlap(self, claim, source_text):
        claim_terms = set(self._key_terms(claim))
        source_terms = set(self._key_terms(source_text))
        lexical_overlap = len(claim_terms.intersection(source_terms))

        claim_nums = set(re.findall(r"\d+(?:\.\d+)?", claim or ""))
        source_nums = set(re.findall(r"\d+(?:\.\d+)?", source_text or ""))
        numeric_overlap = len(claim_nums.intersection(source_nums)) > 0

        return lexical_overlap >= 2 or numeric_overlap

    def best_support(self, claim: str, sources: list, threshold=None):
        """
        Check claim against multiple sources, encoding the claim only ONCE (batch encode).
        Returns (claim_supported: bool, best_score: float, best_src_id: str|None).
        Fixes the N-encoding bug where claim was re-encoded once per source in a loop.
        """
        th = threshold if threshold is not None else self.threshold
        if self._is_low_information(claim):
            return False, 0.0, None

        # Pre-filter sources with cheap lexical overlap check
        eligible = [(src, self._has_fact_overlap(claim, src.get("text", ""))) for src in sources]
        eligible_sources = [src for src, ok in eligible if ok]
        if not eligible_sources:
            return False, 0.0, None

        # Batch encode claim + all eligible sources in one call
        texts_to_encode = [claim] + [src.get("text", "") for src in eligible_sources]
        embs = self._embed(texts_to_encode)
        claim_vec = embs[0]

        best_score = 0.0
        best_src_id = None
        claim_supported = False

        for i, src in enumerate(eligible_sources):
            src_vec = embs[i + 1]
            score = float(np.dot(claim_vec, src_vec))
            if score > best_score:
                best_score = score
                best_src_id = src.get("id")
            if score >= th:
                claim_supported = True

        return claim_supported, best_score, best_src_id
