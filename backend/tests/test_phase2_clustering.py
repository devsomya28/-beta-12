import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import User, Assignment, Submission, Answer, GradeRun, Grade, RubricCriterion, Flag, AuditLog, Override
from backend.app.clustering import cluster_answers_for_question, apply_group_mark

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

def test_paraphrased_and_unrelated_clustering():
    """
    Test Phase 2 requirements:
    1. Two paraphrased answers land in the same group (>= 0.85 similarity).
    2. An unrelated answer does not join the group (lands in separate group or singleton).
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    assert assn is not None, "A published assignment must exist"
    q = assn.questions[0]

    student1 = db.query(User).filter(User.email == "student1@markanchor.edu").first()
    student2 = db.query(User).filter(User.email == "student2@markanchor.edu").first()
    student3 = db.query(User).filter(User.email == "student3@markanchor.edu").first()

    # Submission 1: Paraphrase A
    sub1 = Submission(assignment_id=assn.id, student_id=student1.id, status="graded", file_status="Text extracted")
    db.add(sub1)
    db.flush()
    ans1 = Answer(
        submission_id=sub1.id,
        question_id=q.id,
        student_answer_text="Supervised learning trains predictive models using labeled input-output training datasets."
    )
    db.add(ans1)

    # Submission 2: Paraphrase B
    sub2 = Submission(assignment_id=assn.id, student_id=student2.id, status="graded", file_status="Text extracted")
    db.add(sub2)
    db.flush()
    ans2 = Answer(
        submission_id=sub2.id,
        question_id=q.id,
        student_answer_text="In supervised learning, models are trained on labeled datasets containing input-output pairs to make predictions."
    )
    db.add(ans2)

    # Submission 3: Unrelated topic
    sub3 = Submission(assignment_id=assn.id, student_id=student3.id, status="graded", file_status="Text extracted")
    db.add(sub3)
    db.flush()
    ans3 = Answer(
        submission_id=sub3.id,
        question_id=q.id,
        student_answer_text="Photosynthesis is the biological process by which plants use sunlight, water, and carbon dioxide to produce oxygen and sugar."
    )
    db.add(ans3)
    db.commit()

    # Run clustering
    result = cluster_answers_for_question(q.id, db)

    # Verify paraphrased answers are grouped together
    found_group = None
    for g in result["groups"]:
        member_ids = [m["answer_id"] for m in g["members"]]
        if ans1.id in member_ids and ans2.id in member_ids:
            found_group = g
            break

    assert found_group is not None, "Paraphrased answers must land in the same cluster"
    assert found_group["count"] >= 2

    # Verify unrelated answer is NOT in that group
    group_member_ids = [m["answer_id"] for m in found_group["members"]]
    assert ans3.id not in group_member_ids, "Unrelated answer must NOT be placed in the supervised learning group"

    # Verify unrelated answer is either in singletons or in an independent group
    singleton_ids = [s["answer_id"] for s in result["singletons"]]
    other_group_members = [
        m["answer_id"]
        for g in result["groups"] if g["group_id"] != found_group["group_id"]
        for m in g["members"]
    ]
    assert (ans3.id in singleton_ids) or (ans3.id in other_group_members)
    db.close()


def test_inconsistent_marks_warning_and_outliers():
    """
    Test Phase 2 requirement:
    If marks inside one group differ by more than one band (10% of max marks),
    highlight the group with 'Inconsistent marks inside this group' and list outliers.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    q = assn.questions[0]
    crit = q.rubric_criteria[0] if q.rubric_criteria else None
    if not crit:
        crit = RubricCriterion(question_id=q.id, criterion_text="Accuracy", max_marks=q.max_marks, order_num=1)
        db.add(crit)
        db.commit()

    student1 = db.query(User).filter(User.email == "student1@markanchor.edu").first()
    student2 = db.query(User).filter(User.email == "student2@markanchor.edu").first()

    # Sub 1: High mark (10.0)
    sub1 = Submission(assignment_id=assn.id, student_id=student1.id, status="graded", file_status="Text extracted")
    db.add(sub1)
    db.flush()
    ans1 = Answer(
        submission_id=sub1.id,
        question_id=q.id,
        student_answer_text="Supervised learning maps inputs X to outputs Y using labeled dataset pairs consistently."
    )
    db.add(ans1)
    db.flush()
    run1 = GradeRun(answer_id=ans1.id, run_number=1, total_marks=10.0)
    db.add(run1)
    db.flush()
    g1 = Grade(grade_run_id=run1.id, rubric_criterion_id=crit.id, marks_awarded=10.0)
    db.add(g1)

    # Sub 2: Inconsistent Low mark (5.0, difference is 5.0 > 10% of 10 = 1.0)
    sub2 = Submission(assignment_id=assn.id, student_id=student2.id, status="graded", file_status="Text extracted")
    db.add(sub2)
    db.flush()
    ans2 = Answer(
        submission_id=sub2.id,
        question_id=q.id,
        student_answer_text="Supervised learning maps input data X to output labels Y using labeled dataset pairs consistently."
    )
    db.add(ans2)
    db.flush()
    run2 = GradeRun(answer_id=ans2.id, run_number=1, total_marks=5.0)
    db.add(run2)
    db.flush()
    g2 = Grade(grade_run_id=run2.id, rubric_criterion_id=crit.id, marks_awarded=5.0)
    db.add(g2)
    db.commit()

    result = cluster_answers_for_question(q.id, db)

    # Find the cluster containing both
    target_group = None
    for g in result["groups"]:
        m_ids = [m["answer_id"] for m in g["members"]]
        if ans1.id in m_ids and ans2.id in m_ids:
            target_group = g
            break

    assert target_group is not None, "Both answers should cluster together"
    assert target_group["marks_summary"]["is_inconsistent"] is True
    assert target_group["marks_summary"]["warning"] == "Inconsistent marks inside this group"
    assert len(target_group["marks_summary"]["outliers"]) > 0
    db.close()


def test_apply_group_mark_skips_flagged_member():
    """
    Test Phase 2 requirement:
    1. 'Apply to group' sets marks for clean members.
    2. Flagged members (e.g. injection) are skipped unless explicitly checked.
    3. Saves overrides with note 'Group apply' and logs in AuditLog.
    """
    db = SessionLocal()
    assn = db.query(Assignment).filter(Assignment.status == "published").first()
    q = assn.questions[0]
    crit = q.rubric_criteria[0]
    teacher = db.query(User).filter(User.role == "teacher").first()

    student1 = db.query(User).filter(User.email == "student1@markanchor.edu").first()
    student4 = db.query(User).filter(User.email == "student4@markanchor.edu").first()

    # Member 1: Clean
    sub_clean = Submission(assignment_id=assn.id, student_id=student1.id, status="graded", file_status="Text extracted")
    db.add(sub_clean)
    db.flush()
    ans_clean = Answer(
        submission_id=sub_clean.id,
        question_id=q.id,
        student_answer_text="Batch cluster test: neural networks learn hierarchical representations through backpropagation."
    )
    db.add(ans_clean)
    db.flush()
    run_clean = GradeRun(answer_id=ans_clean.id, run_number=1, total_marks=6.0)
    db.add(run_clean)
    db.flush()
    for c in q.rubric_criteria:
        db.add(Grade(grade_run_id=run_clean.id, rubric_criterion_id=c.id, marks_awarded=3.0))

    # Member 2: Has Injection Flag
    sub_flagged = Submission(assignment_id=assn.id, student_id=student4.id, status="graded", file_status="Text extracted")
    db.add(sub_flagged)
    db.flush()
    ans_flagged = Answer(
        submission_id=sub_flagged.id,
        question_id=q.id,
        student_answer_text="Batch cluster test: neural networks learn hierarchical representations through backpropagation with injection.",
        injection_detected=True
    )
    db.add(ans_flagged)
    db.flush()
    run_flagged = GradeRun(answer_id=ans_flagged.id, run_number=1, total_marks=0.0)
    db.add(run_flagged)
    db.flush()
    for c in q.rubric_criteria:
        db.add(Grade(grade_run_id=run_flagged.id, rubric_criterion_id=c.id, marks_awarded=0.0))
    db.add(Flag(
        submission_id=sub_flagged.id,
        answer_id=ans_flagged.id,
        flag_type="injection_attempt",
        reason="Prompt injection detected in cluster answer",
        severity="high"
    ))
    db.commit()

    # Apply mark (9.5) to group with include_flagged_answer_ids = [] (unchecked)
    res = apply_group_mark(
        question_id=q.id,
        target_mark=9.5,
        member_answer_ids=[ans_clean.id, ans_flagged.id],
        include_flagged_answer_ids=[],
        teacher_id=teacher.id,
        db=db
    )

    # Verify counts
    assert res["updated_count"] == 1
    assert res["skipped_flagged_count"] == 1

    # Verify clean member was updated to 9.5 total
    db.refresh(run_clean)
    total_clean = sum(g.marks_awarded for g in run_clean.grades)
    assert total_clean == 9.5

    # Verify flagged member was NOT updated (still 0.0)
    db.refresh(run_flagged)
    total_flagged = sum(g.marks_awarded for g in run_flagged.grades)
    assert total_flagged == 0.0

    # Verify override note is 'Group apply'
    ov = db.query(Override).filter(Override.submission_id == sub_clean.id).first()
    assert ov is not None
    assert ov.note == "Group apply"

    # Verify AuditLog has GROUP_MARK_APPLIED
    audit = db.query(AuditLog).filter(
        AuditLog.event_type == "GROUP_MARK_APPLIED"
    ).order_by(AuditLog.id.desc()).first()
    assert audit is not None
    assert "Applied group mark 9.5" in audit.details

    db.close()


def test_clustering_endpoints_security(teacher_auth, student_auth):
    """
    Test security:
    Teacher can access clustering and group apply.
    Students receive 403 Forbidden on both endpoints.
    """
    db = SessionLocal()
    assn = db.query(Assignment).first()
    q = assn.questions[0]
    db.close()

    # Teacher GET clusters -> 200 OK
    res_t = client.get(f"/api/review/assignments/{assn.id}/questions/{q.id}/clusters", headers=teacher_auth)
    assert res_t.status_code == 200
    assert "groups" in res_t.json()

    # Student GET clusters -> 403 Forbidden
    res_s = client.get(f"/api/review/assignments/{assn.id}/questions/{q.id}/clusters", headers=student_auth)
    assert res_s.status_code == 403

    # Student POST apply group mark -> 403 Forbidden
    res_s_post = client.post(
        f"/api/review/assignments/{assn.id}/questions/{q.id}/clusters/apply-group-mark",
        json={"target_mark": 8.0, "member_answer_ids": [1]},
        headers=student_auth
    )
    assert res_s_post.status_code == 403
