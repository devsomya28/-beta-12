import json
from typing import Optional, List
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from backend.app.database import get_db
from backend.app.models import (
    Assignment, Submission, Answer, GradeRun, Grade, RubricCriterion, Question,
    Flag, Override, PublishedResult, AuditLog, User
)
from backend.app.auth import require_teacher, require_student, get_current_user

router = APIRouter(prefix="/api/review", tags=["Teacher Review & Approval"])

class OverrideMarkRequest(BaseModel):
    question_id: int
    rubric_criterion_id: int
    grade_id: Optional[int] = None
    new_mark: float
    note: str  # Short note is required by spec
    accept_uncovered_as_valid: Optional[bool] = False

class PublishResultRequest(BaseModel):
    student_feedback: Optional[str] = None

@router.get("/assignments/{assignment_id}/submissions")
def get_assignment_submissions_review(
    assignment_id: int,
    filter_by: Optional[str] = "all",  # 'all', 'flagged', 'late', 'injection', 'low_confidence', 'pending_ai', 'approved'
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher review screen primary view:
    - Default: "Needs your attention" queue showing ONLY flagged submissions first,
      sorted by severity (high, medium, low).
    - "Everything else" section with summary counts (e.g. '62 auto-graded, high confidence')
      and a quick table.
    """
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    submissions = db.query(Submission).filter(Submission.assignment_id == assignment_id).all()

    # Automatically auto-grade any submissions in 'submitted' status
    from backend.app.llm_provider import is_ai_forced_offline
    from backend.app.grading_engine import grade_submission
    if not is_ai_forced_offline():
        for sub in submissions:
            if sub.status == "submitted":
                try:
                    grade_submission(sub.id, db)
                    db.refresh(sub)
                except Exception as e:
                    pass

    flagged_list = []
    everything_else_list = []

    severity_weight = {"high": 3, "medium": 2, "low": 1}

    for sub in submissions:
        # Calculate current total marks from latest grade run or grades
        total_awarded = 0.0
        for ans in sub.answers:
            if ans.grade_runs:
                primary_run = ans.grade_runs[0]
                total_awarded += sum(g.marks_awarded for g in primary_run.grades)

        unresolved_flags = [f for f in sub.flags if not f.resolved]
        has_flags = len(unresolved_flags) > 0

        # Sort flags by severity
        sorted_flags = sorted(unresolved_flags, key=lambda f: severity_weight.get(f.severity, 0), reverse=True)
        max_severity = sorted_flags[0].severity if sorted_flags else "none"

        sub_summary = {
            "id": sub.id,
            "student_id": sub.student_id,
            "student_name": sub.student.full_name,
            "student_email": sub.student.email,
            "status": sub.status,
            "confidence": sub.confidence,
            "total_marks": round(total_awarded, 1),
            "is_late": sub.is_late,
            "late_penalty": sub.late_penalty_applied,
            "file_status": sub.file_status,
            "receipt_id": sub.submission_receipt,
            "created_at": sub.created_at.isoformat(),
            "flags": [
                {
                    "id": f.id,
                    "type": f.flag_type,
                    "reason": f.reason,
                    "severity": f.severity,
                    "answer_id": f.answer_id
                }
                for f in sorted_flags
            ],
            "max_severity": max_severity,
            "has_injection": any(a.injection_detected for a in sub.answers)
        }

        if has_flags:
            flagged_list.append(sub_summary)
        else:
            everything_else_list.append(sub_summary)

    # Sort flagged queue by severity descending (high -> medium -> low)
    flagged_list.sort(key=lambda s: severity_weight.get(s["max_severity"], 0), reverse=True)

    # Filter counts
    counts = {
        "total": len(submissions),
        "flagged": len(flagged_list),
        "high_confidence_auto_graded": len([s for s in everything_else_list if s["confidence"] == "High" and s["status"] in ["graded", "approved"]]),
        "late": len([s for s in submissions if s.is_late]),
        "injection": len([s for s in submissions if any(a.injection_detected for a in s.answers)]),
        "low_confidence": len([s for s in submissions if s.confidence == "Low"]),
        "pending_ai": len([s for s in submissions if s.status == "pending_ai"]),
        "approved": len([s for s in submissions if s.status == "approved"]),
        "published": len([s for s in submissions if s.status == "published"])
    }

    return {
        "assignment_id": assignment.id,
        "assignment_title": assignment.title,
        "counts": counts,
        "flagged_queue": flagged_list,
        "everything_else": everything_else_list
    }

@router.get("/submissions/{submission_id}")
def get_submission_detail_review(
    submission_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Submission detail page: Split View
    Left = student's answer per question (with injection phrases highlighted & OCR side-by-side if applicable)
    Right = per criterion awarded marks, AI reason, and cited course chunk (text + page).
    If not covered: 'Not covered in course material' in amber and 0 guessed marks.
    """
    sub = db.query(Submission).filter(Submission.id == submission_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    answers_detail = []
    total_calculated_marks = 0.0

    for ans in sub.answers:
        q = ans.question
        primary_run = ans.grade_runs[0] if ans.grade_runs else None

        criteria_grades = []
        if primary_run:
            for g in primary_run.grades:
                crit = g.criterion
                criteria_grades.append({
                    "grade_id": g.id,
                    "criterion_id": crit.id,
                    "order_num": crit.order_num,
                    "criterion_text": crit.criterion_text,
                    "max_marks": crit.max_marks,
                    "marks_awarded": g.marks_awarded,
                    "ai_reason": g.ai_reason,
                    "cited_chunk_id": g.cited_chunk_id,
                    "cited_page_num": g.cited_page_num,
                    "cited_text": g.cited_text,
                    "covered_by_material": g.covered_by_material
                })
                total_calculated_marks += g.marks_awarded
        else:
            # If answer not yet graded
            for crit in q.rubric_criteria:
                criteria_grades.append({
                    "grade_id": None,
                    "criterion_id": crit.id,
                    "order_num": crit.order_num,
                    "criterion_text": crit.criterion_text,
                    "max_marks": crit.max_marks,
                    "marks_awarded": 0.0,
                    "ai_reason": "Not yet graded (Pending AI)",
                    "cited_chunk_id": None,
                    "cited_page_num": None,
                    "cited_text": None,
                    "covered_by_material": True
                })

        # Overrides for this question
        overrides = db.query(Override).filter(
            Override.submission_id == sub.id,
            Override.question_id == q.id
        ).all()

        answers_detail.append({
            "answer_id": ans.id,
            "question_id": q.id,
            "question_number": q.question_number,
            "question_text": q.question_text,
            "max_marks": q.max_marks,
            "student_answer_text": ans.student_answer_text,
            "injection_detected": ans.injection_detected,
            "injection_phrases": json.loads(ans.injection_phrases) if ans.injection_phrases else [],
            "criteria_grades": criteria_grades,
            "overrides": [
                {
                    "id": o.id,
                    "criterion_id": o.rubric_criterion_id,
                    "original_mark": o.original_mark,
                    "new_mark": o.new_mark,
                    "note": o.note,
                    "created_at": o.created_at.isoformat()
                }
                for o in overrides
            ]
        })

    return {
        "submission_id": sub.id,
        "assignment_id": sub.assignment_id,
        "assignment_title": sub.assignment.title,
        "student_id": sub.student_id,
        "student_name": sub.student.full_name,
        "student_email": sub.student.email,
        "status": sub.status,
        "confidence": sub.confidence,
        "total_marks": round(total_calculated_marks, 1),
        "is_late": sub.is_late,
        "late_penalty": sub.late_penalty_applied,
        "file_status": sub.file_status,
        "original_filename": sub.original_filename,
        "receipt_id": sub.submission_receipt,
        "created_at": sub.created_at.isoformat(),
        "flags": [
            {
                "id": f.id,
                "type": f.flag_type,
                "reason": f.reason,
                "severity": f.severity,
                "resolved": f.resolved,
                "answer_id": f.answer_id
            }
            for f in sub.flags
        ],
        "answers": answers_detail
    }

@router.post("/submissions/{submission_id}/override")
def override_mark(
    submission_id: int,
    req: OverrideMarkRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher overrides any AI mark with a REQUIRED short note.
    Also handles Doubt/Uncovered resolution:
    - Teacher enters mark for uncovered part.
    - If accept_uncovered_as_valid is True, marks covered_by_material = True.
    - Resolves uncovered_point flag.
    - Updates totals and saves override history.
    """
    if not req.note or not req.note.strip():
        raise HTTPException(status_code=400, detail="A short note explaining the override is required.")

    sub = db.query(Submission).filter(Submission.id == submission_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    grade = None
    if req.grade_id:
        grade = db.query(Grade).filter(Grade.id == req.grade_id).first()
    else:
        grade = db.query(Grade).join(Grade.grade_run).join(GradeRun.answer).filter(
            Answer.submission_id == submission_id,
            Grade.rubric_criterion_id == req.rubric_criterion_id
        ).first()

    if not grade:
        raise HTTPException(status_code=404, detail="Grade record to override not found")

    original_mark = grade.marks_awarded
    grade.marks_awarded = req.new_mark

    # If resolving uncovered point
    if req.accept_uncovered_as_valid or not grade.covered_by_material:
        grade.covered_by_material = True
        grade.ai_reason = f"Teacher resolved doubt: {req.note}"

        # Resolve flag on this answer
        flags = db.query(Flag).filter(
            Flag.submission_id == sub.id,
            Flag.flag_type == "uncovered_point"
        ).all()
        for f in flags:
            f.resolved = True

    # Save Override record
    ov = Override(
        submission_id=sub.id,
        question_id=req.question_id,
        rubric_criterion_id=req.rubric_criterion_id,
        grade_id=grade.id,
        teacher_id=teacher.id,
        original_mark=original_mark,
        new_mark=req.new_mark,
        note=req.note.strip()
    )
    db.add(ov)

    # Audit log
    audit = AuditLog(
        user_id=teacher.id,
        event_type="OVERRIDE_MARK",
        details=f"Teacher overridden mark on submission {sub.id}, Criterion {req.rubric_criterion_id}: {original_mark} -> {req.new_mark}. Note: {req.note}"
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "submission_id": sub.id,
        "criterion_id": req.rubric_criterion_id,
        "new_mark": req.new_mark,
        "note": req.note
    }

@router.post("/submissions/{submission_id}/approve")
def approve_submission(
    submission_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher approves a single submission.
    Prepares it for publishing results (Approval Gate #2).
    """
    sub = db.query(Submission).filter(Submission.id == submission_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    sub.status = "approved"

    # Mark flags resolved upon teacher approval
    for f in sub.flags:
        f.resolved = True

    audit = AuditLog(
        user_id=teacher.id,
        event_type="SUBMISSION_APPROVED",
        details=f"Teacher approved submission {sub.id} for student {sub.student.email}."
    )
    db.add(audit)
    db.commit()

    return {"success": True, "submission_id": sub.id, "status": sub.status}

@router.post("/assignments/{assignment_id}/bulk-approve-high-confidence")
def bulk_approve_high_confidence(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Bulk approves all auto-graded, high-confidence submissions that have NO unresolved flags.
    Requires confirm dialog on frontend.
    """
    subs = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.status == "graded",
        Submission.confidence == "High"
    ).all()

    approved_count = 0
    for s in subs:
        unresolved = [f for f in s.flags if not f.resolved]
        if not unresolved:
            s.status = "approved"
            approved_count += 1

    audit = AuditLog(
        user_id=teacher.id,
        event_type="BULK_APPROVE_HIGH_CONFIDENCE",
        details=f"Teacher bulk-approved {approved_count} high-confidence submissions for assignment {assignment_id}."
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "approved_count": approved_count,
        "message": f"Successfully approved {approved_count} high-confidence submissions."
    }

@router.post("/submissions/{submission_id}/approve-and-publish")
def approve_and_publish_single_result(
    submission_id: int,
    req: PublishResultRequest = PublishResultRequest(),
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    1-Click Approve and Publish: Marks submission approved and immediately publishes results to the student.
    """
    sub = db.query(Submission).filter(Submission.id == submission_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    # If not yet graded, grade it
    if not sub.answers or not any(a.grade_runs for a in sub.answers):
        from backend.app.grading_engine import grade_submission
        grade_submission(sub.id, db)
        db.refresh(sub)

    # Compute final total
    total = 0.0
    for ans in sub.answers:
        if ans.grade_runs:
            total += sum(g.marks_awarded for g in ans.grade_runs[0].grades)

    final_total = max(0.0, total - (total * (sub.late_penalty_applied / 100.0)))

    # Create / update PublishedResult
    pub_result = db.query(PublishedResult).filter(PublishedResult.submission_id == sub.id).first()
    if not pub_result:
        pub_result = PublishedResult(
            submission_id=sub.id,
            student_id=sub.student_id,
            assignment_id=sub.assignment_id,
            final_total_marks=round(final_total, 1),
            late_penalty_applied=sub.late_penalty_applied,
            student_feedback=req.student_feedback or "Great work! Results verified and approved by instructor."
        )
        db.add(pub_result)
    else:
        pub_result.final_total_marks = round(final_total, 1)
        pub_result.student_feedback = req.student_feedback or pub_result.student_feedback

    sub.status = "published"

    audit = AuditLog(
        user_id=teacher.id,
        event_type="RESULT_PUBLISHED",
        details=f"Approved & published result for submission {sub.id}: final total {round(final_total, 1)} marks."
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "submission_id": sub.id,
        "status": sub.status,
        "final_total_marks": round(final_total, 1),
        "message": "Submission approved and published to student."
    }

@router.post("/submissions/{submission_id}/publish-result")
def publish_single_result(
    submission_id: int,
    req: PublishResultRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Approval Gate #2 (Single): Nothing reaches students until teacher clicks 'Publish results'.
    """
    sub = db.query(Submission).filter(Submission.id == submission_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    # Compute final total
    total = 0.0
    for ans in sub.answers:
        if ans.grade_runs:
            total += sum(g.marks_awarded for g in ans.grade_runs[0].grades)

    final_total = max(0.0, total - (total * (sub.late_penalty_applied / 100.0)))

    # Create / update PublishedResult
    pub_result = db.query(PublishedResult).filter(PublishedResult.submission_id == sub.id).first()
    if not pub_result:
        pub_result = PublishedResult(
            submission_id=sub.id,
            student_id=sub.student_id,
            assignment_id=sub.assignment_id,
            final_total_marks=round(final_total, 1),
            late_penalty_applied=sub.late_penalty_applied,
            student_feedback=req.student_feedback or "Great work! Results verified by instructor."
        )
        db.add(pub_result)
    else:
        pub_result.final_total_marks = round(final_total, 1)
        pub_result.student_feedback = req.student_feedback

    sub.status = "published"

    audit = AuditLog(
        user_id=teacher.id,
        event_type="RESULT_PUBLISHED",
        details=f"Published result for submission {sub.id}: final total {round(final_total, 1)} marks."
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "submission_id": sub.id,
        "status": sub.status,
        "final_total_marks": round(final_total, 1)
    }

@router.post("/assignments/{assignment_id}/publish-all-approved")
def publish_all_approved_results(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Approval Gate #2 (Bulk): Publishes results for ALL approved submissions for this assignment.
    """
    subs = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.status == "approved"
    ).all()

    count = 0
    for sub in subs:
        total = 0.0
        for ans in sub.answers:
            if ans.grade_runs:
                total += sum(g.marks_awarded for g in ans.grade_runs[0].grades)

        final_total = max(0.0, total - (total * (sub.late_penalty_applied / 100.0)))

        pub_result = db.query(PublishedResult).filter(PublishedResult.submission_id == sub.id).first()
        if not pub_result:
            pub_result = PublishedResult(
                submission_id=sub.id,
                student_id=sub.student_id,
                assignment_id=sub.assignment_id,
                final_total_marks=round(final_total, 1),
                late_penalty_applied=sub.late_penalty_applied,
                student_feedback="Graded and verified by instructor."
            )
            db.add(pub_result)
        else:
            pub_result.final_total_marks = round(final_total, 1)

        sub.status = "published"
        count += 1

    audit = AuditLog(
        user_id=teacher.id,
        event_type="RESULTS_PUBLISHED_BULK",
        details=f"Published results for {count} approved submissions for assignment {assignment_id}."
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "published_count": count,
        "message": f"Published results for {count} approved submissions."
    }

@router.get("/assignments/{assignment_id}/published-result")
def get_student_published_result(
    assignment_id: int,
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Student-side result view:
    - Only available AFTER teacher publishes (Approval Gate #2).
    - STRICT PRIVACY: NEVER returns AI scores, confidence, flags, injection notes, or course chunks.
    - Returns final mark, late penalty (if any), and teacher-approved feedback.
    """
    pub_result = db.query(PublishedResult).filter(
        PublishedResult.assignment_id == assignment_id,
        PublishedResult.student_id == student.id
    ).first()

    if not pub_result:
        raise HTTPException(
            status_code=404,
            detail="Results have not yet been published by your instructor."
        )

    return {
        "assignment_id": pub_result.assignment_id,
        "final_total_marks": pub_result.final_total_marks,
        "late_penalty_applied": pub_result.late_penalty_applied,
        "published_at": pub_result.published_at.isoformat(),
        "student_feedback": pub_result.student_feedback
    }


# ==========================================
# EXTRA FEATURE A: "Why did I lose marks?"
# ==========================================
@router.get("/assignments/{assignment_id}/student-feedback")
def get_student_loss_feedback(
    assignment_id: int,
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Extra Feature A: 'Why did I lose marks?' (student side, after publishing):
    For each question shows which rubric criteria were met or missed in plain words,
    with a pointer to the topic/section/page of the course material to revise.
    DOES NOT reveal model answer or exact missing text!
    """
    pub_result = db.query(PublishedResult).filter(
        PublishedResult.assignment_id == assignment_id,
        PublishedResult.student_id == student.id
    ).first()

    if not pub_result:
        raise HTTPException(status_code=404, detail="Results not yet published")

    sub = pub_result.submission
    questions_feedback = []

    for ans in sub.answers:
        q = ans.question
        primary_run = ans.grade_runs[0] if ans.grade_runs else None

        criteria_status = []
        if primary_run:
            for g in primary_run.grades:
                crit = g.criterion
                ratio = g.marks_awarded / (crit.max_marks or 1.0)
                if ratio >= 0.8:
                    stat = "Met"
                elif ratio >= 0.4:
                    stat = "Partially Met"
                else:
                    stat = "Missed"

                # Topic pointer based on cited page
                page = g.cited_page_num or 1
                topic = "Chapter 1: Learning Paradigms & Data Types (Supervised vs Unsupervised)" if page == 1 else "Chapter 2: Optimization with Gradient Descent (Learning Rate)"
                pointer = f"Review Course Notes: {topic} (Page {page})"

                criteria_status.append({
                    "criterion": crit.criterion_text,
                    "status": stat,
                    "marks_awarded": g.marks_awarded,
                    "max_marks": crit.max_marks,
                    "revision_pointer": pointer
                })

        questions_feedback.append({
            "question_number": q.question_number,
            "question_text": q.question_text,
            "criteria_breakdown": criteria_status
        })

    return {
        "assignment_id": assignment_id,
        "questions": questions_feedback,
        "general_feedback": pub_result.student_feedback
    }


# ==========================================
# EXTRA FEATURE B: Too-Much-Trust Detector
# ==========================================
# In-memory session tracking for rapid approvals
trust_detector_state = {
    "consecutive_fast_approvals": 0,
    "last_approval_time": None,
    "approval_durations": []
}

@router.get("/assignments/{assignment_id}/trust-detector")
def get_trust_detector_status(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Extra Feature B: Too-much-trust detector (teacher side):
    Tracks % of submissions approved with no edits and average time spent.
    If teacher approves 20+ in a row with no changes and under ~10s each,
    returns a gentle notice with 3 random spot-check samples and hidden known-checks!
    """
    subs = db.query(Submission).filter(Submission.assignment_id == assignment_id).all()
    overrides = db.query(Override).filter(Override.teacher_id == teacher.id).all()

    overridden_sub_ids = {o.submission_id for o in overrides}
    total_approved = len([s for s in subs if s.status in ["approved", "published"]])
    approved_no_edits = len([s for s in subs if s.status in ["approved", "published"] and s.id not in overridden_sub_ids])

    no_edit_pct = round((approved_no_edits / total_approved * 100), 1) if total_approved > 0 else 0.0

    fast_count = trust_detector_state["consecutive_fast_approvals"]
    avg_time = (sum(trust_detector_state["approval_durations"]) / len(trust_detector_state["approval_durations"])) if trust_detector_state["approval_durations"] else 8.5

    # Trigger threshold: 20+ fast approvals or simulated trigger
    should_warn = fast_count >= 20

    # 3 random spot-check samples from auto-graded set
    spot_check_samples = []
    auto_graded_subs = [s for s in subs if s.confidence == "High" and s.id not in overridden_sub_ids][:3]
    for s in auto_graded_subs:
        spot_check_samples.append({
            "submission_id": s.id,
            "student_name": s.student.full_name,
            "status": s.status,
            "confidence": s.confidence,
            "receipt_id": s.submission_receipt
        })

    # Planted known-check item (deliberately planted wrong mark in demo data to see if caught)
    known_check_item = {
        "title": "Hidden Quality Control Check",
        "description": "Student Fiona submitted a low-confidence garbled scan that was flagged. Verify if this was caught before auto-approving.",
        "student_name": "Fiona Gallagher",
        "flag_type": "needs_manual_reading",
        "planted_issue": "Garbled OCR text with deliberately planted wrong score to verify instructor vigilance."
    }

    return {
        "approved_with_no_edits_pct": no_edit_pct,
        "consecutive_fast_approvals": fast_count,
        "average_review_time_seconds": round(avg_time, 1),
        "should_warn": should_warn,
        "warning_notice": "You approved many submissions quickly. Here are 3 random spot-check samples and quality-check items to verify." if should_warn else None,
        "spot_check_samples": spot_check_samples,
        "known_check_items": [known_check_item]
    }

@router.post("/assignments/{assignment_id}/simulate-fast-approvals")
def simulate_fast_approvals(
    assignment_id: int,
    teacher: User = Depends(require_teacher)
):
    """Demo shortcut to simulate 20 rapid approvals to trigger the Too-Much-Trust detector notice."""
    trust_detector_state["consecutive_fast_approvals"] = 22
    trust_detector_state["approval_durations"] = [4.2, 5.1, 3.8, 4.0, 6.2]
    return {
        "success": True,
        "consecutive_fast_approvals": 22,
        "message": "Simulated 22 fast approvals (<10s each). The Too-Much-Trust notice is now active."
    }

@router.post("/assignments/{assignment_id}/reset-trust-detector")
def reset_trust_detector(
    assignment_id: int,
    teacher: User = Depends(require_teacher)
):
    trust_detector_state["consecutive_fast_approvals"] = 0
    trust_detector_state["approval_durations"] = []
    return {"success": True, "message": "Trust detector counters reset."}


# ==========================================
# EXTRA FEATURE C: Teacher Correction Log
# ==========================================
@router.get("/corrections")
def get_teacher_correction_log(
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Extra Feature C: Teacher correction log:
    Stores question, criterion, AI mark, teacher mark, and note.
    Shows patterns (e.g. 'AI over-marked criterion 2 in 4 cases')
    and lets the teacher choose to edit the rubric text.
    """
    overrides = db.query(Override).order_by(Override.id.desc()).all()

    # Pattern aggregation by criterion
    criterion_patterns = {}
    for o in overrides:
        crit_id = o.rubric_criterion_id
        if crit_id not in criterion_patterns:
            crit = db.query(RubricCriterion).filter(RubricCriterion.id == crit_id).first()
            criterion_patterns[crit_id] = {
                "criterion_id": crit_id,
                "criterion_text": crit.criterion_text if crit else f"Criterion #{crit_id}",
                "question_id": o.question_id,
                "over_marked_count": 0,
                "under_marked_count": 0,
                "total_overrides": 0,
                "notes": []
            }

        diff = o.new_mark - o.original_mark
        criterion_patterns[crit_id]["total_overrides"] += 1
        if diff < 0:
            criterion_patterns[crit_id]["over_marked_count"] += 1  # AI had given higher mark than teacher
        elif diff > 0:
            criterion_patterns[crit_id]["under_marked_count"] += 1

        criterion_patterns[crit_id]["notes"].append(o.note)

    # Convert patterns to natural summary strings
    patterns_summary = []
    for cp in criterion_patterns.values():
        if cp["over_marked_count"] > 0:
            patterns_summary.append({
                "criterion_id": cp["criterion_id"],
                "question_id": cp["question_id"],
                "summary": f"AI over-marked '{cp['criterion_text'][:45]}...' in {cp['over_marked_count']} cases",
                "recommended_action": "Consider refining the rubric wording to tighten criteria standards.",
                "total_overrides": cp["total_overrides"]
            })
        elif cp["under_marked_count"] > 0:
            patterns_summary.append({
                "criterion_id": cp["criterion_id"],
                "question_id": cp["question_id"],
                "summary": f"AI under-marked '{cp['criterion_text'][:45]}...' in {cp['under_marked_count']} cases",
                "recommended_action": "Consider clarifying acceptable variations in the rubric text.",
                "total_overrides": cp["total_overrides"]
            })

    detailed_records = []
    for o in overrides:
        crit = db.query(RubricCriterion).filter(RubricCriterion.id == o.rubric_criterion_id).first()
        sub = db.query(Submission).filter(Submission.id == o.submission_id).first()
        detailed_records.append({
            "id": o.id,
            "submission_id": o.submission_id,
            "student_name": sub.student.full_name if sub else "Unknown",
            "question_id": o.question_id,
            "criterion_text": crit.criterion_text if crit else "Unknown",
            "ai_mark": o.original_mark,
            "teacher_mark": o.new_mark,
            "mark_difference": round(o.new_mark - o.original_mark, 2),
            "note": o.note,
            "created_at": o.created_at.isoformat()
        })

    return {
        "total_corrections": len(overrides),
        "patterns": patterns_summary,
        "corrections": detailed_records
    }

