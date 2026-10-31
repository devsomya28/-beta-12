import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from backend or root directory
load_dotenv()
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'markanchor.db'}")
SECRET_KEY = os.getenv("SECRET_KEY", "markanchor-super-secret-key-for-dev-demo-2026")
LLM_MODE = os.getenv("LLM_MODE", "mock").lower()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
TESSERACT_CMD = os.getenv("TESSERACT_CMD", r"C:\Program Files\Tesseract-OCR\tesseract.exe")

# Demo toggle override for AI offline testing
AI_OFFLINE_OVERRIDE = os.getenv("AI_OFFLINE_OVERRIDE", "false").lower() == "true"
