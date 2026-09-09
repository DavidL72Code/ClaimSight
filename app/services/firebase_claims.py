from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger("claimsight.firebase")


class FirebaseClaimLookup:
    """Server-side Firebase guard for claim assistant lookups.

    The chatbot may explain private claim facts only after this service verifies the
    Firebase ID token and loads a claim whose owner_uid matches the token uid.
    """

    def __init__(self) -> None:
        self._auth = None
        self._firestore = None
        self._ready = False
        try:
            import firebase_admin
            from firebase_admin import auth, credentials, firestore

            if not firebase_admin._apps:
                service_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
                service_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "").strip()
                if service_json:
                    firebase_admin.initialize_app(
                        credentials.Certificate(json.loads(service_json))
                    )
                elif service_path:
                    firebase_admin.initialize_app(credentials.Certificate(service_path))
                else:
                    # Uses GOOGLE_APPLICATION_CREDENTIALS or default cloud credentials.
                    firebase_admin.initialize_app()

            self._auth = auth
            self._firestore = firestore.client()
            self._ready = True
        except Exception as exc:
            logger.warning("Firebase Admin claim lookup unavailable: %s", exc)

    @property
    def ready(self) -> bool:
        return self._ready

    def verify_bearer_token(self, authorization: str) -> dict[str, Any] | None:
        if not self._ready or not authorization:
            return None

        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None

        try:
            return self._auth.verify_id_token(token)
        except Exception as exc:
            logger.warning("Firebase ID token verification failed: %s", exc)
            return None

    def get_owned_claim_context(
        self,
        uid: str,
        claim_reference: str,
    ) -> dict[str, Any] | None:
        if not self._ready or not uid or not claim_reference:
            return None

        normalized_reference = claim_reference.strip()
        if not normalized_reference or normalized_reference.lower() == "this claim":
            return None

        direct = self._firestore.collection("cases").document(normalized_reference).get()
        if direct.exists:
            payload = direct.to_dict() or {}
            if payload.get("owner_uid") == uid:
                return self._to_assistant_context(direct.id, payload)
            return None

        query = (
            self._firestore.collection("cases")
            .where("owner_uid", "==", uid)
            .where("claim_reference", "==", normalized_reference)
            .limit(1)
            .stream()
        )
        for doc in query:
            return self._to_assistant_context(doc.id, doc.to_dict() or {})
        return None

    def _to_assistant_context(self, doc_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        review = payload.get("review") or {}
        claim_context = payload.get("claim_context") or {}
        assigned_agent = payload.get("assigned_agent") or {}
        documents = payload.get("supporting_documents") or []
        reviewer_evidence = payload.get("reviewer_evidence") or []

        vehicle_label = payload.get("vehicle_type") or "Vehicle unavailable"
        return {
            "claim_reference": review.get("claim_reference") or payload.get("claim_reference") or doc_id,
            "status": payload.get("status_label") or payload.get("status") or "",
            "vehicle": vehicle_label,
            "vehicle_details": {
                "make": claim_context.get("make") or "",
                "model": claim_context.get("model") or "",
                "trim": claim_context.get("trim") or "",
                "year": claim_context.get("year"),
                "mileage": claim_context.get("mileage"),
                "usage": claim_context.get("usage") or "",
            },
            "adjuster": review.get("reviewer_name") or assigned_agent.get("name") or "",
            "ai_view": review.get("ai_recommended_action") or payload.get("recommended_action") or "",
            "final_action": review.get("final_action") or payload.get("final_action") or "",
            "note": review.get("notes") or payload.get("summary") or "",
            "estimated_total_cost_usd": payload.get("estimated_total_cost_usd") or 0,
            "reviewed_total_cost_usd": review.get("reviewed_total_cost_usd")
            or payload.get("reviewed_total_cost_usd")
            or 0,
            "document_count": len(documents),
            "reviewer_evidence_count": len(reviewer_evidence),
        }

    def describe_case_access(
        self,
        *,
        case_id: str,
        uid: str,
        email: str,
        role: str,
    ) -> dict[str, Any]:
        """Decide what a caller may do to one case.

        This is a direct port of three functions in firebase/firestore.rules,
        needed because attachment uploads now go through the backend and the
        Admin SDK bypasses Security Rules entirely -- so the rules cannot
        enforce this path and the check has to live here:

            ownsCaseId(caseId)     -> owner_uid == request.auth.uid
            isAssignedToCase(id)   -> role == "employee"
                                      && assigned_agent.email == token email
            isManager()            -> role in ("manager", "admin")

        Returns a dict rather than a bool so callers can log *why* access was
        refused without re-deriving it.
        """
        result = {
            "exists": False,
            "is_owner": False,
            "is_assigned_employee": False,
            "is_manager": role in {"manager", "admin"},
            "allowed": False,
        }
        if not self._ready or not case_id:
            return result

        snapshot = self._firestore.collection("cases").document(case_id).get()
        if not snapshot.exists:
            # A manager may still act on a missing case only in the sense that
            # the caller gets a 404 rather than a 403; access stays False here.
            return result

        payload = snapshot.to_dict() or {}
        assigned_email = ((payload.get("assigned_agent") or {}).get("email") or "").lower()

        result["exists"] = True
        result["is_owner"] = bool(uid) and payload.get("owner_uid") == uid
        result["is_assigned_employee"] = (
            role == "employee" and bool(email) and assigned_email == email.lower()
        )
        result["allowed"] = (
            result["is_owner"] or result["is_assigned_employee"] or result["is_manager"]
        )
        return result
