import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import (
    User, Assignment, Question, RubricCriterion,
    Submission, Answer, GradeRun, Grade, SpotCheckSession, AuditLog
)
from backend.app.spot_checks import (
    record_approval, create_spot_checks, resolve_spot_check, teacher_speed_tracker
)
from backend.app.spot_checks_config import FAST_APPROVAL_THRESHOLD

client = TestClient(app)

@pytest.fixture
def teacher_auth():
    res = client.post("/api/auth/login", json={"email": "teacher@markanchor.edu", "password": "teacher123"})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture
def student_auth():
    res = client.post("/api/auth/login", json={"email": "student1@markanchor.edu", "password": "student123"})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def test_fast_approvals_auto_trigger(teacher_auth):
    """
    Test Phase 4:
    Approving 20 fast submissions in a row (<10s) with no edits automatically triggers spot-checks.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    assert assn is not None
    teacher = db.query(User).filter(User.role == "teacher").first()
    assert teacher is not None

    teacher_speed_tracker.clear()

    # Clear active sessions for clean test state
    db.query(SpotCheckSession).filter(
        SpotCheckSession.assignment_id == assn.id,
        SpotCheckSession.teacher_id == teacher.id
    ).delete()
    db.commit()

    # Simulate 19 fast approvals (<10s)
    for _ in range(FAST_APPROVAL_THRESHOLD - 1):
        res = record_approval(teacher.id, assn.id, duration_seconds=4.0, had_override=False, db=db)
        assert res["triggered"] is False

    # 20th fast approval -> auto triggers!
    res20 = record_approval(teacher.id, assn.id, duration_seconds=5.0, had_override=False, db=db)
    assert res20["triggered"] is True
    assert "session_id" in res20

    # Verify session in DB
    session = db.query(SpotCheckSession).filter(SpotCheckSession.id == res20["session_id"]).first()
    assert session is not None
    assert session.status == "active"
    assert session.fast_approvals_count >= FAST_APPROVAL_THRESHOLD

    # Verify spot check samples and planted check items were created
    planted = db.query(Submission).filter(
        Submission.assignment_id == assn.id,
        Submission.is_planted_check == True
    ).all()
    assert len(planted) >= 1
    assert planted[0].is_planted_check is True
    assert planted[0].planted_expected_mark is not None
    assert planted[0].planted_correct_mark is not None
    db.close()


def test_planted_items_never_appear_in_student_api(student_auth):
    """
    Test Phase 4:
    Planted check items NEVER appear in the student API or submission history.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    teacher = db.query(User).filter(User.role == "teacher").first()

    # Ensure a session with planted items exists
    create_spot_checks(assignment_id=assn.id, teacher_id=teacher.id, fast_count=20, avg_duration=4.0, db=db)
    planted_subs = db.query(Submission).filter(
        Submission.assignment_id == assn.id,
        Submission.is_planted_check == True
    ).all()
    assert len(planted_subs) > 0
    planted_ids = {p.id for p in planted_subs}
    db.close()

    # Query student API
    resp = client.get(f"/api/submissions/assignment/{assn.id}/my-submission", headers=student_auth)
    assert resp.status_code == 200
    data = resp.json()

    # Ensure no planted check is returned in latest or history
    if data["has_submission"]:
        history_ids = {h["id"] for h in data["history"]}
        assert len(history_ids.intersection(planted_ids)) == 0
        if data["latest"]:
            assert data["latest"]["id"] not in planted_ids


def test_catching_planted_error(teacher_auth):
    """
    Test Phase 4:
    Teacher catches planted deliberately wrong mark -> records CAUGHT error and vigilance.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    teacher = db.query(User).filter(User.role == "teacher").first()

    session = create_spot_checks(assignment_id=assn.id, teacher_id=teacher.id, fast_count=20, avg_duration=4.0, db=db)
    planted_sub = db.query(Submission).filter(
        Submission.assignment_id == assn.id,
        Submission.is_planted_check == True
    ).first()
    assert planted_sub is not None
    initial_passed = session.planted_checks_passed
    db.close()

    resp = client.post(
        f"/api/review/spot-checks/{planted_sub.id}/resolve",
        json={"action": "correct", "new_mark": 8.0},
        headers=teacher_auth
    )
    assert resp.status_code == 200
    res_data = resp.json()
    assert res_data["success"] is True
    assert res_data["error_caught"] is True

    # Check DB state
    db = SessionLocal()
    sub_refreshed = db.query(Submission).filter(Submission.id == planted_sub.id).first()
    assert sub_refreshed.planted_error_caught is True
    assert sub_refreshed.spot_check_status == "corrected"

    sess_refreshed = db.query(SpotCheckSession).filter(SpotCheckSession.id == session.id).first()
    assert sess_refreshed.planted_checks_passed == initial_passed + 1
    db.close()


def test_missing_planted_error_reopens_approvals(teacher_auth):
    """
    Test Phase 4:
    Teacher confirms a planted deliberately wrong mark -> records MISSED error,
    generates gentle alert, and re-opens related real approvals for a second look.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    teacher = db.query(User).filter(User.role == "teacher").first()

    session = create_spot_checks(assignment_id=assn.id, teacher_id=teacher.id, fast_count=20, avg_duration=4.0, db=db)
    planted_sub = db.query(Submission).filter(
        Submission.assignment_id == assn.id,
        Submission.is_planted_check == True,
        Submission.spot_check_status == "pending"
    ).first()

    if not planted_sub:
        planted_sub = db.query(Submission).filter(
            Submission.assignment_id == assn.id,
            Submission.is_planted_check == True
        ).first()

    assert planted_sub is not None
    initial_missed = session.planted_checks_missed
    db.close()

    resp = client.post(
        f"/api/review/spot-checks/{planted_sub.id}/resolve",
        json={"action": "confirm"},
        headers=teacher_auth
    )
    assert resp.status_code == 200
    res_data = resp.json()
    assert res_data["success"] is True
    assert res_data["error_caught"] is False
    assert "reopened_count" in res_data
    assert "quality-control" in res_data["message"].lower() or "deliberately planted" in res_data["message"].lower()

    # Check DB state
    db = SessionLocal()
    sub_refreshed = db.query(Submission).filter(Submission.id == planted_sub.id).first()
    assert sub_refreshed.planted_error_caught is False
    assert sub_refreshed.spot_check_status == "confirmed"

    sess_refreshed = db.query(SpotCheckSession).filter(SpotCheckSession.id == session.id).first()
    assert sess_refreshed.planted_checks_missed == initial_missed + 1
    db.close()


def test_spot_checks_teacher_only_security(student_auth):
    """
    Test Phase 4:
    Student role is forbidden (403) from accessing spot checks endpoints.
    """
    resp = client.get("/api/review/assignments/1/trust-detector", headers=student_auth)
    assert resp.status_code == 403

    resp2 = client.post("/api/review/spot-checks/1/resolve", json={"action": "confirm"}, headers=student_auth)
    assert resp2.status_code == 403
