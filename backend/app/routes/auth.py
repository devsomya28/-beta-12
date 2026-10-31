from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from backend.app.database import get_db
from backend.app.models import User
from backend.app.auth import verify_password, create_access_token, get_current_user

router = APIRouter(prefix="/api/auth", tags=["Auth"])

class LoginRequest(BaseModel):
    email: str
    password: str

class QuickLoginRequest(BaseModel):
    email: str

class UserResponse(BaseModel):
    id: int
    email: str
    full_name: str
    role: str

class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    user: UserResponse

@router.post("/login", response_model=LoginResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.strip().lower()).first()
    if not user or not verify_password(req.password, user.password_hash, user.salt):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )
    token = create_access_token(user)
    return {
        "access_token": token,
        "token_type": "Bearer",
        "user": {
            "id": user.id,
            "email": user.email,
            "full_name": user.full_name,
            "role": user.role
        }
    }

@router.post("/quick-login", response_model=LoginResponse)
def quick_login(req: QuickLoginRequest, db: Session = Depends(get_db)):
    """Demo shortcut for switching between the seeded teacher and students instantly."""
    user = db.query(User).filter(User.email == req.email.strip().lower()).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User {req.email} not found in seeded database",
        )
    token = create_access_token(user)
    return {
        "access_token": token,
        "token_type": "Bearer",
        "user": {
            "id": user.id,
            "email": user.email,
            "full_name": user.full_name,
            "role": user.role
        }
    }

@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "email": current_user.email,
        "full_name": current_user.full_name,
        "role": current_user.role
    }

@router.get("/demo-users")
def get_demo_users(db: Session = Depends(get_db)):
    """Returns available seeded users for the login selector."""
    users = db.query(User).order_by(User.role.desc(), User.id.asc()).all()
    return [
        {
            "id": u.id,
            "email": u.email,
            "full_name": u.full_name,
            "role": u.role
        }
        for u in users
    ]
