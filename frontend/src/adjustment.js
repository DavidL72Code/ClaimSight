(() => {
const firebaseConfig = window.FIREBASE_CONFIG || {};
const firebaseEnabled = Boolean(
  window.firebase
  && firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.appId
);

const params = new URLSearchParams(window.location.search);
const claimId = params.get("claim") || "CLM-1048";

const elements = {
  claimReference: document.getElementById("adjustment-claim-reference"),
  reviewerName: document.getElementById("adjustment-reviewer-name"),
  finalAction: document.getElementById("adjustment-final-action"),
  notes: document.getElementById("adjustment-notes"),
  aiEstimate: document.getElementById("adjustment-ai-estimate"),
  reviewedEstimateInput: document.getElementById("adjustment-reviewed-estimate-input"),
  reviewedEstimate: document.getElementById("adjustment-reviewed-estimate"),
  summaryAction: document.getElementById("adjustment-summary-action"),
  caseSummary: document.getElementById("adjustment-case-summary"),
  selectedStatus: document.getElementById("adjustment-selected-status"),
  customer: document.getElementById("adjustment-customer"),
  vehicle: document.getElementById("adjustment-vehicle"),
  mileage: document.getElementById("adjustment-mileage"),
  date: document.getElementById("adjustment-date"),
  statement: document.getElementById("adjustment-statement"),
  evidence: document.getElementById("adjustment-evidence"),
  reasoning: document.getElementById("adjustment-reasoning"),
  photoGallery: document.getElementById("adjustment-photo-gallery"),
  aiFeedback: document.getElementById("adjustment-ai-feedback"),
  runSecondPass: document.getElementById("run-second-pass"),
  secondPassResult: document.getElementById("second-pass-result"),
  secondPassText: document.getElementById("second-pass-text"),
  finalJudgementStatus: document.getElementById("final-judgement-status"),
  finalApprovedAmount: document.getElementById("final-approved-amount"),
  finalJudgementNote: document.getElementById("final-judgement-note"),
  reviewerEvidenceInput: document.getElementById("adjustment-reviewer-evidence"),
  saveReviewerEvidence: document.getElementById("adjustment-save-reviewer-evidence"),
  reviewerEvidenceList: document.getElementById("adjustment-reviewer-evidence-list"),
  lineItemsBody: document.getElementById("estimate-line-items"),
  addEstimateLine: document.getElementById("add-estimate-line"),
  lineItemTotal: document.getElementById("estimate-line-total"),
  estimateHistory: document.getElementById("adjustment-estimate-history"),
  submitAdjustment: document.getElementById("submit-adjustment"),
  submitStatus: document.getElementById("adjustment-submit-status"),
};

let activeClaim = null;
let activeReviewerEvidence = [];
let activeLineItems = [];
let activeEstimateVersions = [];

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const setValue = (node, value) => {
  if (node) {
    node.value = value || "";
  }
};

const setText = (node, value) => {
  if (node) {
    node.textContent = value || "—";
  }
};

const formatCurrency = (value) => {
  const amount = Number(value) || 0;
  return amount > 0 ? `$${amount.toLocaleString()}` : "Pending";
};

const formatDate = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
};

const toIso = (value) => {
  if (!value) {
    return "";
  }
  return typeof value.toDate === "function" ? value.toDate().toISOString() : String(value);
};

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
  const photos = normalizePhotos(payload);
  const documents = payload.supporting_documents || payload.documents || [];
  const photoCount = payload.photo_count || payload.image_count || photos.length || 0;
  const vehicle = payload.vehicle_type || [context.year || payload.year, context.make || payload.make, context.model || payload.model].filter(Boolean).join(" ");
  const aiAction = review.ai_recommended_action || payload.recommended_action || payload.final_action || "Use AI recommendation";

  return {
    id,
    claimReference: review.claim_reference || payload.claim_reference || payload.claim_number || id,
    customer: payload.customer_name || payload.customer_email || payload.email || "Customer unavailable",
    vehicle: vehicle || "Vehicle info unavailable",
    mileage: context.mileage || payload.mileage || "",
    submittedAt: toIso(payload.created_at || payload.submitted_at || payload.updated_at),
    status: payload.status_label || payload.status || "Submitted",
    estimate: review.reviewed_total_cost_usd || payload.reviewed_total_cost_usd || payload.estimated_total_cost_usd || 0,
    finalAction: aiAction,
    statement: payload.incident_description || payload.customer_statement || payload.summary || "No customer statement submitted yet.",
    evidence: [
      photoCount ? `${photoCount} photo${photoCount === 1 ? "" : "s"} submitted` : "Photos pending",
      documents.length ? `${documents.length} supporting document${documents.length === 1 ? "" : "s"}` : "No supporting documents listed",
    ].join(" · "),
    reasoning: payload.total_loss_reason || payload.ai_reasoning || payload.reasoning || "AI reasoning will appear after the claim is assessed.",
    photos,
    reviewerEvidence: payload.reviewer_evidence || payload.internal_reviewer_evidence || [],
    lineItems: review.estimate_line_items || payload.estimate_line_items || (payload.regions || []).map((region) => ({
      category: "Repair",
      description: `${region.panel || "Vehicle part"} · ${region.damage_type || "Damage"}`,
      quantity: 1,
      unit_cost_usd: Number(region.estimated_repair_cost_usd) || 0,
    })),
    estimateVersions: payload.estimate_versions || [],
    aiEstimate: payload.estimated_total_cost_usd || 0,
    raw: payload,
  };
};

const demoCases = {
  "CLM-1048": normalizeCase("CLM-1048", {
    claim_reference: "CLM-1048",
    status: "Submitted",
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
  "CLM-1047": normalizeCase("CLM-1047", {
    claim_reference: "CLM-1047",
    status: "In review",
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

const renderReviewerEvidence = (evidence = []) => {
  if (!elements.reviewerEvidenceList) {
    return;
  }
  elements.reviewerEvidenceList.innerHTML = "";
  if (!evidence.length) {
    elements.reviewerEvidenceList.textContent = "No reviewer evidence added.";
    return;
  }
  evidence.forEach((item) => {
    const node = document.createElement(item.download_url ? "a" : "span");
    node.textContent = item.name || "Reviewer evidence";
    if (item.download_url) {
      node.href = item.download_url;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
    }
    elements.reviewerEvidenceList.appendChild(node);
  });
};

const buildLocalReviewerEvidence = () => {
  const uploadedAt = new Date().toISOString();
  return Array.from(elements.reviewerEvidenceInput?.files || []).map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    uploaded_at: uploadedAt,
    source: "employee_adjustment",
  }));
};

const uploadReviewerEvidence = async () => {
  const files = Array.from(elements.reviewerEvidenceInput?.files || []);
  if (!files.length || !activeClaim) {
    return [];
  }
  const uploadedAt = new Date().toISOString();
  if (!firebaseEnabled || typeof window.firebase.storage !== "function") {
    return buildLocalReviewerEvidence();
  }

  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  const storage = window.firebase.storage(app);
  return Promise.all(files.map(async (file) => {
    const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "-");
    const ref = storage.ref().child(`claim-reviewer-evidence/${activeClaim.id}/${Date.now()}-${safeName}`);
    await ref.put(file);
    const download_url = await ref.getDownloadURL();
    return {
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      uploaded_at: uploadedAt,
      source: "employee_adjustment",
      download_url,
    };
  }));
};

const buildSecondPassText = () => {
  const reviewedEstimate = Number(elements.reviewedEstimateInput?.value) || 0;
  const aiEstimateText = elements.aiEstimate?.textContent || "Pending";
  const reviewerFeedback = elements.aiFeedback?.value?.trim() || "No specific reviewer challenge entered.";
  const vehicle = elements.vehicle?.value || "the submitted vehicle";
  const finalAction = elements.finalAction?.value || "Use AI recommendation";

  return [
    `Second pass reviewed ${vehicle} using the adjuster's challenge: ${reviewerFeedback}`,
    `Original AI estimate was ${aiEstimateText}; reviewed estimate is ${formatCurrency(reviewedEstimate)}.`,
    `Recommended next step: ${finalAction}. Re-check visible damage, customer statement, photo evidence, and any hidden-damage risk before final judgement.`,
  ].join(" ");
};

const normalizeLineItem = (item = {}) => ({
  category: String(item.category || "Repair"),
  description: String(item.description || "Repair item"),
  quantity: Math.max(0, Number(item.quantity) || 1),
  unit_cost_usd: Math.max(0, Number(item.unit_cost_usd) || 0),
});

const lineItemTotal = (item) =>
  Math.round((Number(item.quantity) || 0) * (Number(item.unit_cost_usd) || 0));

const estimateTotal = () =>
  activeLineItems.reduce((sum, item) => sum + lineItemTotal(item), 0);

const syncEstimateTotals = () => {
  const total = estimateTotal();
  setText(elements.lineItemTotal, formatCurrency(total));
  setValue(elements.reviewedEstimateInput, total);
  setText(elements.reviewedEstimate, formatCurrency(total));
  setValue(elements.finalApprovedAmount, total);
};

const renderEstimateHistory = () => {
  if (!elements.estimateHistory) return;
  if (!activeEstimateVersions.length) {
    elements.estimateHistory.innerHTML = "<article>No saved estimate versions yet.</article>";
    return;
  }
  elements.estimateHistory.innerHTML = [...activeEstimateVersions].reverse().map((version) => `
    <article>
      <strong>Version ${Number(version.version) || 1} · ${escapeHtml(formatCurrency(version.reviewed_total_cost_usd))}</strong>
      <p>${escapeHtml(version.actor || "Adjuster")} · ${escapeHtml(formatDate(version.created_at))} · ${escapeHtml(version.reason || "Estimate updated")}</p>
    </article>
  `).join("");
};

const renderLineItems = () => {
  if (!elements.lineItemsBody) return;
  elements.lineItemsBody.innerHTML = activeLineItems.map((item, index) => `
    <tr data-line-index="${index}">
      <td><input data-field="category" value="${escapeHtml(item.category)}" aria-label="Estimate category" /></td>
      <td><input data-field="description" value="${escapeHtml(item.description)}" aria-label="Estimate description" /></td>
      <td><input data-field="quantity" type="number" min="0" step="1" value="${item.quantity}" aria-label="Quantity" /></td>
      <td><input data-field="unit_cost_usd" type="number" min="0" step="1" value="${item.unit_cost_usd}" aria-label="Unit cost" /></td>
      <td><strong data-line-total>${formatCurrency(lineItemTotal(item))}</strong></td>
      <td><button class="estimate-remove-line" type="button" data-remove-line="${index}" aria-label="Remove estimate line">×</button></td>
    </tr>
  `).join("");
  syncEstimateTotals();
};

const addActivityEvent = async (db, type, label) => {
  if (!activeClaim) return;
  await db.collection("case_activity").add({
    case_id: activeClaim.id,
    type,
    label,
    actor_role: "employee",
    actor_name: elements.reviewerName?.value?.trim() || "Adjuster",
    created_at: window.firebase.firestore.FieldValue.serverTimestamp(),
  });
};

const submitAdjustment = async () => {
  if (!activeClaim) return;
  const reviewerName = elements.reviewerName?.value?.trim() || "";
  const finalNote = elements.finalJudgementNote?.value?.trim() || elements.notes?.value?.trim() || "";
  if (!reviewerName || !finalNote) {
    setText(elements.submitStatus, "Add the reviewer name and final judgement note before submitting.");
    return;
  }
  const reviewedTotal = estimateTotal() || Number(elements.finalApprovedAmount?.value) || 0;
  const nextVersion = Math.max(0, ...activeEstimateVersions.map((item) => Number(item.version) || 0)) + 1;
  const version = {
    version: nextVersion,
    created_at: new Date().toISOString(),
    actor: reviewerName,
    ai_total_cost_usd: activeClaim.aiEstimate,
    reviewed_total_cost_usd: reviewedTotal,
    delta_usd: reviewedTotal - activeClaim.aiEstimate,
    reason: finalNote,
    line_items: activeLineItems.map((item) => ({ ...item, total_usd: lineItemTotal(item) })),
  };
  const review = {
    ...(activeClaim.raw?.review || {}),
    claim_reference: elements.claimReference?.value?.trim() || activeClaim.claimReference,
    reviewer_name: reviewerName,
    final_action: elements.finalAction?.value || activeClaim.finalAction,
    notes: elements.notes?.value?.trim() || finalNote,
    reviewed_total_cost_usd: reviewedTotal,
    ai_recommended_action: activeClaim.finalAction,
    second_pass_feedback: elements.aiFeedback?.value?.trim() || "",
    second_pass_result: elements.secondPassText?.textContent || "",
    final_judgement: elements.finalJudgementStatus?.value || "Approve adjusted estimate",
    final_judgement_note: finalNote,
    estimate_line_items: version.line_items,
    completed_at: new Date().toISOString(),
  };
  if (!firebaseEnabled) {
    activeEstimateVersions.push(version);
    renderEstimateHistory();
    setText(elements.submitStatus, "Preview adjustment saved. Firebase is required to persist it.");
    return;
  }
  setText(elements.submitStatus, "Saving adjustment...");
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  const db = window.firebase.firestore(app);
  await db.collection("cases").doc(activeClaim.id).set({
    review,
    vehicle_type: elements.vehicle?.value?.trim() || activeClaim.vehicle,
    claim_context: {
      ...(activeClaim.raw?.claim_context || {}),
      mileage: Number(elements.mileage?.value) || null,
    },
    customer_statement: elements.statement?.value?.trim() || activeClaim.statement,
    ai_reasoning: elements.reasoning?.value?.trim() || activeClaim.reasoning,
    reviewer_evidence: activeReviewerEvidence,
    estimate_line_items: version.line_items,
    estimate_versions: [...activeEstimateVersions, version].slice(-20),
    reviewed_total_cost_usd: reviewedTotal,
    final_action: review.final_action,
    status: "final_review",
    status_label: "Final review",
    report_ready: false,
    updated_at: window.firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await addActivityEvent(db, "adjustment_submitted", `Adjustment version ${nextVersion} submitted for final review.`);
  setText(elements.submitStatus, "Adjustment saved and sent to final review.");
  window.setTimeout(() => {
    window.location.href = `./further-reasoning.html?claim=${encodeURIComponent(activeClaim.id)}`;
  }, 500);
};

const applyCase = (claim) => {
  activeClaim = claim;
  activeReviewerEvidence = [...(claim.reviewerEvidence || [])];
  activeLineItems = (claim.lineItems || []).map(normalizeLineItem);
  if (!activeLineItems.length) {
    activeLineItems = [normalizeLineItem({
      category: "Repair",
      description: "Base AI repair estimate",
      quantity: 1,
      unit_cost_usd: claim.estimate,
    })];
  }
  activeEstimateVersions = [...(claim.estimateVersions || [])];
  setValue(elements.claimReference, claim.claimReference);
  setValue(elements.reviewerName, "Alex Morgan");
  setValue(elements.notes, claim.reasoning);
  setValue(elements.reviewedEstimateInput, claim.estimate);
  setValue(elements.finalApprovedAmount, claim.estimate);
  if (elements.finalAction) {
    const matchedOption = Array.from(elements.finalAction.options).find((option) => claim.finalAction.toLowerCase().includes(option.textContent.toLowerCase()));
    elements.finalAction.value = matchedOption?.value || "Use AI recommendation";
  }

  setText(elements.aiEstimate, formatCurrency(claim.estimate));
  setText(elements.reviewedEstimate, formatCurrency(claim.estimate));
  setText(elements.summaryAction, elements.finalAction?.value || claim.finalAction);
  setText(elements.caseSummary, `${claim.claimReference} · ${claim.vehicle} · ${claim.customer}`);
  setText(elements.selectedStatus, claim.status);
  setValue(elements.customer, claim.customer);
  setValue(elements.vehicle, claim.vehicle);
  setValue(elements.mileage, claim.mileage);
  setText(elements.date, formatDate(claim.submittedAt));
  setValue(elements.statement, claim.statement);
  setText(elements.evidence, claim.evidence);
  setValue(elements.reasoning, claim.reasoning);
  setValue(elements.aiFeedback, "");
  setValue(elements.finalJudgementNote, "");
  elements.secondPassResult?.classList.add("hidden");
  renderPhotos(claim.photos);
  renderReviewerEvidence(activeReviewerEvidence);
  renderLineItems();
  renderEstimateHistory();

  document.querySelectorAll('a[href^="./further-reasoning.html"]').forEach((link) => {
    link.href = `./further-reasoning.html?claim=${encodeURIComponent(claim.id)}`;
  });
};

const fetchFirebaseCase = async () => {
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  const db = window.firebase.firestore(app);
  const doc = await db.collection("cases").doc(claimId).get();
  return doc.exists ? normalizeCase(doc.id, doc.data()) : null;
};

const loadCase = async () => {
  let claim = null;
  if (firebaseEnabled) {
    try {
      claim = await fetchFirebaseCase();
    } catch {
      claim = null;
    }
  }
  applyCase(claim || demoCases[claimId] || demoCases["CLM-1048"]);
};

elements.finalAction?.addEventListener("change", () => {
  setText(elements.summaryAction, elements.finalAction.value);
});

elements.reviewedEstimateInput?.addEventListener("input", () => {
  setText(elements.reviewedEstimate, formatCurrency(elements.reviewedEstimateInput.value));
  setValue(elements.finalApprovedAmount, elements.reviewedEstimateInput.value);
});

elements.lineItemsBody?.addEventListener("input", (event) => {
  const row = event.target.closest("[data-line-index]");
  const field = event.target.dataset.field;
  const index = Number(row?.dataset.lineIndex);
  if (!row || !field || !activeLineItems[index]) return;
  activeLineItems[index][field] = ["quantity", "unit_cost_usd"].includes(field)
    ? Math.max(0, Number(event.target.value) || 0)
    : event.target.value;
  row.querySelector("[data-line-total]").textContent = formatCurrency(lineItemTotal(activeLineItems[index]));
  syncEstimateTotals();
});

elements.lineItemsBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-line]");
  if (!button) return;
  activeLineItems.splice(Number(button.dataset.removeLine), 1);
  renderLineItems();
});

elements.addEstimateLine?.addEventListener("click", () => {
  activeLineItems.push(normalizeLineItem({ category: "Repair", description: "New estimate item", quantity: 1 }));
  renderLineItems();
});

elements.submitAdjustment?.addEventListener("click", () => {
  submitAdjustment().catch((error) => setText(elements.submitStatus, error?.message || "Unable to save adjustment."));
});

[elements.claimReference, elements.customer, elements.vehicle].forEach((input) => {
  input?.addEventListener("input", () => {
    setText(
      elements.caseSummary,
      `${elements.claimReference?.value || claimId} · ${elements.vehicle?.value || "Vehicle info unavailable"} · ${elements.customer?.value || "Customer unavailable"}`
    );
  });
});

elements.runSecondPass?.addEventListener("click", () => {
  const secondPass = buildSecondPassText();
  setText(elements.secondPassText, secondPass);
  elements.secondPassResult?.classList.remove("hidden");
  if (!elements.finalJudgementNote?.value) {
    setValue(elements.finalJudgementNote, secondPass);
  }
});

elements.saveReviewerEvidence?.addEventListener("click", async () => {
  const uploaded = await uploadReviewerEvidence();
  if (!uploaded.length || !activeClaim) {
    return;
  }
  activeReviewerEvidence = [...activeReviewerEvidence, ...uploaded];
  renderReviewerEvidence(activeReviewerEvidence);
  if (elements.reviewerEvidenceInput) {
    elements.reviewerEvidenceInput.value = "";
  }

  if (firebaseEnabled) {
    try {
      const app = window.firebase.apps?.length
        ? window.firebase.app()
        : window.firebase.initializeApp(firebaseConfig);
      const db = window.firebase.firestore(app);
      await db.collection("cases").doc(activeClaim.id).set(
        {
          reviewer_evidence: activeReviewerEvidence,
          updated_at: window.firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {
      // Keep local preview evidence visible even if Firebase is not reachable.
    }
  }
});

loadCase();
})();
