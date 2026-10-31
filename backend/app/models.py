from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, Boolean, Float, DateTime, ForeignKey
)
from sqlalchemy.orm import relationship
from backend.app.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    salt = Column(String(64), nullable=False)
    full_name = Column(String(255), nullable=False)
    role = Column(String(32), nullable=False)  # 'teacher' or 'student'
    created_at = Column(DateTime, default=datetime.utcnow)

    submissions = relationship("Submission", back_populates="student")
    audit_logs = relationship("AuditLog", back_populates="user")


class Course(Base):
    __tablename__ = "courses"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    code = Column(String(64), nullable=False)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    materials = relationship("Material", back_populates="course", cascade="all, delete-orphan")
    assignments = relationship("Assignment", back_populates="course", cascade="all, delete-orphan")


class Material(Base):
    __tablename__ = "materials"

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False)
    filename = Column(String(255), nullable=False)
    file_path = Column(String(512), nullable=False)
    status = Column(String(32), default="indexing")  # 'indexing', 'ready', 'failed'
    error_reason = Column(Text, nullable=True)
    extraction_status = Column(String(64), default="Text extracted")  # 'Text extracted', 'OCR used', 'OCR low confidence', 'Failed with reason'
    created_at = Column(DateTime, default=datetime.utcnow)

    course = relationship("Course", back_populates="materials")
    pages = relationship("MaterialPage", back_populates="material", cascade="all, delete-orphan")
    chunks = relationship("MaterialChunk", back_populates="material", cascade="all, delete-orphan")


class MaterialPage(Base):
    __tablename__ = "material_pages"

    id = Column(Integer, primary_key=True, index=True)
    material_id = Column(Integer, ForeignKey("materials.id"), nullable=False)
    page_number = Column(Integer, nullable=False)
    extracted_text = Column(Text, nullable=False)
    ocr_confidence = Column(Float, default=1.0)  # 0.0 to 1.0
    image_path = Column(String(512), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    material = relationship("Material", back_populates="pages")


class MaterialChunk(Base):
    __tablename__ = "material_chunks"

    id = Column(Integer, primary_key=True, index=True)
    material_id = Column(Integer, ForeignKey("materials.id"), nullable=False)
    chunk_index = Column(Integer, nullable=False)
    page_number = Column(Integer, nullable=False)
    chunk_text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    material = relationship("Material", back_populates="chunks")


class Assignment(Base):
    __tablename__ = "assignments"

    id = Column(Integer, primary_key=True, index=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    deadline = Column(DateTime, nullable=True)
    late_policy = Column(String(32), default="accept_penalty")  # 'block', 'accept_late', 'accept_penalty'
    penalty_percent = Column(Float, default=10.0)
    status = Column(String(32), default="draft")  # 'draft', 'published'
    kind = Column(String(32), default="assignment", nullable=False)  # 'assignment' or 'examination'
    created_at = Column(DateTime, default=datetime.utcnow)

    course = relationship("Course", back_populates="assignments")
    questions = relationship("Question", back_populates="assignment", cascade="all, delete-orphan", order_by="Question.question_number")
    submissions = relationship("Submission", back_populates="assignment", cascade="all, delete-orphan")


class Question(Base):
    __tablename__ = "questions"

    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False)
    question_number = Column(Integer, nullable=False)
    question_text = Column(Text, nullable=False)
    max_marks = Column(Float, nullable=False, default=10.0)
    model_answer = Column(Text, nullable=True)
    source_chunks_info = Column(Text, nullable=True)  # JSON summary of cited chunks / pages
    is_uncovered = Column(Boolean, default=False)
    # Phase B: Question Type ('text', 'math_numeric', 'mixed') & Teacher-accepted alternative methods
    question_type = Column(String(32), default="text", nullable=False)
    alternative_methods = Column(Text, nullable=True)  # JSON list of teacher-approved alternative solutions

    assignment = relationship("Assignment", back_populates="questions")
    rubric_criteria = relationship("RubricCriterion", back_populates="question", cascade="all, delete-orphan", order_by="RubricCriterion.order_num")
    answers = relationship("Answer", back_populates="question")


class RubricCriterion(Base):
    __tablename__ = "rubric_criteria"

    id = Column(Integer, primary_key=True, index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    criterion_text = Column(String(512), nullable=False)
    max_marks = Column(Float, nullable=False)
    order_num = Column(Integer, default=1)

    question = relationship("Question", back_populates="rubric_criteria")


class Submission(Base):
    __tablename__ = "submissions"

    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String(32), default="submitted")  # 'submitted', 'pending_ai', 'graded', 'approved', 'published', 'failed'
    is_late = Column(Boolean, default=False)
    late_penalty_applied = Column(Float, default=0.0)
    file_status = Column(String(64), default="Text extracted")  # 'Text extracted', 'OCR used', 'OCR low confidence', 'Failed with reason'
    original_filename = Column(String(255), nullable=True)
    file_path = Column(String(512), nullable=True)
    raw_text = Column(Text, nullable=True)
    submission_receipt = Column(String(64), nullable=True)  # receipt id + timestamp
    confidence = Column(String(16), default="High")  # 'High', 'Medium', 'Low'
    risk_score = Column(Float, default=0.0)  # 0 to 100
    risk_band = Column(String(16), default="Low")  # 'High', 'Medium', 'Low'
    risk_breakdown = Column(Text, nullable=True)  # JSON breakdown
    # Phase 4: Automation #7 Spot-Checks and Planted Known-Check Items
    is_planted_check = Column(Boolean, default=False, nullable=False)
    planted_expected_mark = Column(Float, nullable=True)
    planted_correct_mark = Column(Float, nullable=True)
    planted_error_caught = Column(Boolean, nullable=True)  # None=pending, True=caught, False=missed
    is_spot_check = Column(Boolean, default=False, nullable=False)
    spot_check_status = Column(String(32), nullable=True)  # 'pending', 'confirmed', 'corrected'
    # Phase A: 2-minute correction window
    correction_window_until = Column(DateTime, nullable=True)
    student_comment = Column(Text, nullable=True)
    window_locked = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    student = relationship("User", back_populates="submissions")
    assignment = relationship("Assignment", back_populates="submissions")
    answers = relationship("Answer", back_populates="submission", cascade="all, delete-orphan")
    flags = relationship("Flag", back_populates="submission", cascade="all, delete-orphan")
    published_result = relationship("PublishedResult", back_populates="submission", uselist=False)


class Answer(Base):
    __tablename__ = "answers"

    id = Column(Integer, primary_key=True, index=True)
    submission_id = Column(Integer, ForeignKey("submissions.id"), nullable=False)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    student_answer_text = Column(Text, nullable=False)
    original_answer_text = Column(Text, nullable=True)  # original extracted text snapshot
    student_edited = Column(Boolean, default=False, nullable=False)
    teacher_edited = Column(Boolean, default=False, nullable=False)
    injection_detected = Column(Boolean, default=False)
    injection_phrases = Column(Text, nullable=True)  # JSON list of detected strings

    submission = relationship("Submission", back_populates="answers")
    question = relationship("Question", back_populates="answers")
    grade_runs = relationship("GradeRun", back_populates="answer", cascade="all, delete-orphan")
    external_verification = relationship("ExternalVerification", back_populates="answer", uselist=False, cascade="all, delete-orphan")


class GradeRun(Base):
    __tablename__ = "grade_runs"

    id = Column(Integer, primary_key=True, index=True)
    answer_id = Column(Integer, ForeignKey("answers.id"), nullable=False)
    run_number = Column(Integer, nullable=False)  # 1, 2, 3
    total_marks = Column(Float, default=0.0)
    raw_llm_output = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    answer = relationship("Answer", back_populates="grade_runs")
    grades = relationship("Grade", back_populates="grade_run", cascade="all, delete-orphan")


class Grade(Base):
    __tablename__ = "grades"

    id = Column(Integer, primary_key=True, index=True)
    grade_run_id = Column(Integer, ForeignKey("grade_runs.id"), nullable=False)
    rubric_criterion_id = Column(Integer, ForeignKey("rubric_criteria.id"), nullable=False)
    marks_awarded = Column(Float, nullable=False, default=0.0)
    ai_reason = Column(Text, nullable=True)
    cited_chunk_id = Column(Integer, ForeignKey("material_chunks.id"), nullable=True)
    cited_page_num = Column(Integer, nullable=True)
    cited_text = Column(Text, nullable=True)
    covered_by_material = Column(Boolean, default=True)

    grade_run = relationship("GradeRun", back_populates="grades")
    criterion = relationship("RubricCriterion")


class ExternalVerification(Base):
    """
    Phase B: External AI Verifier for Math and Alternate Methods.
    Stored separately from RAG grades. Strictly advisory-only.
    """
    __tablename__ = "external_verifications"

    id = Column(Integer, primary_key=True, index=True)
    answer_id = Column(Integer, ForeignKey("answers.id"), nullable=False, unique=True)
    submission_id = Column(Integer, ForeignKey("submissions.id"), nullable=False)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)

    # Step 1: Deterministic check with SymPy
    sympy_result = Column(String(64), nullable=True)  # 'equivalent', 'different', 'parse_failed', 'no_model_expr', 'skipped'
    sympy_details = Column(Text, nullable=True)
    student_expr_parsed = Column(String(255), nullable=True)
    model_expr_parsed = Column(String(255), nullable=True)

    # Step 2: Second-opinion LLM check
    llm_verdict = Column(String(32), nullable=False)  # 'valid', 'partially_valid', 'invalid', 'cannot_verify'
    first_incorrect_step = Column(String(255), nullable=True)
    step_notes = Column(Text, nullable=True)  # JSON list of strings
    confidence = Column(Float, default=1.0)

    # Advisory metadata
    is_alternate_method = Column(Boolean, default=False)
    label = Column(String(64), default="Checked outside course material", nullable=False)
    status = Column(String(32), default="verified", nullable=False)  # 'verified', 'unavailable'
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    answer = relationship("Answer", back_populates="external_verification")
    submission = relationship("Submission")
    question = relationship("Question")


class Flag(Base):
    __tablename__ = "flags"

    id = Column(Integer, primary_key=True, index=True)
    submission_id = Column(Integer, ForeignKey("submissions.id"), nullable=False)
    answer_id = Column(Integer, ForeignKey("answers.id"), nullable=True)
    flag_type = Column(String(64), nullable=False)  # 'thin_material', 'uncovered_point', 'unstable_marks', 'marks_conflict', 'unusual_answer', 'injection_attempt', 'needs_manual_reading', 'late_submission'
    reason = Column(String(255), nullable=False)
    severity = Column(String(16), default="medium")  # 'high', 'medium', 'low'
    resolved = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    submission = relationship("Submission", back_populates="flags")


class Override(Base):
    __tablename__ = "overrides"

    id = Column(Integer, primary_key=True, index=True)
    submission_id = Column(Integer, ForeignKey("submissions.id"), nullable=False)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    rubric_criterion_id = Column(Integer, ForeignKey("rubric_criteria.id"), nullable=True)
    grade_id = Column(Integer, ForeignKey("grades.id"), nullable=True)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    original_mark = Column(Float, nullable=False)
    new_mark = Column(Float, nullable=False)
    note = Column(Text, nullable=False)  # Short note required by spec
    created_at = Column(DateTime, default=datetime.utcnow)

    submission = relationship("Submission")
    question = relationship("Question")
    criterion = relationship("RubricCriterion")


class PublishedResult(Base):
    __tablename__ = "published_results"

    id = Column(Integer, primary_key=True, index=True)
    submission_id = Column(Integer, ForeignKey("submissions.id"), unique=True, nullable=False)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False)
    final_total_marks = Column(Float, nullable=False)
    late_penalty_applied = Column(Float, default=0.0)
    student_feedback = Column(Text, nullable=True)  # Criteria met/missed feedback
    published_at = Column(DateTime, default=datetime.utcnow)

    submission = relationship("Submission", back_populates="published_result")


class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    event_type = Column(String(64), nullable=False)
    details = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="audit_logs")


class RubricSuggestion(Base):
    __tablename__ = "rubric_suggestions"

    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    rubric_criterion_id = Column(Integer, ForeignKey("rubric_criteria.id"), nullable=False)
    pattern_type = Column(String(32), nullable=False)  # 'over_marked' or 'under_marked'
    pattern_description = Column(String(255), nullable=False)
    overrides_count = Column(Integer, default=0)
    avg_mark_difference = Column(Float, default=0.0)
    current_criterion_text = Column(Text, nullable=False)
    suggested_criterion_text = Column(Text, nullable=False)
    evidence_notes = Column(Text, nullable=True)  # JSON list of evidence
    status = Column(String(32), default="pending")  # 'pending', 'accepted', 'rejected'
    created_at = Column(DateTime, default=datetime.utcnow)
    resolved_at = Column(DateTime, nullable=True)

    criterion = relationship("RubricCriterion")
    question = relationship("Question")
    assignment = relationship("Assignment")


class RubricVersion(Base):
    __tablename__ = "rubric_versions"

    id = Column(Integer, primary_key=True, index=True)
    rubric_criterion_id = Column(Integer, ForeignKey("rubric_criteria.id"), nullable=False)
    version_number = Column(Integer, nullable=False)
    criterion_text = Column(Text, nullable=False)
    change_reason = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    criterion = relationship("RubricCriterion")


class SpotCheckSession(Base):
    __tablename__ = "spot_check_sessions"

    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    triggered_at = Column(DateTime, default=datetime.utcnow)
    fast_approvals_count = Column(Integer, default=20)
    avg_review_seconds = Column(Float, default=5.0)
    status = Column(String(32), default="active")  # 'active', 'completed'
    planted_checks_passed = Column(Integer, default=0)
    planted_checks_missed = Column(Integer, default=0)
    real_samples_confirmed = Column(Integer, default=0)
    real_samples_corrected = Column(Integer, default=0)
    reopened_approvals_count = Column(Integer, default=0)

    assignment = relationship("Assignment")
    teacher = relationship("User")
