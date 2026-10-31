# MarkAnchor ⚓

**MarkAnchor** is an AI-assisted grading tool for classrooms where **every mark is anchored strictly to what was taught in the course notes**. The model never guesses from general knowledge, flags prompt injections, runs a 3-run consistency check, and enforces teacher approval gates before any score reaches students.

---

## Tech Stack
- **Backend:** Python FastAPI, SQLite (SQLAlchemy), PyMuPDF (`fitz`), `python-docx`, Tesseract OCR (`pytesseract`)
- **Frontend:** React (Vite) + Plain CSS (Strict light theme: `#FFFFFF` background, `#E8F3FF` panels, `#2F80ED` buttons, `#BBD9FB` borders)
- **RAG & Search:** Local BM25 chunk retrieval (~300 words per chunk with page numbers)
- **LLM Modes:** One abstraction file supporting:
  1. `mock` (Deterministic fake grader; whole app runs with 0 API keys)
  2. `gemini` (Google Gemini API)
  3. `ollama` (Local Ollama LLM)

---

## 5 Setup Steps (Run Locally)

### 1. Prerequisites & OCR Installation
Ensure **Python 3.10+** and **Node.js 18+** are installed.

#### Installing Tesseract OCR:
- **Windows:** Download and run the installer from [UB-Mannheim Tesseract Releases](https://github.com/UB-Mannheim/tesseract/wiki). Default install path is `C:\Program Files\Tesseract-OCR\tesseract.exe`.
- **macOS:** `brew install tesseract`
- **Ubuntu/Debian:** `sudo apt-get update && sudo apt-get install -y tesseract-ocr`

### 2. Configure Environment
Copy the example configuration:
```bash
cp .env.example .env
```
*(By default `LLM_MODE=mock`, allowing the full application to run without any external API keys or models).*

### 3. Backend Setup
```bash
# Create virtual environment and install packages
python -m venv backend/venv
backend/venv/Scripts/pip install -r backend/requirements.txt  # Windows
# or: source backend/venv/bin/activate && pip install -r backend/requirements.txt  # Mac/Linux

# Run the seed script (creates database, course material, assignment, and demo submissions)
backend/venv/Scripts/python backend/seed.py
```

### 4. Frontend Setup
```bash
cd frontend
npm install
```

### 5. Start Servers
In two terminal tabs:

**Terminal 1 (Backend):**
```bash
backend/venv/Scripts/uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

**Terminal 2 (Frontend):**
```bash
cd frontend
npm run dev
```
Open **`http://localhost:5173`** (or the port Vite outputs) in your browser.

---

## Running Automated Tests
Run the comprehensive 33-test test suite:
```bash
backend/venv/Scripts/pytest backend/tests
```

---

## Demo Accounts
Pre-seeded credentials:
- **Teacher:** `teacher@markanchor.edu` / `teacher123` (*Prof. Alan Turing*)
- **Students (8 seeded):** `student1@markanchor.edu` through `student8@markanchor.edu` / `student123`

The sign-in screen includes a **1-Click Demo Login selector** for rapid persona switching.
