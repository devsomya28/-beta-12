from fastapi import APIRouter
from pydantic import BaseModel
from backend.app.config import LLM_MODE
from backend.app.llm_provider import get_llm_provider, is_ai_forced_offline, set_ai_offline

router = APIRouter(tags=["Health"])

class ToggleAIRequest(BaseModel):
    offline: bool

@router.get("/health")
@router.get("/api/health")
def check_health():
    provider = get_llm_provider()
    is_online, message = provider.check_health()
    forced = is_ai_forced_offline()
    return {
        "status": "ok",
        "ai_status": "online" if is_online else "offline",
        "ai_online": is_online,
        "forced_offline": forced,
        "provider": LLM_MODE,
        "message": message
    }

@router.post("/api/health/toggle-ai")
def toggle_ai_state(req: ToggleAIRequest):
    """Allows testing the AI Offline behavior during demos without modifying .env"""
    set_ai_offline(req.offline)
    provider = get_llm_provider()
    is_online, message = provider.check_health()
    return {
        "status": "ok",
        "ai_status": "online" if is_online else "offline",
        "ai_online": is_online,
        "forced_offline": req.offline,
        "provider": LLM_MODE,
        "message": message
    }
