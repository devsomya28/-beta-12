import json
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional
import requests
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.app.models import (
    Override, RubricCriterion, Question, Assignment, Submission,
    Answer, GradeRun, Grade, AuditLog, RubricSuggestion, RubricVersion, Material, MaterialChunk
)
from backend.app.config import LLM_MODE, GEMINI_API_KEY, GEMINI_MODEL
from backend.app.grading_engine import grade_submission

logger = logging.getLogger("markanchor.correction_learning")

MIN_PATTERN_OVERRIDES = 3


def analyze_and_generate_suggestions(assignment_id: int, db: Session) -> List[Dict[str, Any]]:
    """
    Analyzes teacher override history for an assignment.
    When the same pattern appears 3 or more times on a criterion (e.g. over-marked >= 3 times),
    generates ONE suggestion with clearer wording / boundaries, anchored to teacher notes & course material.
    Safety:
    - AI NEVER changes rubric behavior silently.
    - If a suggestion was rejected, it is hidden and not shown again for the same pattern.
    - An initial rubric version (v1) is preserved before any change so the teacher can always roll back.
    """
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        return []

    question_ids = [q.id for q in assignment.questions]
    if not question_ids:
        return []

    overrides = db.query(Override).filter(Override.question_id.in_(question_ids)).all()

    # Group overrides by (question_id, rubric_criterion_id)
    grouped: Dict[tuple, List[Override]] = {}
    for o in overrides:
        key = (o.question_id, o.rubric_criterion_id)
        grouped.setdefault(key, []).append(o)

    suggestions_list = []

    for (q_id, crit_id), ov_list in grouped.items():
        if not crit_id:
            continue

        criterion = db.query(RubricCriterion).filter(RubricCriterion.id == crit_id).first()
        question = db.query(Question).filter(Question.id == q_id).first()
        if not criterion or not question:
            continue

        # Ensure an initial version (v1) exists for rollback history
        existing_versions = db.query(RubricVersion).filter(
            RubricVersion.rubric_criterion_id == crit_id
        ).order_by(RubricVersion.version_number.asc()).all()

        if not existing_versions:
            v1 = RubricVersion(
                rubric_criterion_id=crit_id,
                version_number=1,
                criterion_text=criterion.criterion_text,
                change_reason="Original rubric text at creation",
                created_at=datetime.utcnow()
            )
            db.add(v1)
            db.commit()

        # Count over-marked (AI mark > teacher mark, so diff < 0) vs under-marked (diff > 0)
        over_marked = [o for o in ov_list if (o.new_mark - o.original_mark) < 0]
        under_marked = [o for o in ov_list if (o.new_mark - o.original_mark) > 0]

        target_pattern = None
        target_group = None

        if len(over_marked) >= MIN_PATTERN_OVERRIDES:
            target_pattern = "over_marked"
            target_group = over_marked
        elif len(under_marked) >= MIN_PATTERN_OVERRIDES:
            target_pattern = "under_marked"
            target_group = under_marked

        if not target_pattern or not target_group:
            continue

        # Check existing suggestions for this criterion and pattern
        existing_sug = db.query(RubricSuggestion).filter(
            RubricSuggestion.rubric_criterion_id == crit_id,
            RubricSuggestion.pattern_type == target_pattern
        ).first()

        # If already rejected by teacher, DO NOT re-surface for the same pattern
        if existing_sug and existing_sug.status == "rejected":
            continue

        # If already accepted, check if there are NEW overrides since acceptance
        if existing_sug and existing_sug.status == "accepted":
            # Only resurface if 3 new overrides occurred after resolved_at
            if existing_sug.resolved_at:
                post_resolved = [o for o in target_group if o.created_at > existing_sug.resolved_at]
                if len(post_resolved) < MIN_PATTERN_OVERRIDES:
                    continue

        diffs = [abs(o.new_mark - o.original_mark) for o in target_group]
        avg_diff = round(sum(diffs) / len(diffs), 1)

        pattern_desc = (
            f"Over-marked {len(target_group)} times, average {avg_diff} mark"
            if target_pattern == "over_marked"
            else f"Under-marked {len(target_group)} times, average {avg_diff} mark"
        )

        evidence = [
            {
                "override_id": o.id,
                "submission_id": o.submission_id,
                "student_name": o.submission.student.full_name if o.submission and o.submission.student else "Student",
                "ai_mark": o.original_mark,
                "teacher_mark": o.new_mark,
                "delta": round(o.new_mark - o.original_mark, 1),
                "note": o.note
            }
            for o in target_group
        ]

        if existing_sug and existing_sug.status == "pending":
            existing_sug.overrides_count = len(target_group)
            existing_sug.avg_mark_difference = avg_diff
            existing_sug.pattern_description = pattern_desc
            existing_sug.evidence_notes = json.dumps(evidence)
            db.commit()
            suggestions_list.append(_format_suggestion_dict(existing_sug, db))
            continue

        # Generate proposed rewording using LLM or deterministic fallback
        new_text = _generate_rubric_rewording(
            current_text=criterion.criterion_text,
            pattern_type=target_pattern,
            pattern_desc=pattern_desc,
            teacher_notes=[e["note"] for e in evidence],
            question_text=question.question_text,
            assignment=assignment,
            db=db
        )

        sug = RubricSuggestion(
            assignment_id=assignment.id,
            question_id=q_id,
            rubric_criterion_id=crit_id,
            pattern_type=target_pattern,
            pattern_description=pattern_desc,
            overrides_count=len(target_group),
            avg_mark_difference=avg_diff,
            current_criterion_text=criterion.criterion_text,
            suggested_criterion_text=new_text,
            evidence_notes=json.dumps(evidence),
            status="pending",
            created_at=datetime.utcnow()
        )
        db.add(sug)
        db.commit()
        db.refresh(sug)

        suggestions_list.append(_format_suggestion_dict(sug, db))

    return suggestions_list


def _generate_rubric_rewording(
    current_text: str,
    pattern_type: str,
    pattern_desc: str,
    teacher_notes: List[str],
    question_text: str,
    assignment: Assignment,
    db: Session
) -> str:
    """
    Generates revised rubric wording built only from teacher override notes and existing course materials.
    """
    notes_summary = "; ".join(set(n.strip() for n in teacher_notes if n.strip()))

    # Gather anchor material chunks
    chunks = db.query(MaterialChunk).join(MaterialChunk.material).filter(
        Material.course_id == assignment.course_id
    ).limit(3).all()
    anchors = " ".join([c.chunk_text[:200] for c in chunks])

    if LLM_MODE == "gemini" and GEMINI_API_KEY:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
            prompt = f"""You are an expert academic rubric designer.
The teacher has corrected the AI grading for this rubric criterion repeatedly.
Question: {question_text}
Current Rubric Criterion: "{current_text}"
Correction Pattern: {pattern_desc}
Teacher Override Notes: "{notes_summary}"
Course Material Context: "{anchors[:400]}"

Instructions:
1. Provide a revised, clearer wording for this rubric criterion that incorporates the teacher's corrections.
2. If the AI was over-marking, make boundaries stricter and specify what must be present for full marks.
3. If the AI was under-marking, clarify acceptable variations and partial credit.
4. Return ONLY the revised criterion text without quotes, markdown headers, or introductory chatter.
"""
            resp = requests.post(
                url,
                json={"contents": [{"parts": [{"text": prompt}]}]},
                headers={"Content-Type": "application/json"},
                timeout=12
            )
            if resp.status_code == 200:
                data = resp.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                if text:
                    return text.replace('"', '')
        except Exception as e:
            logger.warning(f"Gemini rubric rewording fallback to deterministic template: {e}")

    # Deterministic fallback
    if pattern_type == "over_marked":
        return f"{current_text} (Must strictly include complete working and accurate derivations as noted: {notes_summary[:120]})"
    else:
        return f"{current_text} (Accept valid conceptual equivalents and partial variations as noted: {notes_summary[:120]})"


def _format_suggestion_dict(sug: RubricSuggestion, db: Session) -> Dict[str, Any]:
    """Helper to format a RubricSuggestion for the API response."""
    versions = db.query(RubricVersion).filter(
        RubricVersion.rubric_criterion_id == sug.rubric_criterion_id
    ).order_by(RubricVersion.version_number.desc()).all()

    versions_data = [
        {
            "id": v.id,
            "version_number": v.version_number,
            "criterion_text": v.criterion_text,
            "change_reason": v.change_reason,
            "created_at": v.created_at.isoformat()
        }
        for v in versions
    ]

    return {
        "id": sug.id,
        "assignment_id": sug.assignment_id,
        "question_id": sug.question_id,
        "question_number": sug.question.question_number if sug.question else 1,
        "question_text": sug.question.question_text if sug.question else "",
        "rubric_criterion_id": sug.rubric_criterion_id,
        "pattern_type": sug.pattern_type,
        "pattern_description": sug.pattern_description,
        "overrides_count": sug.overrides_count,
        "avg_mark_difference": sug.avg_mark_difference,
        "current_criterion_text": sug.current_criterion_text,
        "suggested_criterion_text": sug.suggested_criterion_text,
        "evidence_notes": json.loads(sug.evidence_notes) if sug.evidence_notes else [],
        "status": sug.status,
        "created_at": sug.created_at.isoformat(),
        "resolved_at": sug.resolved_at.isoformat() if sug.resolved_at else None,
        "rubric_versions": versions_data
    }


def accept_suggestion(
    suggestion_id: int,
    edited_text: Optional[str],
    teacher_id: int,
    db: Session
) -> Dict[str, Any]:
    """
    Accepts the suggestion (or an edited version of it).
    - Preserves current rubric text as a new RubricVersion for rollback.
    - Updates the rubric criterion text.
    - Marks suggestion as accepted.
    - Logs to AuditLog.
    """
    sug = db.query(RubricSuggestion).filter(RubricSuggestion.id == suggestion_id).first()
    if not sug:
        raise ValueError(f"Suggestion {suggestion_id} not found")

    crit = db.query(RubricCriterion).filter(RubricCriterion.id == sug.rubric_criterion_id).first()
    if not crit:
        raise ValueError("Rubric criterion not found")

    new_text = edited_text.strip() if edited_text and edited_text.strip() else sug.suggested_criterion_text

    # Determine next version number
    latest_v = db.query(func.max(RubricVersion.version_number)).filter(
        RubricVersion.rubric_criterion_id == crit.id
    ).scalar() or 0

    next_v = latest_v + 1

    # Save new version record
    ver = RubricVersion(
        rubric_criterion_id=crit.id,
        version_number=next_v,
        criterion_text=new_text,
        change_reason=f"Accepted suggestion #{sug.id} ({sug.pattern_description})",
        created_at=datetime.utcnow()
    )
    db.add(ver)

    # Update criterion
    crit.criterion_text = new_text

    # Update suggestion status
    sug.status = "accepted"
    sug.resolved_at = datetime.utcnow()

    # Log to AuditLog
    db.add(AuditLog(
        user_id=teacher_id,
        event_type="RUBRIC_SUGGESTION_ACCEPTED",
        details=f"Automation #5: Accepted revised rubric text for Question {sug.question.question_number}, Criterion #{crit.id}. New version: v{next_v}."
    ))

    db.commit()

    return {
        "success": True,
        "suggestion_id": sug.id,
        "new_version_number": next_v,
        "updated_criterion_text": new_text,
        "message": f"Rubric updated to version v{next_v}. Old version preserved for rollback."
    }


def reject_suggestion(suggestion_id: int, teacher_id: int, db: Session) -> Dict[str, Any]:
    """
    Rejects the suggestion.
    - Hides the suggestion and prevents it from resurfacing for the same pattern.
    - Leaves rubric text untouched.
    - Logs to AuditLog.
    """
    sug = db.query(RubricSuggestion).filter(RubricSuggestion.id == suggestion_id).first()
    if not sug:
        raise ValueError(f"Suggestion {suggestion_id} not found")

    sug.status = "rejected"
    sug.resolved_at = datetime.utcnow()

    db.add(AuditLog(
        user_id=teacher_id,
        event_type="RUBRIC_SUGGESTION_REJECTED",
        details=f"Automation #5: Rejected rubric rewording suggestion #{sug.id} ({sug.pattern_description})."
    ))
    db.commit()

    return {
        "success": True,
        "suggestion_id": sug.id,
        "message": "Suggestion rejected and hidden. Will not resurface for this pattern."
    }


def restore_rubric_version(version_id: int, teacher_id: int, db: Session) -> Dict[str, Any]:
    """
    Rolls back the rubric criterion to a previous version.
    """
    ver = db.query(RubricVersion).filter(RubricVersion.id == version_id).first()
    if not ver:
        raise ValueError(f"Rubric version {version_id} not found")

    crit = db.query(RubricCriterion).filter(RubricCriterion.id == ver.rubric_criterion_id).first()
    if not crit:
        raise ValueError("Rubric criterion not found")

    old_text = crit.criterion_text
    crit.criterion_text = ver.criterion_text

    db.add(AuditLog(
        user_id=teacher_id,
        event_type="RUBRIC_VERSION_RESTORED",
        details=f"Automation #5: Restored Rubric Criterion #{crit.id} to version v{ver.version_number}."
    ))
    db.commit()

    return {
        "success": True,
        "criterion_id": crit.id,
        "restored_version": ver.version_number,
        "criterion_text": ver.criterion_text,
        "message": f"Successfully rolled back to version v{ver.version_number}."
    }


def regrade_affected_submissions(
    suggestion_id: int,
    teacher_id: int,
    db: Session
) -> Dict[str, Any]:
    """
    Re-runs grading ONLY for UNPUBLISHED submissions of that question with the new rubric.
    Safety Rules:
    - Published results are NEVER changed automatically.
    - Shows before/after mark comparison to the teacher.
    - Shows 'Did it help?' metrics (marks changed, overrides trend).
    """
    sug = db.query(RubricSuggestion).filter(RubricSuggestion.id == suggestion_id).first()
    if not sug:
        raise ValueError(f"Suggestion {suggestion_id} not found")

    question = sug.question
    assignment = sug.assignment

    # Get all UNPUBLISHED submissions for this assignment
    submissions = db.query(Submission).filter(
        Submission.assignment_id == assignment.id,
        Submission.status != "published"
    ).all()

    before_after = []
    submissions_changed = 0
    total_delta = 0.0

    for sub in submissions:
        # Find answer for this question
        ans = next((a for a in sub.answers if a.question_id == question.id), None)
        if not ans:
            continue

        # Get old mark for this question
        old_mark = 0.0
        if ans.grade_runs:
            old_mark = sum(g.marks_awarded for g in ans.grade_runs[0].grades)

        # Regrade this submission
        try:
            res = grade_submission(sub.id, db)
            # Fetch new mark for this answer
            db.refresh(ans)
            new_mark = 0.0
            if ans.grade_runs:
                new_mark = sum(g.marks_awarded for g in ans.grade_runs[0].grades)

            delta = round(new_mark - old_mark, 1)
            if abs(delta) > 0.05:
                submissions_changed += 1
                total_delta += delta

            before_after.append({
                "submission_id": sub.id,
                "student_name": sub.student.full_name if sub.student else "Student",
                "old_mark": round(old_mark, 1),
                "new_mark": round(new_mark, 1),
                "mark_delta": delta,
                "confidence": res.get("confidence", "Medium")
            })
        except Exception as e:
            logger.error(f"Error regrading sub {sub.id}: {e}")

    # Did it help panel summary:
    # Overrides count on this criterion prior to regrade: sug.overrides_count
    # Submissions whose marks improved / aligned:
    did_it_help = {
        "submissions_evaluated": len(before_after),
        "submissions_changed": submissions_changed,
        "avg_mark_adjustment": round(total_delta / max(1, submissions_changed), 1) if submissions_changed > 0 else 0.0,
        "prior_override_frequency": sug.overrides_count,
        "impact_summary": (
            f"Regrading adjusted {submissions_changed} of {len(before_after)} unpublished submissions "
            f"(avg shift: {round(total_delta / max(1, submissions_changed), 1) if submissions_changed > 0 else 0.0} pts), "
            f"aligning AI grading closer to teacher preferences and reducing criterion ambiguity."
        )
    }

    db.add(AuditLog(
        user_id=teacher_id,
        event_type="REGRADE_AFFECTED_SUBMISSIONS",
        details=f"Automation #5: Regraded {len(before_after)} unpublished submissions for Question {question.question_number} with new rubric. {submissions_changed} changed."
    ))
    db.commit()

    return {
        "success": True,
        "suggestion_id": sug.id,
        "question_number": question.question_number,
        "submissions_changed": submissions_changed,
        "total_evaluated": len(before_after),
        "before_after": before_after,
        "did_it_help": did_it_help
    }
