import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import User, Course, Material, Assignment, Question

client = TestClient(app)

@pytest.fixture(scope="module")
def teacher_auth():
    res = client.post("/api/auth/login", json={"email": "teacher@markanchor.edu", "password": "teacher123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture(scope="module")
def student_auth():
    res = client.post("/api/auth/login", json={"email": "student1@markanchor.edu", "password": "student123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

def test_course_material_and_chunks(teacher_auth):
    """Verify course material indexing with chunks and page numbers."""
    res = client.get("/api/courses/1/materials", headers=teacher_auth)
    assert res.status_code == 200
    materials = res.json()
    assert len(materials) > 0
    mat = materials[0]
    assert mat["status"] == "ready"
    assert mat["extraction_status"] in ["Text extracted", "OCR used", "OCR low confidence"]
    assert mat["total_chunks"] > 0

    # Test Material Viewer
    chunks_res = client.get(f"/api/materials/{mat['id']}/chunks", headers=teacher_auth)
    assert chunks_res.status_code == 200
    data = chunks_res.json()
    assert len(data["chunks"]) > 0
    assert data["chunks"][0]["page_number"] >= 1
    assert "chunk_text" in data["chunks"][0]

def test_extract_questions_from_text(teacher_auth):
    """Verify question extraction from assignment text."""
    res = client.post(
        "/api/assignments/upload-questions",
        data={"course_id": 1, "raw_text": "1. Explain supervised learning.\n2. Define Gradient Descent."},
        headers=teacher_auth
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert len(data["questions"]) >= 2
    assert data["questions"][0]["max_marks"] > 0

def test_rag_rubric_covered_question(teacher_auth):
    """Verify AI suggests rubric & model answer with citations when question is covered."""
    res = client.post(
        "/api/assignments/suggest-rubric",
        json={
            "course_id": 1,
            "question_text": "Explain the difference between supervised and unsupervised learning with concrete examples.",
            "max_marks": 10.0
        },
        headers=teacher_auth
    )
    assert res.status_code == 200
    data = res.json()
    assert data["covered"] is True
    assert len(data["criteria"]) > 0
    # Verify criteria marks sum to max_marks
    total = sum(c["max_marks"] for c in data["criteria"])
    assert abs(total - 10.0) < 0.1
    assert "Supervised learning" in data["model_answer"]
    assert len(data["cited_sources"]) > 0
    assert data["cited_sources"][0]["page_number"] >= 1

def test_rag_rubric_uncovered_question(teacher_auth):
    """Verify AI does NOT invent rubric if material does not cover the question."""
    res = client.post(
        "/api/assignments/suggest-rubric",
        json={
            "course_id": 1,
            "question_text": "Explain quantum entanglement in superconducting qubits and Bell inequalities.",
            "max_marks": 10.0
        },
        headers=teacher_auth
    )
    assert res.status_code == 200
    data = res.json()
    assert data["covered"] is False
    assert "Course material does not cover this question" in data["message"]
    assert len(data["criteria"]) == 0

def test_draft_invisibility_and_approval_gate(teacher_auth, student_auth):
    """
    Verify Approval Gate #1:
    - Draft assignments are strictly invisible to students on the backend.
    - Direct fetch returns 403.
    - After teacher publishes, assignment becomes visible to students.
    """
    # 1. Teacher creates draft
    create_res = client.post(
        "/api/assignments",
        json={
            "course_id": 1,
            "title": "Assignment Test Draft",
            "description": "Testing draft invisibility",
            "deadline": "2026-11-10T23:59:00",
            "late_policy": "accept_penalty",
            "penalty_percent": 10.0,
            "questions": [
                {
                    "question_number": 1,
                    "question_text": "What is Gradient Descent?",
                    "max_marks": 10.0,
                    "criteria": [
                        {"criterion_text": "Mathematical definition", "max_marks": 5.0, "order_num": 1},
                        {"criterion_text": "Learning rate role", "max_marks": 5.0, "order_num": 2}
                    ]
                }
            ]
        },
        headers=teacher_auth
    )
    assert create_res.status_code == 200
    draft_id = create_res.json()["id"]
    assert create_res.json()["status"] == "draft"

    # 2. Student queries assignments: Draft must NOT appear
    student_list = client.get("/api/assignments/courses/1", headers=student_auth).json()
    draft_ids = [a["id"] for a in student_list]
    assert draft_id not in draft_ids

    # 3. Student attempts direct access to draft: Must be 403 Forbidden
    direct_res = client.get(f"/api/assignments/{draft_id}", headers=student_auth)
    assert direct_res.status_code == 403

    # 4. Teacher Approves & Publishes (Approval Gate #1)
    publish_res = client.post(
        f"/api/assignments/{draft_id}/publish",
        json={
            "title": "Assignment Test Draft - Published",
            "deadline": "2026-11-10T23:59:00",
            "late_policy": "accept_penalty",
            "penalty_percent": 10.0
        },
        headers=teacher_auth
    )
    assert publish_res.status_code == 200
    assert publish_res.json()["status"] == "published"

    # 5. Now student queries assignments: It must appear!
    updated_student_list = client.get("/api/assignments/courses/1", headers=student_auth).json()
    assert draft_id in [a["id"] for a in updated_student_list]

def test_ai_offline_behavior(teacher_auth):
    """Verify that when AI is offline, AI suggestions are disabled but manual assignment creation works."""
    # Toggle offline
    client.post("/api/health/toggle-ai", json={"offline": True})

    # AI suggest rubric should return 503
    offline_res = client.post(
        "/api/assignments/suggest-rubric",
        json={"course_id": 1, "question_text": "Explain Gradient Descent", "max_marks": 10.0},
        headers=teacher_auth
    )
    assert offline_res.status_code == 503
    assert "AI offline" in offline_res.json()["detail"]

    # Manual creation still works completely!
    manual_res = client.post(
        "/api/assignments",
        json={
            "course_id": 1,
            "title": "Manual Assignment During AI Offline",
            "deadline": "2026-11-15T23:59:00",
            "late_policy": "block",
            "questions": [
                {
                    "question_number": 1,
                    "question_text": "Explain manual grading without AI.",
                    "max_marks": 10.0,
                    "criteria": [{"criterion_text": "Manual criteria", "max_marks": 10.0, "order_num": 1}]
                }
            ]
        },
        headers=teacher_auth
    )
    assert manual_res.status_code == 200

    # Restore AI Online
    client.post("/api/health/toggle-ai", json={"offline": False})
