import io
import pytest
from datetime import datetime, timedelta
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import Assignment, Question, Submission

client = TestClient(app)

@pytest.fixture(scope="module")
def teacher_auth():
    res = client.post("/api/auth/login", json={"email": "teacher@markanchor.edu", "password": "teacher123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture(scope="module")
def student_auth():
    res = client.post("/api/auth/login", json={"email": "student1@markanchor.edu", "password": "student123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture(scope="module")
def published_assignment(teacher_auth):
    """Creates a published assignment for testing submissions."""
    deadline = (datetime.now() + timedelta(days=5)).isoformat()
    res = client.post(
        "/api/assignments",
        json={
            "course_id": 1,
            "title": "CS101 Assignment 1 - Supervised vs Unsupervised",
            "deadline": deadline,
            "late_policy": "accept_penalty",
            "penalty_percent": 10.0,
            "questions": [
                {
                    "question_number": 1,
                    "question_text": "Explain supervised vs unsupervised learning with examples.",
                    "max_marks": 10.0,
                    "criteria": [{"criterion_text": "Definitions", "max_marks": 5.0}, {"criterion_text": "Examples", "max_marks": 5.0}]
                },
                {
                    "question_number": 2,
                    "question_text": "Define Gradient Descent and learning rate.",
                    "max_marks": 10.0,
                    "criteria": [{"criterion_text": "Gradient Descent definition", "max_marks": 5.0}, {"criterion_text": "Learning rate role", "max_marks": 5.0}]
                }
            ]
        },
        headers=teacher_auth
    )
    assn_id = res.json()["id"]

    # Publish it
    pub = client.post(
        f"/api/assignments/{assn_id}/publish",
        json={
            "title": "CS101 Assignment 1 - Supervised vs Unsupervised",
            "deadline": deadline,
            "late_policy": "accept_penalty",
            "penalty_percent": 10.0
        },
        headers=teacher_auth
    )
    return pub.json()

def test_prepare_and_split_submission_text(published_assignment, student_auth):
    """Test text submission splitting into per-question answers."""
    assn_id = published_assignment["id"]
    submission_text = (
        "Question 1: Supervised learning requires labeled training pairs like spam filtering. "
        "Unsupervised learning uses unlabeled data like customer clustering.\n\n"
        "Question 2: Gradient descent iteratively updates weights to minimize loss. "
        "The learning rate controls the step size."
    )

    res = client.post(
        "/api/submissions/prepare-split",
        data={"assignment_id": assn_id, "raw_text": submission_text},
        headers=student_auth
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert len(data["parsed_answers"]) == 2
    assert "Supervised learning" in data["parsed_answers"][0]["answer_text"]
    assert "Gradient descent" in data["parsed_answers"][1]["answer_text"]

def test_failed_upload_handling_file_too_large(published_assignment, student_auth):
    """Verify that a file exceeding 10MB is rejected without creating a half-saved submission."""
    assn_id = published_assignment["id"]
    db = SessionLocal()
    initial_count = db.query(Submission).count()
    db.close()

    # Create dummy bytes > 10MB (10.5MB)
    large_bytes = b"0" * (11 * 1024 * 1024)
    file_payload = ("toolarge.txt", io.BytesIO(large_bytes), "text/plain")

    res = client.post(
        "/api/submissions/prepare-split",
        data={"assignment_id": assn_id},
        files={"file": file_payload},
        headers=student_auth
    )
    assert res.status_code == 400
    assert "10MB" in res.json()["detail"]

    # Ensure NO half-saved submission record was created in database
    db = SessionLocal()
    assert db.query(Submission).count() == initial_count
    db.close()

def test_confirm_submission_and_receipt(published_assignment, student_auth):
    """Test confirming submission and receipt issuance."""
    assn_id = published_assignment["id"]
    res = client.post(
        "/api/submissions/confirm",
        json={
            "assignment_id": assn_id,
            "raw_text": "Sample submission",
            "file_status": "Text typed directly",
            "ocr_confidence": 1.0,
            "answers": [
                {"question_id": 1, "question_number": 1, "answer_text": "Supervised vs unsupervised explanation"},
                {"question_id": 2, "question_number": 2, "answer_text": "Gradient descent explanation"}
            ]
        },
        headers=student_auth
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert "REC-" in data["receipt_id"]
    assert data["status"] in ["submitted", "pending_ai"]

def test_student_privacy_backend_enforcement(published_assignment, student_auth):
    """
    CRITICAL PRIVACY TEST:
    Students must NEVER receive AI scores, confidence, flags, or chunks via the API.
    """
    assn_id = published_assignment["id"]
    res = client.get(f"/api/submissions/assignment/{assn_id}/my-submission", headers=student_auth)
    assert res.status_code == 200
    data = res.json()
    assert data["has_submission"] is True
    latest = data["latest"]

    # Assert student view NEVER leaks AI internals
    assert "confidence" not in latest
    assert "flags" not in latest
    assert "grade_runs" not in latest
    assert "cited_chunk_id" not in latest

def test_late_policy_block(teacher_auth, student_auth):
    """Verify that late submissions are blocked when policy is 'block'."""
    # Create past-deadline assignment with policy 'block'
    past_deadline = (datetime.now() - timedelta(days=1)).isoformat()
    res = client.post(
        "/api/assignments",
        json={
            "course_id": 1,
            "title": "Strict Deadline Assignment",
            "deadline": past_deadline,
            "late_policy": "block",
            "questions": [{"question_number": 1, "question_text": "Q1", "max_marks": 10.0}]
        },
        headers=teacher_auth
    )
    assn_id = res.json()["id"]

    client.post(
        f"/api/assignments/{assn_id}/publish",
        json={"title": "Strict Deadline Assignment", "deadline": past_deadline, "late_policy": "block", "penalty_percent": 0.0},
        headers=teacher_auth
    )

    # Student submission should be blocked
    submit_res = client.post(
        "/api/submissions/confirm",
        json={
            "assignment_id": assn_id,
            "answers": [{"question_id": 1, "question_number": 1, "answer_text": "Late answer"}]
        },
        headers=student_auth
    )
    assert submit_res.status_code == 400
    assert "Submissions are closed" in submit_res.json()["detail"]

def test_ai_offline_pending_grading(published_assignment, student_auth):
    """Verify that submissions during AI offline are safely queued with status 'pending_ai'."""
    assn_id = published_assignment["id"]

    # Toggle AI Offline
    client.post("/api/health/toggle-ai", json={"offline": True})

    res = client.post(
        "/api/submissions/confirm",
        json={
            "assignment_id": assn_id,
            "answers": [
                {"question_id": 1, "question_number": 1, "answer_text": "Offline answer 1"},
                {"question_id": 2, "question_number": 2, "answer_text": "Offline answer 2"}
            ]
        },
        headers=student_auth
    )
    assert res.status_code == 200
    assert res.json()["status"] == "pending_ai"

    # Restore AI Online
    client.post("/api/health/toggle-ai", json={"offline": False})
