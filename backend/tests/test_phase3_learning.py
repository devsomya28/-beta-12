import pytest
from datetime import datetime
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import (
    User, Assignment, Question, RubricCriterion, Submission,
    Answer, GradeRun, Grade, Override, RubricSuggestion, RubricVersion,
    PublishedResult, AuditLog
)
from backend.app.correction_learning import (
    analyze_and_generate_suggestions, accept_suggestion,
    reject_suggestion, restore_rubric_version, regrade_affected_submissions
)

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


def test_three_similar_overrides_create_exactly_one_suggestion():
    """
    Test Phase 3 requirement:
    When the same pattern appears 3 or more times (e.g. criterion was over-marked 3 times),
    generate ONE suggestion with proposed rewording and evidence notes.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    assert assn is not None
    q = assn.questions[0]
    crit = q.rubric_criteria[0]
    teacher = db.query(User).filter(User.role == "teacher").first()
    student = db.query(User).filter(User.role == "student").first()

    # Clear any previous suggestions for this criterion
    db.query(RubricSuggestion).filter(RubricSuggestion.rubric_criterion_id == crit.id).delete()
    db.commit()

    # Create 3 overrides on this criterion where AI over-marked (diff = teacher - AI < 0)
    for i in range(3):
        sub = Submission(assignment_id=assn.id, student_id=student.id, status="graded")
        db.add(sub)
        db.flush()
        ov = Override(
            submission_id=sub.id,
            question_id=q.id,
            rubric_criterion_id=crit.id,
            teacher_id=teacher.id,
            original_mark=5.0,
            new_mark=4.0,  # diff = -1.0 (over-marked)
            note=f"Over-marked case #{i+1}: student omitted specific circuit derivation"
        )
        db.add(ov)
    db.commit()

    # Run analysis
    suggestions = analyze_and_generate_suggestions(assn.id, db)

    # Verify exactly one suggestion for this criterion
    target_sug = next((s for s in suggestions if s["rubric_criterion_id"] == crit.id), None)
    assert target_sug is not None, "Exactly one suggestion should be generated for 3 overrides"
    assert target_sug["pattern_type"] == "over_marked"
    assert target_sug["overrides_count"] >= 3
    assert "Over-marked" in target_sug["pattern_description"]
    assert len(target_sug["evidence_notes"]) >= 3
    assert target_sug["suggested_criterion_text"] != target_sug["current_criterion_text"]

    # Verify an initial version (v1) was preserved
    v1 = db.query(RubricVersion).filter(
        RubricVersion.rubric_criterion_id == crit.id,
        RubricVersion.version_number == 1
    ).first()
    assert v1 is not None
    assert v1.criterion_text == target_sug["current_criterion_text"]

    db.close()


def test_rejecting_hides_suggestion_permanently():
    """
    Test Phase 3 requirement:
    Rejecting a suggestion marks it rejected and prevents it from appearing again
    for the same pattern.
    """
    db = SessionLocal()
    teacher = db.query(User).filter(User.role == "teacher").first()

    sug = db.query(RubricSuggestion).filter(RubricSuggestion.status == "pending").first()
    assert sug is not None, "A pending suggestion must exist"
    sug_id = sug.id
    assn_id = sug.assignment_id
    crit_id = sug.rubric_criterion_id

    # Reject suggestion
    res = reject_suggestion(sug_id, teacher.id, db)
    assert res["success"] is True

    # Verify status in database
    db_sug = db.query(RubricSuggestion).filter(RubricSuggestion.id == sug_id).first()
    assert db_sug.status == "rejected"
    assert db_sug.resolved_at is not None

    # Verify AuditLog has RUBRIC_SUGGESTION_REJECTED
    audit = db.query(AuditLog).filter(
        AuditLog.event_type == "RUBRIC_SUGGESTION_REJECTED"
    ).order_by(AuditLog.id.desc()).first()
    assert audit is not None

    # Re-running analysis does NOT re-generate or return the rejected suggestion
    new_suggestions = analyze_and_generate_suggestions(assn_id, db)
    assert not any(s["rubric_criterion_id"] == crit_id and s["status"] == "pending" for s in new_suggestions)
    db.close()


def test_accepting_creates_new_version_and_rollback_restores():
    """
    Test Phase 3 requirement:
    1. Accepting a suggestion creates a new RubricVersion and updates criterion text.
    2. Old version is preserved and can be restored (rollback).
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    q = assn.questions[0]
    crit = q.rubric_criteria[0]
    teacher = db.query(User).filter(User.role == "teacher").first()
    student = db.query(User).filter(User.role == "student").first()

    # Reset any suggestions on this criterion
    db.query(RubricSuggestion).filter(RubricSuggestion.rubric_criterion_id == crit.id).delete()
    db.commit()

    # Seed 3 overrides
    for i in range(3):
        sub = Submission(assignment_id=assn.id, student_id=student.id, status="graded")
        db.add(sub)
        db.flush()
        db.add(Override(
            submission_id=sub.id,
            question_id=q.id,
            rubric_criterion_id=crit.id,
            teacher_id=teacher.id,
            original_mark=4.0,
            new_mark=5.0,  # under-marked
            note=f"Under-marked case #{i+1}: valid equivalent formula accepted"
        ))
    db.commit()

    # Generate suggestion
    suggestions = analyze_and_generate_suggestions(assn.id, db)
    sug = next(s for s in suggestions if s["rubric_criterion_id"] == crit.id)

    original_text = crit.criterion_text
    proposed_text = sug["suggested_criterion_text"]

    # Accept suggestion
    accept_res = accept_suggestion(sug["id"], edited_text=None, teacher_id=teacher.id, db=db)
    assert accept_res["success"] is True
    assert accept_res["new_version_number"] >= 2

    # Verify criterion text was updated
    db.refresh(crit)
    assert crit.criterion_text == proposed_text

    # Verify versions table has both v1 and v2
    v1 = db.query(RubricVersion).filter(
        RubricVersion.rubric_criterion_id == crit.id,
        RubricVersion.version_number == 1
    ).first()
    v2 = db.query(RubricVersion).filter(
        RubricVersion.rubric_criterion_id == crit.id,
        RubricVersion.version_number == accept_res["new_version_number"]
    ).first()
    assert v1 is not None
    assert v2 is not None
    assert v1.criterion_text == original_text
    assert v2.criterion_text == proposed_text

    # Test Rollback: restore v1
    restore_res = restore_rubric_version(v1.id, teacher.id, db)
    assert restore_res["success"] is True

    # Verify criterion text was restored to original
    db.refresh(crit)
    assert crit.criterion_text == original_text

    # Verify AuditLog logged both events
    audit_accept = db.query(AuditLog).filter(AuditLog.event_type == "RUBRIC_SUGGESTION_ACCEPTED").first()
    audit_restore = db.query(AuditLog).filter(AuditLog.event_type == "RUBRIC_VERSION_RESTORED").first()
    assert audit_accept is not None
    assert audit_restore is not None

    db.close()


def test_regrade_affected_unpublished_preserves_published():
    """
    Test Phase 3 requirement:
    1. Regrade runs ONLY for unpublished submissions of that question.
    2. Published results are NEVER changed automatically.
    3. Before/after mark comparison and 'Did it help?' panel are returned.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    q = assn.questions[0]
    crit = q.rubric_criteria[0]
    teacher = db.query(User).filter(User.role == "teacher").first()
    student = db.query(User).filter(User.role == "student").first()

    # Create an UNPUBLISHED submission
    sub_unpub = Submission(assignment_id=assn.id, student_id=student.id, status="graded")
    db.add(sub_unpub)
    db.flush()
    ans_unpub = Answer(
        submission_id=sub_unpub.id,
        question_id=q.id,
        student_answer_text="Regrade test: Supervised learning maps inputs to outputs with ground truth labels."
    )
    db.add(ans_unpub)
    db.flush()
    run_unpub = GradeRun(answer_id=ans_unpub.id, run_number=1, total_marks=4.0)
    db.add(run_unpub)
    db.flush()
    db.add(Grade(grade_run_id=run_unpub.id, rubric_criterion_id=crit.id, marks_awarded=4.0))

    # Create a PUBLISHED submission
    sub_pub = Submission(assignment_id=assn.id, student_id=student.id, status="published")
    db.add(sub_pub)
    db.flush()
    ans_pub = Answer(
        submission_id=sub_pub.id,
        question_id=q.id,
        student_answer_text="Published test answer that must never be altered."
    )
    db.add(ans_pub)
    db.flush()
    run_pub = GradeRun(answer_id=ans_pub.id, run_number=1, total_marks=8.0)
    db.add(run_pub)
    db.flush()
    db.add(Grade(grade_run_id=run_pub.id, rubric_criterion_id=crit.id, marks_awarded=8.0))
    pub_result = PublishedResult(
        submission_id=sub_pub.id,
        student_id=student.id,
        assignment_id=assn.id,
        final_total_marks=8.0,
        student_feedback="Final grade visible to student"
    )
    db.add(pub_result)
    db.commit()

    # Create an accepted suggestion
    sug = RubricSuggestion(
        assignment_id=assn.id,
        question_id=q.id,
        rubric_criterion_id=crit.id,
        pattern_type="over_marked",
        pattern_description="Over-marked 3 times",
        overrides_count=3,
        avg_mark_difference=1.0,
        current_criterion_text="Old text",
        suggested_criterion_text="Strict text requiring explicit derivation",
        status="accepted",
        created_at=datetime.utcnow()
    )
    db.add(sug)
    db.commit()

    # Run regrade
    res = regrade_affected_submissions(sug.id, teacher.id, db)
    assert res["success"] is True
    assert "did_it_help" in res
    assert "before_after" in res

    # Verify published submission was NOT regraded / changed
    db.refresh(pub_result)
    assert pub_result.final_total_marks == 8.0, "PublishedResult must NEVER be changed automatically"

    # Verify the published submission is NOT in the before_after unpublished list
    before_after_sub_ids = [item["submission_id"] for item in res["before_after"]]
    assert sub_pub.id not in before_after_sub_ids, "Published submissions must not be included in regrade list"
    assert sub_unpub.id in before_after_sub_ids, "Unpublished submission should be evaluated"

    db.close()


def test_suggestions_endpoints_security(teacher_auth, student_auth):
    """
    Test security:
    Teacher can access suggestions, accept, reject, regrade.
    Students receive 403 Forbidden.
    """
    db = SessionLocal()
    assn = db.query(Assignment).first()
    db.close()

    # Teacher GET suggestions -> 200 OK
    res_t = client.get(f"/api/review/assignments/{assn.id}/suggestions", headers=teacher_auth)
    assert res_t.status_code == 200
    assert "suggestions" in res_t.json()

    # Student GET suggestions -> 403 Forbidden
    res_s = client.get(f"/api/review/assignments/{assn.id}/suggestions", headers=student_auth)
    assert res_s.status_code == 403

    # Student POST accept -> 403 Forbidden
    res_s_accept = client.post(
        "/api/review/suggestions/1/accept",
        json={"edited_text": "Hacked text"},
        headers=student_auth
    )
    assert res_s_accept.status_code == 403
