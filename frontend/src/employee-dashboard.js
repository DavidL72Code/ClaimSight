(() => {
const firebaseConfig = window.FIREBASE_CONFIG || {};
const firebaseEnabled = Boolean(
  window.firebase
  && firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.appId
);

const consumerClaimIdsStorageKey = "claimsight.consumer-claim-ids";
const consumerDraftStorageKey = "claimsight.consumer-draft";
const selectedEmployeeClaimKey = "claimsight.employee-selected-claim";
const employeePreviewEmailKey = "claimsight.employee-preview-email";

const elements = {
  table: document.getElementById("employee-claims-table"),
  refresh: document.getElementById("employee-refresh-claims"),
  search: document.getElementById("employee-claim-search"),
  filters: Array.from(document.querySelectorAll(".queue-filter")),
  empty: document.getElementById("employee-claim-empty"),
  review: document.getElementById("employee-claim-review"),
  selectedStatus: document.getElementById("employee-selected-status"),
  adjustmentLink: document.getElementById("employee-adjustment-link"),
  claim: document.getElementById("employee-detail-claim"),
  date: document.getElementById("employee-detail-date"),
  customer: document.getElementById("employee-detail-customer"),
  assignedAgent: document.getElementById("employee-detail-agent"),
  vehicle: document.getElementById("employee-detail-vehicle"),
  mileage: document.getElementById("employee-detail-mileage"),
  estimate: document.getElementById("employee-detail-estimate"),
  action: document.getElementById("employee-detail-action"),
  statement: document.getElementById("employee-detail-statement"),
  evidence: document.getElementById("employee-detail-evidence"),
  reasoning: document.getElementById("employee-detail-reasoning"),
  photoGallery: document.getElementById("employee-photo-gallery"),
  requestEvidence: document.getElementById("employee-request-evidence"),
  requestEvidenceItems: document.getElementById("employee-request-evidence-items"),
  requestEvidenceDue: document.getElementById("employee-request-evidence-due"),
  finalizeClaim: document.getElementById("employee-finalize-claim"),
  finalChecklist: document.getElementById("employee-final-checklist"),
  actionStatus: document.getElementById("employee-action-status"),
  aiComparison: document.getElementById("employee-ai-comparison"),
  adjusterComparison: document.getElementById("employee-adjuster-comparison"),
  appealPanel: document.getElementById("employee-appeal-panel"),
  appealCategory: document.getElementById("employee-appeal-category"),
  appealAmount: document.getElementById("employee-appeal-amount"),
  appealFiles: document.getElementById("employee-appeal-files"),
  appealExplanation: document.getElementById("employee-appeal-explanation"),
  internalNotes: document.getElementById("employee-internal-notes"),
  saveInternalNote: document.getElementById("employee-save-internal-note"),
  auditLog: document.getElementById("employee-audit-log"),
};

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const formatDate = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
};

const formatCurrency = (value) => {
  const amount = Number(value) || 0;
  return amount > 0 ? `$${amount.toLocaleString()}` : "Pending";
};

const timestampToIso = (value) => {
  if (!value) {
    return "";
  }
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return String(value);
};

const readJsonStorage = (key, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const readStorageValue = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return "";
  }
};

const writeStorageValue = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Local preview browsers may block storage; the dashboard should still render.
  }
};

const deriveStatus = (payload = {}) => {
  const review = payload.review || {};
  if (payload.consumer_decision?.decision === "appealed") {
    return "Appealed";
  }
  if (payload.status_label) {
    return payload.status_label;
  }
  if (payload.status === "finalized") {
    return "Finalized";
  }
  if (payload.status === "final_review") {
    return "Final review";
  }
  if (payload.status === "in_review" || review.reviewer_name) {
    return "In review";
  }
  if (payload.status === "draft") {
    return "In progress";
  }
  return "Submitted";
};

const fallbackAdjusters = [
  { id: "adj-alex-morgan", name: "Alex Morgan", email: "alex.morgan@claimsight.com" },
  { id: "adj-jordan-lee", name: "Jordan Lee", email: "jordan.lee@claimsight.com" },
  { id: "adj-sam-rivera", name: "Sam Rivera", email: "sam.rivera@claimsight.com" },
  { id: "adj-taylor-kim", name: "Taylor Kim", email: "taylor.kim@claimsight.com" },
];

const fallbackAssignedAgent = (claimId = "") =>
  fallbackAdjusters[Math.abs(String(claimId).split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % fallbackAdjusters.length];

const getCurrentEmployeeEmail = () => {
  try {
    const app = window.firebase?.apps?.length ? window.firebase.app() : null;
    const auth = app && typeof window.firebase.auth === "function" ? window.firebase.auth(app) : null;
    return auth?.currentUser?.email || window.localStorage.getItem(employeePreviewEmailKey) || "alex.morgan@claimsight.com";
  } catch {
    return "alex.morgan@claimsight.com";
  }
};

const isAssignedToCurrentEmployee = (claim) =>
  String(claim.assignedAgent?.email || "").toLowerCase() === getCurrentEmployeeEmail().toLowerCase();

const normalizePhotos = (payload = {}) => {
  const rawPhotos = payload.photo_urls || payload.image_urls || payload.uploaded_photos || payload.images || payload.files || [];
  if (!Array.isArray(rawPhotos)) {
    return [];
  }
  return rawPhotos
    .map((item) => {
      if (typeof item === "string") {
        return { src: item, label: "Submitted photo" };
      }
      return {
        src: item.url || item.src || item.download_url || item.preview_url || "",
        label: item.label || item.name || item.filename || "Submitted photo",
      };
    })
    .filter((item) => item.src);
};

const normalizeCase = (id, payload = {}) => {
  const context = payload.claim_context || {};
  const review = payload.review || {};
  const makeModel = [context.year || payload.year, context.make || payload.make, context.model || payload.model]
    .filter(Boolean)
    .join(" ");
  const evidence = payload.supporting_documents || payload.documents || [];
  const photos = normalizePhotos(payload);
  const photoCount = payload.photo_count || payload.image_count || photos.length || 0;

  return {
    id,
    claimNumber: review.claim_reference || payload.claim_reference || payload.claim_number || id,
    customer: payload.customer_name || payload.customer_email || payload.email || "Customer unavailable",
    assignedAgent: payload.assigned_agent || fallbackAssignedAgent(id),
    submittedAt: timestampToIso(payload.created_at || payload.submitted_at || payload.updated_at),
    vehicle: payload.vehicle_type || makeModel || "Vehicle info unavailable",
    mileage: context.mileage || payload.mileage || "",
    status: deriveStatus(payload),
    estimate: review.reviewed_total_cost_usd || payload.reviewed_total_cost_usd || payload.estimated_total_cost_usd || 0,
    action: review.ai_recommended_action || payload.recommended_action || payload.final_action || "Awaiting employee review",
    statement: payload.incident_description || payload.customer_statement || payload.summary || "No customer statement submitted yet.",
    evidence: [
      photoCount ? `${photoCount} photo${photoCount === 1 ? "" : "s"} submitted` : "Photos pending",
      evidence.length ? `${evidence.length} supporting document${evidence.length === 1 ? "" : "s"}` : "No supporting documents listed",
    ].join(" · "),
    reasoning: payload.total_loss_reason || payload.ai_reasoning || payload.reasoning || "AI reasoning will appear after the claim is assessed.",
    requestedEvidence: payload.requested_evidence || review.requested_evidence || [],
    evidenceDueAt: timestampToIso(payload.evidence_due_at || review.evidence_due_at),
    appeal: payload.appeal || null,
    photos,
  };
};

const readLocalCases = () => {
  const ids = readJsonStorage(consumerClaimIdsStorageKey, []);
  const draft = readJsonStorage(consumerDraftStorageKey, null);
  const cases = [];

  if (draft) {
    cases.push(normalizeCase(draft.claimId || "DRF-LOCAL", {
      ...draft,
      status: "draft",
      claim_reference: draft.claimId || "DRF-LOCAL",
      claim_context: draft.vehicle || draft.claim_context || {},
      customer_statement: draft.incidentDescription || "Draft claim saved by customer.",
      photo_count: draft.photoCount || 0,
    }));
  }

  ids.forEach((id, index) => {
    cases.push(normalizeCase(id, {
      claim_reference: id,
      assigned_agent: fallbackAssignedAgent(id),
      status: index === 0 ? "submitted" : "in_review",
      created_at: new Date(Date.now() - (index + 1) * 86400000).toISOString(),
      customer_email: "customer@example.com",
      vehicle_type: index === 0 ? "2021 Toyota Camry" : "2020 Honda Accord",
      mileage: index === 0 ? 42800 : 51750,
      estimated_total_cost_usd: index === 0 ? 4200 : 6850,
      recommended_action: index === 0 ? "Review front bumper and passenger fender damage." : "Escalate for structural review.",
      customer_statement: "Customer submitted crash photos and requested review.",
      photo_count: 4,
      photo_urls: [
        "https://www.claimpix.com/wp-content/uploads/2018/04/AdobeStock_144028969-300x225.jpeg",
        "https://cdn.raw2k.co.uk/app/public/media/624/c/how-to-spot-hidden-structural-damage-on-a-salvage-car-567.jpg",
      ],
      total_loss_reason: "AI found visible exterior damage and recommends employee validation before adjustment.",
    }));
  });

  const assignedCases = cases.filter(isAssignedToCurrentEmployee);
  if (assignedCases.length) {
    return assignedCases;
  }

  return [
    normalizeCase("CLM-1048", {
      claim_reference: "CLM-1048",
      assigned_agent: fallbackAdjusters[0],
      status: "submitted",
      created_at: new Date().toISOString(),
      customer_email: "maria.customer@example.com",
      vehicle_type: "2022 Toyota RAV4",
      mileage: 31840,
      estimated_total_cost_usd: 5400,
      recommended_action: "Review rear bumper, liftgate, and quarter-panel impact before adjustment.",
      customer_statement: "Customer reports being rear-ended at a stop light and uploaded rear damage photos.",
      photo_count: 6,
      photo_urls: [
        "https://www.claimpix.com/wp-content/uploads/2018/04/AdobeStock_144028969-300x225.jpeg",
        "https://cdn.raw2k.co.uk/app/public/media/624/c/how-to-spot-hidden-structural-damage-on-a-salvage-car-567.jpg",
        "https://www.qapter.com/wp-content/uploads/2024/02/Car-Service-Day-2.png",
      ],
      total_loss_reason: "AI sees moderate rear-end damage with possible hidden liftgate alignment issues.",
    }),
    normalizeCase("CLM-1047", {
      claim_reference: "CLM-1047",
      assigned_agent: fallbackAdjusters[1],
      status: "in_review",
      created_at: new Date(Date.now() - 86400000).toISOString(),
      customer_email: "lee.customer@example.com",
      vehicle_type: "2019 Honda Civic",
      mileage: 64210,
      estimated_total_cost_usd: 3200,
      recommended_action: "Confirm headlight assembly, bumper cover, and paint blend.",
      customer_statement: "Customer submitted front-right collision photos from a parking lot crash.",
      photo_count: 5,
      photo_urls: [
        "https://www.claimpix.com/wp-content/uploads/2018/04/AdobeStock_144028969-300x225.jpeg",
        "https://formsite.com/wp-content/uploads/2021/08/formsite-custom-pdf-results-doc-example-1024x576.jpg",
      ],
      total_loss_reason: "AI estimate is repairable, but employee should validate part availability and labor time.",
    }),
  ].filter(isAssignedToCurrentEmployee);
};

let claims = [];
let selectedClaim = null;
let activeFilter = "all";
let searchTerm = "";

const auditStorageKey = "claimsight.employee-audit-log";
const notesStorageKey = "claimsight.employee-internal-notes";

const readAuditLog = () => readJsonStorage(auditStorageKey, {});
const writeAuditLog = (payload) => {
  try {
    window.localStorage.setItem(auditStorageKey, JSON.stringify(payload));
  } catch {
    // Preview storage is best-effort.
  }
};

const appendAuditEvent = (claimId, label) => {
  const audit = readAuditLog();
  const events = audit[claimId] || [];
  audit[claimId] = [
    { label, at: new Date().toISOString(), actor: getCurrentEmployeeEmail() },
    ...events,
  ].slice(0, 12);
  writeAuditLog(audit);
  renderAuditLog(claimId);
};

const readInternalNotes = () => readJsonStorage(notesStorageKey, {});
const writeInternalNotes = (payload) => {
  try {
    window.localStorage.setItem(notesStorageKey, JSON.stringify(payload));
  } catch {
    // Preview storage is best-effort.
  }
};

const priorityForClaim = (claim) => {
  const status = claim.status.toLowerCase().replaceAll(" ", "_");
  if (["appealed", "needs_info"].includes(status) || claim.estimate >= 8000) return "urgent";
  if (["final_review", "in_review"].includes(status) || claim.estimate >= 4000) return "review";
  return "routine";
};

const dueDateForClaim = (claim) => {
  const submitted = Date.parse(claim.submittedAt || "") || Date.now();
  const days = priorityForClaim(claim) === "urgent" ? 1 : priorityForClaim(claim) === "review" ? 2 : 4;
  return new Date(submitted + days * 86400000).toLocaleDateString();
};

const filteredClaims = () => claims.filter((claim) => {
  const priority = priorityForClaim(claim);
  const status = claim.status.toLowerCase().replaceAll(" ", "_");
  const matchesFilter = activeFilter === "all"
    || activeFilter === priority
    || activeFilter === status
    || (activeFilter === "needs_info" && status.includes("need"));
  const haystack = `${claim.claimNumber} ${claim.customer} ${claim.vehicle} ${claim.status}`.toLowerCase();
  return matchesFilter && haystack.includes(searchTerm.toLowerCase());
});

const renderTable = () => {
  if (!elements.table) {
    return;
  }
  const visibleClaims = filteredClaims();
  if (!visibleClaims.length) {
    elements.table.innerHTML = `
      <tr class="claim-row empty">
        <td>—</td>
        <td><strong>No assigned claims</strong></td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>Assigned to you</td>
      </tr>
    `;
    return;
  }

  elements.table.innerHTML = visibleClaims.map((claim) => {
    const priority = priorityForClaim(claim);
    return `
    <tr class="claim-row ${claim.status.toLowerCase().replaceAll(" ", "_")}">
      <td>${formatDate(claim.submittedAt)}</td>
      <td><strong>${escapeHtml(claim.claimNumber)}</strong></td>
      <td>${escapeHtml(claim.vehicle)}</td>
      <td><span class="priority-badge ${priority}">${priority}</span></td>
      <td>${escapeHtml(dueDateForClaim(claim))}</td>
      <td>${escapeHtml(claim.assignedAgent?.name || "Unassigned")}</td>
      <td>${escapeHtml(claim.status)}</td>
      <td>
        <button class="text-action employee-review-button" type="button" data-claim-id="${escapeHtml(claim.id)}">Review</button>
      </td>
    </tr>
  `;
  }).join("");
};

const setText = (node, value) => {
  if (node) {
    node.textContent = value || "—";
  }
};

const renderPhotos = (photos = []) => {
  if (!elements.photoGallery) {
    return;
  }
  if (!photos.length) {
    elements.photoGallery.innerHTML = `<p class="empty-copy">No submitted photos available for this claim.</p>`;
    return;
  }
  elements.photoGallery.innerHTML = photos.map((photo, index) => `
    <figure>
      <img src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.label || `Submitted claim photo ${index + 1}`)}" />
      <figcaption>${escapeHtml(photo.label || `Photo ${index + 1}`)}</figcaption>
    </figure>
  `).join("");
};

const selectClaim = (claimId) => {
  const claim = claims.find((item) => item.id === claimId) || claims[0];
  selectedClaim = claim || null;
  if (!claim) {
    elements.empty?.classList.remove("hidden");
    elements.review?.classList.add("hidden");
    return;
  }

  writeStorageValue(selectedEmployeeClaimKey, claim.id);
  elements.empty?.classList.add("hidden");
  elements.review?.classList.remove("hidden");

  setText(elements.selectedStatus, claim.status);
  setText(elements.claim, claim.claimNumber);
  setText(elements.date, formatDate(claim.submittedAt));
  setText(elements.customer, claim.customer);
  setText(elements.assignedAgent, claim.assignedAgent?.name || "Unassigned");
  setText(elements.vehicle, claim.vehicle);
  setText(elements.mileage, claim.mileage ? `${Number(claim.mileage).toLocaleString()} mi` : "—");
  setText(elements.estimate, formatCurrency(claim.estimate));
  setText(elements.action, claim.action);
  setText(elements.statement, claim.statement);
  setText(elements.evidence, claim.evidence);
  setText(elements.reasoning, claim.reasoning);
  if (elements.requestEvidenceItems) {
    elements.requestEvidenceItems.value = claim.requestedEvidence.join(", ");
  }
  if (elements.requestEvidenceDue) {
    elements.requestEvidenceDue.value = claim.evidenceDueAt
      ? claim.evidenceDueAt.slice(0, 10)
      : "";
  }
  setText(elements.aiComparison, claim.action);
  setText(elements.adjusterComparison, claim.status === "Final review" || claim.status === "Finalized"
    ? "Adjuster judgement is ready for final review."
    : "Pending adjustment.");
  elements.appealPanel?.classList.toggle("hidden", !claim.appeal);
  if (claim.appeal) {
    setText(elements.appealCategory, claim.appeal.category || "General dispute");
    setText(elements.appealAmount, claim.appeal.disputed_amount
      ? formatCurrency(claim.appeal.disputed_amount)
      : "Not specified");
    setText(elements.appealFiles, `${(claim.appeal.supporting_documents || []).length} attached`);
    setText(elements.appealExplanation, claim.appeal.explanation || "No explanation supplied.");
  }
  const notes = readInternalNotes();
  if (elements.internalNotes) elements.internalNotes.value = notes[claim.id] || "";
  loadFirebaseInternalNote(claim.id).then((note) => {
    if (note === null || selectedClaim?.id !== claim.id || !elements.internalNotes) return;
    elements.internalNotes.value = note;
  });
  if (elements.finalChecklist) elements.finalChecklist.checked = false;
  if (elements.actionStatus) elements.actionStatus.textContent = "Select an action after reviewing the case.";
  renderAuditLog(claim.id);
  renderPhotos(claim.photos);
  if (elements.adjustmentLink) {
    elements.adjustmentLink.href = `./adjustment.html?claim=${encodeURIComponent(claim.id)}`;
  }
};

const renderAuditLog = (claimId) => {
  if (!elements.auditLog) return;
  const events = readAuditLog()[claimId] || [];
  if (!events.length) {
    elements.auditLog.innerHTML = "<article>No audit events yet.</article>";
    return;
  }
  elements.auditLog.innerHTML = events.map((event) => `
    <article>
      <strong>${escapeHtml(event.label)}</strong>
      <p>${escapeHtml(event.actor || "Employee")} · ${formatDate(event.at)}</p>
    </article>
  `).join("");
};

const loadFirebaseCases = async () => {
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  const db = window.firebase.firestore(app);
  const employeeEmail = getCurrentEmployeeEmail();
  const snapshot = await db.collection("cases")
    .where("assigned_agent.email", "==", employeeEmail)
    .orderBy("updated_at", "desc")
    .limit(25)
    .get();
  return snapshot.docs.map((doc) => normalizeCase(doc.id, doc.data()));
};

const updateFirebaseClaim = async (claimId, updates) => {
  if (!firebaseEnabled || !claimId) return;
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  const db = window.firebase.firestore(app);
  await db.collection("cases").doc(claimId).set(
    {
      ...updates,
      updated_at: window.firebase.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
};

const loadFirebaseInternalNote = async (claimId) => {
  if (!firebaseEnabled || !claimId) return null;
  try {
    const app = window.firebase.apps?.length
      ? window.firebase.app()
      : window.firebase.initializeApp(firebaseConfig);
    const snapshot = await window.firebase.firestore(app).collection("case_internal").doc(claimId).get();
    return snapshot.exists ? String(snapshot.data()?.note || "") : "";
  } catch {
    return null;
  }
};

const updateFirebaseInternalNote = async (claimId, note) => {
  if (!firebaseEnabled || !claimId) return;
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  await window.firebase.firestore(app).collection("case_internal").doc(claimId).set(
    {
      note,
      updated_at: window.firebase.firestore.FieldValue.serverTimestamp(),
      updated_by: getCurrentEmployeeEmail(),
    },
    { merge: true }
  );
};

const appendFirebaseActivity = async (claimId, type, label) => {
  if (!firebaseEnabled || !claimId) return;
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  await window.firebase.firestore(app).collection("case_activity").add({
    case_id: claimId,
    type,
    label,
    actor_role: "employee",
    actor_name: getCurrentEmployeeEmail(),
    created_at: window.firebase.firestore.FieldValue.serverTimestamp(),
  });
};

const loadClaims = async () => {
  window.CLAIMSIGHT_EMPLOYEE_DASHBOARD_LOADED = true;
  elements.table.innerHTML = `
    <tr class="claim-row empty">
      <td>—</td>
      <td><strong>Loading claims</strong></td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
    </tr>
  `;

  try {
    claims = firebaseEnabled ? await loadFirebaseCases() : readLocalCases();
  } catch {
    claims = readLocalCases();
  }

  renderTable();
  const savedClaimId = readStorageValue(selectedEmployeeClaimKey);
  selectClaim(savedClaimId || claims[0]?.id);
};

elements.table?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-claim-id]");
  if (button) {
    selectClaim(button.dataset.claimId);
  }
});

elements.refresh?.addEventListener("click", loadClaims);
elements.search?.addEventListener("input", () => {
  searchTerm = elements.search.value || "";
  renderTable();
});
elements.filters.forEach((filter) => {
  filter.addEventListener("click", () => {
    activeFilter = filter.dataset.filter || "all";
    elements.filters.forEach((item) => item.classList.toggle("active", item === filter));
    renderTable();
  });
});

elements.requestEvidence?.addEventListener("click", async () => {
  if (!selectedClaim) return;
  const requestedEvidence = String(elements.requestEvidenceItems?.value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!requestedEvidence.length) {
    if (elements.actionStatus) elements.actionStatus.textContent = "List the exact evidence the customer needs to provide.";
    elements.requestEvidenceItems?.focus();
    return;
  }
  const dueValue = elements.requestEvidenceDue?.value || "";
  const evidenceDueAt = dueValue ? new Date(`${dueValue}T23:59:59`).toISOString() : "";
  appendAuditEvent(selectedClaim.id, "Requested more evidence from customer");
  await updateFirebaseClaim(selectedClaim.id, {
    status: "needs_info",
    status_label: "Needs more information",
    requested_evidence: requestedEvidence,
    evidence_due_at: evidenceDueAt,
    consumer_notifications: [
      {
        title: "More information needed",
        message: `Please upload ${requestedEvidence.join(", ")}.`,
        created_at: new Date().toISOString(),
      },
    ],
  });
  await appendFirebaseActivity(selectedClaim.id, "evidence_requested", `Requested evidence: ${requestedEvidence.join(", ")}.`);
  if (elements.actionStatus) {
    elements.actionStatus.textContent = "Evidence request sent to the customer action center.";
  }
});

elements.finalizeClaim?.addEventListener("click", async () => {
  if (!selectedClaim) return;
  if (!elements.finalChecklist?.checked) {
    if (elements.actionStatus) elements.actionStatus.textContent = "Complete the checklist before finalizing.";
    return;
  }
  appendAuditEvent(selectedClaim.id, "Marked claim ready for finalization");
  await updateFirebaseClaim(selectedClaim.id, {
    status: "final_review",
    status_label: "Final review",
  });
  await appendFirebaseActivity(selectedClaim.id, "final_review_ready", "Claim moved to final review.");
  if (elements.actionStatus) elements.actionStatus.textContent = "Finalization logged. Send the claim to final reasoning/report review next.";
});

elements.saveInternalNote?.addEventListener("click", async () => {
  if (!selectedClaim) return;
  const notes = readInternalNotes();
  notes[selectedClaim.id] = elements.internalNotes?.value || "";
  writeInternalNotes(notes);
  await updateFirebaseInternalNote(selectedClaim.id, notes[selectedClaim.id]);
  appendAuditEvent(selectedClaim.id, "Saved private internal note");
  if (elements.actionStatus) elements.actionStatus.textContent = "Internal note saved privately.";
});

loadClaims();
})();
