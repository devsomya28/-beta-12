import json
import pytest
from datetime import datetime, timedelta
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from backend.app.main import app
from backend.app.database import get_db, Base, engine
from backend.app.models import User, Course, Assignment, Question, RubricCriterion, Submission, Answer, ExternalVerification, Flag
from backend.app.verifier import (
    has_math_or_calculation,
    run_sympy_check,
    should_trigger_verifier,
    call_llm_verifier
)

client = TestClient(app)

@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    yield

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


def test_math_detection_and_sympy():
    """Verify formula detection and SymPy deterministic checks."""
    assert has_math_or_calculation("x^2 + 5x + 6 = 0") is True
    assert has_math_or_calculation("The final answer = 42") is True
    assert has_math_or_calculation("Just a qualitative essay about machine learning history.") is False

    # SymPy Equivalent
    res_equiv = run_sympy_check("Hence the result is x = 2*y + 4", "Model answer: x = 4 + 2*y")
    assert res_equiv["sympy_result"] == "equivalent"

    # SymPy Different
    res_diff = run_sympy_check("Answer = 15", "Answer = 42")
    assert res_diff["sympy_result"] == "different"

    # SymPy Parse Failed
    res_failed = run_sympy_check("Answer is (3 + 2 *", "Answer = 42")
    assert res_failed["sympy_result"] == "parse_failed"
    assert "without guessing" in res_failed["sympy_details"]


def test_plain_text_question_never_triggers_verifier():
    """Requirement: A plain text question NEVER triggers the external verifier."""
    q = Question(
        assignment_id=1,
        question_number=1,
        question_text="Explain the difference between supervised and unsupervised learning.",
        max_marks=10.0,
        model_answer="Supervised learning uses labeled datasets; unsupervised learning finds patterns.",
        question_type="text"
    )
    student_text = "Supervised learning relies on ground-truth target labels. Unsupervised clustering finds structure."
    
    triggered, reason = should_trigger_verifier(q, student_text, [], [])
    assert triggered is False
    assert reason == ""


def test_alternate_math_method_triggers_and_verifies_valid(teacher_auth, student_auth, monkeypatch):
    """
    Requirement: A correct alternate-method math answer gets the verdict 'valid'
    and is flagged for the teacher with NO marks given automatically.
    """
    import backend.app.verifier
    monkeypatch.setattr(backend.app.verifier, "VERIFIER_MODE", "mock")

    # 1. Create assignment with a math question in course 1
    a_res = client.post("/api/assignments", json={
        "course_id": 1,
        "title": "Calculus Exam 1 - Quadratic Roots",
        "kind": "examination",
        "questions": [
            {
                "question_number": 1,
                "question_text": "Solve the quadratic equation x^2 - 5x + 6 = 0.",
                "max_marks": 10.0,
                "question_type": "math_numeric",
                "model_answer": "Factor into (x - 2)(x - 3) = 0. Therefore x = 2 or x = 3.",
                "criteria": [
                    {"criterion_text": "Methodology and setup", "max_marks": 5.0, "order_num": 1},
                    {"criterion_text": "Correct roots identified", "max_marks": 5.0, "order_num": 2}
                ]
            }
        ]
    }, headers=teacher_auth)
    assert a_res.status_code == 200
    assignment_id = a_res.json()["id"]

    # Publish examination
    client.post(f"/api/assignments/{assignment_id}/publish", json={
        "title": "Calculus Exam 1 - Quadratic Roots",
        "deadline": (datetime.utcnow() + timedelta(days=2)).isoformat(),
        "late_policy": "accept_penalty",
        "kind": "examination"
    }, headers=teacher_auth)

    # 2. Student submits using ALTERNATIVE METHOD (Quadratic Formula instead of factoring)
    alt_student_solution = (
        "Using the Quadratic Formula: x = (-b +- sqrt(b^2 - 4ac)) / (2a)\n"
        "Here a=1, b=-5, c=6.\n"
        "Discriminant = (-5)^2 - 4(1)(6) = 25 - 24 = 1.\n"
        "x = (5 +- 1) / 2 => x = 3 or x = 2.\n"
        "Answer = 3"
    )

    split_res = client.post("/api/submissions/prepare-split", data={
        "assignment_id": assignment_id,
        "raw_text": f"Question 1:\n{alt_student_solution}"
    }, headers=student_auth)
    assert split_res.status_code == 200

    confirm_res = client.post("/api/submissions/confirm", json={
        "assignment_id": assignment_id,
        "answers": split_res.json()["parsed_answers"]
    }, headers=student_auth)
    assert confirm_res.status_code == 200
    sub_id = confirm_res.json()["submission_id"]

    # 3. Verify teacher review details
    rev_res = client.get(f"/api/review/submissions/{sub_id}", headers=teacher_auth)
    assert rev_res.status_code == 200
    data = rev_res.json()

    ans = data["answers"][0]
    assert ans["external_verification"] is not None
    ev = ans["external_verification"]

    # Advisory rules check:
    # - Verdict is 'valid'
    # - Labeled 'Checked outside course material'
    assert ev["llm_verdict"] == "valid"
    assert ev["label"] == "Checked outside course material"

    # Check that flag 'alternative_method' is created and submission is flagged
    flags = [f["type"] for f in data["flags"]]
    assert "alternative_method" in flags

    # 4. Teacher Doubt Resolution / Accept Alternate Method
    q_id = ans["question_id"]
    accept_res = client.post(f"/api/review/questions/{q_id}/accept-method", json={
        "method_text": "Quadratic Formula: x = (-b +- sqrt(b^2 - 4ac))/(2a)",
        "note": "Teacher-approved quadratic formula alternative",
        "submission_id": sub_id
    }, headers=teacher_auth)
    assert accept_res.status_code == 200
    assert accept_res.json()["success"] is True

    # 5. Regrade unpublished submissions for this question
    regrade_res = client.post(f"/api/review/questions/{q_id}/regrade-unpublished", headers=teacher_auth)
    assert regrade_res.status_code == 200
    assert regrade_res.json()["regraded_count"] >= 1

    # 6. Verify grader now cites "Teacher-approved alternative"
    rev_after = client.get(f"/api/review/submissions/{sub_id}", headers=teacher_auth).json()
    cg_reasons = [cg["ai_reason"] for cg in rev_after["answers"][0]["criteria_grades"]]
    assert any("Teacher-approved alternative" in r for r in cg_reasons)

    # 7. Student privacy: Student CANNOT see external verification data through API
    student_view = client.get(f"/api/submissions/assignment/{assignment_id}/my-submission", headers=student_auth)
    assert student_view.status_code == 200
    sv_json = student_view.json()
    assert "external_verification" not in sv_json
    assert "flags" not in sv_json
    if sv_json.get("latest") and sv_json["latest"].get("answers"):
        for a in sv_json["latest"]["answers"]:
            assert "external_verification" not in a
            assert "sympy_result" not in a
            assert "llm_verdict" not in a


def test_invalid_math_method_verdict():
    """Requirement: A wrong answer gets 'invalid'."""
    res = call_llm_verifier(
        question_text="Calculate 2 + 2",
        student_text="Calculation: 2 + 2 = 5 due to arithmetic error",
        model_answer="2 + 2 = 4",
        sympy_summary="SymPy: different",
        mode="mock"
    )
    assert res["verdict"] == "invalid"
    assert "Step 2" in res["first_incorrect_step"]


def test_unparseable_answer_cannot_verify():
    """Requirement: An unparseable answer gives 'cannot verify' without guessing."""
    res = call_llm_verifier(
        question_text="Solve differential equation",
        student_text="cannot parse gibberish",
        model_answer="dy/dx = y",
        sympy_summary="SymPy: parse_failed",
        mode="mock"
    )
    assert res["verdict"] == "cannot_verify"


def test_verifier_offline_graceful_handling():
    """
    Requirement: If the verifier is offline or unavailable, show 'Verification unavailable',
    still flag the submission, and never block grading.
    """
    from backend.app.llm_provider import set_ai_offline
    set_ai_offline(True)
    try:
        res = call_llm_verifier(
            question_text="Solve x^2 = 9",
            student_text="x = 3 or -3",
            model_answer="x = +-3",
            sympy_summary="SymPy: equivalent"
        )
        assert res["status"] == "unavailable"
        assert res["verdict"] == "cannot_verify"
        assert "offline" in res["step_notes"][0].lower()
    finally:
        set_ai_offline(False)
