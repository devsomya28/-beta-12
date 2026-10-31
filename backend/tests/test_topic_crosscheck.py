import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import User, Assignment, Question, Answer, Submission, RubricCriterion
from backend.app.grading_engine import cross_check_topic_with_ai, grade_single_answer, grade_submission

client = TestClient(app)

@pytest.fixture
def teacher_auth():
    res = client.post("/api/auth/login", json={"email": "teacher@markanchor.edu", "password": "password123"})
    assert res.status_code == 200
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}

@pytest.fixture
def student1_auth():
    res = client.post("/api/auth/login", json={"email": "student1@markanchor.edu", "password": "student123"})
    assert res.status_code == 200
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}

def test_cross_check_detects_college_form_and_awards_zero_marks():
    """Verify that an administrative/college form uploaded instead of an answer scores 0.0 marks."""
    college_form_text = """
    COLLEGE OF ENGINEERING AND TECHNOLOGY
    ADMISSION & SEMESTER REGISTRATION FORM 2026-2027
    Applicant Name: John Doe
    Roll Number: CS-2026-0891
    Father's Name: Robert Doe
    Date of Birth: 15/04/2004
    Branch: Computer Science & Engineering
    Fee Receipt No: CHAL-991204
    Office Use Only - Dean Approval Signature
    """
    question_text = "Explain the working principle and architecture of a Zener diode voltage regulator circuit."
    model_answer = "A Zener diode voltage regulator maintains a constant output voltage across a load by operating in its reverse breakdown region."

    is_on_topic, reason, checker = cross_check_topic_with_ai(college_form_text, question_text, model_answer)
    assert is_on_topic is False
    assert "administrative form" in reason.lower() or "unrelated" in reason.lower()

    # Now verify grading engine awards 0.0 marks
    db = SessionLocal()
    try:
        assn = db.query(Assignment).first()
        q = assn.questions[0]
        sub = Submission(assignment_id=assn.id, student_id=2, status="submitted", file_status="Text extracted")
        db.add(sub)
        db.flush()
        ans = Answer(submission_id=sub.id, question_id=q.id, student_answer_text=college_form_text)
        db.add(ans)
        db.commit()

        res = grade_single_answer(ans, q, [], db)
        assert res["is_off_topic"] is True
        assert res["primary_run_total"] == 0.0
        for g in res["primary_grades"]:
            assert g["marks_awarded"] == 0.0
            assert g["covered"] is False
    finally:
        db.close()

def test_cross_check_detects_different_subject_matter():
    """Verify that an answer on a totally different subject (e.g. photosynthesis vs voltage regulator) scores 0.0 marks."""
    biology_text = """
    Photosynthesis in green plants occurs within the chloroplast thylakoid membranes.
    Chlorophyll pigments absorb sunlight energy to synthesize glucose and release oxygen from water molecules.
    Light reactions produce ATP and NADPH for the Calvin cycle dark reactions.
    """
    question_text = "Explain the working principle and architecture of a Zener diode voltage regulator circuit."
    model_answer = "A Zener diode voltage regulator operates in the reverse breakdown region to keep voltage fixed."

    is_on_topic, reason, checker = cross_check_topic_with_ai(biology_text, question_text, model_answer)
    assert is_on_topic is False

    db = SessionLocal()
    try:
        assn = db.query(Assignment).first()
        q = assn.questions[0]
        sub = Submission(assignment_id=assn.id, student_id=2, status="submitted", file_status="Text extracted")
        db.add(sub)
        db.flush()
        ans = Answer(submission_id=sub.id, question_id=q.id, student_answer_text=biology_text)
        db.add(ans)
        db.commit()

        res = grade_single_answer(ans, q, [], db)
        assert res["is_off_topic"] is True
        assert res["primary_run_total"] == 0.0
    finally:
        db.close()
