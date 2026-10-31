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
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
TESSERACT_CMD = os.getenv("TESSERACT_CMD", r"C:\Program Files\Tesseract-OCR\tesseract.exe")

# Demo toggle override for AI offline testing
AI_OFFLINE_OVERRIDE = os.getenv("AI_OFFLINE_OVERRIDE", "false").lower() == "true"

# Phase A: Correction window for Assignments (default: 120 seconds / 2 minutes)
CORRECTION_WINDOW_SECONDS = int(os.getenv("CORRECTION_WINDOW_SECONDS", "120"))

# Phase B: Verifier settings for Math and Alternate Methods
VERIFIER_MODE = os.getenv("VERIFIER_MODE", "gemini").lower()
VERIFIER_MODEL = os.getenv("VERIFIER_MODEL", "gemini-2.5-flash")

# Groq & Cross-Checking LLM Configuration
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
CROSS_CHECK_LLM = os.getenv("CROSS_CHECK_LLM", "auto").lower()
