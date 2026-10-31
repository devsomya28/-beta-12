import pytest
from datetime import datetime, timedelta
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import Assignment, Submission, Answer, Question, RubricCriterion, AuditLog
from backend.app.llm_provider import set_ai_offline

client = TestClient(app)

@pytest.fixture(autouse=True)
def ensure_ai_online():
    set_ai_offline(False)
    yield
    set_ai_offline(False)

@pytest.fixture(scope="module")
def teacher_auth():
    res = client.post("/api/auth/login", json={"email": "teacher@markanchor.edu", "password": "teacher123"})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture(scope="module")
def student1_auth():
    res = client.post("/api/auth/login", json={"email": "student1@markanchor.edu", "password": "student123"})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture(scope="module")
def student2_auth():
    res = client.post("/api/auth/login", json={"email": "student2@markanchor.edu", "password": "student123"})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def test_assignment_and_examination_creation(teacher_auth):
    """Verify teacher can create and publish both Assignment and Examination types."""
    # 1. Create Assignment
    assn_payload = {
        "course_id": 1,
        "title": "Phase A Test: Regular Assignment",
        "kind": "assignment",
        "deadline": (datetime.utcnow() + timedelta(days=7)).isoformat(),
        "late_policy": "accept_penalty",
        "penalty_percent": 10.0,
        "questions": [
            {
                "question_number": 1,
                "question_text": "What is Supervised Learning?",
                "max_marks": 10.0,
                "criteria": [{"criterion_text": "Definition", "max_marks": 10.0}]
            }
        ]
    }
    res = client.post("/api/assignments", json=assn_payload, headers=teacher_auth)
    assert res.status_code == 200
    assn_id = res.json()["id"]

    # Publish assignment
    pub_res = client.post(
        f"/api/assignments/{assn_id}/publish",
        json={
            "title": "Phase A Test: Regular Assignment",
            "kind": "assignment",
            "deadline": (datetime.utcnow() + timedelta(days=7)).isoformat(),
            "late_policy": "accept_penalty",
            "penalty_percent": 10.0
        },
        headers=teacher_auth
    )
    assert pub_res.status_code == 200
    assert pub_res.json()["kind"] == "assignment"

    # 2. Create Examination
    exam_payload = {
        "course_id": 1,
        "title": "Phase A Test: High-Stakes Examination",
        "kind": "examination",
        "deadline": (datetime.utcnow() + timedelta(days=7)).isoformat(),
        "late_policy": "block",
        "penalty_percent": 0.0,
        "questions": [
            {
                "question_number": 1,
                "question_text": "Solve the gradient update equation.",
                "max_marks": 10.0,
                "criteria": [{"criterion_text": "Mathematical derivation", "max_marks": 10.0}]
            }
        ]
    }
    res2 = client.post("/api/assignments", json=exam_payload, headers=teacher_auth)
    assert res2.status_code == 200
    exam_id = res2.json()["id"]

    pub_res2 = client.post(
        f"/api/assignments/{exam_id}/publish",
        json={
            "title": "Phase A Test: High-Stakes Examination",
            "kind": "examination",
            "deadline": (datetime.utcnow() + timedelta(days=7)).isoformat(),
            "late_policy": "block",
            "penalty_percent": 0.0
        },
        headers=teacher_auth
    )
    assert pub_res2.status_code == 200
    assert pub_res2.json()["kind"] == "examination"


def test_assignment_correction_window_lifecycle(teacher_auth, student1_auth):
    """
    Test Assignment rules:
    - 2-minute window opens on confirm
    - Student edits answer within window (succeeds)
    - Student adds comment within window (succeeds)
    - After window closes: edits and comments return 403 Forbidden (enforced on backend)
    - Original text preserved as diff
    """
    # 1. Fetch assignment questions
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.title == "Phase A Test: Regular Assignment").first()
    # Clean up prior test runs for student 1 on this assignment
    sub_prior = db.query(Submission).filter(Submission.assignment_id == assn.id).all()
    for sp in sub_prior:
        db.delete(sp)
    db.commit()
    q = assn.questions[0]
    assn_id = assn.id
    q_id = q.id
    db.close()

    # 2. Student confirms submission
    confirm_payload = {
        "assignment_id": assn_id,
        "raw_text": "1. Supervised learning maps inputs to outputs.",
        "file_status": "Text extracted",
        "ocr_confidence": 0.95,
        "original_filename": "hw1.pdf",
        "answers": [
            {"question_id": q_id, "question_number": 1, "answer_text": "Supervised lerning maps X to Y."}
        ]
    }
    conf_res = client.post("/api/submissions/confirm", json=confirm_payload, headers=student1_auth)
    assert conf_res.status_code == 200
    sub_data = conf_res.json()
    sub_id = sub_data["submission_id"]
    assert sub_data["in_correction_window"] is True
    assert sub_data["seconds_remaining"] > 0

    # 3. Check submission in DB
    db = SessionLocal()
    submission = db.query(Submission).filter(Submission.id == sub_id).first()
    assert submission.window_locked is False
    assert submission.correction_window_until is not None
    answer = submission.answers[0]
    ans_id = answer.id
    assert answer.original_answer_text == "Supervised lerning maps X to Y."
    db.close()

    # 4. Edit answer inside window -> should succeed
    edit_res = client.put(
        f"/api/submissions/{sub_id}/answers/{ans_id}",
        json={"answer_text": "Supervised learning maps labeled inputs to outputs accurately."},
        headers=student1_auth
    )
    assert edit_res.status_code == 200
    assert edit_res.json()["student_edited"] is True

    # 5. Add student comment inside window -> should succeed
    comment_res = client.post(
        f"/api/submissions/{sub_id}/comment",
        json={"comment": "OCR misread the spelling of learning"},
        headers=student1_auth
    )
    assert comment_res.status_code == 200
    assert comment_res.json()["student_comment"] == "OCR misread the spelling of learning"

    # 6. Verify audit log has the events
    db = SessionLocal()
    audit_events = [a.event_type for a in db.query(AuditLog).filter(AuditLog.user_id == submission.student_id).all()]
    assert "STUDENT_ANSWER_EDITED" in audit_events
    assert "STUDENT_OCR_COMMENT" in audit_events

    # 7. Simulate expiration of the 2-minute correction window on the backend
    submission = db.query(Submission).filter(Submission.id == sub_id).first()
    submission.correction_window_until = datetime.utcnow() - timedelta(seconds=10)
    db.commit()
    db.close()

    # 8. Attempt to edit answer AFTER window closes -> Must return 403 Forbidden!
    late_edit = client.put(
        f"/api/submissions/{sub_id}/answers/{ans_id}",
        json={"answer_text": "Trying to edit after window expired"},
        headers=student1_auth
    )
    assert late_edit.status_code == 403
    assert "closed" in late_edit.json()["detail"].lower()

    # 9. Attempt to add comment AFTER window closes -> Must return 403 Forbidden!
    late_comment = client.post(
        f"/api/submissions/{sub_id}/comment",
        json={"comment": "Trying to comment after window expired"},
        headers=student1_auth
    )
    assert late_comment.status_code == 403
    assert "closed" in late_comment.json()["detail"].lower()

    # 10. Finalize window (grading starts using final edited text)
    finalize_res = client.post(f"/api/submissions/{sub_id}/finalize-window", headers=student1_auth)
    assert finalize_res.status_code == 200
    assert finalize_res.json()["window_locked"] is True

    # Check grading ran on final text
    db = SessionLocal()
    sub_final = db.query(Submission).filter(Submission.id == sub_id).first()
    ans_final = sub_final.answers[0]
    assert ans_final.student_answer_text == "Supervised learning maps labeled inputs to outputs accurately."
    assert ans_final.original_answer_text == "Supervised lerning maps X to Y."
    assert ans_final.student_edited is True
    assert sub_final.window_locked is True
    db.close()


def test_examination_rules_and_fairness_safety_net(teacher_auth, student2_auth):
    """
    Test Examination rules:
    - Read-only preview (cannot edit split, cannot edit text)
    - Exactly ONE submission permitted (resubmission returns 400)
    - Edits and comments return 403 Forbidden
    - Teacher fairness safety net: Teacher can correct text/split in review screen,
      original is kept, and audit log records change
    """
    db = SessionLocal()
    exam = db.query(Assignment).filter(Assignment.title == "Phase A Test: High-Stakes Examination").first()
    # Clean up prior test runs on this examination
    sub_prior = db.query(Submission).filter(Submission.assignment_id == exam.id).all()
    for sp in sub_prior:
        db.delete(sp)
    db.commit()
    q = exam.questions[0]
    exam_id = exam.id
    q_id = q.id
    db.close()

    # 1. Student submits examination
    confirm_payload = {
        "assignment_id": exam_id,
        "raw_text": "1. w := w - alpha * grad(J)",
        "file_status": "Text extracted",
        "ocr_confidence": 0.98,
        "original_filename": "exam_scan.pdf",
        "answers": [
            {"question_id": q_id, "question_number": 1, "answer_text": "w := w - alphs * grad(J)"}
        ]
    }
    sub_res = client.post("/api/submissions/confirm", json=confirm_payload, headers=student2_auth)
    assert sub_res.status_code == 200
    sub_data = sub_res.json()
    sub_id = sub_data["submission_id"]
    assert sub_data["in_correction_window"] is False

    # 2. Resubmission attempt -> Must return 400 Bad Request
    resubmit_res = client.post("/api/submissions/confirm", json=confirm_payload, headers=student2_auth)
    assert resubmit_res.status_code == 400
    assert "only one submission is permitted" in resubmit_res.json()["detail"].lower()

    # Prepare-split attempt also blocked for examination
    prepare_res = client.post(
        "/api/submissions/prepare-split",
        data={"assignment_id": exam_id, "raw_text": "New attempt"},
        headers=student2_auth
    )
    assert prepare_res.status_code == 400

    # 3. Attempt to edit answer on Examination -> Must return 403 Forbidden
    db = SessionLocal()
    sub = db.query(Submission).filter(Submission.id == sub_id).first()
    ans_id = sub.answers[0].id
    db.close()

    edit_res = client.put(
        f"/api/submissions/{sub_id}/answers/{ans_id}",
        json={"answer_text": "Hacking exam answer"},
        headers=student2_auth
    )
    assert edit_res.status_code == 403
    assert "disabled for examinations" in edit_res.json()["detail"].lower()

    # 4. Attempt to comment on Examination -> Must return 403 Forbidden
    comm_res = client.post(
        f"/api/submissions/{sub_id}/comment",
        json={"comment": "Comment on examination"},
        headers=student2_auth
    )
    assert comm_res.status_code == 403
    assert "disabled for examinations" in comm_res.json()["detail"].lower()

    # 5. Teacher Fairness Safety Net: Teacher corrects extracted text in review
    correct_res = client.post(
        f"/api/review/submissions/{sub_id}/answers/{ans_id}/teacher-correct",
        json={
            "corrected_text": "w := w - alpha * grad(J) (Teacher corrected OCR alpha symbol)",
            "note": "OCR misread Greek letter alpha as alphs"
        },
        headers=teacher_auth
    )
    assert correct_res.status_code == 200
    correct_data = correct_res.json()
    assert correct_data["teacher_edited"] is True
    assert correct_data["original_answer_text"] == "w := w - alphs * grad(J)"
    assert "alpha" in correct_data["student_answer_text"]

    # Verify audit log records TEACHER_TEXT_CORRECTED
    db = SessionLocal()
    teacher_audits = [a.event_type for a in db.query(AuditLog).filter(AuditLog.event_type == "TEACHER_TEXT_CORRECTED").all()]
    assert "TEACHER_TEXT_CORRECTED" in teacher_audits
    db.close()


def test_strict_student_privacy_and_teacher_review_views(teacher_auth, student1_auth):
    """
    Test Teacher Review vs Student Privacy:
    - Teacher sees original vs edited diff and student comments in review endpoint.
    - Student API endpoint (/api/submissions/assignment/{id}/my-submission) strictly hides:
      model answers, AI score, rubric criteria evaluations, flags, chunks, and risk scores.
    - Student accessing teacher endpoints gets 403 Forbidden.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.title == "Phase A Test: Regular Assignment").first()
    assn_id = assn.id
    db.close()

    # 1. Teacher checks review screen submissions
    rev_res = client.get(f"/api/review/assignments/{assn_id}/submissions", headers=teacher_auth)
    assert rev_res.status_code == 200
    rev_data = rev_res.json()
    assert rev_data["assignment_kind"] == "assignment"
    all_subs = rev_data["flagged_queue"] + rev_data["everything_else"]
    assert len(all_subs) > 0
    sub_summary = all_subs[0]
    assert sub_summary["has_student_comment"] is True
    assert "OCR misread" in sub_summary["student_comment"]
    assert sub_summary["student_edited"] is True

    # 2. Teacher checks submission detail
    detail_res = client.get(f"/api/review/submissions/{sub_summary['id']}", headers=teacher_auth)
    assert detail_res.status_code == 200
    detail = detail_res.json()
    assert detail["student_comment"] == "OCR misread the spelling of learning"
    ans_detail = detail["answers"][0]
    assert ans_detail["student_edited"] is True
    assert ans_detail["original_answer_text"] != ans_detail["student_answer_text"]

    # 3. Student fetches their submission
    my_sub_res = client.get(f"/api/submissions/assignment/{assn_id}/my-submission", headers=student1_auth)
    assert my_sub_res.status_code == 200
    my_sub = my_sub_res.json()
    assert my_sub["has_submission"] is True
    latest = my_sub["latest"]

    # STRICT PRIVACY CHECKS: No AI grades, model answers, flags, risk scores, or chunks
    assert "grades" not in latest
    assert "total_marks" not in latest
    assert "flags" not in latest
    assert "risk_score" not in latest
    assert "confidence" not in latest
    for a in latest["answers"]:
        assert "model_answer" not in a
        assert "criteria_grades" not in a
        assert "cited_text" not in a

    # 4. Student attempts to access teacher review endpoint -> Must return 403 Forbidden
    teacher_view_res = client.get(f"/api/review/assignments/{assn_id}/submissions", headers=student1_auth)
    assert teacher_view_res.status_code == 403
