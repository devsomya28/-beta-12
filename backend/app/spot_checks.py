import random
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc

from backend.app.models import (
    Submission, Answer, GradeRun, Grade, RubricCriterion, Question,
    Assignment, User, AuditLog, SpotCheckSession
)
from backend.app.spot_checks_config import (
    FAST_APPROVAL_THRESHOLD, FAST_APPROVAL_MAX_SECONDS,
    SAMPLE_COUNT, MAX_PLANTED_CHECKS, REOPEN_COUNT_ON_MISSED_CHECK
)

logger = logging.getLogger("markanchor.spot_checks")

# In-memory tracking of consecutive fast approvals per teacher
teacher_speed_tracker: Dict[int, Dict[str, Any]] = {}


def record_approval(
    teacher_id: int,
    assignment_id: int,
    duration_seconds: float,
    had_override: bool,
    db: Session
) -> Dict[str, Any]:
    """
    Tracks teacher approval speed.
    Trigger condition: 20 or more approvals in a row with no edits and under 10 seconds each.
    If triggered, automatically generates the Spot-Check list (3 real random + up to 2 planted checks).
    """
    tracker = teacher_speed_tracker.setdefault(teacher_id, {
        "consecutive_fast_approvals": 0,
        "approval_durations": []
    })

    if had_override:
        # Teacher inspected and changed mark; reset consecutive fast approvals
        tracker["consecutive_fast_approvals"] = 0
        tracker["approval_durations"].clear()
        return {"triggered": False, "consecutive_fast": 0}

    if duration_seconds <= FAST_APPROVAL_MAX_SECONDS:
        tracker["consecutive_fast_approvals"] += 1
        tracker["approval_durations"].append(duration_seconds)
    else:
        # Teacher spent significant time (>10s); reset streak
        tracker["consecutive_fast_approvals"] = 0
        tracker["approval_durations"].clear()

    # Check auto-trigger threshold
    if tracker["consecutive_fast_approvals"] >= FAST_APPROVAL_THRESHOLD:
        session = create_spot_checks(
            assignment_id=assignment_id,
            teacher_id=teacher_id,
            fast_count=tracker["consecutive_fast_approvals"],
            avg_duration=(sum(tracker["approval_durations"]) / len(tracker["approval_durations"])),
            db=db
        )
        # Reset counter after triggering
        tracker["consecutive_fast_approvals"] = 0
        tracker["approval_durations"].clear()
        return {"triggered": True, "session_id": session.id}

    return {
        "triggered": False,
        "consecutive_fast": tracker["consecutive_fast_approvals"]
    }


def create_spot_checks(
    assignment_id: int,
    teacher_id: int,
    fast_count: int,
    avg_duration: float,
    db: Session
) -> SpotCheckSession:
    """
    Automatically creates the Spot-Check list:
    (a) 3 random submissions from the auto-approved, high-confidence set.
    (b) Up to 2 planted known-check items (real answers with deliberately wrong marks planted).
    """
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise ValueError(f"Assignment {assignment_id} not found")

    # (a) Pick 3 random submissions from auto-approved high-confidence set
    approved_high_conf = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.is_planted_check == False,
        Submission.confidence == "High",
        Submission.status.in_(["approved", "published"])
    ).all()

    selected_real = random.sample(approved_high_conf, min(SAMPLE_COUNT, len(approved_high_conf))) if approved_high_conf else []
    for s in selected_real:
        s.is_spot_check = True
        s.spot_check_status = "pending"

    # (b) Plant up to 2 known-check items
    # Copy a real answer and deliberately plant a wrong mark
    planted_count = 0
    candidate_answers = db.query(Answer).join(Answer.submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.is_planted_check == False
    ).all()

    dummy_student = db.query(User).filter(User.role == "student").first()
    dummy_student_id = dummy_student.id if dummy_student else 1

    if candidate_answers and len(candidate_answers) > 0:
        sample_answers = random.sample(candidate_answers, min(MAX_PLANTED_CHECKS, len(candidate_answers)))
        for idx, src_ans in enumerate(sample_answers):
            q = src_ans.question
            crit = q.rubric_criteria[0] if q.rubric_criteria else None
            if not crit:
                continue

            # Compute true mark from source answer
            true_mark = 8.5
            if src_ans.grade_runs and src_ans.grade_runs[0].grades:
                true_mark = src_ans.grade_runs[0].grades[0].marks_awarded

            # Plant deliberately wrong mark:
            # If true mark >= 5.0, plant 2.0 (obviously defective)
            # If true mark < 5.0, plant 10.0 (obviously unearned)
            wrong_mark = 2.0 if true_mark >= 5.0 else min(10.0, q.max_marks)

            planted_sub = Submission(
                assignment_id=assignment_id,
                student_id=dummy_student_id,
                status="pending_spot_check",
                is_planted_check=True,  # STRICT FLAG: Never visible to students, never published, never in real totals
                is_spot_check=True,
                spot_check_status="pending",
                planted_expected_mark=wrong_mark,
                planted_correct_mark=true_mark,
                planted_error_caught=None,
                confidence="High",
                file_status="Text extracted",
                submission_receipt=f"QC-CHECK-{random.randint(1000, 9999)}"
            )
            db.add(planted_sub)
            db.flush()

            planted_ans = Answer(
                submission_id=planted_sub.id,
                question_id=q.id,
                student_answer_text=src_ans.student_answer_text
            )
            db.add(planted_ans)
            db.flush()

            p_run = GradeRun(answer_id=planted_ans.id, run_number=1, total_marks=wrong_mark)
            db.add(p_run)
            db.flush()

            p_grade = Grade(
                grade_run_id=p_run.id,
                rubric_criterion_id=crit.id,
                marks_awarded=wrong_mark,
                ai_reason="Planted quality-control verification score."
            )
            db.add(p_grade)
            planted_count += 1

    # Create SpotCheckSession record
    session = SpotCheckSession(
        assignment_id=assignment_id,
        teacher_id=teacher_id,
        fast_approvals_count=fast_count,
        avg_review_seconds=round(avg_duration, 1),
        status="active"
    )
    db.add(session)

    db.add(AuditLog(
        user_id=teacher_id,
        event_type="SPOT_CHECK_TRIGGERED",
        details=f"Automation #7: Triggered spot-check after {fast_count} rapid approvals ({round(avg_duration, 1)}s avg). Picked {len(selected_real)} random samples and planted {planted_count} quality checks."
    ))

    db.commit()
    db.refresh(session)
    return session


def get_active_spot_checks(assignment_id: int, teacher_id: int, db: Session) -> Dict[str, Any]:
    """
    Returns the active spot-check samples, planted known-check items,
    and review attention summary.
    """
    session = db.query(SpotCheckSession).filter(
        SpotCheckSession.assignment_id == assignment_id,
        SpotCheckSession.teacher_id == teacher_id,
        SpotCheckSession.status == "active"
    ).order_by(desc(SpotCheckSession.id)).first()

    tracker = teacher_speed_tracker.get(teacher_id, {})
    consecutive_fast = tracker.get("consecutive_fast_approvals", 0)
    durations = tracker.get("approval_durations", [])
    avg_duration = (sum(durations) / len(durations)) if durations else 7.5

    # If no active session, check if warning threshold reached
    should_warn = (session is not None) or (consecutive_fast >= FAST_APPROVAL_THRESHOLD)

    # Real random spot-check samples
    real_samples = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.is_planted_check == False,
        Submission.is_spot_check == True
    ).order_by(desc(Submission.id)).limit(SAMPLE_COUNT).all()

    if len(real_samples) < SAMPLE_COUNT:
        fallback = db.query(Submission).filter(
            Submission.assignment_id == assignment_id,
            Submission.is_planted_check == False,
            Submission.id.notin_([s.id for s in real_samples])
        ).limit(SAMPLE_COUNT - len(real_samples)).all()
        real_samples.extend(fallback)

    real_list = []
    for s in real_samples:
        total = 0.0
        for a in s.answers:
            if a.grade_runs:
                total += sum(g.marks_awarded for g in a.grade_runs[0].grades)
        real_list.append({
            "submission_id": s.id,
            "student_name": s.student.full_name if s.student else "Student",
            "confidence": s.confidence,
            "total_marks": round(total, 1),
            "spot_check_status": s.spot_check_status or "pending",
            "is_planted": False
        })

    # Planted quality-control items
    planted_items = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.is_planted_check == True,
        Submission.is_spot_check == True
    ).order_by(desc(Submission.id)).limit(MAX_PLANTED_CHECKS).all()

    if not planted_items:
        # If no planted items exist yet, create them on the fly
        try:
            create_spot_checks(assignment_id, teacher_id, 20, 5.0, db)
            planted_items = db.query(Submission).filter(
                Submission.assignment_id == assignment_id,
                Submission.is_planted_check == True,
                Submission.is_spot_check == True
            ).order_by(desc(Submission.id)).limit(MAX_PLANTED_CHECKS).all()
        except Exception as e:
            logger.warning(f"Failed to auto-create planted checks: {e}")

    planted_list = []
    for p in planted_items:
        q_ans = p.answers[0] if p.answers else None
        q_text = q_ans.question.question_text if q_ans and q_ans.question else "Question"
        planted_list.append({
            "submission_id": p.id,
            "title": "Quality Control Check Item",
            "question_text": q_text,
            "answer_preview": q_ans.student_answer_text[:120] if q_ans else "",
            "planted_mark": p.planted_expected_mark,
            "correct_mark": p.planted_correct_mark,
            "planted_error_caught": p.planted_error_caught,
            "spot_check_status": p.spot_check_status or "pending",
            "is_planted": True
        })

    # Real student submissions for stats
    from backend.app.models import Override
    subs = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.is_planted_check == False
    ).all()
    overrides = db.query(Override).filter(Override.teacher_id == teacher_id).all()
    overridden_sub_ids = {o.submission_id for o in overrides}
    total_approved = len([s for s in subs if s.status in ["approved", "published"]])
    approved_no_edits = len([s for s in subs if s.status in ["approved", "published"] and s.id not in overridden_sub_ids])
    no_edit_pct = round((approved_no_edits / total_approved * 100), 1) if total_approved > 0 else 0.0

    # Review Attention Summary metrics: accumulate across all sessions for this assignment & teacher
    all_sessions = db.query(SpotCheckSession).filter(
        SpotCheckSession.assignment_id == assignment_id,
        SpotCheckSession.teacher_id == teacher_id
    ).all()
    passed = sum(s.planted_checks_passed for s in all_sessions)
    missed = sum(s.planted_checks_missed for s in all_sessions)
    confirmed = sum(s.real_samples_confirmed for s in all_sessions)
    corrected = sum(s.real_samples_corrected for s in all_sessions)
    reopened = sum(s.reopened_approvals_count for s in all_sessions)

    total_checks = passed + missed
    accuracy_pct = round((passed / total_checks * 100), 1) if total_checks > 0 else 100.0

    return {
        "should_warn": should_warn,
        "approved_with_no_edits_pct": no_edit_pct,
        "consecutive_fast_approvals": session.fast_approvals_count if session else consecutive_fast,
        "average_review_time_seconds": session.avg_review_seconds if session else round(avg_duration, 1),
        "warning_notice": "You approved many submissions quickly. Please check these samples to ensure grading quality." if should_warn else None,
        "spot_check_samples": real_list,
        "planted_check_items": planted_list,
        "known_check_items": planted_list,
        "attention_summary": {
            "checks_passed": passed,
            "checks_missed": missed,
            "real_samples_confirmed": confirmed,
            "real_samples_corrected": corrected,
            "reopened_approvals_count": reopened,
            "quality_rating_pct": accuracy_pct,
            "vigilance_band": "High Vigilance" if missed == 0 else "Needs Attention"
        }
    }


def resolve_spot_check(
    submission_id: int,
    action: str,  # 'confirm' or 'correct'
    teacher_id: int,
    db: Session,
    new_mark: Optional[float] = None
) -> Dict[str, Any]:
    """
    Records whether the teacher caught or missed a spot-check error.
    - If teacher confirms a planted wrong mark -> MISSED:
      Gentle alert generated, and last 5 rapid approvals are re-opened for a second look.
    - If teacher corrects a planted wrong mark -> CAUGHT:
      Vigilance reward logged.
    - If real sample -> confirms or updates mark.
    """
    sub = db.query(Submission).filter(Submission.id == submission_id).first()
    if not sub:
        raise ValueError(f"Submission {submission_id} not found")

    session = db.query(SpotCheckSession).filter(
        SpotCheckSession.assignment_id == sub.assignment_id,
        SpotCheckSession.teacher_id == teacher_id,
        SpotCheckSession.status == "active"
    ).order_by(desc(SpotCheckSession.id)).first()

    if not session:
        session = db.query(SpotCheckSession).filter(
            SpotCheckSession.assignment_id == sub.assignment_id,
            SpotCheckSession.teacher_id == teacher_id
        ).order_by(desc(SpotCheckSession.id)).first()

    if not session:
        session = SpotCheckSession(
            assignment_id=sub.assignment_id,
            teacher_id=teacher_id,
            fast_approvals_count=20,
            avg_review_seconds=5.0,
            status="active"
        )
        db.add(session)
        db.flush()

    if sub.is_planted_check:
        # Teacher reviewed a planted quality-control test item
        if action == "confirm":
            # Teacher blindly confirmed the deliberately wrong score!
            sub.planted_error_caught = False
            sub.spot_check_status = "confirmed"
            if session:
                session.planted_checks_missed += 1

            # Re-open related rapid approvals for a second look
            reopened = db.query(Submission).filter(
                Submission.assignment_id == sub.assignment_id,
                Submission.is_planted_check == False,
                Submission.status == "approved"
            ).order_by(desc(Submission.id)).limit(REOPEN_COUNT_ON_MISSED_CHECK).all()

            for r in reopened:
                r.status = "graded"  # Re-open for second look!

            reopened_count = len(reopened)
            if session:
                session.reopened_approvals_count += reopened_count

            db.add(AuditLog(
                user_id=teacher_id,
                event_type="SPOT_CHECK_PLANTED_ERROR_MISSED",
                details=f"Automation #7: Teacher missed planted quality check (planted mark: {sub.planted_expected_mark}, true mark: {sub.planted_correct_mark}). Re-opened {reopened_count} real approvals for a second look."
            ))
            db.commit()

            return {
                "success": True,
                "is_planted": True,
                "error_caught": False,
                "message": (
                    f"Notice: You confirmed a quality-control check with a deliberately planted score "
                    f"({sub.planted_expected_mark} pts instead of {sub.planted_correct_mark} pts). "
                    f"To safeguard student fairness, we have gently re-opened {reopened_count} of your "
                    f"recent rapid approvals for a second look."
                ),
                "reopened_count": reopened_count
            }
        else:
            # Teacher caught the error!
            sub.planted_error_caught = True
            sub.spot_check_status = "corrected"
            if session:
                session.planted_checks_passed += 1

            db.add(AuditLog(
                user_id=teacher_id,
                event_type="SPOT_CHECK_PLANTED_ERROR_CAUGHT",
                details=f"Automation #7: Teacher caught planted quality check error! (Corrected {sub.planted_expected_mark} to {new_mark or sub.planted_correct_mark})."
            ))
            db.commit()

            return {
                "success": True,
                "is_planted": True,
                "error_caught": True,
                "message": (
                    f"Excellent attention! You caught the planted quality-control error "
                    f"(deliberate test mark was {sub.planted_expected_mark} pts vs true {sub.planted_correct_mark} pts)."
                )
            }
    else:
        # Real student sample
        sub.spot_check_status = action
        if action == "confirm":
            if session:
                session.real_samples_confirmed += 1
            db.add(AuditLog(
                user_id=teacher_id,
                event_type="SPOT_CHECK_SAMPLE_CONFIRMED",
                details=f"Automation #7: Teacher confirmed spot-check sample for submission {sub.id} ({sub.student.full_name})."
            ))
        else:
            if session:
                session.real_samples_corrected += 1
            db.add(AuditLog(
                user_id=teacher_id,
                event_type="SPOT_CHECK_SAMPLE_CORRECTED",
                details=f"Automation #7: Teacher corrected spot-check sample for submission {sub.id} ({sub.student.full_name})."
            ))
        db.commit()

        return {
            "success": True,
            "is_planted": False,
            "message": f"Spot-check sample {action}ed successfully."
        }
