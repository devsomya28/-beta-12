# MarkAnchor Free-Tier Deployment Guide 🚀
### Deploy Full-Stack AI Grading (FastAPI + React + OCR) at Zero Financial Cost

This guide walks through deploying **MarkAnchor** completely free of charge using the most reliable free-tier cloud platforms.

---

## 📊 Free-Tier Platforms Comparison

| Platform | Component | Free Tier Allowance | Credit Card Required? | Recommended For |
| :--- | :--- | :--- | :--- | :--- |
| **Render.com** | Full-Stack (Unified) | 750 free instance hours / month | **No** | ⭐ **Best 1-Click Unified Option** |
| **Vercel** | React Frontend | 100 GB bandwidth, unlimited deploys | **No** | Global Edge CDN performance |
| **Netlify** | React Frontend | 100 GB bandwidth, automated CI/CD | **No** | Instant Git push triggers |
| **Koyeb** | Docker Container | 1 Free Nano instance (512MB RAM) | **No** | Multi-stage Docker hosting |
| **Hugging Face** | Docker Container | 16 GB RAM / 2 vCPU Spaces | **No** | High-memory container hosting |

---

## 🌟 Option A: Unified 1-Click Free Deployment on Render (Recommended)

In this setup, a single **Render Free Web Service** compiles both the React frontend and the FastAPI backend. FastAPI automatically serves the compiled React SPA and all REST APIs from one domain with **zero CORS setup and zero split-service limits**.

### Step 1: Push Repository to GitHub
Ensure all your files (including `render.yaml`, `Procfile`, and `backend/requirements.txt`) are present in your GitHub repository.

### Step 2: Create Free Account on Render
1. Visit [render.com](https://render.com) and sign up with your GitHub account.
2. No credit card is required for the free tier.

### Step 3: Deploy with Render Blueprint
1. In your Render Dashboard, click **New +** in the top navigation bar.
2. Select **Blueprint**.
3. Choose your GitHub repository (`devsomya28/-beta-12` or `ITSprakrati/manit`).
4. Render will automatically detect [`render.yaml`](./render.yaml).
5. Click **Apply**.

Render will automatically execute:
```bash
# Build Command
npm --prefix frontend install && npm --prefix frontend run build && pip install -r backend/requirements.txt && python backend/seed.py

# Start Command
uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT
```

### Step 4: Configure Environment Variables in Render Dashboard
Under your newly created service's **Environment** tab, set:
- `LLM_MODE`: `mock` (or `gemini` if you have a Google AI Studio key)
- `GEMINI_API_KEY`: *(Optional: free key from https://aistudio.google.com)*
- `GROQ_API_KEY`: *(Optional: free key from https://console.groq.com)*
- `GROQ_MODEL`: `openai/gpt-oss-120b`
- `SECRET_KEY`: *(Click Generate on Render)*
- `CORRECTION_WINDOW_SECONDS`: `120`

Your full application will be live at:
**`https://markanchor-app.onrender.com`**

---

## ⚡ Option B: Split Free Deployment (Vercel Frontend + Render Backend)

If you prefer deploying the frontend onto Vercel's global CDN while hosting the FastAPI backend on Render:

### Part 1: Deploy Backend to Render (Free Web Service)
1. On Render, click **New +** -> **Web Service**.
2. Connect your GitHub repository.
3. Configure the service:
   - **Name:** `markanchor-backend`
   - **Region:** Oregon (or closest to you)
   - **Environment:** `Python 3`
   - **Plan:** `Free`
   - **Build Command:** `pip install -r backend/requirements.txt && python backend/seed.py`
   - **Start Command:** `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT`
   - **Health Check Path:** `/health`
4. Click **Create Web Service**. Note your backend URL (e.g., `https://markanchor-backend.onrender.com`).

### Part 2: Deploy Frontend to Vercel (Free)
1. Visit [vercel.com](https://vercel.com) and log in with GitHub.
2. Click **Add New...** -> **Project**.
3. Select your repository.
4. In project configuration:
   - **Framework Preset:** `Vite`
   - **Root Directory:** `./` (or `frontend`)
   - **Build Command:** `npm --prefix frontend run build` (or `npm run build` if root is `frontend`)
   - **Output Directory:** `frontend/dist` (or `dist` if root is `frontend`)
5. Under **Environment Variables**, add:
   - `VITE_API_BASE_URL`: `https://markanchor-backend.onrender.com`
6. Click **Deploy**.

Vercel will deploy your React frontend with edge caching and automatically route all API requests to your Render backend.

---

## 🐳 Option C: Free Docker Container Deployment (Koyeb / Railway / HF)

For container-native free hosting, MarkAnchor includes a multi-stage production [`Dockerfile`](./Dockerfile) that packages Node.js, Python, and system Tesseract OCR into an optimized image.

### Deploying to Koyeb Free Tier:
1. Sign up at [koyeb.com](https://www.koyeb.com) (free 1 Nano service).
2. Click **Create App** -> Select **GitHub**.
3. Choose repository.
4. Set **Builder** to **Dockerfile**.
5. Set Exposed Port to `8000`.
6. Add environment variables (`LLM_MODE`, `GROQ_API_KEY`, `GEMINI_API_KEY`).
7. Click **Deploy**.

### Testing Docker Locally:
```bash
docker-compose up --build
```
Open **`http://localhost:8000`** in your browser.

---

## 🔑 How to Get Free AI API Keys

MarkAnchor is designed to run with **zero paid services**:

1. **Google Gemini API (Free Tier):**
   - Free tier includes **15 requests per minute** and **1,500 requests per day** at $0 cost.
   - Get key: [Google AI Studio](https://aistudio.google.com).
2. **Groq API (Free Tier):**
   - Free tier includes **14,400 requests per day** and ultra-fast inference for `openai/gpt-oss-120b` and `llama-3.3-70b-versatile`.
   - Get key: [Groq Console](https://console.groq.com).
3. **Mock Mode (100% Offline / Zero Keys):**
   - Set `LLM_MODE=mock`. The entire system, grading engine, OCR, and rubrics will run deterministically without internet access or external APIs.

---

## ✅ Deployment Checklist

- [x] `backend/requirements.txt` includes all dependencies (`fastapi`, `uvicorn`, `scikit-learn`, `numpy`, `sympy`, `pytesseract`, `PyMuPDF`).
- [x] Tesseract OCR path dynamically auto-detects system binary (`shutil.which`).
- [x] `render.yaml` blueprint ready for 1-click Render free service.
- [x] `Procfile` configured for Python web process.
- [x] `frontend/vercel.json` and `vercel.json` configured for SPA routing.
- [x] `netlify.toml` configured for Netlify SPA redirects.
- [x] Production multi-stage `Dockerfile` and `docker-compose.yml` verified.
- [x] Relative API routing with `VITE_API_BASE_URL` fallback tested.
