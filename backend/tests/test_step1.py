import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import User, Course
from backend.app.auth import hash_password

client = TestClient(app)

def test_health_endpoint():
    """Verify AI status indicator health check endpoint."""
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["ai_status"] in ["online", "offline"]
    assert "provider" in data

    # Test toggling to offline
    toggle_res = client.post("/api/health/toggle-ai", json={"offline": True})
    assert toggle_res.status_code == 200
    assert toggle_res.json()["ai_status"] == "offline"
    assert toggle_res.json()["ai_online"] is False

    # Restore to online
    restore_res = client.post("/api/health/toggle-ai", json={"offline": False})
    assert restore_res.status_code == 200
    assert restore_res.json()["ai_status"] == "online"
    assert restore_res.json()["ai_online"] is True

def test_seed_users_exist():
    """Verify 1 teacher and 8 students exist in database."""
    db = SessionLocal()
    try:
        teacher = db.query(User).filter(User.role == "teacher").first()
        assert teacher is not None
        assert teacher.email == "teacher@markanchor.edu"

        students = db.query(User).filter(User.role == "student").all()
        assert len(students) == 8
        student_emails = {s.email for s in students}
        for i in range(1, 9):
            assert f"student{i}@markanchor.edu" in student_emails

        course = db.query(Course).first()
        assert course is not None
        assert course.code == "CS101"
    finally:
        db.close()

def test_auth_login_teacher():
    """Verify teacher login with valid and invalid credentials."""
    # Valid
    res = client.post("/api/auth/login", json={
        "email": "teacher@markanchor.edu",
        "password": "teacher123"
    })
    assert res.status_code == 200
    data = res.json()
    assert "access_token" in data
    assert data["user"]["role"] == "teacher"
    assert data["user"]["email"] == "teacher@markanchor.edu"

    # Invalid
    bad_res = client.post("/api/auth/login", json={
        "email": "teacher@markanchor.edu",
        "password": "wrongpassword"
    })
    assert bad_res.status_code == 401

def test_auth_login_student():
    """Verify student login with valid credentials."""
    res = client.post("/api/auth/login", json={
        "email": "student1@markanchor.edu",
        "password": "student123"
    })
    assert res.status_code == 200
    data = res.json()
    assert "access_token" in data
    assert data["user"]["role"] == "student"

def test_auth_me_endpoint():
    """Verify protected /api/auth/me endpoint."""
    login_res = client.post("/api/auth/login", json={
        "email": "teacher@markanchor.edu",
        "password": "teacher123"
    })
    token = login_res.json()["access_token"]

    # With valid token
    me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_res.status_code == 200
    assert me_res.json()["email"] == "teacher@markanchor.edu"

    # Without token
    unauth_res = client.get("/api/auth/me")
    assert unauth_res.status_code == 401
