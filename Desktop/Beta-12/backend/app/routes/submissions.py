import shutil
import secrets
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from backend.app.database import get_db
from backend.app.models import Assignment, Question, Submission, Answer, Flag, AuditLog, User
from backend.app.auth import require_student, get_current_user
from backend.app.config import UPLOAD_DIR
from backend.app.text_extractor import extract_text_from_file
from backend.app.llm_provider import get_llm_provider, is_ai_forced_offline

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
    Handles AI offline: assigns status 'pending_ai'.
    Issues submission receipt.
    """
    assignment = db.query(Assignment).filter(Assignment.id == req.assignment_id).first()
    if not assignment or assignment.status != "published":
        raise HTTPException(status_code=404, detail="Published assignment not found")

    now = datetime.now()
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

    # Determine submission status
    initial_status = "pending_ai" if is_ai_forced_offline() else "submitted"

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
        confidence="High"
    )
    db.add(submission)
    db.flush()

    # Save answers
    for item in req.answers:
        ans = Answer(
            submission_id=submission.id,
            question_id=item.question_id,
            student_answer_text=item.answer_text.strip()
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
        details=f"Student {student.email} submitted assignment {assignment.id} (Receipt: {receipt_code}, Status: {initial_status}, Late: {is_late})"
    )
    db.add(audit)
    db.commit()
    db.refresh(submission)

    # Automatically run AI grading on submission
    if not is_ai_forced_offline():
        try:
            from backend.app.grading_engine import grade_submission
            grade_submission(submission.id, db)
            db.refresh(submission)
        except Exception as e:
            logger.error(f"Auto-grading error on submission {submission.id}: {str(e)}")

    return {
        "success": True,
        "submission_id": submission.id,
        "receipt_id": submission.submission_receipt,
        "timestamp": submission.created_at.isoformat(),
        "status": initial_status,
        "is_late": submission.is_late,
        "late_penalty_applied": submission.late_penalty_applied,
        "message": "Submission recorded successfully." + (" Queued as 'Pending AI grading' while AI is offline." if initial_status == "pending_ai" else "")
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
    """
    submissions = db.query(Submission).filter(
        Submission.assignment_id == assignment_id,
        Submission.student_id == student.id
    ).order_by(Submission.id.desc()).all()

    if not submissions:
        return {"has_submission": False, "latest": None, "history": []}

    latest = submissions[0]
    answers = db.query(Answer).filter(Answer.submission_id == latest.id).all()

    # Sanitized answers (no AI grades / no injection notes shown to student)
    sanitized_answers = [
        {
            "id": a.id,
            "question_id": a.question_id,
            "question_number": a.question.question_number if a.question else 1,
            "question_text": a.question.question_text if a.question else "",
            "student_answer_text": a.student_answer_text
        }
        for a in answers
    ]

    return {
        "has_submission": True,
        "latest": {
            "id": latest.id,
            "receipt_id": latest.submission_receipt,
            "status": latest.status,
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
