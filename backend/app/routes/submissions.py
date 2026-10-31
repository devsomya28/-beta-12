import shutil
import secrets
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from backend.app.database import get_db
from backend.app.models import Assignment, Question, Submission, Answer, Flag, AuditLog, User
from backend.app.auth import require_student, get_current_user
from backend.app.config import UPLOAD_DIR, CORRECTION_WINDOW_SECONDS
from backend.app.text_extractor import extract_text_from_file
from backend.app.llm_provider import get_llm_provider, is_ai_forced_offline

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/submissions", tags=["Submissions"])

MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10MB limit per spec
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".png", ".jpg", ".jpeg"}

class AnswerItem(BaseModel):
    question_id: int
    question_number: int
    answer_text: str

class ConfirmSubmissionRequest(BaseModel):
    assignment_id: int
    raw_text: Optional[str] = ""
    file_status: Optional[str] = "Text extracted"
    ocr_confidence: Optional[float] = 1.0
    original_filename: Optional[str] = None
    answers: List[AnswerItem]

class StudentEditAnswerRequest(BaseModel):
    answer_text: str

class StudentCommentRequest(BaseModel):
    comment: str

@router.post("/prepare-split")
async def prepare_and_split_submission(
    assignment_id: int = Form(...),
    raw_text: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Accepts student's file (PDF, DOCX, TXT, PNG, JPG) or typed text for whole assignment.
    Validates size (<= 10MB) and format.
    Runs text extraction + OCR, computes confidence.
    Splits text into per-question answers for student preview.
    If upload fails, creates NO half-saved record and returns clear error.
    """
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment or assignment.status != "published":
        raise HTTPException(status_code=404, detail="Published assignment not found")

    # Check if student already submitted (No resubmission for exams or after correction window closes)
    existing_sub = db.query(Submission).filter(
        Submission.assignment_id == assignment.id,
        Submission.student_id == student.id,
        Submission.is_planted_check == False
    ).order_by(Submission.id.desc()).first()

    if existing_sub:
        if assignment.kind == "examination":
            raise HTTPException(
                status_code=400,
                detail="This is an Examination. Only one submission is permitted and resubmission is disabled."
            )
        is_window_active = False
        if existing_sub.correction_window_until and not existing_sub.window_locked:
            if datetime.utcnow() < existing_sub.correction_window_until:
                is_window_active = True
        if not is_window_active:
            raise HTTPException(
                status_code=400,
                detail="The correction window has closed. Your submission is final and resubmission is disabled."
            )

    questions = db.query(Question).filter(Question.assignment_id == assignment.id).order_by(Question.question_number.asc()).all()
    q_dicts = [
        {"question_id": q.id, "question_number": q.question_number, "question_text": q.question_text}
        for q in questions
    ]

    extracted_text = ""
    file_status = "Text extracted"
    ocr_conf = 1.0
    saved_filename = None

    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            # Audit upload failure
            audit = AuditLog(
                user_id=student.id,
                event_type="UPLOAD_FAILURE",
                details=f"Failed upload: Unsupported file extension '{ext}' for assignment {assignment_id}"
            )
            db.add(audit)
            db.commit()
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type '{ext}'. Allowed formats: PDF, DOCX, TXT, PNG, JPG"
            )

        # Read contents to check size <= 10MB
        file_bytes = await file.read()
        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            audit = AuditLog(
                user_id=student.id,
                event_type="UPLOAD_FAILURE",
                details=f"Failed upload: File '{file.filename}' exceeded 10MB limit ({len(file_bytes)} bytes)"
            )
            db.add(audit)
            db.commit()
            raise HTTPException(
                status_code=400,
                detail="File exceeds 10MB limit. Please upload a smaller file or type your answer instead."
            )

        # Save to student uploads
        student_dir = UPLOAD_DIR / "submissions" / f"student_{student.id}" / f"assn_{assignment_id}"
        student_dir.mkdir(parents=True, exist_ok=True)
        file_path = student_dir / file.filename
        with open(file_path, "wb") as f:
            f.write(file_bytes)

        saved_filename = file.filename

        # Extract text and run OCR
        res = extract_text_from_file(str(file_path), file.filename)
        if not res["success"] or not res["combined_text"].strip():
            audit = AuditLog(
                user_id=student.id,
                event_type="UPLOAD_FAILURE",
                details=f"Failed upload: Text extraction or OCR failed for '{file.filename}'"
            )
            db.add(audit)
            db.commit()
            raise HTTPException(
                status_code=400,
                detail="File could not be read or contains no extractable text. Please retry or type your answer instead."
            )

        extracted_text = res["combined_text"]
        file_status = res["extraction_status"]
        ocr_conf = res.get("min_confidence", 1.0)

    elif raw_text and raw_text.strip():
        extracted_text = raw_text.strip()
        file_status = "Text typed directly"
    else:
        raise HTTPException(status_code=400, detail="Please upload a file or type your answer.")

    # Split into per-question answers
    provider = get_llm_provider()
    success, split_res, raw_log = provider.split_student_answers(extracted_text, q_dicts)

    # Map split answers to question IDs
    parsed_answers = []
    split_map = {item["question_number"]: item["answer_text"] for item in split_res}

    for q in questions:
        ans_text = split_map.get(q.question_number, "")
        parsed_answers.append({
            "question_id": q.id,
            "question_number": q.question_number,
            "question_text": q.question_text,
            "answer_text": ans_text
        })

    # Deadline status check
    now = datetime.now()
    is_past = assignment.deadline and now > assignment.deadline
    late_msg = ""
    if is_past:
        if assignment.late_policy == "block":
            late_msg = "Deadline passed. Submissions are closed."
        elif assignment.late_policy == "accept_penalty":
            late_msg = f"Deadline passed. Your work will be marked LATE with a {assignment.penalty_percent}% penalty."
        else:
            late_msg = "Deadline passed. Your work will be accepted as LATE."

    return {
        "success": True,
        "assignment_kind": assignment.kind or "assignment",
        "raw_text": extracted_text,
        "file_status": file_status,
        "ocr_confidence": ocr_conf,
        "original_filename": saved_filename,
        "parsed_answers": parsed_answers,
        "deadline_info": {
            "is_past_deadline": is_past,
            "late_policy": assignment.late_policy,
            "penalty_percent": assignment.penalty_percent,
            "message": late_msg
        }
    }

@router.post("/confirm")
def confirm_submission(
    req: ConfirmSubmissionRequest,
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Confirms and saves the student's submission and per-question answers.
    Enforces deadline policy:
    - Block: raises 400
    - Accept with penalty / Accept late: marks is_late and records penalty
    - Examination rules: single submission only, no correction window, grading starts immediately.
    - Assignment rules: 2-minute correction window opens, grading starts after window closes.
    """
    assignment = db.query(Assignment).filter(Assignment.id == req.assignment_id).first()
    if not assignment or assignment.status != "published":
        raise HTTPException(status_code=404, detail="Published assignment not found")

    is_exam = (assignment.kind == "examination")

    # Check if student already submitted (No resubmission for exams or after correction window closes)
    existing_sub = db.query(Submission).filter(
        Submission.assignment_id == assignment.id,
        Submission.student_id == student.id,
        Submission.is_planted_check == False
    ).order_by(Submission.id.desc()).first()

    if existing_sub:
        if is_exam:
            raise HTTPException(
                status_code=400,
                detail="This is an Examination. Only one submission is permitted and resubmission is disabled."
            )
        is_window_active = False
        if existing_sub.correction_window_until and not existing_sub.window_locked:
            if datetime.utcnow() < existing_sub.correction_window_until:
                is_window_active = True
        if not is_window_active:
            raise HTTPException(
                status_code=400,
                detail="The correction window has closed. Your submission is final and resubmission is disabled."
            )

    now = datetime.utcnow()
    is_late = False
    penalty_applied = 0.0

    if assignment.deadline and now > assignment.deadline:
        if assignment.late_policy == "block":
            raise HTTPException(
                status_code=400,
                detail="Submissions are closed. The deadline has passed and late submissions are blocked."
            )
        elif assignment.late_policy == "accept_penalty":
            is_late = True
            penalty_applied = assignment.penalty_percent
        else:
            is_late = True
            penalty_applied = 0.0

    # Determine submission status and correction window
    initial_status = "pending_ai" if is_ai_forced_offline() else "submitted"
    if is_exam:
        window_until = None
        window_locked = True
    else:
        window_until = now + timedelta(seconds=CORRECTION_WINDOW_SECONDS)
        window_locked = False

    # Generate unique receipt (ID + timestamp)
    receipt_code = f"REC-CS101-{assignment.id}-{student.id}-{secrets.token_hex(4).upper()}"

    submission = Submission(
        assignment_id=assignment.id,
        student_id=student.id,
        status=initial_status,
        is_late=is_late,
        late_penalty_applied=penalty_applied,
        file_status=req.file_status or "Text extracted",
        original_filename=req.original_filename,
        raw_text=req.raw_text,
        submission_receipt=receipt_code,
        confidence="High",
        correction_window_until=window_until,
        window_locked=window_locked
    )
    db.add(submission)
    db.flush()

    # Save answers
    for item in req.answers:
        text = item.answer_text.strip()
        ans = Answer(
            submission_id=submission.id,
            question_id=item.question_id,
            student_answer_text=text,
            original_answer_text=text,
            student_edited=False,
            teacher_edited=False
        )
        db.add(ans)

    # Check if OCR confidence is low (< 0.60), flag for teacher
    if req.ocr_confidence and req.ocr_confidence < 0.60:
        flag = Flag(
            submission_id=submission.id,
            flag_type="needs_manual_reading",
            reason="Needs manual reading: OCR quality low",
            severity="high"
        )
        db.add(flag)

    # If answers are empty or splitting failed, flag
    if any(not a.answer_text.strip() for a in req.answers):
        flag2 = Flag(
            submission_id=submission.id,
            flag_type="needs_manual_reading",
            reason="Answer splitting incomplete or answer left blank",
            severity="medium"
        )
        db.add(flag2)

    # If late, add informational tag
    if is_late:
        late_flag = Flag(
            submission_id=submission.id,
            flag_type="late_submission",
            reason=f"Late submission ({penalty_applied}% penalty)",
            severity="low"
        )
        db.add(late_flag)

    # Audit log
    audit = AuditLog(
        user_id=student.id,
        event_type="SUBMISSION_CREATED",
        details=f"Student {student.email} submitted {'examination' if is_exam else 'assignment'} {assignment.id} (Receipt: {receipt_code}, Status: {initial_status}, Late: {is_late})"
    )
    db.add(audit)
    db.commit()
    db.refresh(submission)

    # For Examination: starts AI grading immediately (if AI online)
    # For Assignment: AI grading starts ONLY after the 2-minute window closes!
    if is_exam and not is_ai_forced_offline():
        try:
            from backend.app.grading_engine import grade_submission
            grade_submission(submission.id, db)
            db.refresh(submission)
        except Exception as e:
            logger.error(f"Auto-grading error on exam submission {submission.id}: {str(e)}")

    in_window = bool(not is_exam and not window_locked and window_until and datetime.utcnow() < window_until)

    return {
        "success": True,
        "submission_id": submission.id,
        "receipt_id": submission.submission_receipt,
        "timestamp": submission.created_at.isoformat(),
        "status": submission.status,
        "assignment_kind": assignment.kind or "assignment",
        "in_correction_window": in_window,
        "correction_window_until": submission.correction_window_until.isoformat() if submission.correction_window_until else None,
        "seconds_remaining": CORRECTION_WINDOW_SECONDS if in_window else 0,
        "is_late": submission.is_late,
        "late_penalty_applied": submission.late_penalty_applied,
        "message": (
            "Examination submitted successfully. Extracted text is final."
            if is_exam
            else f"Submission recorded. 2-minute correction window open ({CORRECTION_WINDOW_SECONDS}s remaining to edit or comment)."
        )
    }

@router.put("/{submission_id}/answers/{answer_id}")
def student_edit_answer(
    submission_id: int,
    answer_id: int,
    req: StudentEditAnswerRequest,
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Allows student to edit extracted answer text during the 2-minute correction window.
    Strictly forbidden for Examinations (403).
    Strictly forbidden after the window closes (403 enforced on backend via timestamps).
    """
    sub = db.query(Submission).filter(
        Submission.id == submission_id,
        Submission.student_id == student.id
    ).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    if sub.assignment.kind == "examination":
        raise HTTPException(status_code=403, detail="Answer editing is disabled for Examinations.")

    now = datetime.utcnow()
    if sub.window_locked or (sub.correction_window_until and now >= sub.correction_window_until):
        sub.window_locked = True
        db.commit()
        raise HTTPException(status_code=403, detail="The 2-minute correction window has closed. Edits are locked.")

    ans = db.query(Answer).filter(
        Answer.id == answer_id,
        Answer.submission_id == sub.id
    ).first()
    if not ans:
        raise HTTPException(status_code=404, detail="Answer not found")

    if ans.original_answer_text is None:
        ans.original_answer_text = ans.student_answer_text

    ans.student_answer_text = req.answer_text.strip()
    ans.student_edited = True

    audit = AuditLog(
        user_id=student.id,
        event_type="STUDENT_ANSWER_EDITED",
        details=f"Student {student.email} edited answer {ans.id} for question {ans.question_id} within correction window"
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "answer_id": ans.id,
        "student_answer_text": ans.student_answer_text,
        "original_answer_text": ans.original_answer_text,
        "student_edited": True
    }

@router.post("/{submission_id}/comment")
def student_add_comment(
    submission_id: int,
    req: StudentCommentRequest,
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Allows student to add a comment (e.g. 'OCR misread question 3') during the correction window.
    Strictly forbidden for Examinations (403).
    Strictly forbidden after the window closes (403).
    Creates flag 'student_reported_ocr_issue' for the teacher review screen.
    """
    sub = db.query(Submission).filter(
        Submission.id == submission_id,
        Submission.student_id == student.id
    ).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    if sub.assignment.kind == "examination":
        raise HTTPException(status_code=403, detail="Comments are disabled for Examinations.")

    now = datetime.utcnow()
    if sub.window_locked or (sub.correction_window_until and now >= sub.correction_window_until):
        sub.window_locked = True
        db.commit()
        raise HTTPException(status_code=403, detail="The 2-minute correction window has closed. Comments are locked.")

    sub.student_comment = req.comment.strip()

    # Add or update flag
    existing_flag = db.query(Flag).filter(
        Flag.submission_id == sub.id,
        Flag.flag_type == "student_reported_ocr_issue"
    ).first()
    if not existing_flag:
        flag = Flag(
            submission_id=sub.id,
            flag_type="student_reported_ocr_issue",
            reason=f"Student reported OCR issue: {sub.student_comment}",
            severity="medium"
        )
        db.add(flag)
    else:
        existing_flag.reason = f"Student reported OCR issue: {sub.student_comment}"

    audit = AuditLog(
        user_id=student.id,
        event_type="STUDENT_OCR_COMMENT",
        details=f"Student {student.email} submitted OCR comment on submission {sub.id}: '{sub.student_comment}'"
    )
    db.add(audit)
    db.commit()

    return {
        "success": True,
        "student_comment": sub.student_comment
    }

@router.post("/{submission_id}/finalize-window")
def finalize_correction_window(
    submission_id: int,
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Locks the correction window and triggers AI grading using the final text.
    Can be triggered by the student clicking 'Lock & Grade Now' or automatically.
    """
    sub = db.query(Submission).filter(
        Submission.id == submission_id,
        Submission.student_id == student.id
    ).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    if sub.window_locked and sub.status != "in_correction_window":
        return {"success": True, "status": sub.status, "window_locked": True}

    sub.window_locked = True
    sub.status = "pending_ai" if is_ai_forced_offline() else "submitted"

    audit = AuditLog(
        user_id=student.id,
        event_type="CORRECTION_WINDOW_CLOSED",
        details=f"Correction window closed for submission {sub.id} (Status: {sub.status})"
    )
    db.add(audit)
    db.commit()

    # AI grading starts only after window closes, using the final text
    if not is_ai_forced_offline():
        try:
            from backend.app.grading_engine import grade_submission
            grade_submission(sub.id, db)
            db.refresh(sub)
        except Exception as e:
            logger.error(f"Grading error after window close on submission {sub.id}: {str(e)}")

    return {
        "success": True,
        "status": sub.status,
        "window_locked": True,
        "message": "Correction window closed. AI grading started."
    }

@router.get("/assignment/{assignment_id}/my-submission")
def get_my_submission(
    assignment_id: int,
    student: User = Depends(require_student),
    db: Session = Depends(get_db)
):
    """
    Returns the student's submission history and latest submission.
    STRICT PRIVACY: Never includes AI scores, confidence, flags, or chunks!
    Auto-locks expired correction windows and initiates grading.
    """
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    submissions = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.student_id == student.id,
        Submission.is_planted_check == False
    ).order_by(Submission.id.desc()).all()

    if not submissions:
        return {
            "has_submission": False,
            "assignment_kind": assignment.kind or "assignment",
            "latest": None,
            "history": []
        }

    latest = submissions[0]

    # Auto-close window if expired
    now = datetime.utcnow()
    is_in_window = bool(not latest.window_locked and latest.correction_window_until and now < latest.correction_window_until)
    seconds_remaining = max(0, int((latest.correction_window_until - now).total_seconds())) if is_in_window else 0

    if not latest.window_locked and latest.correction_window_until and now >= latest.correction_window_until:
        latest.window_locked = True
        db.commit()
        if not is_ai_forced_offline() and latest.status in ["submitted", "pending_ai"]:
            try:
                from backend.app.grading_engine import grade_submission
                grade_submission(latest.id, db)
                db.refresh(latest)
            except Exception as e:
                logger.error(f"Auto-grade on expired window error: {str(e)}")
        is_in_window = False
        seconds_remaining = 0

    answers = db.query(Answer).filter(Answer.submission_id == latest.id).all()

    # Sanitized answers (no AI grades / no injection notes shown to student)
    sanitized_answers = [
        {
            "id": a.id,
            "question_id": a.question_id,
            "question_number": a.question.question_number if a.question else 1,
            "question_text": a.question.question_text if a.question else "",
            "student_answer_text": a.student_answer_text,
            "original_answer_text": a.original_answer_text or a.student_answer_text,
            "student_edited": a.student_edited
        }
        for a in answers
    ]

    return {
        "has_submission": True,
        "assignment_kind": assignment.kind or "assignment",
        "latest": {
            "id": latest.id,
            "receipt_id": latest.submission_receipt,
            "status": latest.status,
            "assignment_kind": assignment.kind or "assignment",
            "in_correction_window": is_in_window,
            "seconds_remaining": seconds_remaining,
            "correction_window_until": latest.correction_window_until.isoformat() if latest.correction_window_until else None,
            "student_comment": latest.student_comment,
            "window_locked": latest.window_locked,
            "is_late": latest.is_late,
            "late_penalty_applied": latest.late_penalty_applied,
            "file_status": latest.file_status,
            "original_filename": latest.original_filename,
            "created_at": latest.created_at.isoformat(),
            "answers": sanitized_answers
        },
        "history": [
            {
                "id": s.id,
                "receipt_id": s.submission_receipt,
                "created_at": s.created_at.isoformat(),
                "is_late": s.is_late,
                "status": s.status
            }
            for s in submissions
        ]
    }
