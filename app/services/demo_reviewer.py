"""Model-driven stand-in for a human adjuster, for the public demo only.

A demo deployment has nobody on shift, so a submitted claim sits at "submitted"
forever and every screen worth showing -- the AI-vs-adjuster comparison, the
estimate history, the decision, the final report -- stays empty.

This runs the adjuster's workflow ONE STEP AT A TIME, driven from the employee
portal, so a viewer can walk through what a reviewer actually does and watch the
customer side react to each step: status moves, notifications arrive, a message
lands in the thread. It also replies in character when the customer writes back,
so the two-way interaction is demonstrable.

It must run server-side: firestore.rules deliberately forbids a customer from
writing `review`, `status`, or `reviewed_total_cost_usd`, so a client-side
version is impossible by design. Every write here goes through the Admin SDK.

Each step carries simulated=True. The employee UI shows that as a badge, and the
stored record never claims a person did this.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable

from app.core.config import (
    DEMO_REVIEWER_EMAIL,
    DEMO_REVIEWER_NAME,
)

logger = logging.getLogger("claimsight.demo_reviewer")

# Below this the estimate is not worth contesting; the reviewer accepts it.
_MATERIALITY_USD = 250
# A reviewer who trims everything is as useless as one who rubber-stamps.
_MAX_TRIM_RATIO = 0.35
# Repair cost at or above this share of value is written off.
_TOTAL_LOSS_RATIO = 0.75

# Ordered plan. The viewer advances through these one click at a time; the
# titles double as the "next up" label in the employee portal.
STEP_PLAN: list[tuple[str, str]] = [
    ("pickup", "Pick up from queue"),
    ("read_first_pass", "Read the AI first pass"),
    ("verify", "Verify the detected damage"),
    ("challenge", "Challenge the AI estimate"),
    ("adjust", "Adjust or accept the estimate"),
    ("decide", "Record the decision"),
    ("release", "Release the decision to the customer"),
]


class DemoReviewerError(RuntimeError):
    """Raised for conditions the caller should surface as a 4xx."""


class DemoReviewer:
    def __init__(self, narrator: Any, claim_lookup: Any) -> None:
        self._narrator = narrator
        self._claim_lookup = claim_lookup

    # ── plumbing ────────────────────────────────────────────────────────────
    @property
    def ready(self) -> bool:
        return bool(getattr(self._claim_lookup, "ready", False))

    def _db(self):
        db = getattr(self._claim_lookup, "_firestore", None)
        if db is None:
            raise DemoReviewerError("Firestore is not available.")
        return db

    @staticmethod
    def _now() -> str:
        """ISO string, for display-only fields inside a step."""
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _server_timestamp():
        """Sentinel for updated_at.

        The rest of the app writes updated_at with a server timestamp and the
        employee queue does orderBy("updated_at", "desc"). Writing an ISO string
        here would put a string next to Timestamps in the same field, and
        Firestore orders across types by type first, so this claim would sort
        into its own group and jump out of the queue's ordering.
        """
        from firebase_admin import firestore

        return firestore.SERVER_TIMESTAMP

    def _actor(self) -> dict[str, Any]:
        return {
            "actor_email": DEMO_REVIEWER_EMAIL,
            "actor_name": DEMO_REVIEWER_NAME,
            "actor_role": "employee",
            "simulated": True,
        }

    def _load(self, case_id: str) -> tuple[Any, dict[str, Any]]:
        ref = self._db().collection("cases").document(case_id)
        snapshot = ref.get()
        if not snapshot.exists:
            raise DemoReviewerError("Case not found.")
        return ref, (snapshot.to_dict() or {})

    # ── enrolment ───────────────────────────────────────────────────────────
    def enroll(self, case_id: str, owner_uid: str) -> dict[str, Any]:
        """Assign a freshly submitted claim to the demo reviewer.

        Called by the customer right after submission. The employee queue
        filters on assigned_agent.email, so without this the claim would be
        invisible in the employee portal and there would be nothing to step
        through -- the claim has to be assigned before the first step runs.
        """
        if not self.ready:
            raise DemoReviewerError("Firebase Admin is not configured.")

        ref, case = self._load(case_id)
        if str(case.get("owner_uid") or "") != owner_uid:
            # Same message as a missing case, so this cannot enumerate ids.
            raise DemoReviewerError("Case not found.")

        if case.get("demo_review_cursor") is not None:
            return self._status_payload(case_id, case)

        ref.set(
            {
                "assigned_agent": {
                    "email": DEMO_REVIEWER_EMAIL,
                    "name": DEMO_REVIEWER_NAME,
                    "simulated": True,
                    "assigned_at": self._now(),
                },
                "demo_review_cursor": 0,
                "demo_review_state": {},
                "review_steps": [],
                "updated_at": self._server_timestamp(),
            },
            merge=True,
        )
        _, refreshed = self._load(case_id)
        return self._status_payload(case_id, refreshed)

    def status(self, case_id: str) -> dict[str, Any]:
        if not self.ready:
            raise DemoReviewerError("Firebase Admin is not configured.")
        _, case = self._load(case_id)
        return self._status_payload(case_id, case)

    def _status_payload(self, case_id: str, case: dict[str, Any]) -> dict[str, Any]:
        cursor = int(case.get("demo_review_cursor") or 0)
        done = cursor >= len(STEP_PLAN)
        return {
            "case_id": case_id,
            "cursor": cursor,
            "total_steps": len(STEP_PLAN),
            "done": done,
            "next_step_title": "" if done else STEP_PLAN[cursor][1],
            "steps": list(case.get("review_steps") or []),
            "simulated": True,
        }

    # ── stepping ────────────────────────────────────────────────────────────
    def advance(self, case_id: str) -> dict[str, Any]:
        """Run exactly one step of the review and persist it."""
        if not self.ready:
            raise DemoReviewerError("Firebase Admin is not configured.")

        ref, case = self._load(case_id)

        cursor = case.get("demo_review_cursor")
        if cursor is None:
            raise DemoReviewerError("This claim is not enrolled in the demo review.")
        cursor = int(cursor)

        if cursor >= len(STEP_PLAN):
            raise DemoReviewerError("The review is already complete.")

        key, title = STEP_PLAN[cursor]
        state = dict(case.get("demo_review_state") or {})

        handler: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]] = getattr(
            self, f"_step_{key}"
        )
        outcome = handler(case, state)

        step = {
            "seq": cursor + 1,
            "title": title,
            "detail": outcome.get("detail", ""),
            "at": self._now(),
            **self._actor(),
        }
        for extra in ("findings", "challenge", "model", "agrees_with_reviewer",
                      "previous_cost_usd", "reviewed_cost_usd", "final_action"):
            if extra in outcome:
                step[extra] = outcome[extra]

        steps = list(case.get("review_steps") or [])
        steps.append(step)

        updates: dict[str, Any] = {
            "review_steps": steps,
            "demo_review_cursor": cursor + 1,
            "demo_review_state": {**state, **outcome.get("state", {})},
            "updated_at": self._server_timestamp(),
        }
        updates.update(outcome.get("doc", {}))

        # Notifications live in an array on the case doc, so append rather than
        # replace or the customer loses their earlier alerts.
        note = outcome.get("notification")
        if note:
            existing = list(case.get("consumer_notifications") or [])
            existing.append(note)
            updates["consumer_notifications"] = existing

        ref.set(updates, merge=True)

        # Every step lands in claim history, not just the final decision.
        # Previously only the release step wrote an event, so the history read
        # as a single message appearing out of nowhere with no review behind it.
        self._post_activity(
            case_id,
            "review_step",
            f"Step {step['seq']} of {len(STEP_PLAN)} — {title}: {outcome.get('detail', '')}"[:900],
        )

        message = outcome.get("customer_message")
        if message:
            self._post_activity(case_id, "reviewer_message", message)

        _, refreshed = self._load(case_id)
        payload = self._status_payload(case_id, refreshed)
        payload["step"] = step
        return payload

    def _post_activity(self, case_id: str, kind: str, label: str) -> None:
        try:
            self._db().collection("case_activity").add(
                {
                    "case_id": case_id,
                    "type": kind,
                    "label": label,
                    "created_at": self._server_timestamp(),
                    **self._actor(),
                }
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Demo reviewer could not post activity: %s", exc)

    # ── replying to the customer ────────────────────────────────────────────
    def reply_to_customer(self, case_id: str) -> dict[str, Any]:
        """Answer the customer's most recent message, in character.

        Demonstrates the other direction of the loop: the viewer writes as the
        customer, then advances the adjuster, and a real reply appears.
        """
        if not self.ready:
            raise DemoReviewerError("Firebase Admin is not configured.")

        _, case = self._load(case_id)
        db = self._db()

        try:
            events = list(
                db.collection("case_activity").where("case_id", "==", case_id).stream()
            )
        except Exception as exc:  # noqa: BLE001
            raise DemoReviewerError(f"Could not read the message thread: {exc}") from exc

        def created_at(event: dict[str, Any]) -> str:
            raw = event.get("created_at")
            return str(getattr(raw, "isoformat", lambda: raw)())

        records = [e.to_dict() or {} for e in events]
        customer_msgs = [
            r for r in records
            if r.get("actor_role") not in {"employee", "manager", "admin"}
            and str(r.get("label") or "").strip()
        ]
        if not customer_msgs:
            raise DemoReviewerError("The customer has not sent a message yet.")

        customer_msgs.sort(key=created_at)
        latest = customer_msgs[-1]
        question = str(latest.get("label") or "").strip()

        reply = self._compose_reply(case, question)
        self._post_activity(case_id, "reviewer_message", reply)

        existing = list(case.get("consumer_notifications") or [])
        existing.append(
            {
                "key": f"{case_id}-reply-{len(existing) + 1}",
                "title": "Adjuster replied",
                "message": f"{DEMO_REVIEWER_NAME} answered your question.",
            }
        )
        self._db().collection("cases").document(case_id).set(
            {"consumer_notifications": existing, "updated_at": self._server_timestamp()},
            merge=True,
        )

        return {
            "case_id": case_id,
            "customer_question": question,
            "reply": reply,
            "simulated": True,
        }

    def _compose_reply(self, case: dict[str, Any], question: str) -> str:
        review = case.get("review") or {}
        reviewed = int(review.get("reviewed_total_cost_usd") or case.get("estimated_total_cost_usd") or 0)
        value = int(case.get("estimated_vehicle_value_usd") or 0)
        action = str(review.get("final_action") or "") or "still under review"

        # Deliberately NOT second_pass_review: that prompt frames its input as
        # an adversarial challenge from a superior, so an ordinary customer
        # question came back labelled a prompt injection attempt.
        context = {
            "claim_reference": case.get("claim_reference") or "",
            "vehicle": case.get("vehicle_type") or "",
            "reviewed_repair_cost_usd": reviewed,
            "vehicle_value_usd": value,
            "decision": action,
            "reviewer_note": str(review.get("reviewer_note") or ""),
            "assessment_summary": str(case.get("summary") or "")[:1500],
            "status": str(case.get("status_label") or ""),
        }

        try:
            if self._narrator is not None:
                text = self._narrator.answer_as_adjuster(question, context)
                if text:
                    return str(text).strip()[:1200]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Demo reviewer reply generation failed: %s", exc)

        # Deterministic fallback so the thread never dead-ends.
        if value and reviewed:
            return (
                f"Thanks for getting in touch. Repairs are currently estimated at ${reviewed:,} "
                f"against a vehicle value of ${value:,}, and the claim is {action}. "
                "If you disagree with any line item, tell me which one and I will look again."
            )
        return (
            "Thanks for getting in touch. I am reviewing your claim now and will come back to you "
            "with the estimate and the decision shortly."
        )

    # ── the individual steps ────────────────────────────────────────────────
    def _step_pickup(self, case: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
        ref = case.get("claim_reference") or ""
        return {
            "detail": f"Opened {ref} from the review queue and locked it for assessment.",
            "doc": {"status": "in_review", "status_label": "In review"},
            "notification": {
                "key": f"{ref}-picked-up",
                "title": "Adjuster assigned",
                "message": f"{DEMO_REVIEWER_NAME} has started reviewing your claim.",
            },
        }

    def _step_read_first_pass(self, case: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
        regions = case.get("regions") or []
        cost = int(case.get("estimated_total_cost_usd") or 0)
        value = int(case.get("estimated_vehicle_value_usd") or 0)
        action = str(case.get("recommended_action") or "")
        return {
            "detail": (
                f"{len(regions)} damage region(s) detected, ${cost:,} estimated repair "
                f"against a ${value:,} vehicle value. "
                f"AI recommendation: {action or 'none recorded'}."
            ),
        }

    def _step_verify(self, case: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
        regions = case.get("regions") or []
        checks = self._verify(
            case,
            regions,
            case.get("assessment_flags") or [],
            int(case.get("estimated_total_cost_usd") or 0),
            int(case.get("estimated_vehicle_value_usd") or 0),
        )

        # Record what was actually examined, so the Evidence package tab shows
        # the basis for the decision instead of "No supporting documents added".
        # These are file/record entries in the shape createDocumentCard expects.
        evidence = list(case.get("reviewer_evidence") or [])
        filenames = [f for f in (case.get("filenames") or []) if f]
        if not filenames and case.get("filename"):
            filenames = [case["filename"]]
        for name in filenames:
            evidence.append({
                "name": str(name),
                "label": str(name),
                "type": "image/jpeg",
                "source": "employee_adjustment",
                "note": "Damage photo examined during review",
                "simulated": True,
            })
        evidence.append({
            "name": f"Verification checks — {len(regions)} region(s)",
            "label": f"Verification checks — {len(regions)} region(s)",
            "type": "text/plain",
            "source": "employee_adjustment",
            "note": checks["detail"],
            "simulated": True,
        })

        return {
            "detail": checks["detail"],
            "findings": checks["findings"],
            "doc": {"reviewer_evidence": evidence},
            "state": {"checks": checks},
        }

    def _step_challenge(self, case: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
        checks = state.get("checks") or {}
        challenge = checks.get("challenge") or "Justify the estimate line by line."
        second = self._challenge(
            case,
            case.get("claim_reference") or "",
            challenge,
            int(case.get("estimated_total_cost_usd") or 0),
            str(case.get("recommended_action") or ""),
        )
        return {
            "detail": second["detail"],
            "challenge": challenge,
            "model": second.get("model", ""),
            "agrees_with_reviewer": second.get("agrees_with_adjuster"),
            "state": {"second_pass": second},
        }

    def _step_adjust(self, case: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
        ai_cost = int(case.get("estimated_total_cost_usd") or 0)
        checks = state.get("checks") or {}
        reviewed = self._reviewed_cost(ai_cost, checks, state.get("second_pass") or {})

        line_items, dropped = self._build_line_items(case, checks, reviewed, ai_cost)

        if reviewed != ai_cost:
            delta = reviewed - ai_cost
            detail = (
                f"Revised the repair estimate from ${ai_cost:,} to ${reviewed:,} "
                f"({'+' if delta > 0 else '-'}${abs(delta):,})."
            )
            if dropped:
                detail += " Reduced: " + ", ".join(dropped) + "."
        else:
            detail = f"No material change warranted; ${ai_cost:,} stands as written."

        # Populate the itemised estimate and its version history, which is what
        # the adjustment screen and the final report read. Without these the
        # estimate table stays on "No adjusted line items yet".
        version = {
            "version": 1,
            "created_at": self._now(),
            "actor": DEMO_REVIEWER_NAME,
            "ai_total_cost_usd": ai_cost,
            "reviewed_total_cost_usd": reviewed,
            "delta_usd": reviewed - ai_cost,
            "reason": detail,
            "line_items": line_items,
            "simulated": True,
        }

        return {
            "detail": detail,
            "previous_cost_usd": ai_cost,
            "reviewed_cost_usd": reviewed,
            "doc": {
                "reviewed_total_cost_usd": reviewed,
                "estimate_line_items": line_items,
                "estimate_versions": [version],
            },
            "state": {"reviewed_cost": reviewed, "line_items": line_items},
        }

    def _build_line_items(
        self,
        case: dict[str, Any],
        checks: dict[str, Any],
        reviewed: int,
        ai_cost: int,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """Turn detected regions into an itemised estimate.

        When the review trimmed the total, the reduction is applied to the
        weakly-evidenced lines specifically rather than spread across every
        item, so the estimate shows *which* lines the reviewer doubted.
        """
        regions = [r for r in (case.get("regions") or []) if isinstance(r, dict)]
        if not regions:
            return ([{
                "category": "Repair",
                "description": "Repair work as assessed",
                "quantity": 1,
                "unit_cost_usd": reviewed,
                "total_usd": reviewed,
            }], [])

        def name_of(region: dict[str, Any]) -> str:
            return str(region.get("panel") or region.get("part") or "Vehicle part")

        def cost_of(region: dict[str, Any]) -> int:
            try:
                return int(region.get("estimated_repair_cost_usd") or 0)
            except (TypeError, ValueError):
                return 0

        def conf_of(region: dict[str, Any]) -> float:
            raw = region.get("confidence")
            if raw is None:
                return 1.0
            try:
                return float(raw)
            except (TypeError, ValueError):
                return 1.0

        priced = [r for r in regions if cost_of(r) > 0]
        weak = [r for r in priced if conf_of(r) < 0.7]
        reduction = max(0, ai_cost - reviewed)
        # Split the reduction across the weak lines; if none are priced, the
        # trim cannot be attributed, so leave the lines at face value.
        per_weak = (reduction // len(weak)) if (weak and reduction) else 0

        items: list[dict[str, Any]] = []
        dropped: list[str] = []
        for region in regions:
            cost = cost_of(region)
            label = name_of(region)
            damage = str(region.get("damage_type") or "Damage")
            if cost <= 0:
                continue
            if region in weak and per_weak:
                new_cost = max(0, cost - per_weak)
                dropped.append(f"{label} ${cost:,}→${new_cost:,}")
                cost = new_cost
            items.append({
                "category": "Repair",
                "description": f"{label} · {damage}",
                "quantity": 1,
                "unit_cost_usd": cost,
                "total_usd": cost,
                "confidence": conf_of(region),
            })

        if not items:
            items = [{
                "category": "Repair",
                "description": "Repair work as assessed",
                "quantity": 1,
                "unit_cost_usd": reviewed,
                "total_usd": reviewed,
            }]
        return (items, dropped)

    def _step_decide(self, case: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
        reviewed = int(state.get("reviewed_cost") or case.get("estimated_total_cost_usd") or 0)
        value = int(case.get("estimated_vehicle_value_usd") or 0)
        decision = self._decide(reviewed, value, bool(case.get("total_loss")))
        return {
            "detail": decision["detail"],
            "final_action": decision["action"],
            "state": {"decision": decision},
        }

    def _step_release(self, case: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
        decision = state.get("decision") or {}
        reviewed = int(state.get("reviewed_cost") or case.get("estimated_total_cost_usd") or 0)
        note = decision.get("customer_note") or "Your claim review is complete."
        ref = case.get("claim_reference") or ""
        return {
            "detail": note,
            "final_action": decision.get("action", ""),
            "doc": {
                "review": {
                    "claim_reference": ref,
                    "reviewer_name": DEMO_REVIEWER_NAME,
                    "reviewer_email": DEMO_REVIEWER_EMAIL,
                    "reviewed_total_cost_usd": reviewed,
                    "final_action": decision.get("action", ""),
                    "reviewer_note": note,
                    "ai_recommended_action": str(case.get("recommended_action") or ""),
                    "simulated": True,
                    "reviewed_at": self._now(),
                },
                "final_action": decision.get("action", ""),
                "total_loss": bool(decision.get("total_loss")),
                "status": "final_review",
                "status_label": "Final review",
                "report_ready": True,
                "demo_review_completed": True,
            },
            "customer_message": note,
            "notification": {
                "key": f"{ref}-decision",
                "title": "Decision ready",
                "message": "Your claim has been reviewed. You can accept or appeal the decision.",
            },
        }

    # ── the individual judgements ───────────────────────────────────────────
    def _verify(
        self,
        case: dict[str, Any],
        regions: list[Any],
        flags: list[Any],
        ai_cost: int,
        vehicle_value: int,
    ) -> dict[str, Any]:
        """Deterministic checks, so the reviewer's challenge is grounded."""
        findings: list[str] = []

        def confidence_of(region: dict) -> float:
            # `or 1` would read a genuine 0.0 as full confidence, which is the
            # exact case a reviewer most needs to see.
            raw = region.get("confidence")
            if raw is None:
                return 1.0
            try:
                return float(raw)
            except (TypeError, ValueError):
                return 1.0

        low_conf = [
            r for r in regions
            if isinstance(r, dict) and confidence_of(r) < 0.7
        ]
        if low_conf:
            # DamageRegion calls this `panel`; `part`/`label` are only fallbacks
            # for hand-written fixtures.
            names = ", ".join(
                str(r.get("panel") or r.get("part") or r.get("label") or "region")
                for r in low_conf[:3]
            )
            findings.append(f"{len(low_conf)} region(s) below 0.70 confidence ({names})")

        flag_codes = [
            str(f.get("code")) for f in flags if isinstance(f, dict) and f.get("code")
        ]
        if flag_codes:
            findings.append("rules layer raised: " + ", ".join(flag_codes[:4]))

        if vehicle_value and ai_cost:
            ratio = ai_cost / vehicle_value
            findings.append(f"repair-to-value ratio {ratio:.0%}")
            if 0.6 <= ratio <= 1.1:
                findings.append(
                    "ratio sits near the total-loss threshold, so the estimate decides the outcome"
                )

        if not findings:
            findings.append("no low-confidence regions and no rules flags")

        if low_conf:
            challenge = (
                f"{len(low_conf)} of the {len(regions)} detected regions are below 0.70 confidence. "
                "Justify each low-confidence line item against the photos, or drop it from the estimate."
            )
        elif flag_codes:
            challenge = (
                "The rules layer raised " + ", ".join(flag_codes[:3]) + ". "
                "Explain whether these change the estimate or the total-loss call."
            )
        elif vehicle_value and ai_cost and ai_cost / vehicle_value > 1.0:
            challenge = (
                f"Repair at ${ai_cost:,} exceeds the ${vehicle_value:,} vehicle value. "
                "Confirm the write-off and state what evidence rules out an economical repair."
            )
        else:
            challenge = (
                "Walk me through how each line item was priced for this vehicle's age and mileage, "
                "and flag anything you are inferring rather than seeing."
            )

        return {
            "detail": "Checks performed: " + "; ".join(findings) + ".",
            "findings": findings,
            "challenge": challenge,
            "low_confidence_count": len(low_conf),
            "flag_codes": flag_codes,
        }

    def _challenge(
        self,
        case: dict[str, Any],
        case_id: str,
        challenge: str,
        ai_cost: int,
        ai_action: str,
    ) -> dict[str, Any]:
        payload = {
            "claim_reference": case.get("claim_reference") or case_id,
            "vehicle": case.get("vehicle_type") or "",
            "adjuster_challenge": challenge,
            "ai_estimate_usd": ai_cost,
            "reviewed_estimate_usd": ai_cost,
            "ai_recommended_action": ai_action,
            "proposed_final_action": "",
            "ai_reasoning": str(case.get("summary") or "")[:4000],
        }

        result = None
        try:
            if self._narrator is not None:
                result = self._narrator.second_pass_review(payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Demo reviewer second pass failed: %s", exc)

        if not result:
            # No model available: say so rather than inventing a re-review.
            return {
                "detail": (
                    "Raised with the model: \"" + challenge + "\" "
                    "Model review unavailable, so the first pass stands unchallenged."
                ),
                "model": "",
                "fallback_used": True,
            }

        return {
            "detail": (
                "Raised: \"" + challenge + "\" Model response: "
                + str(result.get("reasoning") or "").strip()
            ),
            "model": str(result.get("model") or ""),
            "agrees_with_adjuster": bool(result.get("agrees_with_adjuster")),
            "recommended_action": str(result.get("recommended_action") or ""),
            "fallback_used": bool(result.get("fallback_used")),
        }

    def _reviewed_cost(
        self,
        ai_cost: int,
        checks: dict[str, Any],
        second_pass: dict[str, Any],
    ) -> int:
        """Trim only what the checks actually justify, and never below the cap."""
        if ai_cost <= _MATERIALITY_USD:
            return ai_cost
        # The model conceding the challenge is what licenses a reduction; the
        # size of it comes from how many regions were weakly evidenced.
        if not second_pass.get("agrees_with_adjuster"):
            return ai_cost
        low = int(checks.get("low_confidence_count") or 0)
        if low <= 0:
            return ai_cost
        trim_ratio = min(_MAX_TRIM_RATIO, 0.08 * low)
        reviewed = int(round(ai_cost * (1 - trim_ratio) / 25.0) * 25)
        return max(reviewed, _MATERIALITY_USD)

    def _decide(self, reviewed_cost: int, vehicle_value: int, ai_total_loss: bool) -> dict[str, Any]:
        if not vehicle_value:
            return {
                "action": "escalate_for_valuation",
                "total_loss": ai_total_loss,
                "detail": "No vehicle value on file, so the total-loss test cannot be applied.",
                "customer_note": (
                    "I have reviewed the automated assessment. I cannot confirm the outcome without a "
                    "market value for your vehicle, so I am requesting a valuation before deciding."
                ),
            }

        ratio = reviewed_cost / vehicle_value
        if ratio >= _TOTAL_LOSS_RATIO:
            return {
                "action": "total_loss",
                "total_loss": True,
                "detail": (
                    f"Reviewed repair ${reviewed_cost:,} is {ratio:.0%} of the ${vehicle_value:,} "
                    f"value, at or above the {_TOTAL_LOSS_RATIO:.0%} write-off threshold."
                ),
                "customer_note": (
                    f"I have finished reviewing your claim. Repairs come to ${reviewed_cost:,}, which is "
                    f"{ratio:.0%} of your vehicle's ${vehicle_value:,} market value, so we are treating this "
                    f"as a total loss. That means we pay you the vehicle's value of ${vehicle_value:,}, less "
                    "any deductible on your policy, rather than repairing it. You can accept this or appeal it."
                ),
            }

        return {
            "action": "repair",
            "total_loss": False,
            "detail": (
                f"Reviewed repair ${reviewed_cost:,} is {ratio:.0%} of the ${vehicle_value:,} "
                f"value, below the {_TOTAL_LOSS_RATIO:.0%} write-off threshold."
            ),
            "customer_note": (
                f"I have finished reviewing your claim. Repairs come to ${reviewed_cost:,} against a vehicle "
                f"value of ${vehicle_value:,}, so we are approving a repair rather than writing the car off. "
                "Your deductible still applies. You can accept this or appeal it."
            ),
        }
