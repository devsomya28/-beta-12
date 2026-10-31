import shutil
from pathlib import Path
from typing import List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from sqlalchemy.orm import Session
from backend.app.database import get_db
from backend.app.models import Course, Material, MaterialPage, MaterialChunk, AuditLog, User
from backend.app.auth import require_teacher
from backend.app.config import UPLOAD_DIR
from backend.app.text_extractor import extract_text_from_file
from backend.app.rag import chunk_pages_data

router = APIRouter(prefix="/api", tags=["Materials"])

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".png", ".jpg", ".jpeg"}

@router.post("/courses/{course_id}/materials/upload")
async def upload_material(
    course_id: int,
    file: UploadFile = File(...),
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    course = db.query(Course).filter(Course.id == course_id, Course.teacher_id == teacher.id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found or unauthorized")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: PDF, DOCX, TXT, PNG, JPG"
        )

    # Save uploaded file
    course_upload_dir = UPLOAD_DIR / f"course_{course_id}"
    course_upload_dir.mkdir(parents=True, exist_ok=True)
    saved_file_path = course_upload_dir / file.filename

    with open(saved_file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Run unified text extraction and OCR pipeline
    extraction_res = extract_text_from_file(str(saved_file_path), file.filename)

    material = Material(
        course_id=course.id,
        filename=file.filename,
        file_path=str(saved_file_path),
        status="ready" if extraction_res["success"] else "failed",
        error_reason=extraction_res.get("error"),
        extraction_status=extraction_res["extraction_status"]
    )
    db.add(material)
    db.flush()

    if extraction_res["success"]:
        # Save pages
        for p in extraction_res["pages"]:
            mp = MaterialPage(
                material_id=material.id,
                page_number=p["page_number"],
                extracted_text=p["text"],
                ocr_confidence=p["confidence"],
                image_path=p.get("image_path")
            )
            db.add(mp)

        # Chunk into ~300 words with page numbers
        chunks = chunk_pages_data(extraction_res["pages"], target_words=300)
        for c in chunks:
            mc = MaterialChunk(
                material_id=material.id,
                chunk_index=c["chunk_index"],
                page_number=c["page_number"],
                chunk_text=c["chunk_text"]
            )
            db.add(mc)

    # Audit log
    audit = AuditLog(
        user_id=teacher.id,
        event_type="UPLOAD_MATERIAL",
        details=f"Uploaded material '{file.filename}' (status: {material.status}, extraction: {material.extraction_status}, chunks: {len(chunks) if extraction_res['success'] else 0})"
    )
    db.add(audit)
    db.commit()
    db.refresh(material)

    return {
        "id": material.id,
        "filename": material.filename,
        "status": material.status,
        "extraction_status": material.extraction_status,
        "total_pages": len(extraction_res["pages"]),
        "total_chunks": len(material.chunks),
        "created_at": material.created_at.isoformat()
    }

@router.get("/courses/{course_id}/materials")
def list_materials(
    course_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    materials = db.query(Material).filter(Material.course_id == course_id).order_by(Material.id.desc()).all()
    return [
        {
            "id": m.id,
            "filename": m.filename,
            "status": m.status,
            "extraction_status": m.extraction_status,
            "error_reason": m.error_reason,
            "total_chunks": len(m.chunks),
            "created_at": m.created_at.isoformat()
        }
        for m in materials
    ]

@router.get("/materials/{material_id}/chunks")
def get_material_chunks(
    material_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    material = db.query(Material).filter(Material.id == material_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")

    chunks = db.query(MaterialChunk).filter(MaterialChunk.material_id == material_id).order_by(MaterialChunk.chunk_index.asc()).all()
    return {
        "material_id": material.id,
        "filename": material.filename,
        "extraction_status": material.extraction_status,
        "chunks": [
            {
                "id": c.id,
                "chunk_index": c.chunk_index,
                "page_number": c.page_number,
                "chunk_text": c.chunk_text
            }
            for c in chunks
        ]
    }

@router.delete("/materials/{material_id}")
def delete_material(
    material_id: int,
    teacher: User = Depends(require_teacher),
    db: Session = Depends(get_db)
):
    material = db.query(Material).filter(Material.id == material_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")

    db.delete(material)
    db.commit()
    return {"success": True, "message": "Material deleted"}
