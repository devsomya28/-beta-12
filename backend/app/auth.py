import hmac
import hashlib
import json
import base64
import time
import secrets
from typing import Optional
from fastapi import Depends, HTTPException, status, Header
from sqlalchemy.orm import Session
from backend.app.config import SECRET_KEY
from backend.app.database import get_db
from backend.app.models import User

TOKEN_EXPIRATION_SECONDS = 7 * 24 * 3600  # 7 days

def hash_password(password: str, salt: Optional[str] = None) -> tuple[str, str]:
    """Hashes a password with a salt using PBKDF2-HMAC-SHA256."""
    if salt is None:
        salt = secrets.token_hex(16)
    pw_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        100000
    ).hex()
    return pw_hash, salt

def verify_password(plain_password: str, password_hash: str, salt: str) -> bool:
    """Verifies a plain password against the stored hash and salt."""
    computed_hash, _ = hash_password(plain_password, salt)
    return hmac.compare_digest(computed_hash, password_hash)

def create_access_token(user: User) -> str:
    """Creates a signed HMAC-SHA256 token containing user info and expiration."""
    payload = {
        "sub": user.id,
        "email": user.email,
        "role": user.role,
        "full_name": user.full_name,
        "exp": int(time.time()) + TOKEN_EXPIRATION_SECONDS
    }
    payload_bytes = json.dumps(payload, separators=(',', ':')).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode("utf-8").rstrip("=")
    signature = hmac.new(SECRET_KEY.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"

def decode_access_token(token: str) -> dict:
    """Validates the signature and expiration of an access token."""
    parts = token.split(".")
    if len(parts) != 2:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token format",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload_b64, signature = parts
    expected_sig = hmac.new(SECRET_KEY.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_sig, signature):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token signature",
            headers={"WWW-Authenticate": "Bearer"},
        )
    # Add back base64 padding if needed
    rem = len(payload_b64) % 4
    if rem > 0:
        payload_b64 += "=" * (4 - rem)
    try:
        payload_json = base64.urlsafe_b64decode(payload_b64).decode("utf-8")
        payload = json.loads(payload_json)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not parse token payload",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if payload.get("exp", 0) < time.time():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload

def get_current_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db)
) -> User:
    """Dependency to retrieve the authenticated user from the Authorization header."""
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    else:
        token = authorization.strip()
    
    payload = decode_access_token(token)
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token subject",
        )
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    return user

def require_teacher(current_user: User = Depends(get_current_user)) -> User:
    """Dependency that ensures the authenticated user is a teacher."""
    if current_user.role != "teacher":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Teacher access required",
        )
    return current_user

def require_student(current_user: User = Depends(get_current_user)) -> User:
    """Dependency that ensures the authenticated user is a student."""
    if current_user.role != "student":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Student access required",
        )
    return current_user
