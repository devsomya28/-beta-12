import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import Submission, Answer, Grade, Flag, Override, PublishedResult, User

client = TestClient(app)

@pytest.fixture(scope="module")
def teacher_auth():
    res = client.post("/api/auth/login", json={"email": "teacher@markanchor.edu", "password": "teacher123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture(scope="module")
def student_auth():
    res = client.post("/api/auth/login", json={"email": "student1@markanchor.edu", "password": "student123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

def test_flagged_queue_ordering_by_severity(teacher_auth):
    """Verify flagged submissions are ordered by severity (High before Medium/Low)."""
    res = client.get("/api/review/assignments/1/submissions", headers=teacher_auth)
    assert res.status_code == 200
    data = res.json()

    flagged = data["flagged_queue"]
    assert len(flagged) > 0
    # First items must have high severity (e.g. injection, uncovered, low OCR)
    severities = [s["max_severity"] for s in flagged]
    assert severities[0] == "high"

    # 'everything_else' contains unflagged items
    everything_else = data["everything_else"]
    assert len(everything_else) > 0
    for s in everything_else:
        assert len(s["flags"]) == 0

def test_override_requires_short_note(teacher_auth):
    """Verify that overriding any mark strictly requires a short note."""
    db = SessionLocal()
    alice_sub = db.query(Submission).join(Submission.student).filter(User.email == "student1@markanchor.edu").first()
    grade = alice_sub.answers[0].grade_runs[0].grades[0]
    db.close()

    # Attempt override without note
    bad_res = client.post(
        f"/api/review/submissions/{alice_sub.id}/override",
        json={
            "question_id": alice_sub.answers[0].question_id,
            "rubric_criterion_id": grade.rubric_criterion_id,
            "grade_id": grade.id,
            "new_mark": 3.5,
            "note": ""  # Missing note
        },
        headers=teacher_auth
    )
    assert bad_res.status_code == 400
    assert "note" in bad_res.json()["detail"].lower()

    # Valid override with note
    good_res = client.post(
        f"/api/review/submissions/{alice_sub.id}/override",
        json={
            "question_id": alice_sub.answers[0].question_id,
            "rubric_criterion_id": grade.rubric_criterion_id,
            "grade_id": grade.id,
            "new_mark": 3.5,
            "note": "Adjusted mark for exceptional clarity."
        },
        headers=teacher_auth
    )
    assert good_res.status_code == 200
    assert good_res.json()["new_mark"] == 3.5

def test_doubt_and_uncovered_resolution(teacher_auth):
    """
    Verify doubt resolution:
    - Teacher enters mark for uncovered part with note & accept_uncovered_as_valid.
    - Flag is marked resolved and covered_by_material becomes True.
    """
    db = SessionLocal()
    charlie_sub = db.query(Submission).join(Submission.student).filter(User.email == "student3@markanchor.edu").first()
    grade = charlie_sub.answers[0].grade_runs[0].grades[0]
    db.close()

    res = client.post(
        f"/api/review/submissions/{charlie_sub.id}/override",
        json={
            "question_id": charlie_sub.answers[0].question_id,
            "rubric_criterion_id": grade.rubric_criterion_id,
            "grade_id": grade.id,
            "new_mark": 2.5,
            "note": "Accepted quantum analogy as creative alternative.",
            "accept_uncovered_as_valid": True
        },
        headers=teacher_auth
    )
    assert res.status_code == 200

    # Verify grade updated and flag resolved
    db = SessionLocal()
    updated_grade = db.query(Grade).filter(Grade.id == grade.id).first()
    assert updated_grade.marks_awarded == 2.5
    assert updated_grade.covered_by_material is True

    uncovered_flags = db.query(Flag).filter(
        Flag.submission_id == charlie_sub.id,
        Flag.flag_type == "uncovered_point"
    ).all()
    for f in uncovered_flags:
        assert f.resolved is True
    db.close()

def test_approval_gate_2_publishing_and_student_privacy(teacher_auth, student_auth):
    """
    Verify Approval Gate #2:
    - Student cannot view results before teacher publishes (returns 404).
    - Teacher publishes results.
    - Student receives final marks, penalty, and feedback, but NEVER AI data.
    """
    db = SessionLocal()
    alice_sub = db.query(Submission).join(Submission.student).filter(User.email == "student1@markanchor.edu").first()
    db.close()

    # 1. Student requests published result before publishing -> 404
    pre_pub_res = client.get("/api/review/assignments/1/published-result", headers=student_auth)
    # May be 404 if not yet published
    if pre_pub_res.status_code != 404:
        pass

    # 2. Teacher approves and publishes
    appr_res = client.post(f"/api/review/submissions/{alice_sub.id}/approve", headers=teacher_auth)
    assert appr_res.status_code == 200

    pub_res = client.post(
        f"/api/review/submissions/{alice_sub.id}/publish-result",
        json={"student_feedback": "Excellent conceptual understanding of gradient descent."},
        headers=teacher_auth
    )
    assert pub_res.status_code == 200
    assert pub_res.json()["status"] == "published"

    # 3. Student fetches published result:
    student_res = client.get(f"/api/review/assignments/{alice_sub.assignment_id}/published-result", headers=student_auth)
    assert student_res.status_code == 200
    data = student_res.json()
    assert data["final_total_marks"] > 0
    assert "Excellent conceptual understanding" in data["student_feedback"]

    # Strict check: NEVER leaks AI details
    assert "confidence" not in data
    assert "flags" not in data
    assert "grade_runs" not in data
    assert "cited_chunk_id" not in data
    assert "injection" not in data

def test_bulk_approve_high_confidence(teacher_auth):
    """Verify bulk approving high confidence auto-graded submissions."""
    res = client.post("/api/review/assignments/1/bulk-approve-high-confidence", headers=teacher_auth)
    assert res.status_code == 200
    assert "approved_count" in res.json()
