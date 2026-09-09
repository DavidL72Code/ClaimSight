"""The case queue, backed by Supabase.

This used to keep its own SQLite table alongside the Firestore documents,
which meant /api/cases and /api/queue served a second, diverging copy of
data that really lived elsewhere. Now there is one store: these endpoints
read and write the same public.cases rows the frontend does.

Queries run on the caller's access token, not the service key, so the select
policy decides what an adjuster sees -- their own assigned cases, or
everything if they are a manager. That replaces the old behaviour, where the
endpoints returned every row in the local table regardless of who asked.

_triage is unchanged: it is the one piece of real logic here, and it still
computes the priority_score and queue_bucket columns the queue sorts on.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from app.models.schemas import CaseSavePayload
from app.services.supabase_data import SupabaseData, SupabaseDataError

logger = logging.getLogger("claimsight.cases")

# Columns the queue and list views return. Deliberately narrow: the full
# assessment is large and these endpoints are summaries.
SUMMARY_COLUMNS = (
    "id,claim_reference,vehicle_type,final_action,repairability,overall_severity,"
    "estimated_total_cost_usd,reviewed_total_cost_usd,priority_score,queue_bucket,"
    "status,status_label,created_at,updated_at,review"
)


class CaseRepository:
    def __init__(self, data: SupabaseData | None = None) -> None:
        self._data = data or SupabaseData()

    @property
    def ready(self) -> bool:
        return self._data.ready

    # ── reads ───────────────────────────────────────────────────────────────
    def list_cases(self, access_token: str, limit: int = 25) -> list[dict[str, Any]]:
        rows = self._data.list_cases_raw(
            access_token, columns=SUMMARY_COLUMNS, order="updated_at.desc", limit=limit
        )
        return [self._summary(row) for row in rows]

    def list_queue(self, access_token: str, limit: int = 25) -> list[dict[str, Any]]:
        rows = self._data.list_cases_raw(
            access_token,
            columns=SUMMARY_COLUMNS,
            order="priority_score.desc,updated_at.desc",
            limit=limit,
        )
        return [self._summary(row) for row in rows]

    def get_case(self, access_token: str, case_id: str) -> dict[str, Any] | None:
        return self._data.get_case(access_token, case_id)

    # ── write ───────────────────────────────────────────────────────────────
    def save_case(self, access_token: str, payload: CaseSavePayload) -> dict[str, Any]:
        """Persist a reviewed assessment.

        Updates an existing case, and only inserts when there is none. The
        two are separate because the insert policy is far stricter than the
        update one -- a plain `employee` cannot create a case at all, only a
        manager can -- so folding them into an upsert would turn a refused
        insert into a silent no-op.
        """
        assessment = payload.model_dump()
        review = assessment.get("review") or {}
        case_id = self._resolve_case_id(review)
        queue_bucket, priority_score = self._triage(assessment)

        # Only the columns that exist on public.cases, and never status:
        # the workflow status is owned by the review pages and gated by the
        # update allowlist. The old SQLite table wrote a literal "open" here,
        # which would now overwrite a real workflow state.
        patch = {
            "claim_reference": review.get("claim_reference") or case_id,
            "vehicle_type": assessment.get("vehicle_type") or "",
            "repairability": assessment.get("repairability") or "",
            "overall_severity": assessment.get("overall_severity") or "",
            "summary": assessment.get("summary") or "",
            "recommended_action": assessment.get("recommended_action") or "",
            "estimated_total_cost_usd": int(assessment.get("estimated_total_cost_usd") or 0),
            "reviewed_total_cost_usd": int(
                review.get("reviewed_total_cost_usd")
                or assessment.get("estimated_total_cost_usd")
                or 0
            ),
            "final_action": review.get("final_action") or assessment.get("recommended_action") or "",
            "review": review,
            "regions": assessment.get("regions") or [],
            "reviewed_regions": assessment.get("reviewed_regions") or [],
            "assessment_flags": assessment.get("assessment_flags") or [],
            "completeness_checks": assessment.get("completeness_checks") or [],
            "evaluation": assessment.get("evaluation"),
            "retry_attempts": assessment.get("retry_attempts") or [],
            "sources": assessment.get("sources") or [],
            "search_queries": assessment.get("search_queries") or [],
            "pricing_factors": assessment.get("pricing_factors") or [],
            "meta": assessment.get("meta") or {},
            "total_loss": bool(assessment.get("total_loss")),
            "total_loss_reason": assessment.get("total_loss_reason") or "",
            "estimated_vehicle_value_usd": int(assessment.get("estimated_vehicle_value_usd") or 0),
            "valuation_methodology": assessment.get("valuation_methodology") or "",
            "valuation_comparable_prices_usd": assessment.get("valuation_comparable_prices_usd") or [],
            "priority_score": priority_score,
            "queue_bucket": queue_bucket,
        }

        existing = self._data.get_case(access_token, case_id)
        if existing is None:
            row = self._data.insert_case(access_token, {"id": case_id, **patch})
        else:
            row = self._data.update_case(access_token, case_id, patch)

        if row is None:
            raise SupabaseDataError(
                f"Saving case {case_id} affected no rows -- the write was refused."
            )
        return self._summary(row)

    # ── shaping ─────────────────────────────────────────────────────────────
    @staticmethod
    def _summary(row: dict[str, Any]) -> dict[str, Any]:
        review = row.get("review") or {}
        return {
            "id": row.get("id"),
            "claim_reference": review.get("claim_reference") or row.get("claim_reference") or row.get("id"),
            "reviewer_name": review.get("reviewer_name") or "",
            "vehicle_type": row.get("vehicle_type") or "",
            "final_action": review.get("final_action") or row.get("final_action") or "",
            "repairability": row.get("repairability") or "",
            "overall_severity": row.get("overall_severity") or "",
            "estimated_total_cost_usd": int(row.get("estimated_total_cost_usd") or 0),
            "reviewed_total_cost_usd": int(row.get("reviewed_total_cost_usd") or 0),
            "priority_score": int(row.get("priority_score") or 0),
            "queue_bucket": row.get("queue_bucket") or "routine",
            "status": row.get("status") or "",
            "status_label": row.get("status_label") or "",
            "created_at": row.get("created_at") or "",
            "updated_at": row.get("updated_at") or "",
        }

    def _resolve_case_id(self, review: dict[str, Any]) -> str:
        raw_reference = str(review.get("claim_reference", "") or "").strip()
        if raw_reference:
            return self._normalize_reference(raw_reference)
        return f"case-{uuid4().hex[:10]}"

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

        # A weakly-graded assessment needs a human sooner, so the evaluator's
        # verdict is an independent input to triage. Guarded so cases saved
        # before evaluation existed keep their original ranking.
        evaluation = assessment.get("evaluation") or {}
        if isinstance(evaluation, dict) and evaluation:
            verdict = str(evaluation.get("verdict", "")).lower()
            if verdict == "reject":
                priority_score += 4
            elif verdict == "needs_review":
                priority_score += 2
            try:
                overall = int(evaluation.get("overall_score") or 0)
            except (TypeError, ValueError):
                overall = 0
            if 0 < overall < 50:
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
