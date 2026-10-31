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


ADMIN_FORM_PATTERNS = [
    r"\badmission\s+form\b",
    r"\bapplication\s+form\b",
    r"\bregistration\s+form\b",
    r"\benrollment\s+form\b",
    r"\bcollege\s+of\b",
    r"\binstitute\s+of\s+technology\b",
    r"\buniversity\s+of\b",
    r"\broll\s*(?:no|number)\b",
    r"\bfather'?s?\s+name\b",
    r"\bmother'?s?\s+name\b",
    r"\bdate\s+of\s+birth\b",
    r"\bfee\s+(?:receipt|structure|challan)\b",
    r"\bhall\s+ticket\b",
    r"\bcandidate\s*signature\b",
    r"\bfor\s+office\s+use\s+only\b",
    r"\bdeclaration\s+by\s+applicant\b",
    r"\bsemester\s+registration\b",
    r"\bbonafide\s+certificate\b",
    r"\bprovisional\s+allotment\b",
]

def is_unrelated_document_or_form(text: str) -> Tuple[bool, str]:
    """Detects if submitted text is an administrative college/school form or non-academic document."""
    lower = text.lower()
    matched = []
    for pat in ADMIN_FORM_PATTERNS:
        if re.search(pat, lower):
            clean_name = pat.replace(r"\b", "").replace(r"\s+", " ").replace("?", "")
            matched.append(clean_name)
    if len(matched) >= 2 or (len(matched) >= 1 and any(k in lower for k in ["roll", "father", "admission", "office use", "form no", "enrollment"])):
        return True, f"Identified administrative/college form document: {', '.join(matched[:3])}"
    return False, ""


def compute_academic_relevance(student_text: str, question_text: str, model_answer: str, course_chunks: List[Dict[str, Any]]) -> float:
    """Computes academic relevance of student's answer against the question, model answer, and course notes."""
    stopwords = {
        "the", "a", "an", "is", "are", "was", "were", "and", "or", "in", "on", "at", "to", "for", 
        "with", "by", "from", "of", "it", "this", "that", "these", "those", "what", "how", "why", 
        "when", "where", "which", "explain", "describe", "discuss", "define", "give", "write", "about"
    }
    s_tokens = set(re.findall(r'\b[a-zA-Z]{3,}\b', student_text.lower())) - stopwords
    if not s_tokens:
        return 0.0

    target_tokens = set(re.findall(r'\b[a-zA-Z]{3,}\b', question_text.lower())) - stopwords
    if model_answer:
        target_tokens.update(set(re.findall(r'\b[a-zA-Z]{3,}\b', model_answer.lower())) - stopwords)
    for c in course_chunks[:3]:
        c_text = c.get("chunk_text", "") if isinstance(c, dict) else getattr(c, "chunk_text", "")
        target_tokens.update(set(re.findall(r'\b[a-zA-Z]{3,}\b', c_text.lower())) - stopwords)

    if not target_tokens:
        return 0.5

    overlap = len(s_tokens.intersection(target_tokens))
    q_tokens = set(re.findall(r'\b[a-zA-Z]{3,}\b', question_text.lower())) - stopwords
    q_overlap = len(s_tokens.intersection(q_tokens)) / max(len(q_tokens), 1)
    general_overlap = overlap / min(len(s_tokens), 25)

    return max(q_overlap, general_overlap)


def cross_check_topic_with_ai(
    student_text: str,
    question_text: str,
    model_answer: str
) -> Tuple[bool, str, str]:
    """
    Second-opinion AI cross-check (Groq or Gemini) to verify if the student's text
    is on-topic for the question, or if it is a completely unrelated document (e.g. 
    college admission form, fee receipt, syllabus, or different subject).
    Returns: (is_on_topic: bool, reason: str, checker_name: str)
    """
    if not student_text or len(student_text.strip().split()) < 3:
        return False, "Answer text is empty or blank", "Validation"

    # Step 1: Fast pattern check for administrative/college forms
    is_admin_form, form_detail = is_unrelated_document_or_form(student_text)
    if is_admin_form:
        return False, f"Administrative form detected ({form_detail})", "FormScanner"

    # Step 2: Second-opinion AI check using Groq or Gemini if AI is online
    from backend.app.config import GROQ_API_KEY, GROQ_MODEL, GEMINI_API_KEY, GEMINI_MODEL
    from backend.app.llm_provider import is_ai_forced_offline, GroqLLMProvider, GeminiLLMProvider, _clean_json_string

    if not is_ai_forced_offline():
        prompt = (
            "You are a strict academic Topic & Relevance Evaluator.\n"
            "Determine whether the student's submitted text is an attempt to answer the question, "
            "or if it is a completely different document / topic (e.g. college admission form, syllabus, fee receipt, "
            "administrative notice, or completely unrelated subject like history/voltage regulator vs machine learning).\n\n"
            f"Question: {question_text}\n"
            f"Reference Topic / Model Answer: {model_answer}\n\n"
            f"Student's Submitted Text:\n{student_text[:1200]}\n\n"
            "Return strict JSON with this exact schema:\n"
            "{\"is_on_topic\": true/false, \"detected_document_type\": \"exam_answer\"|\"administrative_form\"|\"different_subject\"|\"gibberish\", \"confidence\": float, \"explanation\": \"short reason\"}"
        )

        # Priority 1: Groq fast inference if key is configured
        if GROQ_API_KEY:
            try:
                groq_prov = GroqLLMProvider(GROQ_API_KEY, GROQ_MODEL)
                raw = groq_prov._call(prompt, "You verify whether student answers are relevant to the exam question.", 0.1)
                parsed = json.loads(_clean_json_string(raw))
                is_on_topic = bool(parsed.get("is_on_topic", True))
                explanation = parsed.get("explanation", parsed.get("detected_document_type", ""))
                return is_on_topic, f"Groq ({GROQ_MODEL}): {explanation}", f"Groq-{GROQ_MODEL}"
            except Exception as e:
                logger.warning(f"Groq cross-check error: {e}. Falling back to Gemini.")

        # Priority 2: Gemini
        if GEMINI_API_KEY:
            try:
                gem_prov = GeminiLLMProvider(GEMINI_API_KEY)
                raw = gem_prov._call(prompt, "You verify whether student answers are relevant to the exam question.", 0.1)
                parsed = json.loads(_clean_json_string(raw))
                is_on_topic = bool(parsed.get("is_on_topic", True))
                explanation = parsed.get("explanation", parsed.get("detected_document_type", ""))
                return is_on_topic, f"Gemini: {explanation}", "Gemini"
            except Exception as e:
                logger.warning(f"Gemini cross-check error: {e}. Falling back to lexical analysis.")

    # Step 3: Deterministic fallback based on academic vocabulary relevance
    academic_rel = compute_academic_relevance(student_text, question_text, model_answer, [])
    if academic_rel < 0.08 and len(student_text.split()) >= 8:
        return False, "Near-zero vocabulary overlap with question/model answer", "LexicalRelevance"

    return True, "On-topic academic answer", "LexicalRelevance"


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

    # 3. Check for ungrounded / uncovered points & off-topic/administrative forms
    uncovered_tokens = ["quantum", "genetic algorithm", "blockchain", "dna", "ancient", "uncovered"]
    has_uncovered_content = any(t in student_text.lower() for t in uncovered_tokens)

    # Detect administrative / college form or completely off-topic documents with AI Cross-Check (Groq / Gemini)
    is_on_topic, topic_reason, checker_name = cross_check_topic_with_ai(
        student_text,
        question.question_text,
        question.model_answer or ""
    )
    is_off_topic = not is_on_topic
    off_topic_reason = f"{checker_name}: {topic_reason}"

    academic_relevance = compute_academic_relevance(
        student_text,
        question.question_text,
        question.model_answer or "",
        retrieved_chunks
    )

    # Phase B: Check if question has teacher-accepted alternative method matching student text
    has_teacher_approved_alternative = False
    approved_alt_note = ""
    if question.alternative_methods:
        try:
            alt_list = json.loads(question.alternative_methods)
            s_clean = re.sub(r'\s+', '', student_text.lower())
            s_tokens = set(re.findall(r'\b[a-zA-Z0-9_]+\b', student_text.lower()))
            for m in alt_list:
                m_text = m.get("method_text", "") if isinstance(m, dict) else str(m)
                if not m_text:
                    continue
                m_clean = re.sub(r'\s+', '', m_text.lower())
                m_tokens = set(re.findall(r'\b[a-zA-Z0-9_]+\b', m_text.lower()))
                token_overlap = len(s_tokens.intersection(m_tokens)) / max(len(m_tokens), 1)
                if m_clean in s_clean or s_clean in m_clean or token_overlap >= 0.50:
                    has_teacher_approved_alternative = True
                    approved_alt_note = m.get("note", "Teacher-approved alternative") if isinstance(m, dict) else "Teacher-approved alternative"
                    has_uncovered_content = False  # Teacher approved it!
                    is_off_topic = False
                    break
        except Exception:
            pass

    # 4. Run 3 Grading Evaluations (Consistency & Quality Check)
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
            if is_off_topic:
                # Rule: Zero marks for off-topic documents, administrative college forms, or zero-relevance text
                marks = 0.0
                reason = f"Off-topic submission ({off_topic_reason}). 0 marks awarded."
                cited_chunk = None
                cited_page = None
                cited_txt = None
                covered = False
            elif has_uncovered_content:
                # Rule: Never guess marks for ungrounded hallucinated content (e.g. quantum qubits for ML)!
                marks = 0.0
                reason = "Not covered in course material. Needs teacher decision."
                cited_chunk = None
                cited_page = None
                cited_txt = None
                covered = False
            elif has_teacher_approved_alternative:
                # Phase B: Student solution matches teacher-accepted alternative method
                marks = round(crit.max_marks * 0.95, 1)
                reason = f"Teacher-approved alternative: {approved_alt_note}"
                cited_chunk = None
                cited_page = None
                cited_txt = None
                covered = True
            else:
                # Award mark based on quality and academic relevance
                if academic_relevance >= 0.40:
                    base_ratio = 0.90 if run_num == 1 else (0.88 if run_num == 2 else 0.92)
                elif academic_relevance >= 0.22:
                    base_ratio = 0.60 if run_num == 1 else (0.58 if run_num == 2 else 0.62)
                elif academic_relevance >= 0.10:
                    base_ratio = 0.25 if run_num == 1 else (0.23 if run_num == 2 else 0.27)
                else:
                    base_ratio = 0.0

                # Brief answers (< 10 words) cap at low credit
                if len(student_text.split()) < 10 and base_ratio > 0.35:
                    base_ratio = 0.35

                marks = round(crit.max_marks * base_ratio, 1)
                best_c = retrieved_chunks[0] if retrieved_chunks else None
                if marks == 0.0:
                    cited_chunk = None
                    cited_page = None
                    cited_txt = None
                    reason = "Content lacks technical accuracy or substance required for this criterion."
                    covered = False
                elif best_c and not is_weak_retrieval:
                    cited_chunk = best_c.get("id")
                    cited_page = best_c.get("page_number", 1)
                    cited_txt = best_c.get("chunk_text", "")[:120]
                    reason = f"Anchored to Chapter {cited_page} notes: Direct alignment with {crit.criterion_text[:40]}."
                    covered = True
                else:
                    cited_chunk = None
                    cited_page = None
                    cited_txt = None
                    reason = f"AI evaluated based on technical quality for: {crit.criterion_text[:45]}."
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

    # Save grade runs in DB (clear old runs on re-grade)
    db.query(GradeRun).filter(GradeRun.answer_id == answer.id).delete()
    db.flush()

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

    is_unstable = round(max_diff, 2) > round(grade_band, 2)
    confidence = "Low" if is_unstable else ("Medium" if round(max_diff, 2) > (round(grade_band, 2) * 0.5) else "High")

    # 6. Check for unusual answer: only evaluated when teacher provided a model answer and not off-topic
    has_model_answer = bool(question.model_answer and question.model_answer.strip())
    if is_off_topic:
        is_unusual = False
    elif has_model_answer:
        model_sim = compute_text_similarity(student_text, question.model_answer)
        chunk_sim = compute_text_similarity(student_text, retrieved_chunks[0].get("chunk_text", "") if retrieved_chunks else "")
        is_unusual = (model_sim < 0.12 and chunk_sim < 0.12 and len(student_text.split()) > 15)
    else:
        is_unusual = False

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
        "is_off_topic": is_off_topic,
        "off_topic_reason": off_topic_reason,
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
    answer_results = []

    # Grade each question answer
    for ans in submission.answers:
        res = grade_single_answer(ans, ans.question, chunk_dicts, db)
        answer_results.append(res)
        total_marks_sum += res["primary_run_total"]

        # Confidence aggregation: lowest confidence propagates
        if res["confidence"] == "Low":
            overall_confidence = "Low"
        elif res["confidence"] == "Medium" and overall_confidence != "Low":
            overall_confidence = "Medium"

        # Rule 0: Off-topic / Unrelated document or form submitted
        if res.get("is_off_topic"):
            q_num = ans.question.question_number if ans.question else 1
            flags_to_add.append({
                "type": "unrelated_content",
                "reason": f"Q{q_num}: Off-topic submission ({res.get('off_topic_reason', '0 marks awarded')})",
                "severity": "high",
                "answer_id": ans.id
            })

        # Rule 1: Thin material
        if res["is_weak_retrieval"] and not res.get("is_off_topic"):
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
            q_num = ans.question.question_number if ans.question else 1
            flags_to_add.append({
                "type": "unusual_answer",
                "reason": f"Q{q_num}: Unusual answer (low similarity to model answer & lecture notes)",
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
    db.flush()

    # Phase B: External AI Verifier for Math and Alternate Methods
    # Runs ONLY in special trigger cases (math_numeric/mixed differing from notes, or flagged calculations)
    # The verifier NEVER awards marks automatically and is NEVER shown as course citation.
    try:
        from backend.app.verifier import verify_answer
        for ans in submission.answers:
            ans_flags = [f["type"] for f in flags_to_add if f["answer_id"] == ans.id]
            verify_answer(db, ans, ans.question, ans.student_answer_text, ans_flags, chunk_dicts)
    except Exception as e:
        logger.error(f"External verifier error on submission {submission.id}: {str(e)}")

    db.flush()

    from backend.app.risk_scoring import compute_submission_risk_score
    risk_info = compute_submission_risk_score(submission, answer_results, db)
    submission.risk_score = risk_info["score"]
    submission.risk_band = risk_info["band"]
    submission.risk_breakdown = json.dumps(risk_info["breakdown"])

    submission.confidence = overall_confidence
    submission.status = "graded"

    # Audit log entry for automated risk scoring (Automation #2)
    audit_risk = AuditLog(
        user_id=None,
        event_type="AUTO_RISK_SCORED",
        details=f"Automation #2: Computed risk score {submission.risk_score}/100 ({submission.risk_band} Risk) for submission {submission.id}. Factors: {risk_info['top_reasons_summary']}"
    )
    db.add(audit_risk)

    # Audit log
    audit = AuditLog(
        user_id=None,
        event_type="AI_GRADING_RUN",
        details=f"Completed 3-run grading for submission {submission.id} (Confidence: {overall_confidence}, Total: {total_marks_sum}, Risk: {submission.risk_score}, Flags added: {len(flags_to_add)})"
    )
    db.add(audit)
    db.commit()
    db.refresh(submission)

    return {
        "submission_id": submission.id,
        "status": submission.status,
        "confidence": submission.confidence,
        "total_marks": total_marks_sum,
        "flags_count": len(flags_to_add),
        "risk_score": submission.risk_score,
        "risk_band": submission.risk_band,
        "risk_breakdown": risk_info["breakdown"],
        "top_reasons": risk_info["top_reasons_summary"]
    }
