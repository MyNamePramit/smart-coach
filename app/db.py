# app/db.py
from sqlalchemy import (create_engine, Column, Integer, String, Text, DateTime, JSON)
from sqlalchemy.orm import declarative_base, sessionmaker
import datetime
import os

Base = declarative_base()
default_db_path = "/app/data/ai_coach.db"
os.makedirs(os.path.dirname(default_db_path), exist_ok=True)
database_url = os.getenv("DATABASE_URL", f"sqlite:///{default_db_path}")
engine = create_engine(database_url, echo=False, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

class Session(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, index=True)
    author = Column(String, nullable=True)
    context_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    transcript = Column(JSON, default=list)  # list of turns
    report = Column(JSON, default=dict)


class ScenarioStore(Base):
    __tablename__ = "scenarios"
    id = Column(String, primary_key=True)   # scenario.id e.g. 'salary-negotiation'
    data = Column(JSON)                     # full scenario object {id, label, description, payload}
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)
