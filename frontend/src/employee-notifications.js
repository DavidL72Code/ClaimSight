// ══════════════════════════════════════════════════════════════════
// Employee notification centre
//
// This page was three hardcoded <article> blocks naming CLM-1048 /
// 1047 / 1046 with timestamps like "18 minutes ago". Nothing fed it,
// and the bell badge on all three employee pages was a literal "3" in
// the markup. So while the customer got status notifications, the
// adjuster was never told anything — not a new claim, not returned
// evidence, not an appeal.
//
// Alerts are derived from the claims the adjuster can already see,
// mirroring how consumer-case.js derives the customer's notifications
// from claim status. No new Firestore collection is involved.
// ══════════════════════════════════════════════════════════════════
(() => {
  const dataEnabled = Boolean(window.sbAuth?.ready() && window.claimData);

  const list = document.querySelector(".employee-notification-list");
  const badges = document.querySelectorAll(".notification-count");

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const relative = (iso) => {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
    const days = Math.round(hrs / 24);
    return days === 1 ? "Yesterday" : `${days} days ago`;
  };

  const iso = (value) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    if (typeof value.seconds === "number") return new Date(value.seconds * 1000).toISOString();
    return "";
  };

  // One claim can raise more than one alert (e.g. an appeal that is
  // also past its evidence due date), so this returns a list.
  const alertsFor = (claim) => {
    const out = [];
    const ref = claim.reference;
    const status = claim.status;
    const at = claim.updatedAt || claim.submittedAt;

    if (claim.appeal || status === "appealed") {
      out.push({
        tone: "urgent",
        title: "Appeal received",
        message: `${ref} was appealed by the customer and needs a response before the report is released.`,
        at,
      });
    }

    if (status === "needs_info") {
      const due = Date.parse(claim.evidenceDueAt || "");
      if (due && due < Date.now()) {
        out.push({
          tone: "urgent",
          title: "Evidence overdue",
          message: `${ref} is past the ${new Date(due).toLocaleDateString()} deadline for ${
            claim.requestedEvidence?.join(", ") || "requested evidence"
          }.`,
          at: claim.evidenceDueAt,
        });
      } else {
        out.push({
          tone: "waiting",
          title: "Waiting on customer",
          message: `${ref} is waiting on ${claim.requestedEvidence?.join(", ") || "additional evidence"}.`,
          at,
        });
      }
    }

    // The customer answered an evidence request: the claim has left
    // needs_info but is carrying documents added after the request.
    if (status !== "needs_info" && claim.evidenceReturned) {
      out.push({
        tone: "action",
        title: "Evidence received",
        message: `${ref} has new customer uploads to review.`,
        at,
      });
    }

    if (status === "submitted" || status === "new") {
      out.push({
        tone: "action",
        title: "New claim submitted",
        message: `${ref} is in the queue${claim.assigned ? "" : " and not yet assigned"}.`,
        at: claim.submittedAt,
      });
    }

    // A message from the customer the adjuster has not opened yet.
    if (claim.lastCustomerMessageAt) {
      const sent = Date.parse(claim.lastCustomerMessageAt);
      const seen = Date.parse(claim.threadSeenAt || 0) || 0;
      if (sent > seen) {
        out.push({
          tone: "action",
          title: "New message from customer",
          message: `${ref} has an unread message in the message centre.`,
          at: claim.lastCustomerMessageAt,
        });
      }
    }

    if (claim.accepted) {
      out.push({
        tone: "done",
        title: "Customer accepted decision",
        message: `${ref} was accepted — ready to finalize the report.`,
        at,
      });
    }

    if (status === "final_review") {
      out.push({
        tone: "action",
        title: "Ready for final report",
        message: `${ref} has cleared adjustment and is waiting on the final report.`,
        at,
      });
    }

    return out;
  };

  // A claim carries both a machine `status` ("needs_info") and a human
  // `status_label` ("Needs more information"). Normalising the label
  // gives "needs_more_information", which matches nothing — so prefer
  // the code and fall back to a label lookup.
  const labelToCode = {
    needs_more_information: "needs_info",
    more_information_needed: "needs_info",
    final_review: "final_review",
    in_review: "in_review",
    in_progress: "draft",
    decision_ready: "final_review",
  };

  const statusCode = (payload = {}) => {
    if (payload.consumer_decision?.decision === "appealed") return "appealed";
    const raw = String(payload.status || "").toLowerCase().trim();
    if (raw) return raw.replace(/\s+/g, "_");
    const label = String(payload.status_label || "").toLowerCase().trim().replace(/\s+/g, "_");
    return labelToCode[label] || label;
  };

  const shape = (id, payload = {}) => {
    const review = payload.review || {};
    const docs = payload.supporting_documents || payload.documents || [];
    return {
      id,
      reference: review.claim_reference || payload.claim_reference || payload.claim_number || id,
      status: statusCode(payload),
      statusLabel: payload.status_label || payload.status || "",
      submittedAt: iso(payload.created_at || payload.submitted_at),
      updatedAt: iso(payload.updated_at || payload.created_at),
      requestedEvidence: payload.requested_evidence || review.requested_evidence || [],
      evidenceDueAt: iso(payload.evidence_due_at || review.evidence_due_at),
      appeal: payload.appeal || (payload.consumer_decision?.decision === "appealed" ? {} : null),
      accepted: payload.consumer_decision?.decision === "accepted",
      assigned: Boolean(payload.assigned_agent?.email),
      evidenceReturned: docs.some((d) => String(d.source || "").includes("later")),
      lastCustomerMessageAt: iso(payload.last_customer_message_at),
      // read marker lives on the case doc, so it follows the account
      threadSeenAt: iso(payload.employee_thread_seen_at),
    };
  };

  const render = (alerts) => {
    const total = alerts.length;
    badges.forEach((b) => {
      b.textContent = String(total);
      b.classList.toggle("hidden", total === 0);
    });

    if (!list) return;
    if (!total) {
      list.innerHTML = '<article class="employee-notification-empty"><strong>No alerts right now</strong><p>New claims, returned evidence and appeals will appear here.</p></article>';
      return;
    }
    // most urgent first, then newest
    const rank = { urgent: 0, action: 1, waiting: 2, done: 3 };
    alerts.sort((a, b) => (rank[a.tone] - rank[b.tone]) || (Date.parse(b.at || 0) - Date.parse(a.at || 0)));
    list.innerHTML = alerts.map((a) => `
      <article class="employee-alert ${esc(a.tone)}">
        <strong>${esc(a.title)}</strong>
        <p>${esc(a.message)}</p>
        <span>${esc(relative(a.at))}</span>
      </article>
    `).join("");
  };

  const collect = (cases) => cases.flatMap((c) => alertsFor(c));

  const loadPreview = () => {
    // Mirrors the demo claims the customer preview branch uses, so the
    // two sides of the pipeline tell the same story without Firebase.
    const now = Date.now();
    const mins = (m) => new Date(now - m * 60000).toISOString();
    render(collect([
      shape("CLM-1052", {
        claim_reference: "CLM-1052", status_label: "Needs more information",
        requested_evidence: ["left-side photo", "repair estimate"],
        evidence_due_at: new Date(now + 864e5).toISOString(),
        updated_at: mins(24), created_at: mins(2880),
        last_customer_message_at: mins(11),
        assigned_agent: { email: "adjuster@claimsight.com" },
      }),
      shape("CLM-1048", {
        claim_reference: "CLM-1048", status_label: "Appealed",
        consumer_decision: { decision: "appealed" },
        updated_at: mins(6), created_at: mins(1440),
        assigned_agent: { email: "adjuster@claimsight.com" },
      }),
      shape("CLM-1059", {
        claim_reference: "CLM-1059", status_label: "Submitted",
        created_at: mins(95), updated_at: mins(95),
      }),
      shape("CLM-1056", {
        claim_reference: "CLM-1056", status_label: "Final review",
        updated_at: mins(310), created_at: mins(7200),
        supporting_documents: [{ name: "estimate.pdf", source: "customer_added_later" }],
        assigned_agent: { email: "adjuster@claimsight.com" },
      }),
    ]));
  };

  const loadLive = async () => {
    try {
      // The select policy already limits this to the cases assigned to
      // the signed-in adjuster, so no email filter is needed -- which
      // also removes the preview-email fallback that could previously
      // widen the query to another adjuster's address.
      const rows = await window.claimData.listCases({ limit: 25 });
      render(collect(rows.map((row) => shape(row.id, row))));
    } catch {
      loadPreview();
    }
  };

  if (dataEnabled) loadLive();
  else loadPreview();
})();
