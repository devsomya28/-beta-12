import json
from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session
from backend.app.risk_config import RISK_WEIGHTS, RISK_BANDS


def compute_submission_risk_score(
    submission: Any,
    answer_results: Optional[List[Dict[str, Any]]] = None,
    db: Optional[Session] = None
) -> Dict[str, Any]:
    """
    Computes a weighted risk score (0-100) for a submission.
    Inputs:
    - retrieval similarity (low = risky)
    - 3-run variance (high = risky)
    - OCR confidence (low = risky)
    - injection flag (+35)
    - uncovered-point flag (+20)
    - marks-conflict flag (+15)
    - unusual-answer flag (+10)
    - late tag (small weight: +5)

    Returns:
    {
        "score": float (0-100),
        "band": "High" | "Medium" | "Low",
        "breakdown": [
            {"factor": "INJECTION_ATTEMPT", "points": 35.0, "reason": "Injection attempt (+35)"},
            ...
        ],
        "top_reasons_summary": "Injection attempt (+35), Low OCR confidence (+20)"
    }
    """
    breakdown: List[Dict[str, Any]] = []

    # 1. Prompt Injection Detection
    has_injection = False
    if answer_results:
        has_injection = any(res.get("has_injection") for res in answer_results)
    if not has_injection and hasattr(submission, "answers"):
        has_injection = any(getattr(a, "injection_detected", False) for a in submission.answers)
    if not has_injection and hasattr(submission, "flags"):
        has_injection = any(f.flag_type == "injection_attempt" for f in submission.flags)

    if has_injection:
        breakdown.append({
            "factor": "INJECTION_ATTEMPT",
            "points": RISK_WEIGHTS["INJECTION_ATTEMPT"],
            "reason": f"Injection attempt (+{int(RISK_WEIGHTS['INJECTION_ATTEMPT'])})"
        })

    # 2. OCR Quality / File Status
    has_low_ocr = False
    if getattr(submission, "file_status", "") == "OCR low confidence":
        has_low_ocr = True
    if not has_low_ocr and hasattr(submission, "flags"):
        has_low_ocr = any(f.flag_type == "needs_manual_reading" for f in submission.flags)

    if has_low_ocr:
        breakdown.append({
            "factor": "LOW_OCR_CONFIDENCE",
            "points": RISK_WEIGHTS["LOW_OCR_CONFIDENCE"],
            "reason": f"Low OCR confidence (+{int(RISK_WEIGHTS['LOW_OCR_CONFIDENCE'])})"
        })

    # 3. Uncovered / Out of Syllabus Point
    has_uncovered = False
    if answer_results:
        has_uncovered = any(res.get("has_uncovered_content") for res in answer_results)
    if not has_uncovered and hasattr(submission, "flags"):
        has_uncovered = any(f.flag_type == "uncovered_point" for f in submission.flags)

    if has_uncovered:
        breakdown.append({
            "factor": "UNCOVERED_POINT",
            "points": RISK_WEIGHTS["UNCOVERED_POINT"],
            "reason": f"Uncovered syllabus point (+{int(RISK_WEIGHTS['UNCOVERED_POINT'])})"
        })

    # 4. 3-Run Grading Variance / Instability
    is_unstable = False
    if answer_results:
        is_unstable = any(res.get("is_unstable") for res in answer_results)
    if not is_unstable and getattr(submission, "confidence", "") == "Low":
        is_unstable = True
    if not is_unstable and hasattr(submission, "flags"):
        is_unstable = any(f.flag_type == "unstable_marks" for f in submission.flags)

    if is_unstable:
        breakdown.append({
            "factor": "THREE_RUN_VARIANCE",
            "points": RISK_WEIGHTS["THREE_RUN_VARIANCE"],
            "reason": f"3-run variance high (+{int(RISK_WEIGHTS['THREE_RUN_VARIANCE'])})"
        })

    # 5. Weak Course Retrieval / Thin Material
    weak_retrieval = False
    if answer_results:
        weak_retrieval = any(res.get("is_weak_retrieval") for res in answer_results)
    if not weak_retrieval and hasattr(submission, "flags"):
        weak_retrieval = any(f.flag_type == "thin_material" for f in submission.flags)

    if weak_retrieval:
        breakdown.append({
            "factor": "WEAK_RETRIEVAL",
            "points": RISK_WEIGHTS["WEAK_RETRIEVAL"],
            "reason": f"Weak course retrieval (+{int(RISK_WEIGHTS['WEAK_RETRIEVAL'])})"
        })

    # 6. Marks Conflict
    has_conflict = False
    if answer_results:
        has_conflict = any(res.get("has_conflict") for res in answer_results)
    if not has_conflict and hasattr(submission, "flags"):
        has_conflict = any(f.flag_type == "marks_conflict" for f in submission.flags)

    if has_conflict:
        breakdown.append({
            "factor": "MARKS_CONFLICT",
            "points": RISK_WEIGHTS["MARKS_CONFLICT"],
            "reason": f"Marks conflict (+{int(RISK_WEIGHTS['MARKS_CONFLICT'])})"
        })

    # 7. Unusual Answer Structure
    is_unusual = False
    if answer_results:
        is_unusual = any(res.get("is_unusual") for res in answer_results)
    if not is_unusual and hasattr(submission, "flags"):
        is_unusual = any(f.flag_type == "unusual_answer" for f in submission.flags)

    if is_unusual:
        breakdown.append({
            "factor": "UNUSUAL_ANSWER",
            "points": RISK_WEIGHTS["UNUSUAL_ANSWER"],
            "reason": f"Unusual answer (+{int(RISK_WEIGHTS['UNUSUAL_ANSWER'])})"
        })

    # 8. Late Submission Tag (Small Weight)
    if getattr(submission, "is_late", False):
        breakdown.append({
            "factor": "LATE_SUBMISSION",
            "points": RISK_WEIGHTS["LATE_SUBMISSION"],
            "reason": f"Late submission (+{int(RISK_WEIGHTS['LATE_SUBMISSION'])})"
        })

    # 9. Phase B: Alternative Method Flag
    has_alt_method = False
    if hasattr(submission, "flags"):
        has_alt_method = any(f.flag_type == "alternative_method" for f in submission.flags)
    if has_alt_method:
        breakdown.append({
            "factor": "ALTERNATIVE_METHOD",
            "points": RISK_WEIGHTS.get("ALTERNATIVE_METHOD", 25.0),
            "reason": f"Alternative method: external verification (+{int(RISK_WEIGHTS.get('ALTERNATIVE_METHOD', 25.0))})"
        })

    # Sum and clamp to 0-100
    raw_score = sum(item["points"] for item in breakdown)
    final_score = min(100.0, max(0.0, round(raw_score, 1)))

    # Determine risk band
    if final_score >= RISK_BANDS["HIGH_THRESHOLD"]:
        band = "High"
    elif final_score >= RISK_BANDS["MEDIUM_THRESHOLD"]:
        band = "Medium"
    else:
        band = "Low"

    # Top reasons (sorted by highest point value first)
    sorted_reasons = sorted(breakdown, key=lambda x: x["points"], reverse=True)
    top_reasons_list = [r["reason"] for r in sorted_reasons[:3]]
    top_reasons_summary = ", ".join(top_reasons_list) if top_reasons_list else "Clean submission (low risk)"

    return {
        "score": final_score,
        "band": band,
        "breakdown": breakdown,
        "top_reasons_summary": top_reasons_summary,
        "top_reasons_list": top_reasons_list
    }
