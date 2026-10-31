from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from backend.app.config import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def ensure_sqlite_columns():
    if "sqlite" in DATABASE_URL:
        try:
            with engine.connect() as conn:
                from sqlalchemy import text
                res = conn.execute(text("PRAGMA table_info(submissions)")).fetchall()
                cols = [r[1] for r in res]
                if cols:
                    if "risk_score" not in cols:
                        conn.execute(text("ALTER TABLE submissions ADD COLUMN risk_score FLOAT DEFAULT 0.0"))
                    if "risk_band" not in cols:
                        conn.execute(text("ALTER TABLE submissions ADD COLUMN risk_band VARCHAR(16) DEFAULT 'Low'"))
                    if "risk_breakdown" not in cols:
                        conn.execute(text("ALTER TABLE submissions ADD COLUMN risk_breakdown TEXT"))
                    conn.commit()
        except Exception:
            pass

ensure_sqlite_columns()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
