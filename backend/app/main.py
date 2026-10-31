from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.app.database import engine, Base
from backend.app.routes import auth, health, materials, assignments, submissions, grading, review
from backend.app.config import BASE_DIR
from backend.app import models

# Ensure tables are created
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="MarkAnchor API",
    description="AI-assisted grading tool anchored to course material",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(materials.router)
app.include_router(assignments.router)
app.include_router(submissions.router)
app.include_router(grading.router)
app.include_router(review.router)

@app.get("/")
def root():
    return {
        "app": "MarkAnchor API",
        "version": "1.0.0",
        "status": "running"
    }
