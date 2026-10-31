import json
import shutil
from pathlib import Path
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from backend.app.database import get_db
from backend.app.models import Course, Assignment, Question, RubricCriterion, MaterialChunk, User, AuditLog
from backend.app.auth import get_current_user, require_teacher
from backend.app.config import UPLOAD_DIR
from backend.app.text_extractor import extract_text_from_file
from backend.app.llm_provider import get_llm_provider, is_ai_forced_offline
from backend.app.rag import BM25Retriever

router = APIRouter(prefix="/api/assignments", tags=["Assignments"])

# Pydantic models for assignment management
class CriterionInput(BaseModel):
    criterion_text: str
    max_marks: float
    order_num: Optional[int] = 1

class QuestionInput(BaseModel):
    id: Optional[int] = None
    question_number: int
    question_text: str
    max_marks: float
    model_answer: Optional[str] = None
    source_chunks_info: Optional[str] = None
    is_uncovered: Optional[bool] = False
    criteria: List[CriterionInput] = []

class CreateAssignmentRequest(BaseModel):
    course_id: int
    title: str
    description: Optional[str] = ""
    deadline: Optional[str] = None
    late_policy: Optional[str] = "accept_penalty"
    penalty_percent: Optional[float] = 10.0
    questions: List[QuestionInput] = []

class PublishAssignmentRequest(BaseModel):
    title: str
    deadline: str  # ISO string or YYYY-MM-DDTHH:MM
    late_policy: str  # 'block', 'accept_late', 'accept_penalty'
    penalty_percent: float = 10.0

class SuggestRubricRequest(BaseModel):
    course_id: int
    question_text: str
    max_marks: float

@router.post("/upload-questions")
async def upload_questions_file(
    course_id: int = Form(...),
    raw_text: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Teacher uploads assignment questions (PDF/DOCX/TXT/image) OR types them.
    AI extracts the list of questions with suggested max marks.
    """
    extracted_text = ""
    file_status = "Text extracted"

    if file and file.filename:
        course_dir = UPLOAD_DIR / f"course_{course_id}" / "assignments"
        course_dir.mkdir(parents=True, exist_ok=True)
        file_path = course_dir / file.filename
        with open(file_path, "wb") as buf:
            shutil.copyfileobj(file.file, buf)

        res = extract_text_from_file(str(file_path), file.filename)
        if not res["success"]:
            raise HTTPException(status_code=400, detail=f"Failed to extract questions: {res.get('error')}")
        extracted_text = res["combined_text"]
        file_status = res["extraction_status"]
    elif raw_text:
        extracted_text = raw_text
    else:
        raise HTTPException(status_code=400, detail="Provide either a file or typed text.")

    provider = get_llm_provider()
    if is_ai_forced_offline():
        # Fallback question extraction when AI is offline
        questions = [
            {"question_number": i + 1, "question_text": q.strip(), "max_marks": 10.0}
            for i, q in enumerate(extracted_text.split("\n\n")) if q.strip()
        ]
        if not questions:
            questions = [{"question_number": 1, "question_text": extracted_text.strip(), "max_marks": 10.0}]
        return {
            "success": True,
            "extraction_status": file_status,
            "ai_offline": True,
            "questions": questions,
            "message": "AI is offline: Questions parsed using manual line splitter."
        }

    success, questions, raw = provider.extract_questions(extracted_text)
    if not success:
        raise HTTPException(status_code=500, detail=f"Question extraction failed: {raw}")

    return {
        "success": True,
        "extraction_status": file_status,
        "ai_offline": False,
        "questions": questions
    }

@router.post("/suggest-rubric")
def suggest_rubric_for_question(
    req: SuggestRubricRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    For a question, retrieves top course material chunks and suggests:
    - a rubric (criteria, marks adding up to max_marks),
    - a model answer,
    - the source chunks used (with page numbers).
    If the material does not cover the question, returns 'Course material does not cover this question'.
    """
    if is_ai_forced_offline():
        raise HTTPException(status_code=503, detail="AI offline: Rubric auto-suggestions are disabled. You can type rubrics manually.")

    # Retrieve all chunks for this course
    chunks = db.query(MaterialChunk).join(MaterialChunk.material).filter(
        MaterialChunk.material.has(course_id=req.course_id)
    ).all()

    chunk_dicts = [
        {"id": c.id, "chunk_index": c.chunk_index, "page_number": c.page_number, "chunk_text": c.chunk_text}
        for c in chunks
    ]

    retriever = BM25Retriever()
    retriever.fit(chunk_dicts)
    top_scored = retriever.retrieve(req.question_text, top_k=3)

    retrieved_chunks = [item[0] for item in top_scored]
    best_score = top_scored[0][1] if top_scored else 0.0

    # If best score is negligible or chunks are empty, treat as uncovered
    if best_score < 0.20 or not retrieved_chunks:
        return {
            "covered": False,
            "message": "Course material does not cover this question",
            "model_answer": None,
            "criteria": [],
            "cited_sources": []
        }

    provider = get_llm_provider()
    success, res, raw = provider.suggest_rubric_and_model_answer(
        req.question_text,
        req.max_marks,
        retrieved_chunks
    )

    if not success:
        raise HTTPException(status_code=500, detail="Failed to suggest rubric")

    return res

@router.post("")
def create_draft_assignment(
    req: CreateAssignmentRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """Creates a draft assignment with questions, rubrics, and model answers."""
    course = db.query(Course).filter(Course.id == req.course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    deadline_dt = datetime.fromisoformat(req.deadline.replace("Z", "")) if req.deadline else None

    assignment = Assignment(
        course_id=course.id,
        title=req.title,
        description=req.description,
        deadline=deadline_dt,
        late_policy=req.late_policy or "accept_penalty",
        penalty_percent=req.penalty_percent or 10.0,
        status="draft"
    )
    db.add(assignment)
    db.flush()

    for q_in in req.questions:
        q = Question(
            assignment_id=assignment.id,
            question_number=q_in.question_number,
            question_text=q_in.question_text,
            max_marks=q_in.max_marks,
            model_answer=q_in.model_answer,
            source_chunks_info=q_in.source_chunks_info,
            is_uncovered=q_in.is_uncovered or False
        )
        db.add(q)
        db.flush()

        for c_in in q_in.criteria:
            crit = RubricCriterion(
                question_id=q.id,
                criterion_text=c_in.criterion_text,
                max_marks=c_in.max_marks,
                order_num=c_in.order_num or 1
            )
            db.add(crit)

    audit = AuditLog(
        user_id=teacher.id,
        event_type="CREATE_ASSIGNMENT_DRAFT",
        details=f"Created draft assignment '{assignment.title}' with {len(req.questions)} questions."
    )
    db.add(audit)
    db.commit()
    db.refresh(assignment)

    return {"id": assignment.id, "title": assignment.title, "status": assignment.status}

@router.put("/{assignment_id}")
def update_assignment(
    assignment_id: int,
    req: CreateAssignmentRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """Updates an existing assignment (questions, marks, rubrics, settings)."""
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    assignment.title = req.title
    assignment.description = req.description
    if req.deadline:
        assignment.deadline = datetime.fromisoformat(req.deadline.replace("Z", ""))
    assignment.late_policy = req.late_policy
    assignment.penalty_percent = req.penalty_percent

    # Remove old questions and replace
    db.query(Question).filter(Question.assignment_id == assignment.id).delete()
    db.flush()

    for q_in in req.questions:
        q = Question(
            assignment_id=assignment.id,
            question_number=q_in.question_number,
            question_text=q_in.question_text,
            max_marks=q_in.max_marks,
            model_answer=q_in.model_answer,
            source_chunks_info=q_in.source_chunks_info,
            is_uncovered=q_in.is_uncovered or False
        )
        db.add(q)
        db.flush()

        for c_in in q_in.criteria:
            crit = RubricCriterion(
                question_id=q.id,
                criterion_text=c_in.criterion_text,
                max_marks=c_in.max_marks,
                order_num=c_in.order_num or 1
            )
            db.add(crit)

    audit = AuditLog(
        user_id=teacher.id,
        event_type="EDIT_ASSIGNMENT",
        details=f"Updated assignment '{assignment.title}' (questions updated: {len(req.questions)})"
    )
    db.add(audit)
    db.commit()
    return {"id": assignment.id, "title": assignment.title, "status": assignment.status}

@router.post("/{assignment_id}/publish")
def publish_assignment(
    assignment_id: int,
    req: PublishAssignmentRequest,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    """
    Approval Gate #1: Teacher sets title, deadline, and late policy, then clicks 'Approve & Publish'.
    Draft becomes published and visible to students.
    """
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if not assignment.questions:
        raise HTTPException(status_code=400, detail="Cannot publish assignment with no questions.")

    assignment.title = req.title
    assignment.deadline = datetime.fromisoformat(req.deadline.replace("Z", ""))
    assignment.late_policy = req.late_policy
    assignment.penalty_percent = req.penalty_percent
    assignment.status = "published"

    audit = AuditLog(
        user_id=teacher.id,
        event_type="PUBLISH_ASSIGNMENT",
        details=f"Published assignment '{assignment.title}'. Deadline: {assignment.deadline.isoformat()}, Late policy: {assignment.late_policy}"
    )
    db.add(audit)
    db.commit()

    return {
        "id": assignment.id,
        "title": assignment.title,
        "status": assignment.status,
        "deadline": assignment.deadline.isoformat(),
        "late_policy": assignment.late_policy,
        "message": "Assignment approved and published to students."
    }

@router.get("/{assignment_id}")
def get_assignment(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Returns assignment details.
    Enforces rule: Drafts are strictly invisible to students!
    """
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    if current_user.role == "student" and assignment.status != "published":
        raise HTTPException(status_code=403, detail="Forbidden: Draft assignments are invisible to students.")

    questions = db.query(Question).filter(Question.assignment_id == assignment.id).order_by(Question.question_number.asc()).all()

    return {
        "id": assignment.id,
        "course_id": assignment.course_id,
        "title": assignment.title,
        "description": assignment.description,
        "deadline": assignment.deadline.isoformat() if assignment.deadline else None,
        "late_policy": assignment.late_policy,
        "penalty_percent": assignment.penalty_percent,
        "status": assignment.status,
        "questions": [
            {
                "id": q.id,
                "question_number": q.question_number,
                "question_text": q.question_text,
                "max_marks": q.max_marks,
                "model_answer": q.model_answer if current_user.role == "teacher" else None,  # Hide model answer from students!
                "source_chunks_info": q.source_chunks_info if current_user.role == "teacher" else None,
                "is_uncovered": q.is_uncovered,
                "criteria": [
                    {
                        "id": c.id,
                        "criterion_text": c.criterion_text,
                        "max_marks": c.max_marks,
                        "order_num": c.order_num
                    }
                    for c in q.rubric_criteria
                ] if current_user.role == "teacher" else []  # Students see rubric criteria only if published or after submission
            }
            for q in questions
        ]
    }

@router.get("/courses/{course_id}")
def list_course_assignments(
    course_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Lists assignments for a course.
    Teachers see both Draft and Published assignments.
    Students see ONLY Published assignments.
    """
    query = db.query(Assignment).filter(Assignment.course_id == course_id)
    if current_user.role == "student":
        query = query.filter(Assignment.status == "published")

    assignments = query.order_by(Assignment.id.desc()).all()
    return [
        {
            "id": a.id,
            "title": a.title,
            "description": a.description,
            "deadline": a.deadline.isoformat() if a.deadline else None,
            "late_policy": a.late_policy,
            "penalty_percent": a.penalty_percent,
            "status": a.status,
            "total_questions": len(a.questions),
            "created_at": a.created_at.isoformat()
        }
        for a in assignments
    ]

@router.delete("/{assignment_id}")
def delete_assignment(
    assignment_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    db.delete(assignment)
    db.commit()
    return {"success": True, "message": "Assignment deleted"}
