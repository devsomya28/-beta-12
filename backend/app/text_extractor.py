import os
import io
import fitz  # PyMuPDF
from PIL import Image
import pytesseract
from pathlib import Path
from typing import List, Dict, Any, Tuple
from docx import Document
from backend.app.config import TESSERACT_CMD

# Configure Tesseract binary path if available
if os.path.exists(TESSERACT_CMD):
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

def is_tesseract_available() -> bool:
    try:
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False

def extract_text_from_file(file_path: str, original_filename: str) -> Dict[str, Any]:
    """
    Unified extraction pipeline for PDF, DOCX, TXT, PNG, JPG.
    Accepts text or scanned PDF, performs OCR per page if text is absent.
    Tracks OCR confidence and extraction status per spec:
    'Text extracted', 'OCR used', 'OCR low confidence', or 'Failed with reason'.
    """
    ext = Path(original_filename).suffix.lower()
    pages_data: List[Dict[str, Any]] = []
    extraction_status = "Text extracted"
    ocr_used = False
    min_confidence = 1.0

    try:
        if ext == ".txt":
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            pages_data.append({
                "page_number": 1,
                "text": content,
                "ocr_used": False,
                "confidence": 1.0,
                "image_path": None
            })
            extraction_status = "Text extracted"

        elif ext == ".docx":
            doc = Document(file_path)
            full_text = "\n".join([p.text for p in doc.paragraphs if p.text.strip()])
            pages_data.append({
                "page_number": 1,
                "text": full_text,
                "ocr_used": False,
                "confidence": 1.0,
                "image_path": None
            })
            extraction_status = "Text extracted"

        elif ext in [".png", ".jpg", ".jpeg"]:
            # Image files go straight to OCR
            ocr_used = True
            text, conf = _ocr_image_file(file_path)
            pages_data.append({
                "page_number": 1,
                "text": text,
                "ocr_used": True,
                "confidence": conf,
                "image_path": file_path
            })
            min_confidence = conf
            if conf < 0.60:
                extraction_status = "OCR low confidence"
            else:
                extraction_status = "OCR used"

        elif ext == ".pdf":
            doc = fitz.open(file_path)
            total_pages = len(doc)
            
            for page_index in range(total_pages):
                page_num = page_index + 1
                page = doc.load_page(page_index)
                page_text = page.get_text("text").strip()

                # If a PDF page has little or no text (< 30 characters), render page to image and run OCR
                if len(page_text) < 30:
                    ocr_used = True
                    pix = page.get_pixmap(dpi=150)
                    img_bytes = pix.tobytes("png")
                    img = Image.open(io.BytesIO(img_bytes))
                    
                    # Save rendered page image for side-by-side inspection
                    img_dir = Path(file_path).parent / "rendered_pages"
                    img_dir.mkdir(exist_ok=True)
                    page_img_path = str(img_dir / f"page_{page_num}_{Path(file_path).name}.png")
                    img.save(page_img_path)

                    ocr_text, conf = _ocr_pil_image(img)
                    min_confidence = min(min_confidence, conf)

                    pages_data.append({
                        "page_number": page_num,
                        "text": ocr_text,
                        "ocr_used": True,
                        "confidence": conf,
                        "image_path": page_img_path
                    })
                else:
                    pages_data.append({
                        "page_number": page_num,
                        "text": page_text,
                        "ocr_used": False,
                        "confidence": 1.0,
                        "image_path": None
                    })
            doc.close()

            if ocr_used:
                if min_confidence < 0.60:
                    extraction_status = "OCR low confidence"
                else:
                    extraction_status = "OCR used"
            else:
                extraction_status = "Text extracted"

        else:
            raise ValueError(f"Unsupported file format: {ext}")

        # Combine text
        combined_text = "\n\n".join([f"--- Page {p['page_number']} ---\n{p['text']}" for p in pages_data])
        if not combined_text.strip():
            extraction_status = "Failed with reason"

        return {
            "success": True,
            "extraction_status": extraction_status,
            "pages": pages_data,
            "combined_text": combined_text,
            "min_confidence": min_confidence,
            "error": None
        }

    except Exception as e:
        return {
            "success": False,
            "extraction_status": "Failed with reason",
            "pages": [],
            "combined_text": "",
            "min_confidence": 0.0,
            "error": str(e)
        }

def _ocr_pil_image(img: Image.Image) -> Tuple[str, float]:
    """Runs Tesseract OCR on a PIL Image and calculates average confidence."""
    if not is_tesseract_available():
        # Fallback if host system does not have Tesseract installed
        return "[OCR unavailable: Tesseract is not installed on this machine]", 0.30

    try:
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
        text_words = []
        confidences = []
        n_boxes = len(data['text'])
        for i in range(n_boxes):
            word = data['text'][i].strip()
            conf = int(data['conf'][i])
            if word:
                text_words.append(word)
                if conf > 0:
                    confidences.append(conf)

        ocr_text = " ".join(text_words)
        avg_conf = (sum(confidences) / len(confidences) / 100.0) if confidences else 0.5
        return ocr_text, round(avg_conf, 2)
    except Exception as e:
        return f"[OCR extraction error: {str(e)}]", 0.20

def _ocr_image_file(file_path: str) -> Tuple[str, float]:
    img = Image.open(file_path)
    return _ocr_pil_image(img)
