# app/scoring.py
from concurrent.futures import ThreadPoolExecutor, as_completed
import json

DEFAULT_MAKE_OR_BREAK_THRESHOLD = 0.2


class Scorer:
    def __init__(self, embedder=None):  # noqa: ARG002
        pass

    def _judge_topic(self, topic: dict, learner_turns: list, model_adapter) -> dict:
        """
        Ask the LLM to evaluate a single topic against the learner transcript.
        Returns a dict matching the topic_breakdown entry shape.
        """
        criteria = [c for c in topic.get("success_criteria", []) if str(c).strip()]
        weight = float(topic.get("weight", 0.0))
        topic_name = topic.get("topic", "")

        if not criteria:
            return {
                "topic": topic_name,
                "evaluation_guidelines": topic.get("evaluation_guidelines", ""),
                "weight": weight,
                "make_or_break": bool(topic.get("make_or_break", False)),
                "make_or_break_threshold": float(topic.get("make_or_break_threshold", DEFAULT_MAKE_OR_BREAK_THRESHOLD)),
                "topic_score_pct": 0.0,
                "criteria_covered": 0.0,
                "criteria_total": 0,
                "criteria": [],
                "example_videos": topic.get("example_videos", []),
                "helpful_links": topic.get("helpful_links", []),
            }

        turns_text = "\n".join(
            f"Turn {i+1}: {t}" for i, t in enumerate(learner_turns) if t and t.strip()
        )
        criteria_list = "\n".join(f"{i+1}. {c}" for i, c in enumerate(criteria))

        system_prompt = (
            "You are an objective evaluator for a sales and communication coaching roleplay. "
            "You will be given the learner's messages from a roleplay session and a list of success criteria. "
            "Evaluate strictly based on evidence in the transcript — do not give credit for implied or potential behaviour. "
            "Return ONLY valid JSON, no explanation outside the JSON."
        )
        user_prompt = (
            f"Topic: {topic_name}\n"
            f"Evaluation guideline: {topic.get('evaluation_guidelines', '')}\n\n"
            f"Success criteria:\n{criteria_list}\n\n"
            f"Learner's messages (in order):\n{turns_text}\n\n"
            "For each criterion, decide if the learner clearly demonstrated it. "
            "If met, set supporting_turn to the 1-indexed turn number where the evidence appears (e.g. 2 for Turn 2). "
            "If not met, set supporting_turn to null. "
            "Return JSON in this exact shape:\n"
            '{"criteria_results": [{"criterion": "<criterion text>", "met": true, "reason": "<one sentence>", "supporting_turn": 2}]}'
        )

        try:
            raw = model_adapter.judge(system_prompt, user_prompt, max_tokens=700)
            parsed = json.loads(raw)
            results = parsed.get("criteria_results", [])
        except Exception as exc:
            print(f"[LLMJudge] parse error for topic '{topic_name}': {exc} — raw: {raw[:200] if 'raw' in dir() else '?'}")
            results = []

        n_turns = len(learner_turns)
        # Align results to criteria by position (LLM may return fewer if it truncates)
        criteria_rows = []
        covered = 0.0
        for i, c_text in enumerate(criteria):
            r = results[i] if i < len(results) else {}
            met = bool(r.get("met", False))
            if met:
                covered += 1.0
            raw_turn = r.get("supporting_turn")
            supporting_turn = int(raw_turn) if met and isinstance(raw_turn, (int, float)) and 1 <= int(raw_turn) <= n_turns else None
            criteria_rows.append({
                "criterion": c_text,
                "met": met,
                "reason": r.get("reason", ""),
                "supporting_turn": supporting_turn,
                "best_similarity": 1.0 if met else 0.0,
                "criterion_weight": 0.0,   # filled in below
                "criterion_score": 0.0,    # filled in below
            })

        return {
            "topic": topic_name,
            "evaluation_guidelines": topic.get("evaluation_guidelines", ""),
            "weight": weight,
            "make_or_break": bool(topic.get("make_or_break", False)),
            "make_or_break_threshold": float(topic.get("make_or_break_threshold", DEFAULT_MAKE_OR_BREAK_THRESHOLD)),
            "criteria_covered": covered,
            "criteria_total": len(criteria),
            "criteria_rows": criteria_rows,   # temp key, processed in caller
            "example_videos": topic.get("example_videos", []),
            "helpful_links": topic.get("helpful_links", []),
        }

    def evaluate_weighted_topics_llm(self, learner_text, evaluation_topics, model_adapter):
        """
        LLM-as-judge replacement for evaluate_weighted_topics.
        Parallelises one LLM call per topic, then computes weighted score.
        Output shape is identical to evaluate_weighted_topics so callers need no changes.
        """
        if not evaluation_topics:
            return {
                "score": 0.0, "make_or_break_failed": False,
                "topic_breakdown": [], "weights_total": 0.0,
                "criteria_covered": 0, "criteria_total": 0,
            }

        turns = learner_text if isinstance(learner_text, list) else [learner_text]

        topic_weights = [float(t.get("weight", 0.0)) for t in evaluation_topics]
        total_weight = float(sum(w for w in topic_weights if w > 0)) or float(len(evaluation_topics))

        # Run one LLM call per topic in parallel
        raw_results = [None] * len(evaluation_topics)
        with ThreadPoolExecutor(max_workers=min(len(evaluation_topics), 5)) as pool:
            futures = {
                pool.submit(self._judge_topic, topic, turns, model_adapter): idx
                for idx, topic in enumerate(evaluation_topics)
            }
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    raw_results[idx] = future.result()
                except Exception as exc:
                    print(f"[LLMJudge] topic {idx} failed: {exc}")
                    raw_results[idx] = None

        topic_breakdown = []
        weighted_score = 0.0
        make_or_break_failed = False
        total_criteria_covered = 0.0
        total_criteria_total = 0

        for idx, topic in enumerate(evaluation_topics):
            res = raw_results[idx]
            weight = topic_weights[idx]
            normalized_weight = weight / total_weight
            topic_weight_points = normalized_weight * 100.0

            if res is None:
                # LLM call failed — give zero for this topic
                topic_breakdown.append({
                    "topic": topic.get("topic", ""),
                    "evaluation_guidelines": topic.get("evaluation_guidelines", ""),
                    "weight": weight, "normalized_weight": normalized_weight,
                    "make_or_break": bool(topic.get("make_or_break", False)),
                    "make_or_break_threshold": float(topic.get("make_or_break_threshold", DEFAULT_MAKE_OR_BREAK_THRESHOLD)),
                    "make_or_break_failed": False,
                    "topic_pass_ratio": 0.0, "topic_score_pct": 0.0,
                    "weighted_contribution": 0.0,
                    "criteria_covered": 0.0, "criteria_total": 0, "criteria": [],
                    "example_videos": topic.get("example_videos", []),
                    "helpful_links": topic.get("helpful_links", []),
                })
                continue

            criteria_rows = res.pop("criteria_rows", [])
            n = len(criteria_rows)
            criterion_weight = topic_weight_points / n if n else 0.0

            # Assign per-criterion weight and score
            for row in criteria_rows:
                row["criterion_weight"] = criterion_weight
                row["criterion_score"] = criterion_weight if row["met"] else 0.0

            covered = res["criteria_covered"]
            topic_score_pct = 100.0 * (covered / n) if n else 0.0
            weighted_contribution = sum(r["criterion_score"] for r in criteria_rows)
            topic_pass_ratio = topic_score_pct / 100.0

            topic_make_or_break = res["make_or_break"]
            threshold = res["make_or_break_threshold"]
            topic_mob_failed = topic_make_or_break and topic_pass_ratio < threshold
            make_or_break_failed = make_or_break_failed or topic_mob_failed

            weighted_score += weighted_contribution
            total_criteria_covered += covered
            total_criteria_total += n

            topic_breakdown.append({
                "topic": res["topic"],
                "evaluation_guidelines": res["evaluation_guidelines"],
                "weight": weight,
                "normalized_weight": normalized_weight,
                "make_or_break": topic_make_or_break,
                "make_or_break_threshold": threshold,
                "make_or_break_failed": topic_mob_failed,
                "topic_pass_ratio": topic_pass_ratio,
                "topic_score_pct": topic_score_pct,
                "weighted_contribution": weighted_contribution,
                "criteria_covered": covered,
                "criteria_total": n,
                "criteria": criteria_rows,
                "example_videos": res.get("example_videos", []),
                "helpful_links": res.get("helpful_links", []),
            })

        final_score = 0.0 if make_or_break_failed else max(0.0, min(100.0, weighted_score))
        print(f"[LLMJudge] score={final_score:.1f} make_or_break_failed={make_or_break_failed}")
        return {
            "score": final_score,
            "make_or_break_failed": make_or_break_failed,
            "topic_breakdown": topic_breakdown,
            "weights_total": total_weight,
            "criteria_covered": total_criteria_covered,
            "criteria_total": total_criteria_total,
        }

    def apply_short_session_penalty(self, score, elapsed_minutes, enabled, minimum_minutes, penalty_points):
        if not enabled:
            return float(score), False, 0.0
        if minimum_minutes is None or penalty_points is None:
            return float(score), False, 0.0
        if float(elapsed_minutes) >= float(minimum_minutes):
            return float(score), False, 0.0
        adjusted = max(0.0, float(score) - float(penalty_points))
        return float(adjusted), True, float(penalty_points)
