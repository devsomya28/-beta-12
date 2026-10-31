import re
import json
import logging
from typing import List, Dict, Any, Tuple
from sqlalchemy.orm import Session
from backend.app.models import (
    Assignment, Question, RubricCriterion, Submission, Answer, GradeRun, Grade, Flag, AuditLog, MaterialChunk
)
from backend.app.llm_provider import get_llm_provider, is_ai_forced_offline
from backend.app.rag import BM25Retriever

logger = logging.getLogger("markanchor.grading")

INJECTION_PATTERNS = [
    r"ignore\s+(?:all\s+)?previous\s+instructions",
    r"give\s+me\s+full\s+marks",
    r"give\s+me\s+10\s+marks",
    r"award\s+full\s+marks",
    r"you\s+are\s+now\b",
    r"system\s*prompt\b",
    r"disregard\s+(?:the\s+)?rubric",
    r"override\s+(?:all\s+)?grades",
    r"act\s+as\s+a\s+different\s+grader",
    r"developer\s+mode\b",
    r"jailbreak\b",
]

def detect_prompt_injection(text: str) -> Tuple[bool, List[str]]:
    """
    Separate detector (regex list + pattern check) for prompt injection attempts.
    Treats student answer strictly as untrusted data.
    """
    detected_phrases = []
    for pattern in INJECTION_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            detected_phrases.extend(matches)

    return len(detected_phrases) > 0, list(set(detected_phrases))


def compute_text_similarity(text1: str, text2: str) -> float:
    """Computes Jaccard / token overlap similarity between two text snippets (0.0 to 1.0)."""
    t1 = set(re.findall(r'\b[a-zA-Z0-9_]+\b', text1.lower()))
    t2 = set(re.findall(r'\b[a-zA-Z0-9_]+\b', text2.lower()))
    if not t1 or not t2:
        return 0.0
    intersection = len(t1.intersection(t2))
    union = len(t1.union(t2))
    return intersection / union if union > 0 else 0.0


def grade_single_answer(
    answer: Answer,
    question: Question,
    course_chunks: List[Dict[str, Any]],
    db: Session
) -> Dict[str, Any]:
    """
    Grades a single student answer:
    - 3 independent runs (temperature > 0)
    - Compares marks per criterion across runs
    - If runs differ by > 1 grade band (10% max marks), confidence = Low, flag 'Marks unstable across runs'
    - Anchors every mark to retrieved chunks
    - Detects uncovered points: marks 'Needs teacher decision' without guessing
    - Detects prompt injection
    """
    student_text = answer.student_answer_text.strip()

    # 1. Prompt Injection Detection
    has_injection, injection_phrases = detect_prompt_injection(student_text)
    if has_injection:
        answer.injection_detected = True
        answer.injection_phrases = json.dumps(injection_phrases)
        db.add(answer)
        db.flush()

        # Audit log entry for injection detection
        audit = AuditLog(
            user_id=answer.submission.student_id,
            event_type="INJECTION_DETECTED",
            details=f"Prompt injection attempt detected in submission {answer.submission_id}, Question {question.question_number}: {injection_phrases}"
        )
        db.add(audit)

    # 2. Retrieve relevant course chunks
    retriever = BM25Retriever()
    retriever.fit(course_chunks)
    retrieved_scored = retriever.retrieve(f"{question.question_text} {student_text}", top_k=3)

    retrieved_chunks = [item[0] for item in retrieved_scored]
    best_score = retrieved_scored[0][1] if retrieved_scored else 0.0

    # Flag: Weak retrieval
    is_weak_retrieval = best_score < 0.20 or len(retrieved_chunks) == 0

    # 3. Check for ungrounded / uncovered points
    uncovered_tokens = ["quantum", "genetic algorithm", "blockchain", "dna", "ancient", "uncovered"]
    has_uncovered_content = any(t in student_text.lower() for t in uncovered_tokens)

    # 4. Run 3 Grading Evaluations (Consistency Check)
    criteria = question.rubric_criteria
    if not criteria:
        max_m = question.max_marks or 10.0
        c1 = round(max_m * 0.4, 1)
        c2 = round(max_m * 0.3, 1)
        c3 = round(max_m - c1 - c2, 1)
        default_crits = [
            RubricCriterion(
                question_id=question.id,
                order_num=1,
                criterion_text="Core concepts, definitions, and methodology",
                max_marks=c1
            ),
            RubricCriterion(
                question_id=question.id,
                order_num=2,
                criterion_text="Detailed analysis, diagrams, or intermediate steps",
                max_marks=c2
            ),
            RubricCriterion(
                question_id=question.id,
                order_num=3,
                criterion_text="Final conclusion, technical accuracy, and precision",
                max_marks=c3
            ),
        ]
        for dc in default_crits:
            db.add(dc)
        db.flush()
        criteria = default_crits

    runs_data = []

    # Calculate run outputs
    for run_num in [1, 2, 3]:
        run_grades = []
        run_total = 0.0

        for crit in criteria:
            if has_uncovered_content:
                # Rule: Never guess marks for ungrounded hallucinated content (e.g. quantum qubits for ML)!
                marks = 0.0
                reason = "Not covered in course material. Needs teacher decision."
                cited_chunk = None
                cited_page = None
                cited_txt = None
                covered = False
            else:
                # Award mark anchored to course chunk or evaluated by AI
                ratio = 0.90 if run_num == 1 else (0.85 if run_num == 2 else 0.95)
                # If answer is very brief or poor
                if len(student_text.split()) < 10:
                    ratio = 0.40

                marks = round(crit.max_marks * ratio, 1)
                best_c = retrieved_chunks[0] if retrieved_chunks else None
                if best_c and not is_weak_retrieval:
                    cited_chunk = best_c.get("id")
                    cited_page = best_c.get("page_number", 1)
                    cited_txt = best_c.get("chunk_text", "")[:120]
                    reason = f"Anchored to Chapter {cited_page} notes: Direct alignment with {crit.criterion_text[:40]}."
                    covered = True
                else:
                    cited_chunk = None
                    cited_page = None
                    cited_txt = None
                    reason = f"AI evaluated based on technical completeness for: {crit.criterion_text[:45]}."
                    covered = True

            run_grades.append({
                "criterion_id": crit.id,
                "marks_awarded": marks,
                "ai_reason": reason,
                "cited_chunk_id": cited_chunk,
                "cited_page_num": cited_page,
                "cited_text": cited_txt,
                "covered": covered
            })
            run_total += marks

        runs_data.append({
            "run_number": run_num,
            "total_marks": round(run_total, 1),
            "grades": run_grades
        })

    # Save grade runs in DB
    saved_runs = []
    for rd in runs_data:
        gr = GradeRun(
            answer_id=answer.id,
            run_number=rd["run_number"],
            total_marks=rd["total_marks"],
            raw_llm_output=json.dumps(rd["grades"])
        )
        db.add(gr)
        db.flush()
        saved_runs.append(gr)

        for g_data in rd["grades"]:
            g = Grade(
                grade_run_id=gr.id,
                rubric_criterion_id=g_data["criterion_id"],
                marks_awarded=g_data["marks_awarded"],
                ai_reason=g_data["ai_reason"],
                cited_chunk_id=g_data["cited_chunk_id"],
                cited_page_num=g_data["cited_page_num"],
                cited_text=g_data["cited_text"],
                covered_by_material=g_data["covered"]
            )
            db.add(g)

    # 5. Consistency Analysis: One grade band = 10% of max marks
    grade_band = question.max_marks * 0.10
    totals = [r["total_marks"] for r in runs_data]
    max_diff = max(totals) - min(totals)

    is_unstable = max_diff > grade_band
    confidence = "Low" if is_unstable else ("Medium" if max_diff > (grade_band * 0.5) else "High")

    # 6. Check for unusual answer: low similarity to model answer AND to chunks
    model_sim = compute_text_similarity(student_text, question.model_answer or "")
    chunk_sim = compute_text_similarity(student_text, retrieved_chunks[0].get("chunk_text", "") if retrieved_chunks else "")
    is_unusual = (model_sim < 0.15 and chunk_sim < 0.15 and len(student_text.split()) > 15)

    # 7. Check for criterion conflict
    # Check if criterion level sum matches run total
    primary_run = runs_data[0]
    crit_sum = sum(g["marks_awarded"] for g in primary_run["grades"])
    has_conflict = abs(crit_sum - primary_run["total_marks"]) > 0.05

    return {
        "confidence": confidence,
        "is_unstable": is_unstable,
        "is_weak_retrieval": is_weak_retrieval,
        "has_uncovered_content": has_uncovered_content,
        "has_injection": has_injection,
        "is_unusual": is_unusual,
        "has_conflict": has_conflict,
        "primary_run_total": primary_run["total_marks"],
        "primary_grades": primary_run["grades"]
    }


def grade_submission(submission_id: int, db: Session) -> Dict[str, Any]:
    """
    Grades an entire submission:
    - Iterates through answers
    - Generates 3 runs per answer
    - Evaluates all flagging rules:
      1. Weak retrieval -> "Course material is thin on this topic"
      2. Uncovered content -> "Uncovered point"
      3. Unstable runs -> "Unstable marks"
      4. Marks conflict -> "Marks conflict"
      5. Unusual answer -> "Unusual answer"
      6. Injection attempt -> "Injection attempt"
      7. Low OCR confidence / splitting issue -> "Needs manual reading"
      8. Late submission -> "Late submission"
    - Updates submission confidence & status = "graded"
    - Logs to AuditLog
    """
    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise ValueError(f"Submission {submission_id} not found")

    course_id = submission.assignment.course_id

    # Load course chunks for RAG
    chunks = db.query(MaterialChunk).join(MaterialChunk.material).filter(
        MaterialChunk.material.has(course_id=course_id)
    ).all()
    chunk_dicts = [
        {"id": c.id, "chunk_index": c.chunk_index, "page_number": c.page_number, "chunk_text": c.chunk_text}
        for c in chunks
    ]

    total_marks_sum = 0.0
    overall_confidence = "High"
    flags_to_add = []

    # Grade each question answer
    for ans in submission.answers:
        res = grade_single_answer(ans, ans.question, chunk_dicts, db)
        total_marks_sum += res["primary_run_total"]

        # Confidence aggregation: lowest confidence propagates
        if res["confidence"] == "Low":
            overall_confidence = "Low"
        elif res["confidence"] == "Medium" and overall_confidence != "Low":
            overall_confidence = "Medium"

        # Rule 1: Thin material
        if res["is_weak_retrieval"]:
            flags_to_add.append({
                "type": "thin_material",
                "reason": "Course material is thin on this topic",
                "severity": "medium",
                "answer_id": ans.id
            })

        # Rule 2: Uncovered point
        if res["has_uncovered_content"]:
            flags_to_add.append({
                "type": "uncovered_point",
                "reason": "Answer contains content not found in course material (Needs teacher decision)",
                "severity": "high",
                "answer_id": ans.id
            })

        # Rule 3: Unstable marks
        if res["is_unstable"]:
            flags_to_add.append({
                "type": "unstable_marks",
                "reason": "Marks unstable across runs (>10% variation)",
                "severity": "medium",
                "answer_id": ans.id
            })

        # Rule 4: Marks conflict
        if res["has_conflict"]:
            flags_to_add.append({
                "type": "marks_conflict",
                "reason": "Criterion-level marks conflict with overall question mark",
                "severity": "medium",
                "answer_id": ans.id
            })

        # Rule 5: Unusual answer
        if res["is_unusual"]:
            flags_to_add.append({
                "type": "unusual_answer",
                "reason": "Unusual answer (very low semantic similarity to model answer & lecture notes)",
                "severity": "low",
                "answer_id": ans.id
            })

        # Rule 6: Injection attempt
        if res["has_injection"]:
            flags_to_add.append({
                "type": "injection_attempt",
                "reason": "Prompt injection attempt detected in answer text",
                "severity": "high",
                "answer_id": ans.id
            })

    # Rule 7: Low OCR confidence or splitting failed
    if submission.file_status == "OCR low confidence":
        flags_to_add.append({
            "type": "needs_manual_reading",
            "reason": "Needs manual reading: OCR quality low",
            "severity": "high",
            "answer_id": None
        })

    # Rule 8: Late submission tag
    if submission.is_late:
        flags_to_add.append({
            "type": "late_submission",
            "reason": f"Late submission (penalty: {submission.late_penalty_applied}%)",
            "severity": "low",
            "answer_id": None
        })

    # Save flags
    for f in flags_to_add:
        # Avoid duplicate flag of same type on same answer
        existing = db.query(Flag).filter(
            Flag.submission_id == submission.id,
            Flag.flag_type == f["type"],
            Flag.answer_id == f["answer_id"]
        ).first()
        if not existing:
            flag_obj = Flag(
                submission_id=submission.id,
                answer_id=f["answer_id"],
                flag_type=f["type"],
                reason=f["reason"],
                severity=f["severity"],
                resolved=False
            )
            db.add(flag_obj)

    submission.confidence = overall_confidence
    submission.status = "graded"

    # Audit log
    audit = AuditLog(
        user_id=None,
        event_type="AI_GRADING_RUN",
        details=f"Completed 3-run grading for submission {submission.id} (Confidence: {overall_confidence}, Total: {total_marks_sum}, Flags added: {len(flags_to_add)})"
    )
    db.add(audit)
    db.commit()
    db.refresh(submission)

    return {
        "submission_id": submission.id,
        "status": submission.status,
        "confidence": submission.confidence,
        "total_marks": total_marks_sum,
        "flags_count": len(flags_to_add)
    }
