import io
import fitz
import pytest
from datetime import datetime, timedelta
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.database import SessionLocal
from backend.app.models import User, Submission, Answer, Grade, Flag, Override, PublishedResult
from backend.app.text_extractor import extract_text_from_file
from backend.app.grading_engine import grade_submission

client = TestClient(app)

@pytest.fixture(scope="module")
def teacher_auth():
    res = client.post("/api/auth/login", json={"email": "teacher@markanchor.edu", "password": "teacher123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

@pytest.fixture(scope="module")
def student_auth():
    res = client.post("/api/auth/login", json={"email": "student1@markanchor.edu", "password": "student123"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}

def test_extra_a_why_did_i_lose_marks(teacher_auth, student_auth):
    """
    Test Extra Feature A: 'Why did I lose marks?'
    - Returns criteria breakdown with 'Met'/'Missed' status.
    - Points to course material section/page to revise.
    - NEVER reveals model answer or exact missing text.
    """
    db = SessionLocal()
    alice = db.query(User).filter(User.email == "student1@markanchor.edu").first()
    pub = db.query(PublishedResult).filter(PublishedResult.student_id == alice.id).first()
    assn_id = pub.assignment_id if pub else 1
    db.close()

    res = client.get(f"/api/review/assignments/{assn_id}/student-feedback", headers=student_auth)
    assert res.status_code == 200
    data = res.json()
    assert "questions" in data
    assert len(data["questions"]) > 0

    q1 = data["questions"][0]
    assert len(q1["criteria_breakdown"]) > 0
    crit = q1["criteria_breakdown"][0]
    assert crit["status"] in ["Met", "Missed", "Partially Met"]
    assert "Review Course Notes" in crit["revision_pointer"]
    assert "Page" in crit["revision_pointer"]

    # Assert model answer is NEVER leaked
    res_str = str(data).lower()
    assert "model_answer" not in res_str
    assert "model answer" not in res_str

def test_extra_b_too_much_trust_detector(teacher_auth):
    """
    Test Extra Feature B: Too-much-trust detector.
    - Tracks % approved with no edits.
    - When 20+ fast approvals occur, returns gentle notice and 3 spot-check samples + planted known check.
    """
    # 1. Simulate 22 fast approvals
    sim_res = client.post("/api/review/assignments/1/simulate-fast-approvals", headers=teacher_auth)
    assert sim_res.status_code == 200

    # 2. Check detector status
    detector_res = client.get("/api/review/assignments/1/trust-detector", headers=teacher_auth)
    assert detector_res.status_code == 200
    data = detector_res.json()
    assert data["should_warn"] is True
    assert "approved many submissions quickly" in data["warning_notice"]
    assert len(data["spot_check_samples"]) > 0
    assert len(data["known_check_items"]) > 0
    assert "Quality Control" in data["known_check_items"][0]["title"]

    # 3. Reset
    client.post("/api/review/assignments/1/reset-trust-detector", headers=teacher_auth)

def test_extra_c_teacher_correction_log(teacher_auth):
    """
    Test Extra Feature C: Teacher correction log.
    - Returns stored overrides and identified pattern summaries.
    """
    # Submit an override
    client.post(
        "/api/review/submissions/1/override",
        json={
            "question_id": 1,
            "rubric_criterion_id": 1,
            "new_mark": 3.0,
            "note": "Correction test override."
        },
        headers=teacher_auth
    )

    res = client.get("/api/review/corrections", headers=teacher_auth)
    assert res.status_code == 200
    data = res.json()
    assert data["total_corrections"] > 0
    assert "corrections" in data
    first_c = data["corrections"][0]
    assert "Correction test override" in first_c["note"]
    assert "mark_difference" in first_c

def test_scanned_image_only_pdf_and_ocr(tmp_path):
    """
    Test that a scanned / image-only PDF with zero text triggers OCR,
    extracts text, and preserves page numbers.
    """
    # Create image with text
    img = Image.new("RGB", (400, 200), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((20, 80), "Supervised Machine Learning Exam Question", fill=(0, 0, 0))
    img_path = tmp_path / "page1.png"
    img.save(img_path)

    # Put into a PDF
    pdf_path = tmp_path / "scanned_exam.pdf"
    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    page.insert_image(page.rect, filename=str(img_path))
    doc.save(str(pdf_path))
    doc.close()

    # Extract text using pipeline
    res = extract_text_from_file(str(pdf_path), "scanned_exam.pdf")
    assert res["success"] is True
    # Verify page was detected and processed through OCR
    assert len(res["pages"]) == 1
    assert res["pages"][0]["ocr_used"] is True
    assert res["extraction_status"] in ["OCR used", "OCR low confidence"]

def test_blank_garbled_scan_flagged_needs_manual_reading():
    """Verify that a blank or low-confidence scan is flagged 'Needs manual reading'."""
    db = SessionLocal()
    # Create submission with 'OCR low confidence'
    student = db.query(User).filter(User.role == "student").first()
    sub = Submission(
        assignment_id=1,
        student_id=student.id,
        status="submitted",
        file_status="OCR low confidence",
        submission_receipt="REC-TEST-GARBLED"
    )
    db.add(sub)
    db.flush()
    db.add(Answer(submission_id=sub.id, question_id=1, student_answer_text="... . . .. . ..."))
    db.commit()

    # Run grading
    grade_submission(sub.id, db)
    db.refresh(sub)

    flag_types = [f.flag_type for f in sub.flags]
    assert "needs_manual_reading" in flag_types
    flag_reasons = [f.reason for f in sub.flags]
    assert any("OCR quality low" in r for r in flag_reasons)
    db.close()
