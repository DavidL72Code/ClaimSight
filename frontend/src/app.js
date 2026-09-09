const apiBaseUrl = (window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
const firebaseConfig = window.FIREBASE_CONFIG || {};
const portalMode = document.body.dataset.portal || "employee";
const consumerMode = portalMode === "consumer";
const maxClientUploadBytes = 8 * 1024 * 1024;
const maxImages = 8;
const allowedClientMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const firebaseEnabled = Boolean(
  window.firebase
  && firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.appId
);
const firebaseApp = firebaseEnabled
  ? (window.firebase.apps?.length ? window.firebase.app() : window.firebase.initializeApp(firebaseConfig))
  : null;
const firestore = firebaseApp ? window.firebase.firestore(firebaseApp) : null;
const firebaseAuth = firebaseApp && typeof window.firebase.auth === "function"
  ? window.firebase.auth(firebaseApp)
  : null;
const casesCollection = firestore ? firestore.collection("cases") : null;
const firebaseStorage = firebaseApp && typeof window.firebase.storage === "function"
  ? window.firebase.storage(firebaseApp)
  : null;
const consumerClaimIdsStorageKey = "claimsight.consumer-claim-ids";
const consumerCurrentClaimStorageKey = "claimsight.consumer-current-claim";
const consumerDraftStorageKey = "claimsight.consumer-draft";
const customerMessageStorageKey = "claimsight.customer-message-threads";
const claimAdjusterPool = [
  { id: "adj-alex-morgan", name: "Alex Morgan", email: "alex.morgan@claimsight.com" },
  { id: "adj-jordan-lee", name: "Jordan Lee", email: "jordan.lee@claimsight.com" },
  { id: "adj-sam-rivera", name: "Sam Rivera", email: "sam.rivera@claimsight.com" },
  { id: "adj-taylor-kim", name: "Taylor Kim", email: "taylor.kim@claimsight.com" },
];

const elements = {
  backendUrlLabel: document.getElementById("backend-url-label"),
  workflowMenuToggle: document.getElementById("workflow-menu-toggle"),
  workflowMenuPanel: document.getElementById("workflow-menu-panel"),
  form: document.getElementById("upload-form"),
  fileInput: document.getElementById("claim-image"),
  dropzone: document.getElementById("dropzone"),
  vehicleMakeInput: document.getElementById("vehicle-make-input"),
  vehicleModelInput: document.getElementById("vehicle-model-input"),
  vehicleTrimInput: document.getElementById("vehicle-trim-input"),
  vehicleYearInput: document.getElementById("vehicle-year-input"),
  vehicleMileageInput: document.getElementById("vehicle-mileage-input"),
  preExistingDamageInput: document.getElementById("pre-existing-damage-input"),
  incidentDateInput: document.getElementById("incident-date-input"),
  incidentDescriptionInput: document.getElementById("incident-description-input"),
  supportingDocumentsInput: document.getElementById("supporting-documents"),
  saveDraft: document.getElementById("save-draft"),
  emptyPreview: document.getElementById("empty-preview"),
  previewImage: document.getElementById("preview-image"),
  damageOverlay: document.getElementById("damage-overlay"),
  thumbStrip: document.getElementById("thumb-strip"),
  uploadQueue: document.getElementById("upload-queue"),
  queueList: document.getElementById("queue-list"),
  queueCount: document.getElementById("queue-count"),
  clearQueue: document.getElementById("clear-queue"),
  queuePrev: document.getElementById("queue-prev"),
  queueNext: document.getElementById("queue-next"),
  imageState: document.getElementById("image-state"),
  status: document.getElementById("status"),
  filename: document.getElementById("filename"),
  vehicleType: document.getElementById("vehicle-type"),
  vehicleValue: document.getElementById("vehicle-value"),
  reportedMileage: document.getElementById("reported-mileage"),
  priorDamage: document.getElementById("prior-damage"),
  severity: document.getElementById("overall-severity"),
  repairability: document.getElementById("repairability"),
  estimatedCost: document.getElementById("estimated-cost"),
  recommendedAction: document.getElementById("recommended-action"),
  pricingFactors: document.getElementById("pricing-factors"),
  valuationMethodology: document.getElementById("valuation-methodology"),
  valuationComparables: document.getElementById("valuation-comparables"),
  assessmentFlags: document.getElementById("assessment-flags"),
  completenessChecks: document.getElementById("completeness-checks"),
  segmentationProvider: document.getElementById("segmentation-provider"),
  reportProvider: document.getElementById("report-provider"),
  fallbackNote: document.getElementById("fallback-note"),
  summaryText: document.getElementById("summary-text"),
  evidence: document.getElementById("evidence"),
  reasonBlock: document.getElementById("reason-block"),
  totalLossReason: document.getElementById("total-loss-reason"),
  sourcesBlock: document.getElementById("sources-block"),
  sourcesList: document.getElementById("sources-list"),
  searchQueries: document.getElementById("search-queries"),
  groundingStatus: document.getElementById("grounding-status"),
  regions: document.getElementById("regions-list"),
  regionCount: document.getElementById("region-count"),
  downloadReport: document.getElementById("download-report"),
  downloadHtmlReport: document.getElementById("download-html-report"),
  saveCase: document.getElementById("save-case"),
  reviewState: document.getElementById("review-state"),
  claimReference: document.getElementById("claim-reference"),
  reviewerName: document.getElementById("reviewer-name"),
  reviewFinalAction: document.getElementById("review-final-action"),
  reviewNotes: document.getElementById("review-notes"),
  reviewAiTotal: document.getElementById("review-ai-total"),
  reviewAdjustedTotal: document.getElementById("review-adjusted-total"),
  reviewFinalActionDisplay: document.getElementById("review-final-action-display"),
  reviewGuidance: document.getElementById("review-guidance"),
  reviewRegions: document.getElementById("review-regions"),
  opsState: document.getElementById("ops-state"),
  refreshCases: document.getElementById("refresh-cases"),
  refreshQueue: document.getElementById("refresh-queue"),
  casesList: document.getElementById("cases-list"),
  queueListPanel: document.getElementById("queue-list-panel"),
};

if (elements.backendUrlLabel) {
  elements.backendUrlLabel.textContent = apiBaseUrl ? "Backend connected" : "Backend URL missing";
}

let latestAssessment = null;
let reviewState = null;
let savedCases = [];
let queueCases = [];
// Ordered list of { file, dataUrl, evidenceTag }. The array index is the
// backend uses for each detected region.
let selectedImages = [];
let activeImageIndex = 0;

const setStatus = (message) => {
  elements.status.textContent = message;
};

const firestoreTimestampToIso = (value) => {
  if (!value) {
    return "";
  }
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return String(value);
};

const setWorkflowMenuOpen = (open) => {
  if (!elements.workflowMenuToggle || !elements.workflowMenuPanel) {
    return;
  }
  elements.workflowMenuToggle.setAttribute("aria-expanded", String(open));
  elements.workflowMenuPanel.classList.toggle("hidden", !open);
};

const maxVehicleYear = new Date().getFullYear() + 1;
const emptyDamageValues = new Set(["", "n/a", "na", "none", "no", "none reported", "no prior damage"]);
if (elements.vehicleYearInput) {
  elements.vehicleYearInput.max = String(maxVehicleYear);
}

const parseOptionalInteger = (value) => {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatCurrency = (value) => {
  const amount = Number(value) || 0;
  return `$${amount.toLocaleString()}`;
};

const pickRandomAdjuster = () =>
  claimAdjusterPool[Math.floor(Math.random() * claimAdjusterPool.length)] || claimAdjusterPool[0];

const readConsumerClaimIds = () => {
  try {
    const raw = window.localStorage.getItem(consumerClaimIdsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
};

const writeConsumerClaimIds = (ids) => {
  window.localStorage.setItem(consumerClaimIdsStorageKey, JSON.stringify(Array.from(new Set(ids))));
};

const rememberConsumerClaim = (claimId) => {
  if (!claimId) {
    return;
  }
  writeConsumerClaimIds([claimId, ...readConsumerClaimIds()]);
  window.localStorage.setItem(consumerCurrentClaimStorageKey, claimId);
};

const createCustomerMessageThread = (claimReference, assignedAgent) => {
  try {
    const raw = window.localStorage.getItem(customerMessageStorageKey);
    const threads = raw ? JSON.parse(raw) : {};
    threads[claimReference] = {
      title: claimReference,
      subtitle: assignedAgent?.name ? `Assigned to ${assignedAgent.name}` : "Claim conversation",
      latest: assignedAgent?.name
        ? `${assignedAgent.name} was assigned to your claim.`
        : "Your claim was submitted and is ready for messages.",
      messages: [
        {
          from: "employee",
          text: assignedAgent?.name
            ? `Your claim has been assigned to ${assignedAgent.name}. You can message here if you need to add context or ask about evidence.`
            : "Your claim was submitted. You can message here if you need to add context or ask about evidence.",
          time: new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date()),
        },
      ],
    };
    window.localStorage.setItem(customerMessageStorageKey, JSON.stringify(threads));
  } catch {
    // Message thread creation is best-effort in preview mode.
  }
};

const getDraftPayload = () => ({
  draft_id: (() => {
    try {
      const existing = JSON.parse(window.localStorage.getItem(consumerDraftStorageKey) || "{}");
      return existing.draft_id || `DRF-${Date.now().toString().slice(-8)}`;
    } catch {
      return `DRF-${Date.now().toString().slice(-8)}`;
    }
  })(),
  saved_at: new Date().toISOString(),
  make: elements.vehicleMakeInput?.value?.trim?.() || "",
  model: elements.vehicleModelInput?.value?.trim?.() || "",
  trim: elements.vehicleTrimInput?.value?.trim?.() || "",
  year: elements.vehicleYearInput?.value || "",
  mileage: elements.vehicleMileageInput?.value || "",
  pre_existing_damage: elements.preExistingDamageInput?.value?.trim?.() || "",
  incident_date: elements.incidentDateInput?.value || "",
  incident_description: elements.incidentDescriptionInput?.value?.trim?.() || "",
  supporting_documents: Array.from(elements.supportingDocumentsInput?.files || []).map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
  })),
});

const saveConsumerDraft = () => {
  window.localStorage.setItem(consumerDraftStorageKey, JSON.stringify(getDraftPayload()));
  setStatus("Draft saved. You can continue later from this browser.");
};

const restoreConsumerDraft = () => {
  if (!consumerMode || !elements.form) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(consumerDraftStorageKey);
    if (!raw) {
      return;
    }
    const draft = JSON.parse(raw);
    if (elements.vehicleMakeInput) elements.vehicleMakeInput.value = draft.make || "";
    if (elements.vehicleModelInput) elements.vehicleModelInput.value = draft.model || "";
    if (elements.vehicleTrimInput) elements.vehicleTrimInput.value = draft.trim || "";
    if (elements.vehicleYearInput) elements.vehicleYearInput.value = draft.year || "";
    if (elements.vehicleMileageInput) elements.vehicleMileageInput.value = draft.mileage || "";
    if (elements.preExistingDamageInput) elements.preExistingDamageInput.value = draft.pre_existing_damage || "";
    if (elements.incidentDateInput) elements.incidentDateInput.value = draft.incident_date || "";
    if (elements.incidentDescriptionInput) elements.incidentDescriptionInput.value = draft.incident_description || "";
    setStatus(draft.saved_at ? `Draft restored from ${new Date(draft.saved_at).toLocaleDateString()}.` : "Draft restored.");
  } catch {
    window.localStorage.removeItem(consumerDraftStorageKey);
  }
};

/* Demo deployments have no staff on shift, so nothing would ever move a claim
   past "submitted". Enrol the claim with the demo reviewer, which assigns it so
   it appears in the employee queue -- the review itself is then advanced one
   step at a time from the employee portal, which is the point of the demo.

   Deliberately does NOT run the review: a viewer needs to be watching the
   employee tab when each step lands.

   Self-gating: the endpoint is registered only when DEMO_MODE is on, so a
   production backend answers 404 and this quietly does nothing. Failure is
   never surfaced to the customer -- the claim is already safely submitted, and
   a broken demo extra must not read as a broken submission. */
const requestDemoReview = async (claimReference) => {
  if (!apiBaseUrl || !claimReference) return;

  try {
    const authUser = window.firebase?.auth?.()?.currentUser;
    if (!authUser?.getIdToken) return;

    const response = await fetch(`${apiBaseUrl}/api/demo/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await authUser.getIdToken()}`,
      },
      body: JSON.stringify({ case_id: claimReference }),
    });

    if (response.status === 404) return; // not a demo deployment
    if (!response.ok) {
      console.debug("Demo enrol unavailable:", response.status);
      return;
    }

    const result = await response.json();
    if (result.next_step_title) {
      setStatus(
        `Claim ${claimReference} submitted. An adjuster will pick it up shortly.`,
      );
    }
  } catch (error) {
    console.debug("Demo enrol request failed:", error);
  }
};

const deriveConsumerStatus = (payload = {}) => {
  const review = payload.review || {};
  const reviewerName = String(review.reviewer_name || "").trim();
  const finalAction = String(review.final_action || payload.final_action || "").toLowerCase();
  const statusCode = String(payload.status || "").toLowerCase();
  const statusLabel = payload.status_label || "";

  if (["finalized", "accepted", "closed"].includes(statusCode)) {
    return { code: "finalized", label: statusLabel || "Finalized", reportReady: true };
  }
  if (statusCode === "appealed") {
    return { code: "appealed", label: statusLabel || "Appealed", reportReady: false };
  }

  if (finalAction.includes("more evidence")) {
    return { code: "needs_info", label: "Needs more information", reportReady: false };
  }
  if (finalAction) {
    return { code: "final_review", label: "Final review", reportReady: false };
  }
  if (reviewerName) {
    return { code: "in_review", label: "In review", reportReady: false };
  }
  return { code: "submitted", label: "Submitted", reportReady: false };
};

const buildConsumerNotifications = (payload, statusMeta, claimReference) => {
  const review = payload.review || {};
  const notifications = [
    {
      key: `${claimReference}-submitted`,
      title: "Claim submitted",
      message: `${claimReference} is in the review queue.`,
    },
  ];

  if (review.reviewer_name) {
    notifications.push({
      key: `${claimReference}-reviewed`,
      title: "Human reviewed",
      message: `${review.reviewer_name} reviewed your claim.`,
    });
  }

  if (statusMeta.code === "needs_info") {
    notifications.push({
      key: `${claimReference}-needs-info`,
      title: "More information needed",
      message: review.notes || "A reviewer requested more information before the claim can be finalized.",
    });
  } else if (statusMeta.code === "final_review") {
    notifications.push({
      key: `${claimReference}-final-review`,
      title: "Status: Final review",
      message: review.final_action || "Your claim is ready for final report review.",
    });
  }

  return notifications;
};

const collectSupportingDocuments = async (claimReference) => {
  const files = Array.from(elements.supportingDocumentsInput?.files || []);
  if (!files.length) {
    return [];
  }

  const uploadedAt = new Date().toISOString();
  if (!firebaseStorage) {
    return files.map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      uploaded_at: uploadedAt,
    }));
  }

  // Supporting documents go through POST /api/attachments instead of
  // Firebase Storage, which cannot provision a bucket on the free plan.
  const uploads = files.map(async (file) => {
    const stored = await window.uploadClaimAttachment(
      claimReference,
      file,
      "supporting-documents",
    );
    return {
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      uploaded_at: uploadedAt,
      download_url: stored.download_url,
    };
  });
  return Promise.all(uploads);
};

const saveConsumerClaim = async (assessment) => {
  if (!casesCollection) {
    return null;
  }

  const currentUser = firebaseAuth?.currentUser || null;
  if (firebaseAuth && !currentUser) {
    throw new Error("Sign in before submitting a claim.");
  }

  const claimReference = `CLM-${Date.now().toString().slice(-8)}`;
  const docId = claimReference;
  const now = window.firebase.firestore.FieldValue.serverTimestamp();
  const claimContext = mergeVehicleContext(assessment.claim_context || {});
  const statusMeta = deriveConsumerStatus(assessment);
  const queue = computeQueueMeta(assessment);
  const assignedAgent = pickRandomAdjuster();
  const payload = {
    ...assessment,
    claim_reference: claimReference,
    claim_context: claimContext,
    review: {
      ...(assessment.review || {}),
      claim_reference: claimReference,
    },
    queue,
    status: statusMeta.code,
    status_label: statusMeta.label,
    report_ready: statusMeta.reportReady,
    consumer_notifications: buildConsumerNotifications(assessment, statusMeta, claimReference),
    supporting_documents: [],
    incident_date: elements.incidentDateInput?.value || "",
    incident_description: elements.incidentDescriptionInput?.value?.trim() || "",
    customer_statement: elements.incidentDescriptionInput?.value?.trim() || assessment.summary || "",
    assigned_agent: {
      ...assignedAgent,
      assigned_at: new Date().toISOString(),
    },
    owner_uid: currentUser?.uid || assessment.owner_uid || "",
    customer_email: currentUser?.email || assessment.customer_email || assessment.email || "",
    updated_at: now,
    created_at: now,
  };

  await casesCollection.doc(docId).set(payload, { merge: true });
  await firestore.collection("case_activity").add({
    case_id: docId,
    type: "claim_submitted",
    label: "Claim submitted with initial photos and vehicle details.",
    actor_role: "customer",
    actor_uid: currentUser.uid,
    actor_name: currentUser.displayName || "Customer",
    created_at: now,
  });
  const supportingDocuments = await collectSupportingDocuments(claimReference);
  if (supportingDocuments.length) {
    await casesCollection.doc(docId).set(
      {
        supporting_documents: supportingDocuments,
        updated_at: now,
      },
      { merge: true }
    );
  }
  rememberConsumerClaim(claimReference);
  createCustomerMessageThread(claimReference, assignedAgent);
  return claimReference;
};

const normalizeCaseSummary = (docId, payload = {}) => ({
  id: docId,
  claim_reference: payload.review?.claim_reference || payload.claim_reference || docId,
  reviewer_name: payload.review?.reviewer_name || payload.reviewer_name || "",
  vehicle_type: payload.vehicle_type || "",
  final_action: payload.review?.final_action || payload.final_action || payload.recommended_action || "",
  repairability: payload.repairability || "",
  overall_severity: payload.overall_severity || "",
  estimated_total_cost_usd: payload.estimated_total_cost_usd || 0,
  reviewed_total_cost_usd: payload.review?.reviewed_total_cost_usd || payload.reviewed_total_cost_usd || 0,
  priority_score: payload.queue?.priority_score || 0,
  queue_bucket: payload.queue?.bucket || "routine",
  updated_at: firestoreTimestampToIso(payload.updated_at),
});

const computeQueueMeta = (assessment) => {
  const flags = assessment.assessment_flags || [];
  const checks = assessment.completeness_checks || [];
  const review = assessment.review || {};
  const finalAction = String(review.final_action || assessment.recommended_action || "").toLowerCase();
  const repairability = String(assessment.repairability || "").toLowerCase();
  const severity = String(assessment.overall_severity || "").toLowerCase();
  let priorityScore = 0;

  priorityScore += flags.filter((flag) => flag.level === "high").length * 3;
  priorityScore += flags.filter((flag) => flag.level === "warning").length;
  priorityScore += checks.filter((check) => check.status === "missing").length;
  if (finalAction.includes("total loss") || repairability.includes("total loss")) priorityScore += 3;
  if (finalAction.includes("more evidence")) priorityScore += 2;
  if (severity === "high") priorityScore += 2;

  const bucket = priorityScore >= 8 ? "urgent" : priorityScore >= 4 ? "review" : "routine";
  return { priority_score: priorityScore, bucket };
};

const collectClaimContext = () => {
  const normalizedPreExistingDamage = elements.preExistingDamageInput.value.trim();
  const context = {
    make: elements.vehicleMakeInput.value.trim(),
    model: elements.vehicleModelInput.value.trim(),
    trim: elements.vehicleTrimInput.value.trim(),
    year: parseOptionalInteger(elements.vehicleYearInput.value),
    mileage: parseOptionalInteger(elements.vehicleMileageInput.value),
    pre_existing_damage: emptyDamageValues.has(normalizedPreExistingDamage.toLowerCase())
      ? ""
      : normalizedPreExistingDamage,
  };

  if (context.year !== null && (context.year < 1980 || context.year > maxVehicleYear)) {
    throw new Error(`Vehicle year must be between 1980 and ${maxVehicleYear}.`);
  }
  if (context.mileage !== null && (context.mileage < 0 || context.mileage > 500000)) {
    throw new Error("Mileage must be between 0 and 500,000.");
  }

  return context;
};

const mergeVehicleContext = (payloadClaimContext = {}) => {
  const enteredContext = collectClaimContext();
  return {
    make: payloadClaimContext.make || enteredContext.make || "",
    model: payloadClaimContext.model || enteredContext.model || "",
    trim: payloadClaimContext.trim || enteredContext.trim || "",
    year:
      payloadClaimContext.year !== null && payloadClaimContext.year !== undefined
        ? payloadClaimContext.year
        : enteredContext.year,
    mileage:
      payloadClaimContext.mileage !== null && payloadClaimContext.mileage !== undefined
        ? payloadClaimContext.mileage
        : enteredContext.mileage,
    pre_existing_damage:
      payloadClaimContext.pre_existing_damage || enteredContext.pre_existing_damage || "",
  };
};

const mergeVehicleLabel = (label, claimContext) => {
  const trimmedLabel = (label || "").trim().replace(/^\d{4}\s+/, "");
  const yearPrefix = claimContext.year ? `${claimContext.year} ` : "";

  if (trimmedLabel && claimContext.year && !trimmedLabel.startsWith(String(claimContext.year))) {
    return `${yearPrefix}${trimmedLabel}`;
  }

  if (trimmedLabel) {
    return trimmedLabel;
  }

  const fallbackParts = [claimContext.make, claimContext.model, claimContext.trim]
    .map((part) => (part || "").trim())
    .filter(Boolean);
  const fallbackLabel = fallbackParts.join(" ");
  if (claimContext.year && fallbackLabel) {
    return `${claimContext.year} ${fallbackLabel}`;
  }
  if (fallbackLabel) {
    return fallbackLabel;
  }
  if (claimContext.year) {
    return `${claimContext.year} passenger vehicle`;
  }
  return "—";
};

const isValidClientImage = (file) => {
  if (!allowedClientMimeTypes.has(file.type)) {
    setStatus("Use JPG, PNG, or WebP images.");
    return false;
  }
  if (file.size > maxClientUploadBytes) {
    setStatus("Each image must be smaller than 8 MB.");
    return false;
  }
  return true;
};

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const updateDropLabel = () => {
  const title = elements.dropzone.querySelector(".drop-title");
  const subtitle = elements.dropzone.querySelector(".drop-subtitle");
  if (selectedImages.length === 0) {
    title.textContent = "Drop claim photos here";
    subtitle.textContent = `JPG, PNG, or WebP · up to ${maxImages} images`;
    return;
  }
  title.textContent = `${selectedImages.length} image${selectedImages.length === 1 ? "" : "s"} selected`;
  subtitle.textContent =
    selectedImages.length < maxImages ? "Click to add more · ready to assess" : "Max images reached";
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ── evidence tagging ─────────────────────────────────────────────
// Which checklist row an upload counts towards used to be guessed from
// the filename (/vin|odometer|mileage/, /estimate|invoice|quote/), so a
// repair estimate saved as "scan01.pdf" satisfied nothing and the
// claimant had no way to say what they had attached. Uploads are now
// tagged explicitly and the checklist reads those tags.
const evidenceTypes = [
  { key: "photos", label: "Damage photo" },
  { key: "vin", label: "VIN / odometer photo" },
  { key: "estimate", label: "Repair estimate or invoice" },
  { key: "documents", label: "Police, tow, or storage document" },
];

// Parallel to elements.supportingDocumentsInput.files. A FileList cannot
// be annotated, and picking new files replaces it wholesale, so the tags
// are reset whenever the input changes.
let supportingDocTags = [];

const evidenceTagSelect = (value, onChange) => {
  const select = document.createElement("select");
  select.className = "evidence-link-select";
  select.setAttribute("aria-label", "What this upload shows");

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select what this shows...";
  select.appendChild(placeholder);

  evidenceTypes.forEach(({ key, label }) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    select.appendChild(option);
  });

  select.value = value || "";
  // the queue item behind this select selects the preview image
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", (event) => {
    event.stopPropagation();
    onChange(select.value);
  });
  return select;
};

// Staged supporting documents are only a filename until you can look
// at them. Each row gets a thumbnail (a real image preview where the
// browser can make one) and a View control.
//
// This page does not load consumer-case.js, so the rich preview modal
// used on Edit Claim is not available here; View opens the file in a
// new tab instead, which the browser renders natively for images and
// PDFs. Damage photos already preview in the main stage.
let supportingDocUrls = [];

const releaseSupportingDocUrls = () => {
  supportingDocUrls.forEach((url) => URL.revokeObjectURL(url));
  supportingDocUrls = [];
};

const supportingDocKind = (file) => {
  const name = file.name.toLowerCase();
  if (file.type.includes("pdf") || name.endsWith(".pdf")) return "PDF";
  if (file.type.includes("word") || /\.(docx?|rtf)$/.test(name)) return "DOC";
  return "FILE";
};

const stagedDocPreview = (file) => {
  const url = URL.createObjectURL(file);
  supportingDocUrls.push(url);
  const isImage = file.type.startsWith("image/");

  const thumb = document.createElement("a");
  thumb.className = `evidence-link-thumb${isImage ? " photo" : ""}`;
  thumb.href = url;
  thumb.target = "_blank";
  thumb.rel = "noopener noreferrer";
  thumb.setAttribute("aria-label", `Preview ${file.name}`);
  if (isImage) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    thumb.appendChild(img);
  } else {
    const chip = document.createElement("span");
    chip.textContent = supportingDocKind(file);
    thumb.appendChild(chip);
  }

  const view = document.createElement("a");
  view.className = "evidence-link-view";
  view.href = url;
  view.target = "_blank";
  view.rel = "noopener noreferrer";
  view.textContent = "View";

  return { thumb, view };
};

const renderSupportingDocLinks = () => {
  const list = document.getElementById("supporting-doc-links");
  if (!list) return;
  const files = Array.from(elements.supportingDocumentsInput?.files || []);
  releaseSupportingDocUrls();
  list.innerHTML = "";
  list.classList.toggle("hidden", files.length === 0);

  files.forEach((file, index) => {
    const row = document.createElement("div");
    row.className = "evidence-link-row";

    const { thumb, view } = stagedDocPreview(file);

    const name = document.createElement("span");
    name.className = "evidence-link-name";
    name.textContent = file.name;

    const select = evidenceTagSelect(supportingDocTags[index], (value) => {
      supportingDocTags[index] = value;
      row.classList.toggle("untagged", !value);
      // field-invalid is the post-submit red state; drop it once tagged
      if (value) row.classList.remove("field-invalid");
      updateEvidenceChecklist();
    });

    row.classList.toggle("untagged", !supportingDocTags[index]);
    row.append(thumb, name, select, view);
    list.appendChild(row);
  });
};

const getEvidenceState = () => {
  const tagged = {};
  const count = (tag) => {
    if (tag) tagged[tag] = (tagged[tag] || 0) + 1;
  };
  selectedImages.forEach((item) => count(item.evidenceTag));
  supportingDocTags.forEach((tag) => count(tag));

  return {
    photos: (tagged.photos || 0) >= 2,
    vehicle: Boolean(
      elements.vehicleMakeInput?.value?.trim()
      && elements.vehicleModelInput?.value?.trim()
      && elements.vehicleYearInput?.value
    ),
    incident: Boolean(
      elements.incidentDateInput?.value
      && (elements.incidentDescriptionInput?.value?.trim().length || 0) >= 20
    ),
    vin: Boolean(tagged.vin),
    estimate: Boolean(tagged.estimate),
    documents: Boolean(tagged.documents),
  };
};

// ── inline required-field validation ─────────────────────────────
// The checklist only reported which *group* was short ("photos,
// vehicle, incident"), leaving the claimant to work out which box was
// actually empty. These rules map each requirement to the specific
// control so submit can mark the offending fields directly.
const requiredFields = () => [
  {
    input: elements.vehicleMakeInput,
    ok: (el) => Boolean(el.value.trim()),
    message: "Enter the vehicle make.",
  },
  {
    input: elements.vehicleModelInput,
    ok: (el) => Boolean(el.value.trim()),
    message: "Enter the vehicle model.",
  },
  {
    input: elements.vehicleYearInput,
    ok: (el) => Boolean(el.value),
    message: "Enter the vehicle year.",
  },
  {
    input: elements.incidentDateInput,
    ok: (el) => Boolean(el.value),
    message: "Choose the date of the incident.",
  },
  {
    input: elements.incidentDescriptionInput,
    ok: (el) => el.value.trim().length >= 20,
    message: "Describe what happened in at least 20 characters.",
  },
];

// The field wrapper is the <label> around the control; the dropzone is
// itself a label, so it is its own wrapper.
const fieldWrapper = (input) => input.closest("label") || input.parentElement;

const clearFieldError = (input) => {
  if (!input) return;
  const wrapper = fieldWrapper(input);
  wrapper?.classList.remove("field-invalid");
  wrapper?.querySelector(".field-error")?.remove();
  input.removeAttribute("aria-invalid");
};

const markFieldError = (input, message) => {
  if (!input) return;
  const wrapper = fieldWrapper(input);
  if (!wrapper) return;
  wrapper.classList.add("field-invalid");
  input.setAttribute("aria-invalid", "true");
  let note = wrapper.querySelector(".field-error");
  if (!note) {
    note = document.createElement("span");
    note.className = "field-error";
    note.setAttribute("role", "alert");
    wrapper.appendChild(note);
  }
  note.textContent = message;
};

const clearAllFieldErrors = () => {
  requiredFields().forEach(({ input }) => clearFieldError(input));
  elements.dropzone?.classList.remove("field-invalid");
  elements.dropzone?.querySelector(".field-error")?.remove();
};

// Returns the controls that failed, first one first, so submit can
// focus it. Photos are handled separately because the "control" is the
// dropzone and the requirement is a count, not a value.
const validateRequiredFields = () => {
  const failed = [];

  if (selectedImages.length < 2) {
    const message = selectedImages.length === 0
      ? "Add at least 2 damage photos."
      : "Add at least 2 damage photos — 1 selected.";
    if (elements.dropzone) {
      elements.dropzone.classList.add("field-invalid");
      let note = elements.dropzone.querySelector(".field-error");
      if (!note) {
        note = document.createElement("span");
        note.className = "field-error";
        note.setAttribute("role", "alert");
        elements.dropzone.appendChild(note);
      }
      note.textContent = message;
      failed.push(elements.dropzone);
    }
  } else {
    elements.dropzone?.classList.remove("field-invalid");
    elements.dropzone?.querySelector(".field-error")?.remove();
  }

  requiredFields().forEach(({ input, ok, message }) => {
    if (!input) return;
    if (ok(input)) {
      clearFieldError(input);
    } else {
      markFieldError(input, message);
      failed.push(input);
    }
  });

  return failed;
};

// Clear a field's error as soon as it is corrected, so the red state
// never lingers on something the claimant has already fixed.
requiredFields().forEach(({ input, ok }) => {
  if (!input) return;
  const revalidate = () => {
    if (ok(input)) clearFieldError(input);
  };
  input.addEventListener("input", revalidate);
  input.addEventListener("change", revalidate);
});

const updateEvidenceChecklist = () => {
  const evidenceState = getEvidenceState();

  // Clear the dropzone's red state as soon as enough photos are tagged.
  // The text fields self-clear through their own input listeners, but
  // the dropzone is not an input, so without this the "Add at least 2
  // damage photos" error stayed until the next submit attempt.
  if (evidenceState.photos && elements.dropzone?.classList.contains("field-invalid")) {
    elements.dropzone.classList.remove("field-invalid");
    elements.dropzone.querySelector(".field-error")?.remove();
    if (elements.status?.classList.contains("status-error")) {
      elements.status.classList.remove("status-error");
      setStatus(`${selectedImages.length} image${selectedImages.length === 1 ? "" : "s"} ready to assess.`);
    }
  }

  document.querySelectorAll("[data-evidence-check]").forEach((item) => {
    const complete = Boolean(evidenceState[item.dataset.evidenceCheck]);
    item.classList.toggle("complete", complete);
    item.classList.toggle("needed", !complete && !item.classList.contains("optional"));
  });
  return evidenceState;
};

// The upload queue is the primary "what have I added" view, shown under the dropzone.
const renderQueue = () => {
  elements.queueList.innerHTML = "";
  updateEvidenceChecklist();
  if (selectedImages.length === 0) {
    elements.uploadQueue.classList.add("hidden");
    return;
  }
  elements.uploadQueue.classList.remove("hidden");
  elements.queueCount.textContent = `${selectedImages.length} of ${maxImages} image${
    selectedImages.length === 1 ? "" : "s"
  }`;

  selectedImages.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = `queue-item${index === activeImageIndex ? " active" : ""}`;

    const thumb = document.createElement("span");
    thumb.className = "queue-thumb";
    thumb.style.backgroundImage = `url(${item.dataUrl})`;

    const meta = document.createElement("span");
    meta.className = "queue-meta";
    const name = document.createElement("strong");
    name.textContent = `${index + 1}. ${item.file.name}`;
    const size = document.createElement("small");
    size.textContent = formatBytes(item.file.size);
    meta.append(name, size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "queue-remove";
    remove.setAttribute("aria-label", `Remove ${item.file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeImage(index);
    });

    const tag = evidenceTagSelect(item.evidenceTag, (value) => {
      item.evidenceTag = value;
      li.classList.toggle("untagged", !value);
      if (value) li.classList.remove("field-invalid");
      updateEvidenceChecklist();
    });
    li.classList.toggle("untagged", !item.evidenceTag);

    // Clicking the item previews that image.
    li.addEventListener("click", () => setActiveImage(index));
    li.append(thumb, meta, tag, remove);
    elements.queueList.appendChild(li);
  });

  // Smoothly bring the active card into view within the horizontal carousel.
  const activeCard = elements.queueList.children[activeImageIndex];
  if (activeCard) {
    activeCard.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
};

const addFiles = async (fileList) => {
  const incoming = Array.from(fileList);
  let added = 0;
  for (const file of incoming) {
    if (selectedImages.length >= maxImages) {
      setStatus(`You can upload up to ${maxImages} images per assessment.`);
      break;
    }
    if (!isValidClientImage(file)) {
      continue;
    }
    const duplicate = selectedImages.some(
      (item) => item.file.name === file.name && item.file.size === file.size
    );
    if (duplicate) {
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file);
    // dropped into the claim-photo zone, so it starts tagged as one
    selectedImages.push({ file, dataUrl, evidenceTag: "photos" });
    added += 1;
  }

  if (added === 0 && selectedImages.length === 0) {
    return;
  }

  // New images invalidate any prior assessment.
  latestAssessment = null;
  reviewState = null;
  elements.damageOverlay.innerHTML = "";
  elements.downloadReport?.classList.add("hidden");
  elements.downloadHtmlReport?.classList.add("hidden");
  elements.saveCase?.classList.add("hidden");
  if (activeImageIndex >= selectedImages.length) {
    activeImageIndex = Math.max(0, selectedImages.length - 1);
  }
  renderThumbs();
  renderQueue();
  showActiveImage();
  updateDropLabel();
  setStatus(`${selectedImages.length} image${selectedImages.length === 1 ? "" : "s"} ready.`);
};

const removeImage = (index) => {
  selectedImages.splice(index, 1);
  latestAssessment = null;
  reviewState = null;
  elements.downloadReport?.classList.add("hidden");
  elements.downloadHtmlReport?.classList.add("hidden");
  elements.saveCase?.classList.add("hidden");
  if (activeImageIndex >= selectedImages.length) {
    activeImageIndex = Math.max(0, selectedImages.length - 1);
  }
  renderThumbs();
  renderQueue();
  showActiveImage();
  updateDropLabel();
  setStatus(
    selectedImages.length
      ? `${selectedImages.length} image${selectedImages.length === 1 ? "" : "s"} ready.`
      : "No claim photos selected."
  );
};

const clearQueue = () => {
  selectedImages = [];
  activeImageIndex = 0;
  latestAssessment = null;
  reviewState = null;
  elements.downloadReport?.classList.add("hidden");
  elements.downloadHtmlReport?.classList.add("hidden");
  elements.saveCase?.classList.add("hidden");
  renderThumbs();
  renderQueue();
  showActiveImage();
  updateDropLabel();
  setStatus("No claim photos selected.");
};

const setActiveImage = (index) => {
  if (index < 0 || index >= selectedImages.length) {
    return;
  }
  activeImageIndex = index;
  renderThumbs();
  renderQueue();
  showActiveImage();
};

const showActiveImage = () => {
  if (selectedImages.length === 0) {
    elements.previewImage.classList.add("hidden");
    elements.emptyPreview.classList.remove("hidden");
    elements.imageState.textContent = "Awaiting upload";
    elements.damageOverlay.innerHTML = "";
    return;
  }
  const current = selectedImages[activeImageIndex];
  elements.previewImage.src = current.dataUrl;
  elements.previewImage.classList.remove("hidden");
  elements.emptyPreview.classList.add("hidden");
  elements.imageState.textContent =
    selectedImages.length > 1
      ? `Image ${activeImageIndex + 1} of ${selectedImages.length}`
      : "Photo loaded";
  // Overlay is redrawn on the image's load event (renderActiveOverlay).
};

const renderThumbs = () => {
  elements.thumbStrip.innerHTML = "";
  if (selectedImages.length <= 1) {
    elements.thumbStrip.classList.add("hidden");
    return;
  }
  elements.thumbStrip.classList.remove("hidden");
  selectedImages.forEach((item, index) => {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = `thumb${index === activeImageIndex ? " active" : ""}`;
    thumb.style.backgroundImage = `url(${item.dataUrl})`;
    thumb.title = item.file.name;
    thumb.setAttribute("aria-label", `View image ${index + 1}`);

    const badge = document.createElement("span");
    badge.className = "thumb-index";
    badge.textContent = String(index + 1);
    thumb.appendChild(badge);

    if (!latestAssessment) {
      const remove = document.createElement("span");
      remove.className = "thumb-remove";
      remove.textContent = "×";
      remove.title = "Remove image";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeImage(index);
      });
      thumb.appendChild(remove);
    }

    thumb.addEventListener("click", () => setActiveImage(index));
    elements.thumbStrip.appendChild(thumb);
  });
};

const updateSummary = (payload) => {
  const imageCount = payload.meta?.image_count || 1;
  const claimContext = mergeVehicleContext(payload.claim_context || {});
  const pricingFactors = payload.pricing_factors || [];
  const comparablePrices = payload.valuation_comparable_prices_usd || [];
  elements.filename.textContent =
    imageCount > 1 ? `${imageCount} images` : payload.filename;
  elements.vehicleType.textContent = mergeVehicleLabel(payload.vehicle_type, claimContext);
  const vehicleValue = payload.estimated_vehicle_value_usd || 0;
  elements.vehicleValue.textContent =
    vehicleValue > 0 ? `$${vehicleValue.toLocaleString()}` : "Unknown";
  elements.reportedMileage.textContent =
    claimContext.mileage !== null && claimContext.mileage !== undefined
      ? `${claimContext.mileage.toLocaleString()} mi`
      : "Not provided";
  elements.priorDamage.textContent = claimContext.pre_existing_damage || "None reported";
  elements.severity.textContent = payload.overall_severity;
  elements.repairability.textContent = payload.repairability;
  elements.estimatedCost.textContent = `$${payload.estimated_total_cost_usd.toLocaleString()}`;
  elements.recommendedAction.textContent = payload.recommended_action;
  if (elements.pricingFactors) {
    elements.pricingFactors.textContent = pricingFactors.length
      ? pricingFactors.join(" ")
      : "No additional pricing adjustments were applied.";
  }
  if (elements.valuationMethodology) {
    elements.valuationMethodology.textContent = payload.valuation_methodology
      || "No valuation methodology was returned. The estimate may be coming from a weak or generic market match.";
  }
  if (elements.valuationComparables) {
    elements.valuationComparables.textContent = comparablePrices.length
      ? comparablePrices.map((price) => `$${price.toLocaleString()}`).join(" · ")
      : "No comparable listing prices were captured for this assessment.";
  }
  elements.segmentationProvider.textContent = payload.meta.segmentation_provider;
  elements.reportProvider.textContent = payload.meta.report_provider;
  elements.fallbackNote.textContent = payload.meta.fallback_used
    ? "Fallback summary used."
    : "Narrative generated from visual review.";
  elements.summaryText.textContent = payload.summary;
  renderFlags(payload.assessment_flags || []);
  renderCompleteness(payload.completeness_checks || []);
  renderEvidence(payload);
};

const renderFlags = (flags) => {
  if (!elements.assessmentFlags) {
    return;
  }
  elements.assessmentFlags.innerHTML = "";
  if (!flags.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "No review flags were raised for this assessment.";
    elements.assessmentFlags.appendChild(empty);
    return;
  }

  flags.forEach((flag) => {
    const item = document.createElement("article");
    item.className = `signal-chip ${flag.level || "info"}`;

    const title = document.createElement("strong");
    title.textContent = flag.title;

    const detail = document.createElement("p");
    detail.textContent = flag.detail;

    item.append(title, detail);
    elements.assessmentFlags.appendChild(item);
  });
};

const renderCompleteness = (checks) => {
  if (!elements.completenessChecks) {
    return;
  }
  elements.completenessChecks.innerHTML = "";
  if (!checks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "Claim completeness guidance will appear here.";
    elements.completenessChecks.appendChild(empty);
    return;
  }

  checks.forEach((check) => {
    const item = document.createElement("article");
    item.className = `check-item ${check.status || "partial"}`;

    const title = document.createElement("strong");
    title.textContent = check.title;

    const detail = document.createElement("p");
    detail.textContent = check.detail;

    item.append(title, detail);
    elements.completenessChecks.appendChild(item);
  });
};

// Show the reasoning and the web sources behind the valuation / total-loss call,
// so the AI decision is backed by evidence an adjuster can check.
const renderEvidence = (payload) => {
  const reason = payload.total_loss_reason || "";
  const sources = payload.sources || [];
  const queries = payload.search_queries || [];
  const groundingStatus = payload.meta?.grounding_status || "";

  if (reason) {
    elements.totalLossReason.textContent = reason;
    elements.reasonBlock.classList.remove("hidden");
  } else {
    elements.reasonBlock.classList.add("hidden");
  }

  elements.sourcesList.innerHTML = "";
  if (sources.length) {
    sources.forEach((src) => {
      // Only allow http(s) links — block javascript:/data: URLs (XSS) from
      // untrusted web-search results.
      const safeUrl = /^https?:\/\//i.test(src.url || "") ? src.url : "";
      const li = document.createElement("li");
      const a = document.createElement("a");
      if (safeUrl) {
        a.href = safeUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      a.textContent = src.title || safeUrl || "(source)";
      li.appendChild(a);
      elements.sourcesList.appendChild(li);
    });
    elements.searchQueries.textContent = queries.length
      ? `Searches: ${queries.join(" · ")}`
      : "";
    elements.sourcesBlock.classList.remove("hidden");
  } else {
    elements.sourcesBlock.classList.add("hidden");
  }

  // Always show the grounding status when there are no sources, so it's clear
  // whether web grounding ran (and why not, if it didn't).
  if (groundingStatus && !sources.length) {
    elements.groundingStatus.textContent = `Web grounding: ${groundingStatus}`;
    elements.groundingStatus.classList.remove("hidden");
  } else {
    elements.groundingStatus.classList.add("hidden");
  }

  elements.evidence.classList.toggle(
    "hidden",
    !reason && !sources.length && !groundingStatus
  );
};

const renderRegions = (regions) => {
  elements.regions.innerHTML = "";
  elements.regionCount.textContent = `${regions.length} ${regions.length === 1 ? "part" : "parts"}`;

  if (regions.length === 0) {
    const empty = document.createElement("article");
    empty.className = "region-row placeholder";
    empty.innerHTML = "<span>No damage detected</span><strong>The vehicle appears undamaged in the submitted images.</strong>";
    elements.regions.appendChild(empty);
    return;
  }

  const multi = selectedImages.length > 1;
  const table = document.createElement("table");
  table.className = "regions-table";

  const head = document.createElement("thead");
  const headers = ["Part ID", "Part Name", "Assessment", "Confidence", "AI Model", "Est. Cost"];
  if (multi) {
    headers.push("Image");
  }
  head.innerHTML = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  table.appendChild(head);

  const body = document.createElement("tbody");
  regions.forEach((region, index) => {
    const row = document.createElement("tr");
    row.className = "region-row-tr";

    const cells = [
      region.part_id || `P${index + 1}`,
      region.panel,
      `${region.damage_type} · ${region.severity}`,
      `${(region.confidence * 100).toFixed(0)}%`,
      region.ai_assessor_model || region.source,
      `$${region.estimated_repair_cost_usd.toLocaleString()}`,
    ];
    if (multi) {
      cells.push(`#${(region.image_index ?? 0) + 1}`);
    }

    cells.forEach((value, cellIndex) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (cellIndex === 2) {
        cell.className = `sev-${region.severity}`;
      }
      row.appendChild(cell);
    });

    // Clicking a row jumps the preview to the image that part is on.
    row.addEventListener("click", () => {
      setActiveImage(region.image_index ?? 0);
      elements.previewImage.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    body.appendChild(row);
  });
  table.appendChild(body);
  elements.regions.appendChild(table);
};

const initializeReviewState = (payload) => {
  const review = payload.review || {};
  reviewState = {
    claimReference: review.claim_reference || elements.claimReference?.value?.trim?.() || "",
    reviewerName: review.reviewer_name || elements.reviewerName?.value?.trim?.() || "",
    finalAction: review.final_action || "",
    notes: review.notes || elements.reviewNotes?.value?.trim?.() || "",
    regionEdits: (payload.reviewed_regions?.length ? payload.reviewed_regions : payload.regions || []).map((region, index) => ({
      severity: region.severity,
      estimated_repair_cost_usd: region.estimated_repair_cost_usd,
      note: region.review_note || payload.reviewed_regions?.[index]?.review_note || "",
    })),
  };
  if (elements.claimReference) elements.claimReference.value = reviewState.claimReference;
  if (elements.reviewerName) elements.reviewerName.value = reviewState.reviewerName;
  if (elements.reviewNotes) elements.reviewNotes.value = reviewState.notes;
  if (elements.reviewFinalAction) elements.reviewFinalAction.value = reviewState.finalAction;
};

const getReviewedAssessment = () => {
  if (!latestAssessment) {
    return null;
  }

  const reviewedRegions = latestAssessment.regions.map((region, index) => {
    const edit = reviewState?.regionEdits?.[index] || {};
    return {
      ...region,
      severity: edit.severity || region.severity,
      estimated_repair_cost_usd:
        Number.isFinite(Number(edit.estimated_repair_cost_usd))
          ? Number(edit.estimated_repair_cost_usd)
          : region.estimated_repair_cost_usd,
      review_note: edit.note || "",
    };
  });

  const reviewedTotal = reviewedRegions.reduce(
    (sum, region) => sum + (Number(region.estimated_repair_cost_usd) || 0),
    0
  );
  const finalAction = reviewState?.finalAction || latestAssessment.recommended_action;

  return {
    ...latestAssessment,
    reviewed_regions: reviewedRegions,
    review: {
      claim_reference: reviewState?.claimReference || "",
      reviewer_name: reviewState?.reviewerName || "",
      final_action: finalAction,
      notes: reviewState?.notes || "",
      reviewed_total_cost_usd: reviewedTotal,
      ai_recommended_action: latestAssessment.recommended_action,
      completed_at: new Date().toISOString(),
    },
  };
};

const updateReviewSummary = () => {
  if (
    !elements.reviewState
    || !elements.reviewAiTotal
    || !elements.reviewAdjustedTotal
    || !elements.reviewFinalActionDisplay
    || !elements.reviewGuidance
  ) {
    return;
  }
  const reviewedAssessment = getReviewedAssessment();
  if (!reviewedAssessment) {
    elements.reviewState.textContent = "Waiting for assessment";
    elements.reviewAiTotal.textContent = "—";
    elements.reviewAdjustedTotal.textContent = "—";
    elements.reviewFinalActionDisplay.textContent = "—";
    elements.reviewGuidance.textContent =
      "Region-level overrides will appear here after an assessment is completed.";
    return;
  }

  const reviewedTotal = reviewedAssessment.review.reviewed_total_cost_usd || 0;
  const hasOverrides = reviewedAssessment.reviewed_regions.some((region, index) => {
    const original = latestAssessment.regions[index];
    return (
      region.severity !== original.severity
      || region.estimated_repair_cost_usd !== original.estimated_repair_cost_usd
      || region.review_note
    );
  });

  elements.reviewState.textContent = hasOverrides ? "Overrides in progress" : "AI output ready for review";
  elements.reviewAiTotal.textContent = formatCurrency(latestAssessment.estimated_total_cost_usd);
  elements.reviewAdjustedTotal.textContent = formatCurrency(reviewedTotal);
  elements.reviewFinalActionDisplay.textContent = reviewedAssessment.review.final_action || "—";
  elements.reviewGuidance.textContent = hasOverrides
    ? "Reviewed estimate includes region-level overrides. Export will include both AI output and reviewer edits."
    : "No overrides yet. Use the controls below to adjust severity, estimated cost, and reviewer notes.";
};

const renderReviewRegions = (regions) => {
  if (!elements.reviewRegions) {
    return;
  }
  elements.reviewRegions.innerHTML = "";
  if (!regions.length) {
    const empty = document.createElement("article");
    empty.className = "review-region empty";
    empty.innerHTML = "<strong>No reviewed parts yet</strong><p>Run an assessment to enable severity and cost overrides for each detected part.</p>";
    elements.reviewRegions.appendChild(empty);
    updateReviewSummary();
    return;
  }

  regions.forEach((region, index) => {
    const edit = reviewState?.regionEdits?.[index];
    const card = document.createElement("article");
    card.className = "review-region";

    const header = document.createElement("div");
    header.className = "review-region-header";
    header.innerHTML = `<strong>${escapeHtml(region.part_id || `P${index + 1}`)} · ${escapeHtml(region.panel)}</strong><span>${escapeHtml(region.damage_type)}</span>`;

    const grid = document.createElement("div");
    grid.className = "review-region-grid";

    const severityLabel = document.createElement("label");
    const severityCaption = document.createElement("span");
    severityCaption.textContent = "Severity";
    const severitySelect = document.createElement("select");
    ["low", "moderate", "high"].forEach((severity) => {
      const option = document.createElement("option");
      option.value = severity;
      option.textContent = severity;
      if (edit?.severity === severity) {
        option.selected = true;
      }
      severitySelect.appendChild(option);
    });
    severitySelect.addEventListener("change", () => {
      reviewState.regionEdits[index].severity = severitySelect.value;
      updateReviewSummary();
    });
    severityLabel.append(severityCaption, severitySelect);

    const costLabel = document.createElement("label");
    const costCaption = document.createElement("span");
    costCaption.textContent = "Reviewed cost (USD)";
    const costInput = document.createElement("input");
    costInput.type = "number";
    costInput.min = "0";
    costInput.step = "50";
    costInput.value = String(edit?.estimated_repair_cost_usd ?? region.estimated_repair_cost_usd);
    costInput.addEventListener("input", () => {
      reviewState.regionEdits[index].estimated_repair_cost_usd = Math.max(
        0,
        Number.parseInt(costInput.value || "0", 10) || 0
      );
      updateReviewSummary();
    });
    costLabel.append(costCaption, costInput);

    const noteLabel = document.createElement("label");
    noteLabel.className = "review-note-field";
    const noteCaption = document.createElement("span");
    noteCaption.textContent = "Reviewer note";
    const noteInput = document.createElement("textarea");
    noteInput.rows = 3;
    noteInput.placeholder = "Explain why this part was adjusted.";
    noteInput.value = edit?.note || "";
    noteInput.addEventListener("input", () => {
      reviewState.regionEdits[index].note = noteInput.value.trim();
      updateReviewSummary();
    });
    noteLabel.append(noteCaption, noteInput);

    grid.append(severityLabel, costLabel, noteLabel);
    card.append(header, grid);
    elements.reviewRegions.appendChild(card);
  });

  updateReviewSummary();
};

const boxToDisplayRect = (box) => {
  const image = elements.previewImage;
  const rect = image.getBoundingClientRect();

  if (!image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) {
    return null;
  }

  const scale = Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;

  return {
    left: offsetX + box.x * scale,
    top: offsetY + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
};

const renderActiveOverlay = () => {
  elements.damageOverlay.innerHTML = "";

  if (!latestAssessment || elements.previewImage.classList.contains("hidden")) {
    return;
  }

  // Only draw boxes that belong to the image currently in the preview.
  const regions = latestAssessment.regions.filter(
    (region) => (region.image_index ?? 0) === activeImageIndex
  );

  regions.forEach((region) => {
    const displayRect = boxToDisplayRect(region.bounding_box);
    if (!displayRect) {
      return;
    }

    const box = document.createElement("div");
    box.className = `damage-box ${region.severity}`;
    box.style.left = `${displayRect.left}px`;
    box.style.top = `${displayRect.top}px`;
    box.style.width = `${displayRect.width}px`;
    box.style.height = `${displayRect.height}px`;

    // If MobileSAM produced a mask, overlay its shape filling the box rect.
    // Only accept image data URLs (reject any non-image/external src).
    if (typeof region.mask_png === "string" && region.mask_png.startsWith("data:image/")) {
      const mask = document.createElement("img");
      mask.className = "damage-mask";
      mask.src = region.mask_png;
      box.appendChild(mask);
    }

    const tag = document.createElement("span");
    tag.className = "damage-tag";
    tag.textContent = `${region.part_id || ""} ${region.panel}`.trim();

    box.appendChild(tag);
    elements.damageOverlay.appendChild(box);
  });
};

const downloadAssessmentReport = () => {
  // The report had no images at all — a damage report with no damage.
  // selectedImages holds the data URLs already read for the preview, so
  // they embed without another fetch.
  const reportPhotos = selectedImages.map((entry) => entry.dataUrl).filter(Boolean);
  const exportPayload = getReviewedAssessment();
  if (!exportPayload) {
    return;
  }

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exportPayload.filename || "claim-assessment"}-review.json`;
  link.click();
  URL.revokeObjectURL(url);
};

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const downloadHtmlReport = () => {
  const exportPayload = getReviewedAssessment();
  if (!exportPayload) {
    return;
  }

  const reviewedRegions = exportPayload.reviewed_regions || [];
  const flags = exportPayload.assessment_flags || [];
  const checks = exportPayload.completeness_checks || [];
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClaimSight Review Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #17201b; line-height: 1.5; }
    h1, h2 { margin: 0 0 12px; }
    .meta, .card { margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .tile { padding: 12px; border: 1px solid #d6ddd8; border-radius: 8px; background: #f8fbf9; }
    .pill { display: inline-block; margin: 0 8px 8px 0; padding: 6px 10px; border-radius: 999px; background: #eef4ef; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #d6ddd8; vertical-align: top; }
    .small { color: #516157; font-size: 0.92rem; }
    .photos { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .photos figure { margin: 0; }
    .photos img { width: 100%; border-radius: 6px; border: 1px solid #dde2e9; }
    @media print { .photos { grid-template-columns: repeat(2, 1fr); } .card { break-inside: avoid; } }
  </style>
</head>
<body>
  <h1>ClaimSight Review Report</h1>
  <div class="meta small">
    Generated ${escapeHtml(exportPayload.meta?.generated_at || "")} |
    Reviewed ${escapeHtml(exportPayload.review?.completed_at || "")}
  </div>
  <div class="card grid">
    <div class="tile"><strong>Claim reference</strong><div>${escapeHtml(exportPayload.review?.claim_reference || "—")}</div></div>
    <div class="tile"><strong>Reviewer</strong><div>${escapeHtml(exportPayload.review?.reviewer_name || "—")}</div></div>
    <div class="tile"><strong>Vehicle</strong><div>${escapeHtml(exportPayload.vehicle_type || "—")}</div></div>
    <div class="tile"><strong>Final action</strong><div>${escapeHtml(exportPayload.review?.final_action || exportPayload.recommended_action || "—")}</div></div>
    <div class="tile"><strong>AI estimate</strong><div>${escapeHtml(formatCurrency(exportPayload.estimated_total_cost_usd))}</div></div>
    <div class="tile"><strong>Reviewed estimate</strong><div>${escapeHtml(formatCurrency(exportPayload.review?.reviewed_total_cost_usd || 0))}</div></div>
    <div class="tile"><strong>Assessed vehicle value</strong><div>${escapeHtml(formatCurrency(exportPayload.estimated_vehicle_value_usd || 0))}</div></div>
    <div class="tile"><strong>Outcome</strong><div>${escapeHtml(
      (exportPayload.assessment_flags || []).some((f) => f.code === "total_loss_undecidable_without_value")
        ? "Pending — adjuster to set vehicle value"
        : (exportPayload.total_loss ? "Total loss" : "Repair"))}</div></div>
  </div>
  <div class="card">
    <h2>Assessment summary</h2>
    <p>${escapeHtml(exportPayload.summary || "")}</p>
    <p class="small">${escapeHtml(exportPayload.review?.notes || "No reviewer notes entered.")}</p>
  </div>
  ${exportPayload.total_loss ? `
  <div class="card">
    <h2>Basis for total loss</h2>
    <p>${escapeHtml(exportPayload.total_loss_reason
      || `Repair cost of ${formatCurrency(exportPayload.review?.reviewed_total_cost_usd || exportPayload.estimated_total_cost_usd)} against an assessed vehicle value of ${formatCurrency(exportPayload.estimated_vehicle_value_usd || 0)}.`)}</p>
  </div>` : ""}
  ${(exportPayload.valuation_methodology
     || (exportPayload.valuation_comparable_prices_usd || []).length
     || (exportPayload.sources || []).length) ? `
  <div class="card">
    <h2>How the vehicle was valued</h2>
    ${exportPayload.valuation_methodology ? `<p>${escapeHtml(exportPayload.valuation_methodology)}</p>` : ""}
    ${(exportPayload.valuation_comparable_prices_usd || []).length
      ? `<p class="small">Comparable listings: ${(exportPayload.valuation_comparable_prices_usd || []).map((v) => escapeHtml(formatCurrency(v))).join(", ")}</p>`
      : ""}
    ${(exportPayload.sources || []).length
      ? `<ul class="small">${(exportPayload.sources || []).slice(0, 8).map((src) => {
          const label = src.title || src.name || src.uri || src.url || "";
          const href = src.uri || src.url || "";
          return `<li>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label)}</li>`;
        }).join("")}</ul>`
      : ""}
    ${exportPayload.meta?.grounding_status
      ? `<p class="small">Grounding: ${escapeHtml(exportPayload.meta.grounding_status)}</p>`
      : ""}
    ${(exportPayload.search_queries || []).length
      ? `<p class="small">Searches run: ${(exportPayload.search_queries || []).map((q) => escapeHtml(q)).join(" | ")}</p>`
      : ""}
  </div>` : ""}
  ${reportPhotos.length ? `
  <div class="card">
    <h2>Damage photos</h2>
    <div class="photos">
      ${reportPhotos.map((photo, i) => `
        <figure><img src="${escapeHtml(photo)}" alt="Claim photo ${i + 1}" /><figcaption class="small">Photo ${i + 1}</figcaption></figure>
      `).join("")}
    </div>
  </div>` : ""}
  <div class="card">
    <h2>Review signals</h2>
    ${(flags.length
      ? flags.map((flag) => `<span class="pill"><strong>${escapeHtml(flag.title)}</strong>: ${escapeHtml(flag.detail)}</span>`).join("")
      : "<p class=\"small\">No review flags.</p>")}
  </div>
  <div class="card">
    <h2>Claim completeness</h2>
    ${(checks.length
      ? checks.map((check) => `<span class="pill"><strong>${escapeHtml(check.title)}</strong>: ${escapeHtml(check.detail)}</span>`).join("")
      : "<p class=\"small\">No completeness guidance.</p>")}
  </div>
  <div class="card">
    <h2>Reviewed parts</h2>
    <table>
      <thead>
        <tr><th>Part</th><th>Severity</th><th>Reviewed cost</th><th>Reviewer note</th></tr>
      </thead>
      <tbody>
        ${reviewedRegions.map((region) => `
          <tr>
            <td>${escapeHtml(`${region.part_id || ""} ${region.panel || ""}`.trim())}</td>
            <td>${escapeHtml(region.severity || "")}</td>
            <td>${escapeHtml(formatCurrency(region.estimated_repair_cost_usd || 0))}</td>
            <td>${escapeHtml(region.review_note || "—")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  const reportWindow = window.open("", "_blank", "noopener,noreferrer,width=1100,height=850");
  if (!reportWindow) {
    throw new Error("Allow pop-ups to generate the PDF-ready report.");
  }
  reportWindow.document.open();
  reportWindow.document.write(html);
  reportWindow.document.close();
  reportWindow.focus();
  window.setTimeout(() => {
    reportWindow.print();
  }, 250);
};

const updateOpsState = () => {
  if (!elements.opsState) {
    return;
  }
  if (!savedCases.length) {
    elements.opsState.textContent = "No saved cases yet";
    return;
  }
  const urgentCount = queueCases.filter((item) => item.queue_bucket === "urgent").length;
  elements.opsState.textContent =
    urgentCount > 0
      ? `${savedCases.length} saved cases · ${urgentCount} urgent`
      : `${savedCases.length} saved cases · queue active`;
};

const renderCaseCollection = (target, cases, emptyTitle, emptyDetail, includePriority = false) => {
  if (!target) {
    return;
  }
  target.innerHTML = "";
  if (!cases.length) {
    const empty = document.createElement("article");
    empty.className = "ops-item empty";
    empty.innerHTML = `<strong>${emptyTitle}</strong><p>${emptyDetail}</p>`;
    target.appendChild(empty);
    return;
  }

  cases.forEach((item) => {
    const card = document.createElement("article");
    card.className = `ops-item${includePriority ? ` ${item.queue_bucket || "routine"}` : ""}`;

    const top = document.createElement("div");
    top.className = "ops-item-head";
    top.innerHTML = `<strong>${escapeHtml(item.claim_reference || item.id)}</strong><span>${escapeHtml(item.vehicle_type || "Vehicle unavailable")}</span>`;

    const meta = document.createElement("p");
    const total = formatCurrency(item.reviewed_total_cost_usd || item.estimated_total_cost_usd || 0);
    meta.textContent = includePriority
      ? `${item.queue_bucket || "routine"} priority · score ${item.priority_score || 0} · ${total}`
      : `${item.final_action || "No final action"} · ${total}`;

    const actions = document.createElement("div");
    actions.className = "ops-item-actions";

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "text-action";
    loadButton.textContent = "Open";
    loadButton.addEventListener("click", () => loadCase(item.id));

    actions.appendChild(loadButton);
    card.append(top, meta, actions);
    target.appendChild(card);
  });
};

const renderCases = () => {
  if (!elements.casesList || !elements.queueListPanel) {
    return;
  }
  renderCaseCollection(
    elements.casesList,
    savedCases,
    "No saved cases",
    "Saved reviewed assessments will appear here.",
    false
  );
  renderCaseCollection(
    elements.queueListPanel,
    queueCases,
    "No queue items",
    "Priority-ranked claims will appear here after cases are saved.",
    true
  );
  updateOpsState();
};

const fetchCases = async () => {
  if (!casesCollection || !elements.casesList) {
    return;
  }
  const snapshot = await casesCollection.orderBy("updated_at", "desc").limit(25).get();
  savedCases = snapshot.docs.map((doc) => normalizeCaseSummary(doc.id, doc.data()));
  renderCases();
};

const fetchQueue = async () => {
  if (!casesCollection || !elements.queueListPanel) {
    return;
  }
  const snapshot = await casesCollection
    .orderBy("queue.priority_score", "desc")
    .limit(25)
    .get();
  queueCases = snapshot.docs.map((doc) => normalizeCaseSummary(doc.id, doc.data()));
  renderCases();
};

const loadCase = async (caseId) => {
  if (!casesCollection) {
    return;
  }
  setStatus(`Loading ${caseId}...`);
  const snapshot = await casesCollection.doc(caseId).get();
  if (!snapshot.exists) {
    throw new Error("Failed to load case.");
  }
  const payload = snapshot.data();

  latestAssessment = payload;
  initializeReviewState(payload);
  updateSummary(payload);
  renderRegions(payload.regions || []);
  renderReviewRegions(payload.reviewed_regions?.length ? payload.reviewed_regions : payload.regions || []);
  elements.downloadReport?.classList.remove("hidden");
  elements.downloadHtmlReport?.classList.remove("hidden");
  elements.saveCase?.classList.remove("hidden");
  setStatus(`Loaded case ${caseId}.`);
  window.location.hash = "#review";
};

const saveCurrentCase = async () => {
  const exportPayload = getReviewedAssessment();
  if (!exportPayload || !casesCollection) {
    return;
  }

  setStatus("Saving reviewed case...");
  const claimReference = (exportPayload.review?.claim_reference || reviewState?.claimReference || "").trim();
  const docId = (claimReference || `case-${Date.now()}`).replace(/[^A-Za-z0-9_-]+/g, "-");
  const now = window.firebase.firestore.FieldValue.serverTimestamp();
  const queue = computeQueueMeta(exportPayload);
  const statusMeta = deriveConsumerStatus(exportPayload);
  const payload = {
    ...exportPayload,
    queue,
    claim_reference: docId,
    status: statusMeta.code,
    status_label: statusMeta.label,
    report_ready: statusMeta.reportReady,
    consumer_notifications: buildConsumerNotifications(exportPayload, statusMeta, docId),
    updated_at: now,
  };
  const docRef = casesCollection.doc(docId);
  const existing = await docRef.get();
  if (!existing.exists) {
    payload.created_at = now;
  }
  await docRef.set(payload, { merge: true });

  reviewState.claimReference = claimReference || docId;
  if (elements.claimReference) {
    elements.claimReference.value = reviewState.claimReference;
  }
  await Promise.all([fetchCases(), fetchQueue()]);
  setStatus(`Saved case ${reviewState.claimReference}.`);
};

elements.fileInput.addEventListener("change", () => {
  if (elements.fileInput.files?.length) {
    addFiles(elements.fileInput.files);
    elements.fileInput.value = "";
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("dragging");
  });
});

elements.dropzone.addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;
  if (files?.length) {
    addFiles(files);
  }
});

elements.clearQueue.addEventListener("click", clearQueue);

// Carousel arrows step to the previous/next image (with wrap-around).
elements.queuePrev.addEventListener("click", () => {
  if (selectedImages.length) {
    setActiveImage((activeImageIndex - 1 + selectedImages.length) % selectedImages.length);
  }
});
elements.queueNext.addEventListener("click", () => {
  if (selectedImages.length) {
    setActiveImage((activeImageIndex + 1) % selectedImages.length);
  }
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();

  updateEvidenceChecklist();
  const failedFields = validateRequiredFields();

  // An upload with no evidence type tells us nothing about what was
  // supplied, so it blocks submit the same way an empty field does.
  const untaggedDocs = Array.from(elements.supportingDocumentsInput?.files || [])
    .filter((_, index) => !supportingDocTags[index]).length;
  const untaggedPhotos = selectedImages.filter((item) => !item.evidenceTag).length;

  if (untaggedDocs || untaggedPhotos) {
    document.getElementById("supporting-doc-links")
      ?.querySelectorAll(".evidence-link-row.untagged")
      .forEach((row) => row.classList.add("field-invalid"));
    elements.queueList?.querySelectorAll(".queue-item.untagged")
      .forEach((row) => row.classList.add("field-invalid"));
  }

  if (failedFields.length || untaggedDocs || untaggedPhotos) {
    const problems = failedFields.length + untaggedDocs + untaggedPhotos;
    const verb = problems === 1 ? "needs" : "need";
    setStatus(
      untaggedDocs || untaggedPhotos
        ? `${problems} item${problems === 1 ? "" : "s"} ${verb} attention — every upload needs an evidence type.`
        : `${problems} required field${problems === 1 ? "" : "s"} ${verb} attention.`
    );
    elements.status?.classList.add("status-error");
    const first = failedFields[0];
    if (first) {
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      // the dropzone is a label; focusing it would open the file picker
      if (first !== elements.dropzone) first.focus({ preventScroll: true });
    }
    return;
  }
  elements.status?.classList.remove("status-error");

  if (!apiBaseUrl) {
    setStatus("Set VITE_API_BASE_URL before running the frontend.");
    return;
  }

  setStatus(
    selectedImages.length > 1
      ? `Assessing ${selectedImages.length} images...`
      : "Assessing claim..."
  );

  try {
    const formData = new FormData();
    selectedImages.forEach((item) => formData.append("files", item.file));
    const claimContext = collectClaimContext();
    Object.entries(claimContext).forEach(([key, value]) => {
      if (value !== null && value !== "") {
        formData.append(key, String(value));
      }
    });

    const requestHeaders = {};
    const authUser = window.firebase?.auth?.()?.currentUser;
    if (authUser?.getIdToken) {
      requestHeaders.Authorization = `Bearer ${await authUser.getIdToken()}`;
    }

    const response = await fetch(`${apiBaseUrl}/api/assess`, {
      method: "POST",
      headers: requestHeaders,
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || "Assessment failed.");
    }

    latestAssessment = payload;
    initializeReviewState(payload);
    updateSummary(payload);
    renderRegions(payload.regions);
    renderReviewRegions(payload.regions);
    renderThumbs();
    renderQueue();
    if (!consumerMode) {
      elements.downloadReport?.classList.remove("hidden");
      elements.downloadHtmlReport?.classList.remove("hidden");
      elements.saveCase?.classList.remove("hidden");
      setStatus("Assessment complete.");
    } else {
      const claimReference = await saveConsumerClaim(payload);
      if (claimReference) {
        window.localStorage.removeItem(consumerDraftStorageKey);
        window.ClaimSightConsumer?.refreshPortal?.();
        setStatus(`Assessment complete. Claim ${claimReference} submitted.`);
        await requestDemoReview(claimReference);
        window.ClaimSightConsumer?.refreshPortal?.();
        window.location.href = `./messages.html?claim=${encodeURIComponent(claimReference)}`;
      } else {
        setStatus("Assessment complete.");
      }
    }
    renderActiveOverlay();
  } catch (error) {
    setStatus(error.message || "Something went wrong.");
  }
});

elements.saveDraft?.addEventListener("click", saveConsumerDraft);

[
  elements.vehicleMakeInput,
  elements.vehicleModelInput,
  elements.vehicleYearInput,
  elements.incidentDateInput,
  elements.incidentDescriptionInput,
  elements.supportingDocumentsInput,
].forEach((input) => input?.addEventListener("input", updateEvidenceChecklist));

// Picking files replaces the FileList outright, so the tags start over.
elements.supportingDocumentsInput?.addEventListener("change", () => {
  supportingDocTags = Array.from(elements.supportingDocumentsInput.files || []).map(() => "");
  renderSupportingDocLinks();
  updateEvidenceChecklist();
});

elements.previewImage.addEventListener("load", renderActiveOverlay);

elements.downloadReport?.addEventListener("click", downloadAssessmentReport);
elements.downloadHtmlReport?.addEventListener("click", downloadHtmlReport);
elements.saveCase?.addEventListener("click", async () => {
  try {
    await saveCurrentCase();
  } catch (error) {
    setStatus(error.message || "Failed to save case.");
  }
});

elements.claimReference?.addEventListener("input", () => {
  if (!reviewState) {
    return;
  }
  reviewState.claimReference = elements.claimReference.value.trim();
});

elements.reviewerName?.addEventListener("input", () => {
  if (!reviewState) {
    return;
  }
  reviewState.reviewerName = elements.reviewerName.value.trim();
});

elements.reviewFinalAction?.addEventListener("change", () => {
  if (!reviewState) {
    return;
  }
  reviewState.finalAction = elements.reviewFinalAction.value;
  updateReviewSummary();
});

elements.reviewNotes?.addEventListener("input", () => {
  if (!reviewState) {
    return;
  }
  reviewState.notes = elements.reviewNotes.value.trim();
});

elements.refreshCases?.addEventListener("click", async () => {
  try {
    await fetchCases();
    setStatus("Recent cases refreshed.");
  } catch (error) {
    setStatus(error.message || "Failed to refresh cases.");
  }
});

elements.refreshQueue?.addEventListener("click", async () => {
  try {
    await fetchQueue();
    setStatus("Queue refreshed.");
  } catch (error) {
    setStatus(error.message || "Failed to refresh queue.");
  }
});

elements.workflowMenuToggle?.addEventListener("click", () => {
  const expanded = elements.workflowMenuToggle.getAttribute("aria-expanded") === "true";
  setWorkflowMenuOpen(!expanded);
});

elements.workflowMenuPanel?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setWorkflowMenuOpen(false));
});

document.addEventListener("click", (event) => {
  if (!elements.workflowMenuToggle || !elements.workflowMenuPanel) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (
    !elements.workflowMenuToggle.contains(target)
    && !elements.workflowMenuPanel.contains(target)
  ) {
    setWorkflowMenuOpen(false);
  }
});

if (apiBaseUrl) {
  Promise.allSettled([fetchCases(), fetchQueue()]);
} else if (firebaseEnabled) {
  Promise.allSettled([fetchCases(), fetchQueue()]);
}

restoreConsumerDraft();
updateEvidenceChecklist();

window.addEventListener("resize", () => {
  if (latestAssessment) {
    renderActiveOverlay();
  }
});

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── reveal-on-scroll ─────────────────────────────────────────
const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        revealObserver.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.15 }
);

document.querySelectorAll(".reveal, .summary-grid.stagger").forEach((el) => {
  if (reduceMotion) {
    el.classList.add("in");
  } else {
    revealObserver.observe(el);
  }
});

// ── scroll-linked transforms ──────────────────────────────────
const heroImg    = document.querySelector(".hero-img");
const zoomWrap   = document.getElementById("zoom-wrap");
const imagePanel = document.querySelector(".image-panel");
const zoomCaption = document.getElementById("zoom-caption");

const onScroll = () => {
  const y  = window.scrollY;
  const vh = window.innerHeight;

  // hero parallax: bg drifts slower than the page
  if (heroImg && y < vh * 1.1) {
    const p = y / vh;
    heroImg.style.transform = `scale(${1.12 - p * 0.08}) translateY(${p * vh * 0.22}px)`;
  }

  // sticky zoom: scale image panel as wrapper scrolls past
  if (zoomWrap && imagePanel) {
    const rect = zoomWrap.getBoundingClientRect();
    const progress = Math.min(Math.max(-rect.top / (rect.height - vh), 0), 1);
    const scale    = 1 + progress * 0.14;
    const radius   = Math.round(18 * (1 - progress));
    imagePanel.style.transform    = `scale(${scale})`;
    imagePanel.style.borderRadius = `${radius}px`;
    if (zoomCaption) {
      zoomCaption.classList.toggle("in", progress > 0.55);
    }
  }
};

if (!reduceMotion) {
  window.addEventListener("scroll", () => requestAnimationFrame(onScroll), { passive: true });
  onScroll();
}
