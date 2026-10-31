from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from backend.app.database import get_db
from backend.app.models import Submission, Answer, Grade, Flag, AuditLog, User, Assignment
from backend.app.auth import require_teacher
from backend.app.grading_engine import grade_submission, compute_text_similarity
from backend.app.llm_provider import is_ai_forced_offline

router = APIRouter(prefix="/api/grading", tags=["Grading Engine"])

class GradeSubmissionResponse(BaseModel):
    submission_id: int
    status: str
    confidence: str
    total_marks: float
    flags_count: int

@router.post("/grade-submission/{submission_id}", response_model=GradeSubmissionResponse)
def run_grade_submission(
    submission_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Grades a single student submission via the 3-run RAG-anchored engine.
    Computes consistency, confidence, and evaluates all 8 flagging rules.
    """
    if is_ai_forced_offline():
        raise HTTPException(
            status_code=503,
            detail="AI offline: Grading engine is paused. Submissions remain safely in 'Pending AI grading' status."
        )

    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    result = grade_submission(submission_id, db)
    return result

@router.post("/grade-all-pending/{assignment_id}")
def grade_all_pending(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Auto-grades all pending submissions when AI returns online or when teacher clicks 'Retry grading'.
    """
    if is_ai_forced_offline():
        raise HTTPException(
            status_code=503,
            detail="AI offline: Cannot run batch grading while AI status is Offline."
        )

    pending_subs = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.status.in_(["pending_ai", "submitted"])
    ).all()

    graded_count = 0
    for sub in pending_subs:
        try:
            grade_submission(sub.id, db)
            graded_count += 1
        except Exception as e:
            print(f"Error grading submission {sub.id}: {e}")

    audit = AuditLog(
        user_id=teacher.id,
        event_type="BATCH_GRADING_TRIGGERED",
        details=f"Batch grading triggered for assignment {assignment_id}: {graded_count} submissions processed."
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "assignment_id": assignment_id,
        "graded_count": graded_count,
        "message": f"Successfully graded {graded_count} submissions."
    }

@router.get("/consistency-check")
def check_answers_consistency(
    answer1_id: int = Query(...),
    answer2_id: int = Query(...),
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Consistency Check Button on Teacher Side:
    Picks two answers. If semantically similar (> 0.85 similarity),
    checks whether their marks differ by more than one grade band (10%).
    If so, returns an explicit warning to the teacher.
    """
    ans1 = db.query(Answer).filter(Answer.id == answer1_id).first()
    ans2 = db.query(Answer).filter(Answer.id == answer2_id).first()

    if not ans1 or not ans2:
        raise HTTPException(status_code=404, detail="One or both answers not found")

    # Get primary run marks
    run1 = ans1.grade_runs[0] if ans1.grade_runs else None
    run2 = ans2.grade_runs[0] if ans2.grade_runs else None

    mark1 = run1.total_marks if run1 else 0.0
    mark2 = run2.total_marks if run2 else 0.0

    max_marks = ans1.question.max_marks
    grade_band = max_marks * 0.10

    similarity = compute_text_similarity(ans1.student_answer_text, ans2.student_answer_text)
    mark_diff = abs(mark1 - mark2)
    is_inconsistent = (similarity > 0.70 and mark_diff > grade_band)

    return {
        "answer1": {
            "id": ans1.id,
            "student_name": ans1.submission.student.full_name,
            "mark": mark1,
            "text": ans1.student_answer_text
        },
        "answer2": {
            "id": ans2.id,
            "student_name": ans2.submission.student.full_name,
            "mark": mark2,
            "text": ans2.student_answer_text
        },
        "similarity_score": round(similarity, 3),
        "mark_difference": round(mark_diff, 2),
        "one_grade_band": round(grade_band, 2),
        "is_inconsistent": is_inconsistent,
        "warning": "Warning: These answers are semantically similar but received marks differing by more than one grade band (>10%). Review recommended." if is_inconsistent else None
    }

@router.get("/audit-logs")
def get_audit_logs(
    event_type: Optional[str] = None,
    limit: int = 50,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """Activity Log endpoint with filters."""
    query = db.query(AuditLog)
    if event_type:
        query = query.filter(AuditLog.event_type == event_type)

    logs = query.order_by(AuditLog.id.desc()).limit(limit).all()
    return [
        {
            "id": l.id,
            "event_type": l.event_type,
            "details": l.details,
            "user_email": l.user.email if l.user else "System",
            "created_at": l.created_at.isoformat()
        }
        for l in logs
    ]
