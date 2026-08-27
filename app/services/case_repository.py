from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core.config import CASE_DB_PATH
from app.models.schemas import CaseSavePayload


class CaseRepository:
    def __init__(self, db_path: Path | None = None) -> None:
        self._db_path = db_path or CASE_DB_PATH
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS cases (
                    id TEXT PRIMARY KEY,
                    claim_reference TEXT NOT NULL,
                    reviewer_name TEXT NOT NULL,
                    vehicle_type TEXT NOT NULL,
                    final_action TEXT NOT NULL,
                    repairability TEXT NOT NULL,
                    overall_severity TEXT NOT NULL,
                    estimated_total_cost_usd INTEGER NOT NULL,
                    reviewed_total_cost_usd INTEGER NOT NULL,
                    priority_score INTEGER NOT NULL,
                    queue_bucket TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    assessment_json TEXT NOT NULL
                )
                """
            )

    def save_case(self, payload: CaseSavePayload) -> dict[str, Any]:
        assessment = payload.model_dump()
        review = assessment.get("review", {})
        timestamps = self._resolve_timestamps(review)
        case_id = self._resolve_case_id(review)
        queue_bucket, priority_score = self._triage(assessment)
        summary = {
            "id": case_id,
            "claim_reference": review.get("claim_reference") or case_id,
            "reviewer_name": review.get("reviewer_name", ""),
            "vehicle_type": assessment.get("vehicle_type", ""),
            "final_action": review.get("final_action") or assessment.get("recommended_action", ""),
            "repairability": assessment.get("repairability", ""),
            "overall_severity": assessment.get("overall_severity", ""),
            "estimated_total_cost_usd": int(assessment.get("estimated_total_cost_usd", 0) or 0),
            "reviewed_total_cost_usd": int(
                review.get("reviewed_total_cost_usd")
                or assessment.get("estimated_total_cost_usd", 0)
                or 0
            ),
            "priority_score": priority_score,
            "queue_bucket": queue_bucket,
            "status": "open",
            "created_at": timestamps["created_at"],
            "updated_at": timestamps["updated_at"],
        }

        with self._connect() as connection:
            existing = connection.execute(
                "SELECT created_at FROM cases WHERE id = ?",
                (case_id,),
            ).fetchone()
            if existing:
                summary["created_at"] = existing["created_at"]
            connection.execute(
                """
                INSERT INTO cases (
                    id, claim_reference, reviewer_name, vehicle_type, final_action,
                    repairability, overall_severity, estimated_total_cost_usd,
                    reviewed_total_cost_usd, priority_score, queue_bucket, status,
                    created_at, updated_at, assessment_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    claim_reference = excluded.claim_reference,
                    reviewer_name = excluded.reviewer_name,
                    vehicle_type = excluded.vehicle_type,
                    final_action = excluded.final_action,
                    repairability = excluded.repairability,
                    overall_severity = excluded.overall_severity,
                    estimated_total_cost_usd = excluded.estimated_total_cost_usd,
                    reviewed_total_cost_usd = excluded.reviewed_total_cost_usd,
                    priority_score = excluded.priority_score,
                    queue_bucket = excluded.queue_bucket,
                    status = excluded.status,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    assessment_json = excluded.assessment_json
                """,
                (
                    summary["id"],
                    summary["claim_reference"],
                    summary["reviewer_name"],
                    summary["vehicle_type"],
                    summary["final_action"],
                    summary["repairability"],
                    summary["overall_severity"],
                    summary["estimated_total_cost_usd"],
                    summary["reviewed_total_cost_usd"],
                    summary["priority_score"],
                    summary["queue_bucket"],
                    summary["status"],
                    summary["created_at"],
                    summary["updated_at"],
                    json.dumps(assessment),
                ),
            )

        return summary

    def list_cases(self, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, claim_reference, reviewer_name, vehicle_type, final_action,
                       repairability, overall_severity, estimated_total_cost_usd,
                       reviewed_total_cost_usd, priority_score, queue_bucket,
                       status, created_at, updated_at
                FROM cases
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_queue(self, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, claim_reference, reviewer_name, vehicle_type, final_action,
                       repairability, overall_severity, estimated_total_cost_usd,
                       reviewed_total_cost_usd, priority_score, queue_bucket,
                       status, created_at, updated_at
                FROM cases
                ORDER BY priority_score DESC, updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT assessment_json FROM cases WHERE id = ?",
                (case_id,),
            ).fetchone()
        if not row:
            return None
        return json.loads(row["assessment_json"])

    def _resolve_case_id(self, review: dict[str, Any]) -> str:
        raw_reference = str(review.get("claim_reference", "") or "").strip()
        if raw_reference:
            return self._normalize_reference(raw_reference)
        return f"case-{uuid4().hex[:10]}"

    def _resolve_timestamps(self, review: dict[str, Any]) -> dict[str, str]:
        completed_at = str(review.get("completed_at", "") or "").strip()
        timestamp = completed_at or ""
        if not timestamp:
            from datetime import datetime

            timestamp = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
        return {"created_at": timestamp, "updated_at": timestamp}

    def _triage(self, assessment: dict[str, Any]) -> tuple[str, int]:
        flags = assessment.get("assessment_flags", [])
        checks = assessment.get("completeness_checks", [])
        review = assessment.get("review", {})
        review_action = str(review.get("final_action", "") or assessment.get("recommended_action", "")).lower()
        repairability = str(assessment.get("repairability", "")).lower()
        severity = str(assessment.get("overall_severity", "")).lower()
        priority_score = 0

        priority_score += sum(3 for flag in flags if flag.get("level") == "high")
        priority_score += sum(1 for flag in flags if flag.get("level") == "warning")
        priority_score += sum(1 for check in checks if check.get("status") == "missing")

        if "total loss" in repairability or "total loss" in review_action:
            priority_score += 3
        if "request more evidence" in review_action:
            priority_score += 2
        if severity == "high":
            priority_score += 2

        if priority_score >= 8:
            return "urgent", priority_score
        if priority_score >= 4:
            return "review", priority_score
        return "routine", priority_score

    def _normalize_reference(self, value: str) -> str:
        normalized = "".join(character if character.isalnum() else "-" for character in value.upper())
        normalized = normalized.strip("-")
        return normalized or f"case-{uuid4().hex[:10]}"
