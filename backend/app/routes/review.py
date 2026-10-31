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

class TeacherCorrectAnswerRequest(BaseModel):
    corrected_text: str
    note: Optional[str] = "Teacher fairness correction"

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

    submissions = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.is_planted_check == False
    ).all()

    # Automatically finalize expired correction windows
    now_utc = datetime.utcnow()
    for sub in submissions:
        if not sub.window_locked and sub.correction_window_until and now_utc >= sub.correction_window_until:
            sub.window_locked = True
            db.commit()

    # Automatically auto-grade any submissions in 'submitted' status whose correction window is closed
    from backend.app.llm_provider import is_ai_forced_offline
    from backend.app.grading_engine import grade_submission
    from backend.app.risk_scoring import compute_submission_risk_score

    if not is_ai_forced_offline():
        for sub in submissions:
            can_grade = (sub.status == "submitted" and (sub.window_locked or not sub.correction_window_until or now_utc >= sub.correction_window_until))
            if can_grade:
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

        # Automation #2: Compute or load risk score
        risk_info = compute_submission_risk_score(sub, None, db)
        if sub.risk_score is None or (sub.risk_score == 0.0 and has_flags):
            sub.risk_score = risk_info["score"]
            sub.risk_band = risk_info["band"]
            sub.risk_breakdown = json.dumps(risk_info["breakdown"])
            db.add(sub)
            db.commit()

        parsed_breakdown = risk_info.get("breakdown", [])
        if sub.risk_breakdown:
            try:
                parsed_breakdown = json.loads(sub.risk_breakdown)
            except Exception:
                pass

        ans_q_map = {a.id: (a.question.question_number if a.question else 1) for a in sub.answers}
        flags_data = []
        for f in sorted_flags:
            q_num = ans_q_map.get(f.answer_id)
            reason_text = f.reason
            if q_num and not reason_text.startswith("Q"):
                reason_text = f"Q{q_num}: {f.reason}"
            flags_data.append({
                "id": f.id,
                "type": f.flag_type,
                "reason": reason_text,
                "severity": f.severity,
                "answer_id": f.answer_id,
                "question_number": q_num
            })

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
            "assignment_kind": assignment.kind or "assignment",
            "student_comment": sub.student_comment,
            "has_student_comment": bool(sub.student_comment),
            "student_edited": any(a.student_edited for a in sub.answers),
            "teacher_edited": any(a.teacher_edited for a in sub.answers),
            "in_correction_window": bool(not sub.window_locked and sub.correction_window_until and now_utc < sub.correction_window_until),
            "window_locked": sub.window_locked,
            "flags": flags_data,
            "max_severity": max_severity,
            "has_injection": any(a.injection_detected for a in sub.answers),
            # Phase 1: Automation #2 Risk Score Fields (Teacher-only)
            "risk_score": sub.risk_score if sub.risk_score is not None else risk_info["score"],
            "risk_band": sub.risk_band or risk_info["band"],
            "risk_breakdown": parsed_breakdown,
            "risk_top_reasons": risk_info["top_reasons_summary"],
            "risk_top_reasons_list": risk_info["top_reasons_list"]
        }

        # Needs attention queue: Submissions with High/Medium risk score OR unresolved flags
        if sub_summary["risk_band"] in ["High", "Medium"] or has_flags:
            flagged_list.append(sub_summary)
        else:
            everything_else_list.append(sub_summary)

    # Sort flagged queue by risk score descending (highest score first)
    flagged_list.sort(key=lambda s: s["risk_score"], reverse=True)
    everything_else_list.sort(key=lambda s: s["risk_score"], reverse=True)

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
        "assignment_kind": assignment.kind or "assignment",
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

        # Phase B: External verification data (Advisory-only)
        ext_ver_data = None
        if ans.external_verification:
            ev = ans.external_verification
            step_notes_list = []
            if ev.step_notes:
                try:
                    step_notes_list = json.loads(ev.step_notes)
                except Exception:
                    step_notes_list = [ev.step_notes]
            ext_ver_data = {
                "id": ev.id,
                "sympy_result": ev.sympy_result,
                "sympy_details": ev.sympy_details,
                "student_expr_parsed": ev.student_expr_parsed,
                "model_expr_parsed": ev.model_expr_parsed,
                "llm_verdict": ev.llm_verdict,
                "first_incorrect_step": ev.first_incorrect_step,
                "step_notes": step_notes_list,
                "confidence": ev.confidence,
                "is_alternate_method": ev.is_alternate_method,
                "label": ev.label or "Checked outside course material",
                "status": ev.status,
                "created_at": ev.created_at.isoformat() if ev.created_at else None
            }

        answers_detail.append({
            "answer_id": ans.id,
            "question_id": q.id,
            "question_number": q.question_number,
            "question_text": q.question_text,
            "question_type": q.question_type or "text",
            "model_answer": q.model_answer,
            "alternative_methods": json.loads(q.alternative_methods) if q.alternative_methods else [],
            "source_chunks_info": q.source_chunks_info,
            "max_marks": q.max_marks,
            "student_answer_text": ans.student_answer_text,
            "original_answer_text": ans.original_answer_text or ans.student_answer_text,
            "student_edited": ans.student_edited,
            "teacher_edited": ans.teacher_edited,
            "injection_detected": ans.injection_detected,
            "injection_phrases": json.loads(ans.injection_phrases) if ans.injection_phrases else [],
            "external_verification": ext_ver_data,
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
        "assignment_kind": sub.assignment.kind if sub.assignment else "assignment",
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
        "student_comment": sub.student_comment,
        "window_locked": sub.window_locked,
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
        "answers": answers_detail,
        # Automation #2: Risk scoring detail
        "risk_score": sub.risk_score or 0.0,
        "risk_band": sub.risk_band or "Low",
        "risk_breakdown": json.loads(sub.risk_breakdown) if sub.risk_breakdown else []
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

    # Automation #7: Record approval with override (resets consecutive fast approvals)
    from backend.app.spot_checks import record_approval
    record_approval(
        teacher_id=teacher.id,
        assignment_id=sub.assignment_id,
        duration_seconds=15.0,
        had_override=True,
        db=db
    )

    return {
        "success": True,
        "submission_id": sub.id,
        "criterion_id": req.rubric_criterion_id,
        "new_mark": req.new_mark,
        "note": req.note
    }

@router.post("/submissions/{submission_id}/answers/{answer_id}/teacher-correct")
def teacher_correct_answer(
    submission_id: int,
    answer_id: int,
    req: TeacherCorrectAnswerRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Fairness safety net: Teacher can correct the extracted text or answer split in the review screen.
    Keeps original extracted text snapshot, marks teacher_edited=True, logs in AuditLog,
    and re-grades the submission with the corrected text.
    """
    sub = db.query(Submission).filter(Submission.id == submission_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    ans = db.query(Answer).filter(Answer.id == answer_id, Answer.submission_id == sub.id).first()
    if not ans:
        raise HTTPException(status_code=404, detail="Answer not found")

    if ans.original_answer_text is None:
        ans.original_answer_text = ans.student_answer_text

    old_text = ans.student_answer_text
    ans.student_answer_text = req.corrected_text.strip()
    ans.teacher_edited = True

    audit = AuditLog(
        user_id=teacher.id,
        event_type="TEACHER_TEXT_CORRECTED",
        details=f"Teacher {teacher.email} corrected extracted text for submission {sub.id}, answer {ans.id}. Note: '{req.note}'. Old: '{old_text[:60]}...' -> New: '{ans.student_answer_text[:60]}...'"
    )
    db.add(audit)
    db.commit()

    # Re-grade this submission
    from backend.app.llm_provider import is_ai_forced_offline
    from backend.app.grading_engine import grade_submission
    if not is_ai_forced_offline():
        try:
            grade_submission(sub.id, db)
            db.refresh(sub)
        except Exception as e:
            pass

    return {
        "success": True,
        "answer_id": ans.id,
        "student_answer_text": ans.student_answer_text,
        "original_answer_text": ans.original_answer_text,
        "teacher_edited": True,
        "message": "Extracted text corrected and answer re-graded successfully."
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

    # Automation #7: Record approval speed & check for auto-trigger
    from backend.app.spot_checks import record_approval
    speed_res = record_approval(
        teacher_id=teacher.id,
        assignment_id=sub.assignment_id,
        duration_seconds=5.0,
        had_override=False,
        db=db
    )

    return {
        "success": True,
        "submission_id": sub.id,
        "status": sub.status,
        "spot_check_triggered": speed_res.get("triggered", False)
    }

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
        Submission.confidence == "High",
        Submission.is_planted_check == False
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
        Submission.status == "approved",
        Submission.is_planted_check == False
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
# PHASE 4 / EXTRA FEATURE B: Auto Spot-Checks (Automation #7)
# ==========================================
class SpotCheckResolveRequest(BaseModel):
    action: str  # 'confirm' or 'correct'
    new_mark: Optional[float] = None

@router.get("/assignments/{assignment_id}/trust-detector")
def get_trust_detector_status(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Automation #7: Auto Spot-Checks (Too-Much-Trust detector):
    Tracks % of submissions approved with no edits and average time spent.
    If teacher approves 20+ in a row with no changes and under 10s each,
    automatically generates 3 random spot-check samples + up to 2 planted QC checks.
    """
    from backend.app.spot_checks import get_active_spot_checks
    return get_active_spot_checks(assignment_id, teacher.id, db)

@router.post("/assignments/{assignment_id}/simulate-fast-approvals")
def simulate_fast_approvals(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Demo shortcut to simulate 20 rapid approvals to automatically trigger
    the Spot-Check session and generate planted quality check items.
    """
    from backend.app.spot_checks import create_spot_checks
    session = create_spot_checks(
        assignment_id=assignment_id,
        teacher_id=teacher.id,
        fast_count=22,
        avg_duration=4.8,
        db=db
    )
    return {
        "success": True,
        "consecutive_fast_approvals": 22,
        "session_id": session.id,
        "message": "Simulated 22 fast approvals (<10s each). Spot-check list with planted quality-control items is now active."
    }

@router.post("/assignments/{assignment_id}/reset-trust-detector")
def reset_trust_detector(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    from backend.app.spot_checks import teacher_speed_tracker
    from backend.app.models import SpotCheckSession
    if teacher.id in teacher_speed_tracker:
        teacher_speed_tracker[teacher.id]["consecutive_fast_approvals"] = 0
        teacher_speed_tracker[teacher.id]["approval_durations"].clear()

    # Deactivate active session
    active_sess = db.query(SpotCheckSession).filter(
        SpotCheckSession.assignment_id == assignment_id,
        SpotCheckSession.teacher_id == teacher.id,
        SpotCheckSession.status == "active"
    ).all()
    for s in active_sess:
        s.status = "dismissed"
    db.commit()

    return {"success": True, "message": "Trust detector counters and spot-check sessions reset."}

@router.post("/spot-checks/{submission_id}/resolve")
def resolve_spot_check_endpoint(
    submission_id: int,
    req: SpotCheckResolveRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Automation #7: Resolves a spot-check item (real or planted quality check).
    - If planted item confirmed -> records missed check and re-opens recent approvals for a second look.
    - If planted item corrected -> records caught error.
    - Real samples -> records confirmation or correction.
    """
    from backend.app.spot_checks import resolve_spot_check
    result = resolve_spot_check(
        submission_id=submission_id,
        action=req.action,
        teacher_id=teacher.id,
        db=db,
        new_mark=req.new_mark
    )
    return result


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


# ==========================================
# PHASE 2: Automation #3 - Answer Clustering
# ==========================================

class ApplyGroupMarkRequest(BaseModel):
    target_mark: float
    member_answer_ids: List[int]
    include_flagged_answer_ids: Optional[List[int]] = []

@router.get("/assignments/{assignment_id}/questions/{question_id}/clusters")
def get_question_answer_clusters(
    assignment_id: int,
    question_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Groups answers with identical/similar meaning using semantic embeddings
    and agglomerative clustering. Shows representative, members, and marks consistency.
    """
    from backend.app.clustering import cluster_answers_for_question
    try:
        result = cluster_answers_for_question(question_id, db)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/assignments/{assignment_id}/questions/{question_id}/answer-map")
def get_question_answer_map(
    assignment_id: int,
    question_id: int,
    threshold: Optional[float] = Query(0.85, ge=0.1, le=0.99),
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Phase C: Teacher-only Answer Map Graph endpoint.
    Returns force-directed graph structure:
    - Nodes: student answers and cluster hub nodes
    - Edges: hub connections and pairwise similarity links
    - Flags, ring colors, and inconsistency halos
    Students calling this get 403 Forbidden.
    """
    from backend.app.clustering import generate_answer_map
    try:
        return generate_answer_map(question_id, db, threshold=threshold)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/assignments/{assignment_id}/questions/{question_id}/clusters/apply-group-mark")
def post_apply_group_mark(
    assignment_id: int,
    question_id: int,
    req: ApplyGroupMarkRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Applies a chosen mark to all eligible members of a cluster.
    Skips flagged members unless explicitly checked by instructor.
    Saves overrides with note 'Group apply' and logs to AuditLog.
    """
    from backend.app.clustering import apply_group_mark
    try:
        result = apply_group_mark(
            question_id=question_id,
            target_mark=req.target_mark,
            member_answer_ids=req.member_answer_ids,
            include_flagged_answer_ids=req.include_flagged_answer_ids or [],
            teacher_id=teacher.id,
            db=db
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==============================================================
# PHASE 3: Automation #5 - Teacher-Approved Correction Learning
# ==============================================================

class AcceptSuggestionRequest(BaseModel):
    edited_text: Optional[str] = None


@router.get("/assignments/{assignment_id}/suggestions")
def get_rubric_suggestions(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Analyzes override log and lists rubric wording suggestions
    when 3 or more similar overrides are detected on a criterion.
    """
    from backend.app.correction_learning import analyze_and_generate_suggestions
    try:
        suggestions = analyze_and_generate_suggestions(assignment_id, db)
        return {
            "assignment_id": assignment_id,
            "suggestions": suggestions,
            "pending_count": len([s for s in suggestions if s["status"] == "pending"])
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/assignments/{assignment_id}/suggestions/count")
def get_pending_suggestions_count(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Returns pending suggestions count for review badge.
    """
    from backend.app.correction_learning import analyze_and_generate_suggestions
    try:
        suggestions = analyze_and_generate_suggestions(assignment_id, db)
        return {"pending_count": len([s for s in suggestions if s["status"] == "pending"])}
    except Exception:
        return {"pending_count": 0}


@router.post("/suggestions/{suggestion_id}/accept")
def post_accept_suggestion(
    suggestion_id: int,
    req: AcceptSuggestionRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Accepts suggestion or edited wording. Creates new RubricVersion,
    preserves old version for rollback, and logs to AuditLog.
    """
    from backend.app.correction_learning import accept_suggestion
    try:
        return accept_suggestion(suggestion_id, req.edited_text, teacher.id, db)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/suggestions/{suggestion_id}/reject")
def post_reject_suggestion(
    suggestion_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Rejects suggestion. Hides it permanently for this pattern.
    """
    from backend.app.correction_learning import reject_suggestion
    try:
        return reject_suggestion(suggestion_id, teacher.id, db)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/suggestions/{suggestion_id}/regrade")
def post_regrade_affected(
    suggestion_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Regrades ONLY unpublished submissions for this question.
    Published results are NEVER changed automatically.
    Returns before/after comparison and 'Did it help?' panel metrics.
    """
    from backend.app.correction_learning import regrade_affected_submissions
    try:
        return regrade_affected_submissions(suggestion_id, teacher.id, db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rubric-versions/{version_id}/restore")
def post_restore_rubric_version(
    version_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher-only: Restores previous rubric version for a criterion.
    """
    from backend.app.correction_learning import restore_rubric_version
    try:
        return restore_rubric_version(version_id, teacher.id, db)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class AcceptAlternativeMethodRequest(BaseModel):
    method_text: str
    note: Optional[str] = "Teacher-approved alternative solution"
    submission_id: Optional[int] = None
    award_marks: Optional[float] = None


@router.post("/questions/{question_id}/accept-method")
def accept_alternative_method(
    question_id: int,
    req: AcceptAlternativeMethodRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Phase B: Teacher accepts a verified or valid alternative method.
    Saves the method as a teacher-approved alternative solution on that question.
    Optionally resolves the 'alternative_method' flag on the current submission and awards marks.
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if not question:
        raise HTTPException(status_code=404, detail="Question not found")

    existing_methods = []
    if question.alternative_methods:
        try:
            existing_methods = json.loads(question.alternative_methods)
        except Exception:
            existing_methods = []

    new_entry = {
        "method_text": req.method_text.strip(),
        "note": req.note.strip() if req.note else "Teacher-approved alternative solution",
        "approved_by_id": teacher.id,
        "approved_at": datetime.utcnow().isoformat()
    }
    existing_methods.append(new_entry)
    question.alternative_methods = json.dumps(existing_methods)

    # If submission_id provided, resolve alternative_method flags on this submission
    if req.submission_id:
        sub = db.query(Submission).filter(Submission.id == req.submission_id).first()
        if sub:
            for f in sub.flags:
                if f.flag_type == "alternative_method":
                    f.resolved = True
            db.flush()

    audit = AuditLog(
        user_id=teacher.id,
        event_type="TEACHER_ACCEPTED_ALTERNATIVE_METHOD",
        details=f"Teacher {teacher.email} approved alternative solution method for Question {question.question_number} (Assignment {question.assignment_id}): '{req.note}'"
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "question_id": question.id,
        "alternative_methods": existing_methods,
        "message": "Alternative method accepted and saved as teacher-approved solution."
    }


@router.post("/questions/{question_id}/regrade-unpublished")
def regrade_unpublished_for_question(
    question_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Phase B: Regrades ONLY unpublished submissions for this question.
    Published results are NEVER changed automatically.
    The grader now cites the accepted method as 'Teacher-approved alternative'.
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if not question:
        raise HTTPException(status_code=404, detail="Question not found")

    assignment = question.assignment
    submissions = db.query(Submission).filter(
        Submission.assignment_id == assignment.id,
        Submission.status != "published",
        Submission.is_planted_check == False
    ).all()

    from backend.app.grading_engine import grade_submission
    regraded_count = 0
    for s in submissions:
        try:
            grade_submission(s.id, db)
            regraded_count += 1
        except Exception as e:
            pass

    audit = AuditLog(
        user_id=teacher.id,
        event_type="REGRADE_UNPUBLISHED_SUBMISSIONS",
        details=f"Teacher {teacher.email} triggered regrade of {regraded_count} unpublished submissions for Question {question.question_number} using teacher-approved alternative solutions."
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "question_id": question.id,
        "regraded_count": regraded_count,
        "message": f"Successfully regraded {regraded_count} unpublished submissions for Question {question.question_number}."
    }



