const firebaseConfig = window.FIREBASE_CONFIG || {};
const firebaseEnabled = Boolean(
  window.firebase
  && firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.appId
);
const firebaseAuthAvailable = firebaseEnabled && typeof window.firebase.auth === "function";

const consumerClaimIdsStorageKey = "claimsight.consumer-claim-ids";
const consumerCurrentClaimStorageKey = "claimsight.consumer-current-claim";
const consumerDraftStorageKey = "claimsight.consumer-draft";
const previewAcceptedClaimsStorageKey = "claimsight.preview-accepted-claims";

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

const getCurrentClaimId = () => {
  const claimFromUrl = new URLSearchParams(window.location.search).get("claim");
  return claimFromUrl || window.localStorage.getItem(consumerCurrentClaimStorageKey) || "";
};

const readConsumerDraft = () => {
  try {
    const raw = window.localStorage.getItem(consumerDraftStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const readPreviewAcceptedClaims = () => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(previewAcceptedClaimsStorageKey) || "[]");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
};

const markPreviewClaimAccepted = (claimId) => {
  const accepted = readPreviewAcceptedClaims();
  accepted.add(claimId);
  window.localStorage.setItem(previewAcceptedClaimsStorageKey, JSON.stringify([...accepted]));
};

const setCurrentClaimId = (claimId) => {
  if (!claimId) {
    return;
  }
  writeConsumerClaimIds([claimId, ...readConsumerClaimIds()]);
  window.localStorage.setItem(consumerCurrentClaimStorageKey, claimId);
};

const isDecisionReviewReady = (item = {}) => ["final_review", "finalized", "appealed"].includes(item.status_code);

const formatCurrency = (value) => `$${(Number(value) || 0).toLocaleString()}`;
const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const documentSourceLabel = (source = "") => {
  if (source === "employee_adjustment") return "Employee added during review";
  if (source === "customer_added_later") return "Customer added later";
  if (source === "customer_message") return "Customer message attachment";
  if (source === "employee_message") return "Employee message attachment";
  return "Customer submitted";
};

const formatFileSize = (size) => {
  const bytes = Number(size) || 0;
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getDocumentKind = (documentItem = {}) => {
  const type = String(documentItem.type || "").toLowerCase();
  const name = String(documentItem.name || "").toLowerCase();
  if (type.includes("pdf") || name.endsWith(".pdf")) return "PDF document";
  if (type.includes("image") || /\.(png|jpe?g|webp|heic)$/i.test(name)) return "Photo evidence";
  if (type.includes("word") || /\.(docx?|rtf)$/i.test(name)) return "Document";
  return "Supporting file";
};

const ensureDocumentPreview = () => {
  let modal = document.getElementById("document-preview-modal");
  if (modal) {
    return modal;
  }
  modal = document.createElement("div");
  modal.id = "document-preview-modal";
  modal.className = "document-preview-modal hidden";
  modal.innerHTML = `
    <div class="document-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="document-preview-title">
      <div class="document-preview-head">
        <div>
          <span>Supporting document</span>
          <strong id="document-preview-title">File preview</strong>
        </div>
        <button class="document-preview-close" type="button" aria-label="Close document preview">Close</button>
      </div>
      <div id="document-preview-body" class="document-preview-body"></div>
      <div class="document-preview-actions">
        <a id="document-preview-open-link" class="workflow-nav-button next" href="#" target="_blank" rel="noopener noreferrer">Open in new tab</a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.classList.add("hidden");
  modal.querySelector(".document-preview-close")?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      close();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });
  return modal;
};

// pdf.js is vendored under assets/vendor/pdfjs rather than pulled from a
// CDN. The production CSP is `script-src 'self' https://www.gstatic.com`,
// so the CDN import was blocked outright and every PDF fell through to
// the "could not render" fallback. Self-hosting keeps the policy closed
// to third-party origins.
//
// These are document-relative, not module-relative: consumer-case.js is
// loaded as a classic script, so import() resolves against the page URL.
// Every page that uses this sits at the site root.
const pdfJsModuleUrl = "./assets/vendor/pdfjs/pdf.min.mjs";
const pdfJsWorkerUrl = "./assets/vendor/pdfjs/pdf.worker.min.mjs";
// pdf.js does not embed the 14 standard PDF fonts (Helvetica, Times,
// Courier...). When a document references one and this path is not
// supplied, page.render() never settles — it hangs rather than
// throwing, which is why the modal used to sit on "Rendering PDF
// pages..." forever. Must end in a slash.
const pdfJsStandardFontsUrl = "./assets/vendor/pdfjs/standard_fonts/";

const renderPdfPreview = async (fileUrl, body) => {
  body.innerHTML = `
    <div class="document-preview-loading" role="status">
      <span class="material-symbols-outlined" aria-hidden="true">hourglass_top</span>
      <strong>Rendering PDF pages...</strong>
    </div>
  `;

  try {
    const pdfjs = await import(pdfJsModuleUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl;
    const pdf = await pdfjs.getDocument({
      url: fileUrl,
      standardFontDataUrl: pdfJsStandardFontsUrl,
    }).promise;
    const pages = document.createElement("div");
    pages.className = "document-preview-pdf-pages";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.min(820, Math.max(280, body.clientWidth - 32));
      const viewport = page.getViewport({ scale: availableWidth / baseViewport.width });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const pageShell = document.createElement("figure");
      const canvas = document.createElement("canvas");
      const caption = document.createElement("figcaption");
      const context = canvas.getContext("2d");

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      caption.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
      pageShell.append(canvas, caption);
      pages.appendChild(pageShell);

      await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise;
    }

    body.replaceChildren(pages);
  } catch {
    body.innerHTML = `
      <div class="document-preview-fallback">
        <strong>We could not render this PDF in the preview.</strong>
        <p>The original file is still available from the button below.</p>
      </div>
    `;
  }
};

const openDocumentPreview = (documentItem = {}) => {
  const fileUrl = documentItem.download_url || documentItem.url || documentItem.preview_url || "";
  if (!fileUrl) {
    return;
  }
  const modal = ensureDocumentPreview();
  const title = modal.querySelector("#document-preview-title");
  const body = modal.querySelector("#document-preview-body");
  const openLink = modal.querySelector("#document-preview-open-link");
  const fileName = documentItem.name || documentItem.filename || documentItem.label || "Supporting document";
  const type = String(documentItem.type || "").toLowerCase();
  const isImage = type.includes("image") || /\.(png|jpe?g|webp|gif|heic)$/i.test(fileName);
  const isPdf = type.includes("pdf") || /\.pdf$/i.test(fileName);
  if (title) title.textContent = fileName;
  if (openLink) {
    openLink.href = fileUrl;
    openLink.textContent = isPdf ? "Download original" : "Open in new tab";
    openLink.classList.toggle("hidden", isPdf && fileUrl.startsWith("data:"));
  }
  if (body) {
    if (isImage) {
      body.innerHTML = `<img src="${escapeHtml(fileUrl)}" alt="${escapeHtml(fileName)}" />`;
    } else if (isPdf) {
      renderPdfPreview(fileUrl, body);
    } else {
      body.innerHTML = `
        <div class="document-preview-fallback">
          <strong>Preview unavailable for this file type.</strong>
          <p>Use the button below to open or download the file.</p>
        </div>
      `;
    }
  }
  modal.classList.remove("hidden");
};

const createDocumentCard = (documentItem) => {
  const fileUrl = documentItem.download_url || documentItem.url || documentItem.preview_url || "";
  const wrapper = document.createElement(fileUrl ? "a" : "div");
  wrapper.className = "supporting-doc-card";
  const fileName = documentItem.name || documentItem.filename || documentItem.label || "Supporting document";
  const fileSize = formatFileSize(documentItem.size);
  const fileKind = getDocumentKind(documentItem);
  const isImage = String(documentItem.type || "").includes("image") || /\.(png|jpe?g|webp|gif|heic)$/i.test(fileName);
  const isPdf = String(documentItem.type || "").includes("pdf") || /\.pdf$/i.test(fileName);
  const source = documentSourceLabel(documentItem.source);
  const meta = [source, fileKind, fileSize].filter(Boolean).join(" · ");
  if (fileUrl) {
    wrapper.href = fileUrl;
    wrapper.target = "_blank";
    wrapper.rel = "noopener noreferrer";
    wrapper.setAttribute("aria-label", `Open ${fileName}`);
    wrapper.addEventListener("click", (event) => {
      event.preventDefault();
      openDocumentPreview(documentItem);
    });
  }
    wrapper.innerHTML = `
    <span class="supporting-doc-icon ${isImage ? "photo" : ""}" aria-hidden="true">
      ${isImage && fileUrl
        ? `<img src="${escapeHtml(fileUrl)}" alt="" />`
        : `<span>${isPdf ? "PDF" : "FILE"}</span>`}
    </span>
    <span class="supporting-doc-text">
      <strong>${escapeHtml(fileName)}</strong>
      <small>${escapeHtml(meta)}</small>
    </span>
    <span class="supporting-doc-action">${fileUrl ? "Open file" : "File record only"}</span>
  `;
  return wrapper;
};

const samplePdfDataUrl =
  "data:application/pdf;base64,JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMTk5ID4+CnN0cmVhbQpCVAovRjEgMjYgVGYKNzIgNzAwIFRkCihDbGFpbVNpZ2h0IFJlcGFpciBFc3RpbWF0ZSkgVGoKL0YxIDE0IFRmCjAgLTQwIFRkCihTYW1wbGUgY3VzdG9tZXIgZmlsZSBwcmV2aWV3LikgVGoKMCAtMjQgVGQKKEZpbGU6IHJlcGFpci1lc3RpbWF0ZS11cGxvYWQucGRmKSBUagowIC0yNCBUZAooVXNlIHRoZSBPcGVuIGluIG5ldyB0YWIgYnV0dG9uIGlmIHRoZSBicm93c2VyIGJsb2NrcyBlbWJlZGRlZCBQREZzLikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTIzIDAwMDAwIG4gCjAwMDAwMDAyNzQgMDAwMDAgbiAKMDAwMDAwMDM0NCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjU5MgolJUVPRg==";

const parseOptionalInteger = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const buildVehicleLabel = (context = {}, fallback = "Vehicle unavailable") => {
  const year = context.year ? String(context.year) : "";
  const label = [year, context.make, context.model, context.trim]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  return label || fallback;
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

const formatDate = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleDateString();
};

const deriveStatusMeta = (payload = {}) => {
  const review = payload.review || {};
  const consumerDecision = payload.consumer_decision || {};
  const finalAction = String(review.final_action || payload.final_action || "").toLowerCase();
  const reviewerName = String(review.reviewer_name || "").trim();
  const statusCode = payload.status || "";
  const statusLabel = payload.status_label || "";

  if (["finalized", "accepted", "closed"].includes(statusCode)) {
    return { code: "finalized", label: statusLabel || "Finalized", reportReady: true };
  }
  if (consumerDecision.decision === "accepted") {
    return { code: "finalized", label: "Finalized", reportReady: true };
  }
  if (statusCode === "appealed" || consumerDecision.decision === "appealed") {
    return { code: "appealed", label: statusLabel || "Appealed", reportReady: false };
  }
  if (statusCode === "final_review") {
    return { code: "final_review", label: statusLabel || "Final review", reportReady: false };
  }
  if (statusCode === "in_review") {
    return { code: "in_review", label: statusLabel || "In review", reportReady: false };
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

const buildNotifications = (item) => {
  // Notifications the adjuster wrote explicitly (e.g. an evidence
  // request) come first, then the ones derived from claim status.
  //
  // This used to `return` the adjuster's list and skip the derived ones
  // entirely. Because employee-dashboard.js *replaces* the
  // consumer_notifications array rather than appending to it, a claim
  // that had ever had an evidence request would be stuck showing only
  // that one line — the customer never saw "Final review" or "Claim
  // finalized" after it. Merging keeps both, de-duplicated by title.
  const explicit = Array.isArray(item.consumer_notifications)
    ? item.consumer_notifications
    : [];

  const notifications = [
    {
      title: "Claim submitted",
      message: item.assigned_agent?.name
        ? `${item.claim_reference} was assigned to ${item.assigned_agent.name}.`
        : `${item.claim_reference} is in the review queue.`,
    },
  ];

  if (item.reviewer_name) {
    notifications.push({
      title: "Human reviewed",
      message: `${item.reviewer_name} reviewed your claim.`,
    });
  }
  if (item.status_code === "final_review") {
    notifications.push({
      title: "Status: Final review",
      message: item.final_action || "Your claim is ready for your review.",
    });
  }
  if (item.status_code === "finalized") {
    notifications.push({
      title: "Claim finalized",
      message: "Your final report is ready to export.",
    });
  }
  if (item.status_code === "appealed") {
    notifications.push({
      title: "Appeal submitted",
      message: "Your appeal was sent back to review.",
    });
  }
  if (item.status_code === "needs_info") {
    notifications.push({
      title: "More information needed",
      message: item.adjuster_note || "The review team needs more information to continue.",
    });
  }

  // An adjuster message the customer has not opened yet. The read
  // marker is written to the case doc by customer-messages.js, so it
  // follows the account rather than the browser.
  if (item.last_employee_message_at) {
    const sent = Date.parse(item.last_employee_message_at);
    const seenAt = Date.parse(item.customer_thread_seen_at || 0) || 0;
    if (sent > seenAt) {
      notifications.unshift({
        title: "New message from your adjuster",
        message: `${item.claim_reference} has an unread reply in your message centre.`,
      });
    }
  }

  const seen = new Set(explicit.map((note) => note.title));
  return [...explicit, ...notifications.filter((note) => !seen.has(note.title))];
};

const normalize = (docId, payload = {}) => {
  const claimContext = payload.claim_context || {};
  const review = payload.review || {};
  const statusMeta = deriveStatusMeta(payload);
  const adjusterNote = review.notes || payload.consumer_summary || payload.summary || "No human note yet.";
  return {
    id: docId,
    claim_reference: review.claim_reference || payload.claim_reference || docId,
    vehicle_type: payload.vehicle_type || "Vehicle unavailable",
    make: claimContext.make || "",
    model: claimContext.model || "",
    trim: claimContext.trim || "",
    year: claimContext.year || null,
    mileage: claimContext.mileage || null,
    usage: claimContext.usage || "",
    estimated_total_cost_usd: payload.estimated_total_cost_usd || 0,
    reviewed_total_cost_usd: review.reviewed_total_cost_usd || payload.reviewed_total_cost_usd || payload.estimated_total_cost_usd || 0,
    final_action: review.final_action || payload.final_action || payload.recommended_action || "Pending review",
    ai_action: review.ai_recommended_action || payload.recommended_action || "Pending AI assessment",
    reasoning: payload.total_loss_reason || payload.summary || "Reasoning will appear after review.",
    reviewer_name: review.reviewer_name || payload.reviewer_name || "",
    assigned_agent: payload.assigned_agent || null,
    adjuster_note: adjusterNote,
    supporting_documents: payload.supporting_documents || [],
    reviewer_evidence: payload.reviewer_evidence || payload.internal_reviewer_evidence || [],
    consumer_notifications: payload.consumer_notifications || [],
    requested_evidence: payload.requested_evidence || review.requested_evidence || [],
    requested_evidence_types: payload.requested_evidence_types || review.requested_evidence_types || [],
    reviewer_request_note: payload.reviewer_request_note || review.reviewer_request_note || "",
    evidence_requested_at: firestoreTimestampToIso(payload.evidence_requested_at || review.evidence_requested_at),
    evidence_due_at: firestoreTimestampToIso(payload.evidence_due_at || review.evidence_due_at),
    last_employee_message_at: firestoreTimestampToIso(payload.last_employee_message_at),
    customer_thread_seen_at: firestoreTimestampToIso(payload.customer_thread_seen_at),
    estimate_line_items: review.estimate_line_items || payload.estimate_line_items || [],
    estimate_versions: payload.estimate_versions || [],
    appeal: payload.appeal || null,
    report_ready: Boolean(statusMeta.reportReady),
    status_code: statusMeta.code,
    status_label: statusMeta.label,
    updated_at: firestoreTimestampToIso(payload.updated_at),
    created_at: firestoreTimestampToIso(payload.created_at || payload.updated_at),
    raw: payload,
  };
};

const resolveClaimAction = (item = {}) => {
  const status = item.status_code || "submitted";
  const agentName = item.assigned_agent?.name || item.agent || "Your adjuster";
  const claimReference = item.claim_reference || item.id || "";
  const requestedEvidence = Array.isArray(item.requested_evidence)
    ? item.requested_evidence.filter(Boolean)
    : [];
  const evidenceCopy = requestedEvidence.length
    ? `Upload ${requestedEvidence.join(", ")}.`
    : (item.adjuster_note || item.next_step || `${agentName} needs additional evidence before review can continue.`);
  const actionByStatus = {
    submitted: {
      label: "No action needed",
      copy: "Your claim is submitted. We will notify you when an adjuster is assigned.",
      button: "View claim",
      href: "./edit-claim.html",
    },
    in_review: {
      label: "No action needed",
      copy: item.next_step || `${agentName} is reviewing the AI first pass, photos, and supporting documents.`,
      button: "Message adjuster",
      href: `./messages.html?claim=${encodeURIComponent(claimReference)}`,
    },
    needs_info: {
      label: "Action required",
      copy: evidenceCopy,
      button: "Upload evidence",
      href: "./edit-claim.html#edit-claim-evidence",
      due: item.evidence_due_at || "",
    },
    appealed: {
      label: "No action needed",
      copy: item.next_step || `${agentName} is reviewing your appeal and supporting evidence.`,
      button: "View appeal",
      href: "./case-review.html",
    },
    final_review: {
      label: "Action required",
      copy: item.next_step || "Review the adjuster decision, then accept it or submit an appeal.",
      button: "Review decision",
      href: "./case-review.html",
    },
    finalized: {
      label: "Complete",
      copy: "Your claim is finalized and the final report is ready.",
      button: "View final report",
      href: "./final-report.html",
    },
  };
  return actionByStatus[status] || actionByStatus.submitted;
};

const formatActionDueDate = (value) => {
  if (!value) return "";
  const dueDate = new Date(value);
  if (Number.isNaN(dueDate.getTime())) return "";
  return `Due ${dueDate.toLocaleDateString([], { month: "short", day: "numeric" })}`;
};

const pdfSafeText = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[^\x20-\x7E]/g, " ")
  .replaceAll("\\", "\\\\")
  .replaceAll("(", "\\(")
  .replaceAll(")", "\\)");

const wrapReportText = (value, maxLength = 82) => {
  const words = String(value || "Not provided").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxLength && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : ["Not provided"];
};

const buildReportPdf = (item = {}) => {
  const raw = item.raw || {};
  const lineItems = item.estimate_line_items
    || raw.estimate_line_items || raw.reviewed_regions || raw.regions || [];

  const money = (value) => formatCurrency(value);
  const vehicleValue = item.estimated_vehicle_value_usd
    ?? raw.estimated_vehicle_value_usd ?? 0;
  const aiTotal = item.estimated_total_cost_usd ?? raw.estimated_total_cost_usd ?? 0;
  const reviewedTotal = item.reviewed_total_cost_usd ?? raw.reviewed_total_cost_usd ?? 0;
  const isTotalLoss = Boolean(item.total_loss ?? raw.total_loss);
  // The backend abstains when it has no valuation. Printing "Repair" there
  // would state an outcome nobody has decided yet.
  const flagCodes = (raw.assessment_flags || item.assessment_flags || []).map((f) => f.code);
  const outcomePending = flagCodes.includes("total_loss_undecidable_without_value");
  const totalLossReason = item.total_loss_reason || raw.total_loss_reason || "";
  const methodology = item.valuation_methodology || raw.valuation_methodology || "";
  const comparables = item.valuation_comparable_prices_usd
    || raw.valuation_comparable_prices_usd || [];
  const sources = item.sources || raw.sources || [];

  // Every line the report wants to print, in order. Pagination happens
  // afterwards, so nothing is dropped to fit — the previous version
  // capped at 44 lines and 12 line items and silently discarded the
  // rest, which on a long total-loss write-up removed the whole
  // itemisation section including its heading.
  const lines = [
    { text: "ClaimSight Final Report", size: 20, bold: true, gap: 26 },
    { text: `Claim: ${item.claim_reference || item.id || "Unavailable"}`, bold: true },
    { text: `Vehicle: ${item.vehicle_type || "Unavailable"}` },
    { text: `Status: ${item.status_label || "Finalized"}` },
    { text: `Adjuster: ${item.reviewer_name || item.assigned_agent?.name || "Unavailable"}` },

    // ── the settlement decision, and the numbers behind it ────────
    { text: "Settlement", bold: true, gap: 22 },
    {
      text: `Outcome: ${outcomePending
        ? "Pending - adjuster to set vehicle value"
        : (isTotalLoss ? "Total loss" : "Repair")}`,
      bold: true,
    },
    { text: `Assessed vehicle value: ${money(vehicleValue)}` },
    { text: `AI first-pass estimate: ${money(aiTotal)}` },
    { text: `Reviewed estimate: ${money(reviewedTotal)}`, bold: true },
  ];

  if (isTotalLoss) {
    lines.push({ text: "Why this is a total loss", bold: true, gap: 20 });
    lines.push(...wrapReportText(
      totalLossReason
      || (vehicleValue > 0
        ? `Repair cost of ${money(reviewedTotal || aiTotal)} is uneconomic against an assessed vehicle value of ${money(vehicleValue)}.`
        : "The vehicle was assessed as uneconomic to repair.")
    ).map((text) => ({ text })));
  }

  // ── how the vehicle was valued ────────────────────────────────
  if (methodology || comparables.length || sources.length) {
    lines.push({ text: "How the vehicle was valued", bold: true, gap: 20 });
    if (methodology) lines.push(...wrapReportText(methodology).map((text) => ({ text })));
    if (comparables.length) {
      lines.push({ text: `Comparable listings: ${comparables.map(money).join(", ")}` });
    }
    sources.slice(0, 6).forEach((source) => {
      const label = source.title || source.name || source.uri || source.url || "";
      if (label) lines.push(...wrapReportText(`Source: ${label}`).map((text) => ({ text })));
    });
  }

  lines.push({ text: "Final action", bold: true, gap: 20 });
  lines.push(...wrapReportText(item.final_action).map((text) => ({ text })));
  lines.push({ text: "Adjuster note", bold: true, gap: 20 });
  lines.push(...wrapReportText(item.adjuster_note).map((text) => ({ text })));
  lines.push({ text: "Claim reasoning", bold: true, gap: 20 });
  lines.push(...wrapReportText(item.reasoning).map((text) => ({ text })));

  lines.push({ text: "Reviewed estimate items", bold: true, gap: 20 });
  if (lineItems.length) {
    lineItems.forEach((entry) => {
      const label = entry.description || entry.panel || entry.category || "Estimate item";
      lines.push({ text: `${label} - ${money(entry.total_usd ?? entry.estimated_repair_cost_usd)}` });
    });
  } else {
    lines.push({ text: "No itemised estimate recorded." });
  }

  // ── paginate ──────────────────────────────────────────────────
  const TOP = 748;
  const BOTTOM = 56;
  const pages = [];
  let current = [];
  let y = TOP;

  lines.forEach((line, index) => {
    const gap = index === 0 ? 0 : (line.gap || 16);
    if (y - gap < BOTTOM && current.length) {
      pages.push(current);
      current = [];
      y = TOP;
      current.push({ ...line, y });
      return;
    }
    y -= gap;
    current.push({ ...line, y });
  });
  if (current.length) pages.push(current);

  const pageCount = pages.length;
  const contentStreams = pages.map((page, pageIndex) => {
    const body = page
      .map((line) => `BT /${line.bold ? "F2" : "F1"} ${line.size || 10} Tf 54 ${line.y} Td (${pdfSafeText(line.text)}) Tj ET`)
      .join("\n");
    const footer = `BT /F1 8 Tf 54 36 Td (${pdfSafeText(
      `${item.claim_reference || item.id || "Claim"} - page ${pageIndex + 1} of ${pageCount}`
    )}) Tj ET`;
    return `${body}\n${footer}`;
  });

  // Object layout: 1 catalog, 2 pages, 3..(2+n) page objects,
  // then n content streams, then the two fonts.
  const firstPageObj = 3;
  const firstContentObj = firstPageObj + pageCount;
  const fontRegularObj = firstContentObj + pageCount;
  const fontBoldObj = fontRegularObj + 1;

  const kids = pages.map((_, i) => `${firstPageObj + i} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    ...pages.map((_, i) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRegularObj} 0 R /F2 ${fontBoldObj} 0 R >> >> /Contents ${firstContentObj + i} 0 R >>`),
    ...contentStreams.map((stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
};

const downloadReport = (item) => {
  const blob = buildReportPdf(item);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${item.claim_reference || item.id || "claim"}-final-report.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
};

const prepareReportDownload = (link, item, status) => {
  if (!link) return;
  const previousUrl = link.dataset.reportUrl || "";
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  const url = URL.createObjectURL(buildReportPdf(item));
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.removeAttribute("download");
  link.dataset.reportUrl = url;
  link.onclick = () => {
    if (status) status.textContent = "PDF opened. Use the PDF viewer to save or print it.";
  };
};

const createClaimActionDropdown = (actions = []) => {
  const cell = document.createElement("td");
  cell.className = "claim-row-actions";

  const menu = document.createElement("details");
  menu.className = "claim-action-menu";

  const trigger = document.createElement("summary");
  trigger.textContent = "Actions";
  menu.appendChild(trigger);

  const list = document.createElement("div");
  list.className = "claim-action-list";

  actions.forEach((action) => {
    const control = action.type === "button" ? document.createElement("button") : document.createElement("a");
    control.className = "claim-action-item";
    control.textContent = action.label;

    if (action.type === "button") {
      control.type = "button";
    } else {
      control.href = action.href;
    }

    if (action.onClick) {
      control.addEventListener("click", action.onClick);
    }

    list.appendChild(control);
  });

  menu.appendChild(list);
  cell.appendChild(menu);
  return cell;
};

const positionClaimActionMenu = (menu) => {
  const trigger = menu?.querySelector("summary");
  const list = menu?.querySelector(".claim-action-list");
  if (!trigger || !list) {
    return;
  }

  const triggerRect = trigger.getBoundingClientRect();
  const menuWidth = Math.max(list.offsetWidth || 180, 180);
  const left = Math.min(
    Math.max(12, triggerRect.right - menuWidth),
    window.innerWidth - menuWidth - 12
  );

  list.style.left = `${left}px`;
  list.style.top = `${triggerRect.bottom + 8}px`;
};

document.addEventListener("click", (event) => {
  const trigger = event.target instanceof Element ? event.target.closest(".claim-action-menu summary") : null;
  if (!trigger) {
    return;
  }

  const currentMenu = trigger.closest(".claim-action-menu");
  document.querySelectorAll(".claim-action-menu[open]").forEach((menu) => {
    if (menu !== currentMenu) {
      menu.removeAttribute("open");
    }
  });

  window.setTimeout(() => {
    if (currentMenu?.hasAttribute("open")) {
      positionClaimActionMenu(currentMenu);
    }
  }, 0);
});

window.addEventListener("resize", () => {
  document.querySelectorAll(".claim-action-menu[open]").forEach(positionClaimActionMenu);
});

window.addEventListener("scroll", () => {
  document.querySelectorAll(".claim-action-menu[open]").forEach(positionClaimActionMenu);
}, { passive: true });

const setClaimReviewStatus = (node, label, code = "") => {
  if (!node) return;
  node.textContent = label || "Waiting for review";
  node.dataset.status = code || String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
};

const reviewTabButtons = Array.from(document.querySelectorAll("[data-review-tab]"));
const reviewTabPanels = Array.from(document.querySelectorAll("[data-review-panel]"));

const activateReviewTab = (tabName) => {
  reviewTabButtons.forEach((button) => {
    const active = button.dataset.reviewTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  reviewTabPanels.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.reviewPanel !== tabName);
  });
};

reviewTabButtons.forEach((button) => {
  button.addEventListener("click", () => activateReviewTab(button.dataset.reviewTab || "decision"));
});

if (!firebaseAuthAvailable) {
  document.getElementById("customer-logout")?.addEventListener("click", () => {
    try {
      window.localStorage.removeItem(consumerCurrentClaimStorageKey);
      window.localStorage.removeItem(consumerDraftStorageKey);
    } catch {
      // Storage can be unavailable in local preview, but logout should still navigate.
    }
    window.location.href = "./index.html";
  });
}

if (firebaseEnabled) {
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  const db = window.firebase.firestore(app);
  const auth = firebaseAuthAvailable ? window.firebase.auth(app) : null;
  const casesCollection = db.collection("cases");
  const storage = typeof window.firebase.storage === "function"
    ? window.firebase.storage(app)
    : null;

  const elements = {
    dashboardClaims: document.getElementById("consumer-dashboard-claims"),
    summaryClaim: document.getElementById("customer-summary-claim"),
    summaryMeta: document.getElementById("customer-summary-meta"),
    timelineStatus: document.getElementById("customer-timeline-status"),
    timeline: document.getElementById("customer-claim-timeline"),
    nextStepLabel: document.getElementById("customer-next-step-label"),
    nextStepCopy: document.getElementById("customer-next-step-copy"),
    nextStepDue: document.getElementById("customer-next-step-due"),
    nextStepAction: document.getElementById("customer-next-step-action"),
    missingInfoAlert: document.getElementById("customer-missing-info-alert"),
    missingInfoCopy: document.getElementById("customer-missing-info-copy"),
    notificationToggle: document.getElementById("notification-toggle"),
    notificationCount: document.getElementById("notification-count"),
    notificationDropdown: document.getElementById("notification-dropdown"),
    notificationDropdownList: document.getElementById("notification-dropdown-list"),
    notificationsPageList: document.getElementById("notifications-page-list"),
    casesList: document.getElementById("cases-list"),
    similarList: document.getElementById("queue-list-panel"),
    refreshCases: document.getElementById("refresh-cases"),
    refreshSimilar: document.getElementById("refresh-queue"),
    detailStatus: document.getElementById("consumer-detail-status"),
    detailStatusCopy: document.getElementById("consumer-detail-status-copy"),
    detailEmpty: document.getElementById("consumer-claim-detail-empty"),
    detailCard: document.getElementById("consumer-claim-detail"),
    detailReference: document.getElementById("consumer-detail-reference"),
    detailVehicle: document.getElementById("consumer-detail-vehicle"),
    detailReviewer: document.getElementById("consumer-detail-reviewer"),
    detailNote: document.getElementById("consumer-detail-note"),
    detailReasoning: document.getElementById("consumer-detail-reasoning"),
    detailAiAction: document.getElementById("consumer-detail-ai-action"),
    detailFinalAction: document.getElementById("consumer-detail-final-action"),
    detailDocuments: document.getElementById("consumer-detail-documents"),
    supportDocumentsInput: document.getElementById("consumer-supporting-documents"),
    saveDocuments: document.getElementById("consumer-save-documents"),
    updateStatus: document.getElementById("consumer-update-status"),
    vehicleMakeInput: document.getElementById("consumer-vehicle-make"),
    vehicleModelInput: document.getElementById("consumer-vehicle-model"),
    vehicleTrimInput: document.getElementById("consumer-vehicle-trim"),
    vehicleYearInput: document.getElementById("consumer-vehicle-year"),
    vehicleMileageInput: document.getElementById("consumer-vehicle-mileage"),
    vehicleUsageInput: document.getElementById("consumer-vehicle-usage"),
    acceptDecision: document.getElementById("consumer-accept-decision"),
    appealDecision: document.getElementById("consumer-appeal-decision"),
    appealBuilder: document.getElementById("consumer-appeal-builder"),
    appealClose: document.getElementById("consumer-close-appeal"),
    appealCategory: document.getElementById("consumer-appeal-category"),
    appealAmount: document.getElementById("consumer-appeal-amount"),
    appealExplanation: document.getElementById("consumer-appeal-explanation"),
    appealFiles: document.getElementById("consumer-appeal-files"),
    appealSubmit: document.getElementById("consumer-submit-appeal"),
    appealStatus: document.getElementById("consumer-appeal-status"),
    aiEstimate: document.getElementById("consumer-ai-estimate"),
    adjustedEstimate: document.getElementById("consumer-adjusted-estimate"),
    estimateDelta: document.getElementById("consumer-estimate-delta"),
    estimateVersion: document.getElementById("consumer-estimate-version"),
    estimateLines: document.getElementById("consumer-estimate-lines"),
    estimateHistory: document.getElementById("consumer-estimate-history"),
    activityList: document.getElementById("consumer-activity-list"),
    inlineExport: document.getElementById("consumer-inline-export"),
    finalOpen: document.getElementById("consumer-open-final-report"),
    finalStatus: document.getElementById("consumer-final-status"),
    finalEmpty: document.getElementById("consumer-final-empty"),
    finalCard: document.getElementById("consumer-final-report"),
    finalReference: document.getElementById("consumer-final-reference"),
    finalVehicle: document.getElementById("consumer-final-vehicle"),
    finalStatusCopy: document.getElementById("consumer-final-status-copy"),
    finalReviewer: document.getElementById("consumer-final-reviewer"),
    finalAction: document.getElementById("consumer-final-action"),
    finalTotal: document.getElementById("consumer-final-total"),
    finalNote: document.getElementById("consumer-final-note"),
    finalExport: document.getElementById("consumer-final-export"),
    finalExportStatus: document.getElementById("consumer-final-export-status"),
    finalHistory: document.getElementById("consumer-report-history"),
    submittedCount: document.getElementById("consumer-count-submitted"),
    reviewCount: document.getElementById("consumer-count-review"),
    finalReviewCount: document.getElementById("consumer-count-final-review"),
    finalizedCount: document.getElementById("consumer-count-finalized"),
  };

  let ownClaims = [];
  let selectedClaimId = getCurrentClaimId();
  let currentCustomer = auth?.currentUser || null;

  const sortClaims = (items) =>
    items.sort((left, right) => {
      const leftDate = Date.parse(left.updated_at || "") || 0;
      const rightDate = Date.parse(right.updated_at || "") || 0;
      return rightDate - leftDate;
    });

  const ensureSelectedClaim = () => {
    if (!ownClaims.length) {
      selectedClaimId = "";
      return null;
    }
    const selected = ownClaims.find((item) => item.id === selectedClaimId);
    if (selected) {
      return selected;
    }
    const fallback = ownClaims.find((item) => item.report_ready) || ownClaims[0];
    selectedClaimId = fallback.id;
    setCurrentClaimId(fallback.id);
    return fallback;
  };

  const renderEmpty = (target, title, text) => {
    if (!target) {
      return;
    }
    target.innerHTML = "";
    const card = document.createElement("article");
    card.className = "ops-item empty";
    card.innerHTML = `<strong>${title}</strong><p>${text}</p>`;
    target.appendChild(card);
  };

  const claimCounts = () => ownClaims.reduce(
    (counts, item) => {
      if (item.status_code === "submitted") counts.submitted += 1;
      if (["in_review", "needs_info", "appealed"].includes(item.status_code)) counts.review += 1;
      if (item.status_code === "final_review") counts.finalReview += 1;
      if (item.status_code === "finalized") counts.finalized += 1;
      return counts;
    },
    { submitted: 0, review: 0, finalReview: 0, finalized: 0 }
  );

  const renderCounts = () => {
    const counts = claimCounts();
    if (elements.submittedCount) elements.submittedCount.textContent = String(counts.submitted);
    if (elements.reviewCount) elements.reviewCount.textContent = String(counts.review);
    if (elements.finalReviewCount) elements.finalReviewCount.textContent = String(counts.finalReview);
    if (elements.finalizedCount) elements.finalizedCount.textContent = String(counts.finalized);
  };

  const renderDashboardClaims = () => {
    if (!elements.dashboardClaims) {
      return;
    }
    const draft = readConsumerDraft();
    if (!ownClaims.length && !draft) {
      elements.dashboardClaims.innerHTML = `
        <tr class="claim-row empty">
          <td>—</td>
          <td><strong>No claims yet</strong></td>
          <td>Start a new claim</td>
          <td><a class="text-action" href="./new-claim.html">New claim</a></td>
        </tr>
      `;
      return;
    }

    elements.dashboardClaims.innerHTML = "";
    if (draft) {
      const draftId = draft.draft_id || "Draft";
      const row = document.createElement("tr");
      row.className = "claim-row draft";
      row.innerHTML = `
        <td>—</td>
        <td><strong>${escapeHtml(draftId)}</strong></td>
        <td>In progress</td>
        <td><a class="text-action" href="./new-claim.html">Continue</a></td>
      `;
      elements.dashboardClaims.appendChild(row);
    }

    ownClaims.forEach((item) => {
      const row = document.createElement("tr");
      row.className = `claim-row ${item.status_code}`;
      const date = document.createElement("td");
      date.textContent = formatDate(item.created_at || item.updated_at);

      const claimIdCell = document.createElement("td");
      const claimId = document.createElement("strong");
      claimId.textContent = item.claim_reference;
      claimIdCell.appendChild(claimId);

      const status = document.createElement("td");
      status.textContent = item.status_label;

      const actionItems = isDecisionReviewReady(item)
        ? [
            {
              label: item.status_code === "finalized" ? "View decision" : "Review decision",
              href: "./case-review.html",
              onClick: () => setCurrentClaimId(item.id),
            },
            {
              label: "Message",
              href: `./messages.html?claim=${encodeURIComponent(item.claim_reference)}`,
              onClick: () => setCurrentClaimId(item.id),
            },
            {
              label: "Add evidence",
              href: "./edit-claim.html#edit-claim-evidence",
              onClick: () => setCurrentClaimId(item.id),
            },
          ]
        : [
            {
              label: "View claim",
              href: "./edit-claim.html",
              onClick: () => setCurrentClaimId(item.id),
            },
            {
              label: "Edit claim",
              href: "./edit-claim.html#edit-claim-evidence",
              onClick: () => setCurrentClaimId(item.id),
            },
            {
              label: "Message",
              href: `./messages.html?claim=${encodeURIComponent(item.claim_reference)}`,
              onClick: () => setCurrentClaimId(item.id),
            },
          ];

      if (item.report_ready) {
        actionItems.push({
          type: "button",
          label: "Export report",
          onClick: () => downloadReport(item),
        });
      }

      row.append(date, claimIdCell, status, createClaimActionDropdown(actionItems));
      elements.dashboardClaims.appendChild(row);
    });
  };

  const renderCustomerOverview = () => {
    const selected = ensureSelectedClaim();
    if (!selected) {
      if (elements.summaryClaim) elements.summaryClaim.textContent = "No active claim";
      if (elements.summaryMeta) elements.summaryMeta.textContent = "Start a new claim to see progress here.";
      return;
    }

    const statusIndexMap = {
      submitted: 0,
      in_review: 2,
      needs_info: 2,
      appealed: 2,
      final_review: 3,
      finalized: 4,
    };
    const activeIndex = statusIndexMap[selected.status_code] ?? 0;

    if (elements.summaryClaim) elements.summaryClaim.textContent = selected.claim_reference;
    if (elements.summaryMeta) {
      elements.summaryMeta.textContent = `${selected.vehicle_type} · ${selected.status_label} · ${selected.assigned_agent?.name || "Assignment pending"}`;
    }
    if (elements.timelineStatus) elements.timelineStatus.textContent = selected.status_label;
    if (elements.timeline) {
      elements.timeline.style.setProperty("--timeline-step", String(activeIndex));
      Array.from(elements.timeline.children)
        .filter((step) => !step.classList.contains("timeline-next-card"))
        .forEach((step, index) => {
          step.classList.toggle("done", index < activeIndex);
          step.classList.toggle("active", index === activeIndex);
        });
    }

    const action = resolveClaimAction(selected);
    const dueLabel = formatActionDueDate(action.due);
    if (elements.nextStepLabel) elements.nextStepLabel.textContent = action.label;
    if (elements.nextStepCopy) elements.nextStepCopy.textContent = action.copy;
    if (elements.nextStepDue) {
      elements.nextStepDue.textContent = dueLabel;
      elements.nextStepDue.classList.toggle("hidden", !dueLabel);
    }
    if (elements.nextStepAction) {
      elements.nextStepAction.textContent = action.button;
      elements.nextStepAction.href = action.href;
      elements.nextStepAction.onclick = () => setCurrentClaimId(selected.id);
    }
    elements.timeline?.querySelector(".timeline-next-card")?.classList.toggle(
      "action-required",
      action.label === "Action required"
    );

    const needsInfo = selected.status_code === "needs_info" || String(selected.final_action).toLowerCase().includes("evidence");
    elements.missingInfoAlert?.classList.toggle("hidden", !needsInfo);
    if (elements.missingInfoCopy) {
      elements.missingInfoCopy.textContent = selected.adjuster_note || "Add clearer photos, repair estimates, or documents before final review.";
    }
  };

  const renderNotificationList = (target, notifications, limit = notifications.length) => {
    if (!target) {
      return;
    }
    target.innerHTML = "";
    if (!notifications.length) {
      const empty = document.createElement("article");
      empty.className = "notification-item empty";
      empty.textContent = "No notifications yet.";
      target.appendChild(empty);
      return;
    }

    notifications.slice(0, limit).forEach((note) => {
      const item = document.createElement("a");
      item.className = "notification-item";
      item.href = "./case-review.html";
      item.addEventListener("click", () => setCurrentClaimId(note.claim_id));
      item.innerHTML = `
        <strong>${escapeHtml(note.title)}</strong>
        <span>${escapeHtml(note.claim_reference)} · ${escapeHtml(note.message)}</span>
      `;
      target.appendChild(item);
    });
  };

  const renderNotifications = () => {
    const notifications = ownClaims
      .flatMap((item) => buildNotifications(item).map((note) => ({
        ...note,
        claim_reference: item.claim_reference,
        claim_id: item.id,
        updated_at: item.updated_at || item.created_at,
      })));

    renderNotificationList(elements.notificationDropdownList, notifications, 5);
    renderNotificationList(elements.notificationsPageList, notifications);

    if (elements.notificationCount) {
      elements.notificationCount.textContent = String(notifications.length);
      elements.notificationCount.classList.toggle("hidden", notifications.length === 0);
    }
  };

  const renderCaseList = () => {
    if (!elements.casesList) {
      return;
    }
    if (!ownClaims.length) {
      renderEmpty(elements.casesList, "No case updates yet", "Your submitted claim will appear here after it is saved.");
      return;
    }

    elements.casesList.innerHTML = "";
    ownClaims.forEach((item) => {
      const card = document.createElement("article");
      card.className = `ops-item ${item.status_code}`;
      const top = document.createElement("div");
      top.className = "ops-item-head";
      top.innerHTML = `<strong>${escapeHtml(item.claim_reference)}</strong><span>${escapeHtml(item.status_label)}</span>`;

      const meta = document.createElement("p");
      meta.textContent = `${item.vehicle_type} · ${item.final_action}`;

      const actions = document.createElement("div");
      actions.className = "ops-item-actions";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "text-action";
      openButton.textContent = isDecisionReviewReady(item) ? "Review decision" : "View claim";
      openButton.addEventListener("click", () => {
        selectedClaimId = item.id;
        setCurrentClaimId(item.id);
        renderSelectedClaim();
      });
      actions.appendChild(openButton);

      if (item.report_ready) {
        const exportButton = document.createElement("button");
        exportButton.type = "button";
        exportButton.className = "text-action";
        exportButton.textContent = "Export report";
        exportButton.addEventListener("click", () => downloadReport(item));
        actions.appendChild(exportButton);
      }

      card.append(top, meta, actions);
      elements.casesList.appendChild(card);
    });
  };

  const renderSimilarCases = async () => {
    if (!elements.similarList) {
      return;
    }
    const selected = ensureSelectedClaim();
    if (!selected) {
      renderEmpty(elements.similarList, "No comparison available", "Claim comparisons are generated privately after review.");
      return;
    }

    renderEmpty(
      elements.similarList,
      "No customer-visible case matches",
      "For privacy, customers only see their own claim. Any comparison to past claims must be anonymized server-side before it is shown."
    );
  };

  const documentSourceLabel = (source = "") => {
    if (source === "employee_adjustment") return "Employee added during review";
    if (source === "customer_added_later") return "Customer added later";
    if (source === "customer_message") return "Customer message attachment";
    if (source === "employee_message") return "Employee message attachment";
    return "Customer submitted";
  };

  const formatFileSize = (size) => {
    const bytes = Number(size) || 0;
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getDocumentKind = (documentItem = {}) => {
    const type = String(documentItem.type || "").toLowerCase();
    const name = String(documentItem.name || "").toLowerCase();
    if (type.includes("pdf") || name.endsWith(".pdf")) return "PDF document";
    if (type.includes("image") || /\.(png|jpe?g|webp|heic)$/i.test(name)) return "Photo evidence";
    if (type.includes("word") || /\.(docx?|rtf)$/i.test(name)) return "Document";
    return "Supporting file";
  };

  const createDocumentCard = (documentItem) => {
    const fileUrl = documentItem.download_url || documentItem.url || documentItem.preview_url || "";
    const wrapper = document.createElement(fileUrl ? "a" : "div");
    wrapper.className = "supporting-doc-card";
    const fileName = documentItem.name || documentItem.filename || documentItem.label || "Supporting document";
    const fileSize = formatFileSize(documentItem.size);
    const fileKind = getDocumentKind(documentItem);
    const source = documentSourceLabel(documentItem.source);
    const meta = [source, fileKind, fileSize].filter(Boolean).join(" · ");
    if (fileUrl) {
      wrapper.href = fileUrl;
      wrapper.target = "_blank";
      wrapper.rel = "noopener noreferrer";
      wrapper.setAttribute("aria-label", `Open ${fileName}`);
      wrapper.addEventListener("click", (event) => {
        event.preventDefault();
        openDocumentPreview(documentItem);
      });
    }
    wrapper.innerHTML = `
      <span class="supporting-doc-icon" aria-hidden="true">DOC</span>
      <span class="supporting-doc-text">
        <strong>${escapeHtml(fileName)}</strong>
        <small>${escapeHtml(meta)}</small>
      </span>
      <span class="supporting-doc-action">${fileUrl ? "Open file" : "File record only"}</span>
    `;
    return wrapper;
  };

  const renderDocuments = (documents, reviewerEvidence = []) => {
    if (!elements.detailDocuments) {
      return;
    }
    elements.detailDocuments.innerHTML = "";
    const allDocuments = [
      ...documents.map((item) => ({ ...item, source: item.source || "customer_submitted" })),
      ...reviewerEvidence.map((item) => ({ ...item, source: item.source || "employee_adjustment" })),
    ];
    if (!allDocuments.length) {
      elements.detailDocuments.textContent = "No supporting documents added.";
      return;
    }
    allDocuments.forEach((documentItem) => {
      elements.detailDocuments.appendChild(createDocumentCard(documentItem));
    });
  };

  const renderDecisionComparison = (selected) => {
    const aiTotal = Number(selected.estimated_total_cost_usd) || 0;
    const adjustedTotal = Number(selected.reviewed_total_cost_usd) || 0;
    const delta = adjustedTotal - aiTotal;
    if (elements.aiEstimate) elements.aiEstimate.textContent = formatCurrency(aiTotal);
    if (elements.adjustedEstimate) elements.adjustedEstimate.textContent = formatCurrency(adjustedTotal);
    if (elements.estimateDelta) {
      elements.estimateDelta.textContent = `${delta >= 0 ? "+" : "-"}${formatCurrency(Math.abs(delta))}`;
      elements.estimateDelta.classList.toggle("positive", delta > 0);
      elements.estimateDelta.classList.toggle("negative", delta < 0);
    }
    const versions = selected.estimate_versions || [];
    if (elements.estimateVersion) {
      elements.estimateVersion.textContent = versions.length ? `Version ${versions.at(-1).version || versions.length}` : "AI first pass";
    }
    if (elements.estimateLines) {
      const lines = selected.estimate_line_items || [];
      elements.estimateLines.innerHTML = lines.length
        ? lines.map((item) => `
          <tr>
            <td>${escapeHtml(item.description || item.category || "Estimate item")}</td>
            <td>${Number(item.quantity) || 0}</td>
            <td>${formatCurrency(item.unit_cost_usd)}</td>
            <td>${formatCurrency(item.total_usd ?? ((Number(item.quantity) || 0) * (Number(item.unit_cost_usd) || 0)))}</td>
          </tr>
        `).join("")
        : '<tr><td colspan="4">No adjusted line items yet.</td></tr>';
    }
    if (elements.estimateHistory) {
      elements.estimateHistory.innerHTML = versions.length
        ? [...versions].reverse().map((version) => `
          <article>
            <strong>Version ${Number(version.version) || 1} · ${formatCurrency(version.reviewed_total_cost_usd)}</strong>
            <p>${escapeHtml(version.actor || "Adjuster")} · ${escapeHtml(formatDate(version.created_at))} · ${escapeHtml(version.reason || "Estimate updated")}</p>
          </article>
        `).join("")
        : "<article>No employee estimate revisions yet.</article>";
    }
  };

  const renderActivity = async (selected) => {
    if (!elements.activityList) return;
    elements.activityList.innerHTML = "<article>Loading claim activity...</article>";
    try {
      const snapshot = await db.collection("case_activity")
        .where("case_id", "==", selected.id)
        .orderBy("created_at", "desc")
        .limit(30)
        .get();
      const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      elements.activityList.innerHTML = events.length
        ? events.map((event) => `
          <article>
            <strong>${escapeHtml(event.label || "Claim updated")}</strong>
            <p>${escapeHtml(event.actor_name || (event.actor_role === "customer" ? "Customer" : "ClaimSight"))} · ${escapeHtml(formatDate(firestoreTimestampToIso(event.created_at)))}</p>
          </article>
        `).join("")
        : "<article>No activity recorded yet.</article>";
    } catch {
      elements.activityList.innerHTML = "<article>Activity is unavailable right now.</article>";
    }
  };

  const addCustomerActivity = async (selected, type, label) => {
    if (!currentCustomer) return;
    await db.collection("case_activity").add({
      case_id: selected.id,
      type,
      label,
      actor_role: "customer",
      actor_uid: currentCustomer.uid,
      actor_name: currentCustomer.displayName || "Customer",
      created_at: window.firebase.firestore.FieldValue.serverTimestamp(),
    });
  };

  const uploadAppealFiles = async (selected) => {
    const files = Array.from(elements.appealFiles?.files || []);
    if (!files.length) return [];
    const uploadedAt = new Date().toISOString();
    if (!storage) {
      return files.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        uploaded_at: uploadedAt,
        source: "customer_appeal",
      }));
    }
    return Promise.all(files.map(async (file) => {
      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "-");
      const ref = storage.ref().child(`claim-supporting-documents/${selected.id}/${Date.now()}-${safeName}`);
      await ref.put(file);
      return {
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        uploaded_at: uploadedAt,
        source: "customer_appeal",
        download_url: await ref.getDownloadURL(),
      };
    }));
  };

  const uploadSupportingDocuments = async (item) => {
    const files = Array.from(elements.supportDocumentsInput?.files || []);
    if (!files.length) {
      return [];
    }
    const uploadedAt = new Date().toISOString();
    if (!storage) {
      return files.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        uploaded_at: uploadedAt,
        source: "customer_added_later",
      }));
    }
    return Promise.all(files.map(async (file) => {
      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "-");
      const ref = storage.ref().child(`claim-supporting-documents/${item.id}/${Date.now()}-${safeName}`);
      await ref.put(file);
      const download_url = await ref.getDownloadURL();
      return {
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        uploaded_at: uploadedAt,
        download_url,
        source: "customer_added_later",
      };
    }));
  };

  const getEditedVehicleContext = (selected) => ({
    make: elements.vehicleMakeInput?.value?.trim() || selected.make || "",
    model: elements.vehicleModelInput?.value?.trim() || selected.model || "",
    trim: elements.vehicleTrimInput?.value?.trim() || selected.trim || "",
    year: parseOptionalInteger(elements.vehicleYearInput?.value) || selected.year || null,
    mileage: parseOptionalInteger(elements.vehicleMileageInput?.value) || selected.mileage || null,
    usage: elements.vehicleUsageInput?.value || selected.usage || "",
  });

  const populateEditClaimFields = (selected) => {
    if (elements.vehicleMakeInput) elements.vehicleMakeInput.value = selected.make || "";
    if (elements.vehicleModelInput) elements.vehicleModelInput.value = selected.model || "";
    if (elements.vehicleTrimInput) elements.vehicleTrimInput.value = selected.trim || "";
    if (elements.vehicleYearInput) elements.vehicleYearInput.value = selected.year || "";
    if (elements.vehicleMileageInput) elements.vehicleMileageInput.value = selected.mileage || "";
    if (elements.vehicleUsageInput) elements.vehicleUsageInput.value = selected.usage || "";
  };

  const updateSelectedCase = async (updates) => {
    const selected = ensureSelectedClaim();
    if (!selected) {
      return;
    }
    const now = window.firebase.firestore.FieldValue.serverTimestamp();
    await casesCollection.doc(selected.id).set(
      {
        ...updates,
        updated_at: now,
      },
      { merge: true }
    );
    await refreshPortal();
  };

  const renderSelectedClaim = () => {
    const selected = ensureSelectedClaim();
    if (!selected) {
      setClaimReviewStatus(elements.detailStatus, "Waiting for selection", "submitted");
      elements.detailEmpty?.classList.remove("hidden");
      elements.detailCard?.classList.add("hidden");
      if (elements.finalStatus) elements.finalStatus.textContent = "Read-only report access";
      elements.finalEmpty?.classList.remove("hidden");
      elements.finalCard?.classList.add("hidden");
      elements.finalExport?.classList.add("hidden");
      return;
    }

    setClaimReviewStatus(elements.detailStatus, selected.status_label, selected.status_code);
    if (elements.detailStatusCopy) elements.detailStatusCopy.textContent = selected.status_label;
    if (elements.detailReference) elements.detailReference.textContent = selected.claim_reference;
    if (elements.detailVehicle) elements.detailVehicle.textContent = selected.vehicle_type;
    if (elements.detailReviewer) elements.detailReviewer.textContent = selected.reviewer_name || selected.assigned_agent?.name || "Pending human review";
    if (elements.detailNote) elements.detailNote.textContent = selected.adjuster_note;
    if (elements.detailReasoning) elements.detailReasoning.textContent = selected.reasoning;
    if (elements.detailAiAction) elements.detailAiAction.textContent = selected.ai_action;
    if (elements.detailFinalAction) elements.detailFinalAction.textContent = selected.final_action;
    renderDocuments(selected.supporting_documents, selected.reviewer_evidence);
    // paints the "your adjuster needs changes" panel and reopens the
    // checklist rows the adjuster flagged
    window.ClaimSightReviewerRequest?.(selected);
    renderDecisionComparison(selected);
    renderActivity(selected);
    populateEditClaimFields(selected);
    elements.detailEmpty?.classList.add("hidden");
    elements.detailCard?.classList.remove("hidden");

    if (elements.inlineExport) {
      elements.inlineExport.classList.toggle("hidden", !selected.report_ready);
      elements.inlineExport.onclick = () => downloadReport(selected);
    }
    if (elements.finalOpen) {
      elements.finalOpen.classList.toggle("hidden", !selected.report_ready);
      elements.finalOpen.onclick = () => setCurrentClaimId(selected.id);
    }
    if (elements.acceptDecision) {
      elements.acceptDecision.classList.toggle("hidden", selected.status_code !== "final_review");
      elements.acceptDecision.onclick = async () => {
        const originalLabel = elements.acceptDecision.textContent;
        elements.acceptDecision.disabled = true;
        elements.acceptDecision.textContent = "Accepting...";
        try {
          await casesCollection.doc(selected.id).set(
            {
              consumer_decision: {
                decision: "accepted",
                decided_at: new Date().toISOString(),
              },
              updated_at: window.firebase.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          await addCustomerActivity(selected, "decision_accepted", "Customer accepted the adjuster decision.");
          await refreshPortal();
        } catch {
          elements.acceptDecision.disabled = false;
          elements.acceptDecision.textContent = originalLabel;
          if (elements.detailNote) elements.detailNote.textContent = "We could not accept the decision. Please try again.";
        }
      };
    }
    if (elements.appealDecision) {
      elements.appealDecision.classList.toggle("hidden", selected.status_code !== "final_review");
      elements.appealDecision.onclick = () => {
        elements.appealBuilder?.classList.remove("hidden");
        elements.appealExplanation?.focus();
      };
    }
    elements.appealClose?.addEventListener("click", () => elements.appealBuilder?.classList.add("hidden"), { once: true });
    if (elements.appealSubmit) {
      elements.appealSubmit.onclick = async () => {
        const explanation = elements.appealExplanation?.value?.trim() || "";
        if (explanation.length < 20) {
          if (elements.appealStatus) elements.appealStatus.textContent = "Explain what should be reconsidered using at least 20 characters.";
          return;
        }
        if (elements.appealStatus) elements.appealStatus.textContent = "Submitting appeal...";
        const appealFiles = await uploadAppealFiles(selected);
        const appeal = {
          category: elements.appealCategory?.value || "other",
          disputed_amount_usd: Number(elements.appealAmount?.value) || 0,
          explanation,
          supporting_files: appealFiles,
          submitted_at: new Date().toISOString(),
        };
        await updateSelectedCase({
          appeal,
          consumer_decision: {
            decision: "appealed",
            decided_at: appeal.submitted_at,
          },
          supporting_documents: [...selected.supporting_documents, ...appealFiles],
        });
        await addCustomerActivity(selected, "appeal_submitted", "Customer submitted an appeal with supporting details.");
        if (elements.appealStatus) elements.appealStatus.textContent = "Appeal submitted for employee review.";
        elements.appealBuilder?.classList.add("hidden");
      };
    }
    if (elements.saveDocuments) {
      elements.saveDocuments.onclick = async () => {
        if (elements.updateStatus) {
          elements.updateStatus.textContent = "Updating claim...";
        }
        const uploaded = await uploadSupportingDocuments(selected);
        const vehicleContext = getEditedVehicleContext(selected);
        const vehicleType = buildVehicleLabel(vehicleContext, selected.vehicle_type);
        await updateSelectedCase({
          claim_context: vehicleContext,
          vehicle_type: vehicleType,
          supporting_documents: [...selected.supporting_documents, ...uploaded],
        });
        if (uploaded.length) {
          await addCustomerActivity(selected, "evidence_added", `Customer added ${uploaded.length} supporting file${uploaded.length === 1 ? "" : "s"}.`);
        }
        if (elements.updateStatus) {
          elements.updateStatus.textContent = uploaded.length
            ? "Claim updated with vehicle changes and new evidence."
            : "Claim updated.";
        }
        if (elements.supportDocumentsInput) {
          elements.supportDocumentsInput.value = "";
        }
      };
    }

    if (elements.finalStatus) elements.finalStatus.textContent = selected.status_label;
    if (elements.finalReference) elements.finalReference.textContent = selected.claim_reference;
    if (elements.finalVehicle) elements.finalVehicle.textContent = selected.vehicle_type;
    if (elements.finalStatusCopy) elements.finalStatusCopy.textContent = selected.status_label;
    if (elements.finalReviewer) elements.finalReviewer.textContent = selected.reviewer_name || selected.assigned_agent?.name || "Pending human review";
    if (elements.finalAction) elements.finalAction.textContent = selected.final_action;
    if (elements.finalTotal) elements.finalTotal.textContent = formatCurrency(selected.reviewed_total_cost_usd);
    if (elements.finalNote) elements.finalNote.textContent = selected.adjuster_note;
    if (elements.finalHistory) {
      const versions = selected.estimate_versions || [];
      elements.finalHistory.innerHTML = versions.length
        ? [...versions].reverse().map((version) => `
          <article>
            <strong>Version ${Number(version.version) || 1} · ${formatCurrency(version.reviewed_total_cost_usd)}</strong>
            <p>${escapeHtml(version.actor || "Adjuster")} · ${escapeHtml(formatDate(version.created_at))} · change ${formatCurrency(Math.abs(Number(version.delta_usd) || 0))}</p>
          </article>
        `).join("")
        : "<article><strong>AI first pass</strong><p>No employee estimate revisions were recorded.</p></article>";
    }
    elements.finalEmpty?.classList.toggle("hidden", selected.report_ready);
    elements.finalCard?.classList.toggle("hidden", !selected.report_ready);
    if (elements.finalExport) {
      elements.finalExport.classList.toggle("hidden", !selected.report_ready);
      if (selected.report_ready) prepareReportDownload(elements.finalExport, selected, elements.finalExportStatus);
    }
  };

  const refreshPortal = async () => {
    if (auth && !currentCustomer) {
      ownClaims = [];
      renderCounts();
      renderDashboardClaims();
      renderCustomerOverview();
      renderNotifications();
      renderCaseList();
      renderSelectedClaim();
      await renderSimilarCases();
      return;
    }

    if (currentCustomer) {
      const snapshot = await casesCollection
        .where("owner_uid", "==", currentCustomer.uid)
        .orderBy("updated_at", "desc")
        .limit(50)
        .get();
      ownClaims = sortClaims(snapshot.docs.map((doc) => normalize(doc.id, doc.data())));
    } else {
      const claimIds = readConsumerClaimIds();
      const snapshots = await Promise.all(claimIds.map((id) => casesCollection.doc(id).get()));
      ownClaims = sortClaims(
        snapshots
          .filter((snapshot) => snapshot.exists)
          .map((snapshot) => normalize(snapshot.id, snapshot.data()))
      );
    }

    renderCounts();
    renderDashboardClaims();
    renderCustomerOverview();
    renderNotifications();
    renderCaseList();
    renderSelectedClaim();
    await renderSimilarCases();
  };

  elements.refreshCases?.addEventListener("click", refreshPortal);
  elements.refreshSimilar?.addEventListener("click", renderSimilarCases);
  elements.notificationToggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = elements.notificationToggle.getAttribute("aria-expanded") === "true";
    elements.notificationToggle.setAttribute("aria-expanded", String(!isOpen));
    elements.notificationDropdown?.classList.toggle("hidden", isOpen);
  });
  document.addEventListener("click", (event) => {
    if (!elements.notificationDropdown || !elements.notificationToggle) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (!elements.notificationDropdown.contains(target) && !elements.notificationToggle.contains(target)) {
      elements.notificationToggle.setAttribute("aria-expanded", "false");
      elements.notificationDropdown.classList.add("hidden");
    }
  });

  window.ClaimSightConsumer = {
    refreshPortal,
    registerClaim: setCurrentClaimId,
    exportReport: downloadReport,
  };

  // Live claim updates. Same query as refreshPortal, but pushed: when an
  // adjuster changes a claim, the customer sees it without reloading.
  // Previously there were no onSnapshot listeners anywhere and no polling, so
  // an employee action stayed invisible until a manual refresh.
  let unsubscribeClaims = null;

  const renderPortalFromClaims = () => {
    renderCounts();
    renderDashboardClaims();
    renderCustomerOverview();
    renderNotifications();
    renderCaseList();
    renderSelectedClaim();
  };

  const subscribeToClaims = (user) => {
    unsubscribeClaims?.();
    unsubscribeClaims = null;
    if (!user) return;
    try {
      unsubscribeClaims = casesCollection
        .where("owner_uid", "==", user.uid)
        .orderBy("updated_at", "desc")
        .limit(50)
        .onSnapshot(
          (snapshot) => {
            ownClaims = sortClaims(
              snapshot.docs.map((doc) => normalize(doc.id, doc.data()))
            );
            renderPortalFromClaims();
          },
          () => {
            // Listener failed (rules, offline). Manual Refresh and the next
            // page load still work, so fail quietly rather than alarm the user.
          }
        );
    } catch {
      unsubscribeClaims = null;
    }
  };

  window.addEventListener("beforeunload", () => unsubscribeClaims?.());

  if (auth) {
    auth.onAuthStateChanged((user) => {
      currentCustomer = user;
      refreshPortal();
      subscribeToClaims(user);
    });
  } else {
    refreshPortal();
  }
} else {
  const dashboardClaims = document.getElementById("consumer-dashboard-claims");
  const notificationToggle = document.getElementById("notification-toggle");
  const notificationCount = document.getElementById("notification-count");
  const notificationDropdown = document.getElementById("notification-dropdown");
  const notificationDropdownList = document.getElementById("notification-dropdown-list");
  const notificationsPageList = document.getElementById("notifications-page-list");
  const previewDetailCard = document.getElementById("consumer-claim-detail");
  const previewDetailEmpty = document.getElementById("consumer-claim-detail-empty");
  const previewDetailStatus = document.getElementById("consumer-detail-status");
  const previewDetailStatusCopy = document.getElementById("consumer-detail-status-copy");
  const previewDetailReference = document.getElementById("consumer-detail-reference");
  const previewDetailVehicle = document.getElementById("consumer-detail-vehicle");
  const previewDetailReviewer = document.getElementById("consumer-detail-reviewer");
  const previewDetailAiAction = document.getElementById("consumer-detail-ai-action");
  const previewDetailFinalAction = document.getElementById("consumer-detail-final-action");
  const previewDetailNote = document.getElementById("consumer-detail-note");
  const previewDetailReasoning = document.getElementById("consumer-detail-reasoning");
  const previewDetailDocuments = document.getElementById("consumer-detail-documents");
  const previewSaveDocuments = document.getElementById("consumer-save-documents");
  const previewSupportDocuments = document.getElementById("consumer-supporting-documents");
  const previewUpdateStatus = document.getElementById("consumer-update-status");
  const previewVehicleMake = document.getElementById("consumer-vehicle-make");
  const previewVehicleModel = document.getElementById("consumer-vehicle-model");
  const previewVehicleTrim = document.getElementById("consumer-vehicle-trim");
  const previewVehicleYear = document.getElementById("consumer-vehicle-year");
  const previewVehicleMileage = document.getElementById("consumer-vehicle-mileage");
  const previewVehicleUsage = document.getElementById("consumer-vehicle-usage");
  const previewOpenFinalReport = document.getElementById("consumer-open-final-report");
  const previewAcceptDecision = document.getElementById("consumer-accept-decision");
  const previewAppealDecision = document.getElementById("consumer-appeal-decision");
  const previewInlineExport = document.getElementById("consumer-inline-export");
  const previewAiEstimate = document.getElementById("consumer-ai-estimate");
  const previewAdjustedEstimate = document.getElementById("consumer-adjusted-estimate");
  const previewEstimateDelta = document.getElementById("consumer-estimate-delta");
  const previewEstimateVersion = document.getElementById("consumer-estimate-version");
  const previewEstimateLines = document.getElementById("consumer-estimate-lines");
  const previewEstimateHistory = document.getElementById("consumer-estimate-history");
  const previewActivityList = document.getElementById("consumer-activity-list");
  const previewAppealBuilder = document.getElementById("consumer-appeal-builder");
  const previewAppealClose = document.getElementById("consumer-close-appeal");
  const previewAppealSubmit = document.getElementById("consumer-submit-appeal");
  const previewAppealExplanation = document.getElementById("consumer-appeal-explanation");
  const previewAppealStatus = document.getElementById("consumer-appeal-status");
  const previewFinalStatus = document.getElementById("consumer-final-status");
  const previewFinalEmpty = document.getElementById("consumer-final-empty");
  const previewFinalCard = document.getElementById("consumer-final-report");
  const previewFinalReference = document.getElementById("consumer-final-reference");
  const previewFinalVehicle = document.getElementById("consumer-final-vehicle");
  const previewFinalStatusCopy = document.getElementById("consumer-final-status-copy");
  const previewFinalReviewer = document.getElementById("consumer-final-reviewer");
  const previewFinalAction = document.getElementById("consumer-final-action");
  const previewFinalTotal = document.getElementById("consumer-final-total");
  const previewFinalNote = document.getElementById("consumer-final-note");
  const previewFinalHistory = document.getElementById("consumer-report-history");
  const previewFinalExport = document.getElementById("consumer-final-export");
  const previewFinalExportStatus = document.getElementById("consumer-final-export-status");
  const previewCasesList = document.getElementById("cases-list");
  const previewSummaryClaim = document.getElementById("customer-summary-claim");
  const previewSummaryMeta = document.getElementById("customer-summary-meta");
  const previewTimelineStatus = document.getElementById("customer-timeline-status");
  const previewTimeline = document.getElementById("customer-claim-timeline");
  const previewNextStepLabel = document.getElementById("customer-next-step-label");
  const previewNextStepCopy = document.getElementById("customer-next-step-copy");
  const previewNextStepDue = document.getElementById("customer-next-step-due");
  const previewNextStepAction = document.getElementById("customer-next-step-action");
  const previewClaims = [
    {
      id: "CLM-1048",
      submitted: new Date().toLocaleDateString(),
      status_code: "in_review",
      status_label: "In review",
      vehicle: "2023 Toyota Camry SE",
      agent: "Alex Morgan",
      next_step: "Alex Morgan is reviewing the AI first pass, photos, and supporting documents before sending a decision.",
      ai_estimate: 5400,
      adjusted_estimate: 5400,
    },
    {
      id: "CLM-1052",
      submitted: new Date(Date.now() - 86400000 * 3).toLocaleDateString(),
      status_code: "needs_info",
      status_label: "Needs more information",
      vehicle: "2021 Honda Accord EX",
      agent: "Jordan Lee",
      next_step: "Jordan Lee needs clearer side-impact photos or a repair estimate before the claim can move forward.",
      requested_evidence: ["one clear left-side damage photo", "a repair estimate"],
      evidence_due_at: new Date(Date.now() + 86400000 * 5).toISOString(),
    },
    {
      id: "CLM-1056",
      submitted: new Date(Date.now() - 86400000 * 8).toLocaleDateString(),
      status_code: "final_review",
      status_label: "Final review",
      vehicle: "2020 Ford F-150 XLT",
      agent: "Sam Rivera",
      next_step: "Your decision is ready to review. You can accept it or appeal with supporting evidence.",
      ai_estimate: 7200,
      adjusted_estimate: 8150,
      estimate_line_items: [
        { description: "Rear bumper assembly", quantity: 1, unit_cost_usd: 2350, total_usd: 2350 },
        { description: "Liftgate alignment and repair", quantity: 1, unit_cost_usd: 3100, total_usd: 3100 },
        { description: "Paint and labor", quantity: 1, unit_cost_usd: 2700, total_usd: 2700 },
      ],
    },
    {
      id: "CLM-1059",
      submitted: new Date(Date.now() - 86400000).toLocaleDateString(),
      status_code: "submitted",
      status_label: "Submitted",
      vehicle: "2019 Subaru Outback Premium",
      agent: "Assignment pending",
      next_step: "Your claim has been submitted and will be assigned to an adjuster.",
    },
  ];
  const previewAcceptedClaims = readPreviewAcceptedClaims();
  previewClaims.forEach((claim) => {
    if (previewAcceptedClaims.has(claim.id)) {
      claim.status_code = "finalized";
      claim.status_label = "Finalized";
      claim.next_step = "Your final report is ready to view and export.";
    }
  });
  const previewStatusIndexMap = {
    submitted: 0,
    in_review: 2,
    needs_info: 2,
    appealed: 2,
    final_review: 3,
    finalized: 4,
  };
  const getSelectedPreviewClaim = () =>
    previewClaims.find((claim) => claim.id === getCurrentClaimId()) || previewClaims[0];
  const previewNotifications = [
    {
      title: "Decision ready",
      claim_reference: "CLM-1056",
      message: "Review the final decision when you are ready.",
    },
    {
      title: "More information needed",
      claim_reference: "CLM-1052",
      message: "Upload clearer photos or a repair estimate.",
    },
    {
      title: "Human review pending",
      claim_reference: "CLM-1048",
      message: "Alex Morgan is reviewing your claim.",
    },
  ];
  const renderPreviewNotifications = (target, limit = previewNotifications.length) => {
    if (!target) {
      return;
    }
    target.innerHTML = previewNotifications.slice(0, limit).map((note) => `
      <a class="notification-item" href="./edit-claim.html">
        <strong>${escapeHtml(note.title)}</strong>
        <span>${escapeHtml(note.claim_reference)} · ${escapeHtml(note.message)}</span>
      </a>
    `).join("");
  };

  renderPreviewNotifications(notificationDropdownList, 5);
  renderPreviewNotifications(notificationsPageList);
  if (notificationCount) {
    notificationCount.textContent = String(previewNotifications.length);
    notificationCount.classList.remove("hidden");
  }
  const renderPreviewOverview = (claim = getSelectedPreviewClaim()) => {
    const activeIndex = previewStatusIndexMap[claim.status_code] ?? 0;
    if (previewSummaryClaim) previewSummaryClaim.textContent = claim.id;
    if (previewSummaryMeta) previewSummaryMeta.textContent = `${claim.vehicle} · ${claim.status_label} · ${claim.agent}`;
    if (previewTimelineStatus) previewTimelineStatus.textContent = claim.status_label;
    if (previewTimeline) {
      previewTimeline.style.setProperty("--timeline-step", String(activeIndex));
      Array.from(previewTimeline.children)
        .filter((step) => !step.classList.contains("timeline-next-card"))
        .forEach((step, index) => {
          step.classList.toggle("done", index < activeIndex);
          step.classList.toggle("active", index === activeIndex);
        });
    }
    const action = resolveClaimAction(claim);
    const dueLabel = formatActionDueDate(action.due);
    if (previewNextStepLabel) previewNextStepLabel.textContent = action.label;
    if (previewNextStepCopy) previewNextStepCopy.textContent = action.copy;
    if (previewNextStepDue) {
      previewNextStepDue.textContent = dueLabel;
      previewNextStepDue.classList.toggle("hidden", !dueLabel);
    }
    if (previewNextStepAction) {
      previewNextStepAction.textContent = action.button;
      previewNextStepAction.href = action.href;
      previewNextStepAction.onclick = () => setCurrentClaimId(claim.id);
    }
    previewTimeline?.querySelector(".timeline-next-card")?.classList.toggle(
      "action-required",
      action.label === "Action required"
    );
    document.querySelectorAll("[data-preview-select]").forEach((row) => {
      row.classList.toggle("selected", row.dataset.previewSelect === claim.id);
    });
  };
  notificationToggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = notificationToggle.getAttribute("aria-expanded") === "true";
    notificationToggle.setAttribute("aria-expanded", String(!isOpen));
    notificationDropdown?.classList.toggle("hidden", isOpen);
  });
  document.addEventListener("click", (event) => {
    if (!notificationDropdown || !notificationToggle) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (!notificationDropdown.contains(target) && !notificationToggle.contains(target)) {
      notificationToggle.setAttribute("aria-expanded", "false");
      notificationDropdown.classList.add("hidden");
    }
  });

  const draft = readConsumerDraft();
  if (dashboardClaims) {
    const draftRow = draft ? `
      <tr class="claim-row draft">
        <td>—</td>
        <td><strong>${escapeHtml(draft.draft_id || "Draft")}</strong></td>
        <td>In progress</td>
        <td><a class="text-action" href="./new-claim.html">Continue</a></td>
      </tr>
    ` : "";
    const buildPreviewActions = (claim) => {
      const decisionReady = isDecisionReviewReady(claim);
      const primaryHref = decisionReady ? "./case-review.html" : "./edit-claim.html";
      const primaryLabel = decisionReady ? "Review decision" : "View claim";
      return `
        <td class="claim-row-actions">
          <details class="claim-action-menu">
            <summary>Actions</summary>
            <div class="claim-action-list">
              <a class="claim-action-item" href="${primaryHref}" data-preview-claim="${escapeHtml(claim.id)}">${primaryLabel}</a>
              <a class="claim-action-item" href="./edit-claim.html#edit-claim-evidence" data-preview-claim="${escapeHtml(claim.id)}">Edit claim</a>
              <a class="claim-action-item" href="./messages.html?claim=${encodeURIComponent(claim.id)}" data-preview-claim="${escapeHtml(claim.id)}">Message</a>
            </div>
          </details>
        </td>
      `;
    };
    dashboardClaims.innerHTML = `
      ${draftRow}
      ${previewClaims.map((claim) => `
        <tr class="claim-row ${escapeHtml(claim.status_code)}" data-preview-select="${escapeHtml(claim.id)}">
          <td>${escapeHtml(claim.submitted)}</td>
          <td><strong>${escapeHtml(claim.id)}</strong></td>
          <td>${escapeHtml(claim.status_label)}</td>
          ${buildPreviewActions(claim)}
        </tr>
      `).join("")}
    `;
    dashboardClaims.querySelectorAll("[data-preview-claim]").forEach((link) => {
      link.addEventListener("click", () => setCurrentClaimId(link.dataset.previewClaim));
    });
    dashboardClaims.querySelectorAll("[data-preview-select]").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("a, button, summary, details")) {
          return;
        }
        const claim = previewClaims.find((item) => item.id === row.dataset.previewSelect);
        if (!claim) {
          return;
        }
        setCurrentClaimId(claim.id);
        renderPreviewOverview(claim);
      });
    });
    renderPreviewOverview();
  }

  if (previewCasesList) {
    const listedClaim = getSelectedPreviewClaim();
    previewCasesList.innerHTML = `
      <article class="ops-item ${escapeHtml(listedClaim.status_code)}">
        <div class="ops-item-head">
          <strong>${escapeHtml(listedClaim.id)}</strong>
          <span>${escapeHtml(listedClaim.status_label)}</span>
        </div>
        <p>${escapeHtml(listedClaim.vehicle)} · ${escapeHtml(listedClaim.agent)}</p>
      </article>
    `;
  }

  if (previewDetailCard) {
    const detailClaim = getSelectedPreviewClaim();
    const aiTotal = Number(detailClaim.ai_estimate) || 5400;
    const adjustedTotal = Number(detailClaim.adjusted_estimate) || aiTotal;
    previewDetailEmpty?.classList.add("hidden");
    previewDetailCard.classList.remove("hidden");
    setClaimReviewStatus(previewDetailStatus, detailClaim.status_label, detailClaim.status_code);
    if (previewDetailStatusCopy) previewDetailStatusCopy.textContent = detailClaim.status_label;
    if (previewDetailReference) previewDetailReference.textContent = detailClaim.id;
    if (previewDetailVehicle) previewDetailVehicle.textContent = detailClaim.vehicle;
    if (previewVehicleMake) previewVehicleMake.value = "Toyota";
    if (previewVehicleModel) previewVehicleModel.value = "Camry";
    if (previewVehicleTrim) previewVehicleTrim.value = "SE";
    if (previewVehicleYear) previewVehicleYear.value = "2023";
    if (previewVehicleMileage) previewVehicleMileage.value = "24500";
    if (previewVehicleUsage) previewVehicleUsage.value = "Personal";
    if (previewDetailReviewer) previewDetailReviewer.textContent = detailClaim.agent;
    if (previewDetailAiAction) previewDetailAiAction.textContent = "Moderate rear-end repair likely";
    const previewHasHumanDecision = ["final_review", "finalized"].includes(detailClaim.status_code);
    if (previewDetailFinalAction) previewDetailFinalAction.textContent = previewHasHumanDecision
      ? `Approved repair estimate after human review`
      : "Waiting for adjuster review";
    if (previewDetailNote) previewDetailNote.textContent = detailClaim.status_code === "finalized"
      ? "You accepted the adjuster decision. The final report is ready."
      : previewHasHumanDecision
        ? `${detailClaim.agent} completed the human review and updated the estimate.`
        : "The claim is still before the adjuster, so there is no decision to review yet.";
    if (previewDetailReasoning) previewDetailReasoning.textContent = previewHasHumanDecision
      ? "The adjuster added liftgate alignment work and revised paint labor after comparing the photos with the AI first pass."
      : "Initial AI pass flagged rear bumper damage, possible liftgate alignment issues, and requested supporting photos if available.";
    if (previewDetailDocuments) {
      previewDetailDocuments.innerHTML = "";
      [
        {
          name: "rear-damage-photo-1.jpg",
          type: "image/jpeg",
          size: 1420000,
          preview_url: "assets/damage-hero-center.jpg",
          source: "customer_submitted",
        },
        {
          name: "repair-estimate-upload.pdf",
          type: "application/pdf",
          size: 318000,
          preview_url: samplePdfDataUrl,
          source: "customer_added_later",
        },
      ].forEach((item) => previewDetailDocuments.appendChild(createDocumentCard(item)));
    }
    if (previewAiEstimate) previewAiEstimate.textContent = formatCurrency(aiTotal);
    if (previewAdjustedEstimate) previewAdjustedEstimate.textContent = formatCurrency(adjustedTotal);
    if (previewEstimateDelta) previewEstimateDelta.textContent = `${adjustedTotal >= aiTotal ? "+" : "-"}${formatCurrency(Math.abs(adjustedTotal - aiTotal))}`;
    if (previewEstimateVersion) previewEstimateVersion.textContent = previewHasHumanDecision ? "Version 1" : "AI first pass";
    if (previewEstimateLines) {
      previewEstimateLines.innerHTML = detailClaim.estimate_line_items?.length
        ? detailClaim.estimate_line_items.map((item) => `<tr><td>${escapeHtml(item.description)}</td><td>${item.quantity}</td><td>${formatCurrency(item.unit_cost_usd)}</td><td>${formatCurrency(item.total_usd)}</td></tr>`).join("")
        : '<tr><td colspan="4">No employee adjustment yet.</td></tr>';
    }
    if (previewEstimateHistory) previewEstimateHistory.innerHTML = previewHasHumanDecision
      ? `<article><strong>Version 1 · ${formatCurrency(adjustedTotal)}</strong><p>${escapeHtml(detailClaim.agent)} · Human adjustment completed</p></article>`
      : "<article>No employee estimate revisions yet.</article>";
    if (previewActivityList) {
      const reviewCompleted = ["final_review", "finalized"].includes(detailClaim.status_code)
        ? `<article><strong>${escapeHtml(detailClaim.agent)} completed the human review</strong><p>${escapeHtml(detailClaim.agent)} · Estimate and reasoning submitted</p></article>`
        : "";
      const decisionAccepted = detailClaim.status_code === "finalized"
        ? "<article><strong>Decision accepted</strong><p>Customer · Final report generated</p></article>"
        : "";
      previewActivityList.innerHTML = `
        ${decisionAccepted}
        ${reviewCompleted}
        <article><strong>Claim assigned to ${escapeHtml(detailClaim.agent)}</strong><p>ClaimSight · Assignment completed</p></article>
        <article><strong>Claim submitted</strong><p>Customer · ${escapeHtml(detailClaim.submitted)}</p></article>
      `;
    }
    previewOpenFinalReport?.classList.toggle("hidden", detailClaim.status_code !== "finalized");
    if (previewOpenFinalReport) previewOpenFinalReport.href = `./final-report.html?claim=${encodeURIComponent(detailClaim.id)}`;
    previewAcceptDecision?.classList.toggle("hidden", detailClaim.status_code !== "final_review");
    previewAppealDecision?.classList.toggle("hidden", detailClaim.status_code !== "final_review");
    if (previewAcceptDecision) previewAcceptDecision.onclick = () => {
      markPreviewClaimAccepted(detailClaim.id);
      detailClaim.status_code = "finalized";
      detailClaim.status_label = "Finalized";
      setClaimReviewStatus(previewDetailStatus, "Finalized", "finalized");
      if (previewDetailStatusCopy) previewDetailStatusCopy.textContent = "Finalized";
      if (previewDetailNote) previewDetailNote.textContent = "You accepted the adjuster decision. The final report is ready.";
      previewAcceptDecision.classList.add("hidden");
      previewAppealDecision?.classList.add("hidden");
      previewAppealBuilder?.classList.add("hidden");
      previewOpenFinalReport?.classList.remove("hidden");
      if (previewActivityList) {
        previewActivityList.insertAdjacentHTML("afterbegin", "<article><strong>Decision accepted</strong><p>Customer · Just now</p></article>");
      }
    };
    if (previewAppealDecision) previewAppealDecision.onclick = () => previewAppealBuilder?.classList.remove("hidden");
    if (previewAppealClose) previewAppealClose.onclick = () => previewAppealBuilder?.classList.add("hidden");
    if (previewAppealSubmit) previewAppealSubmit.onclick = () => {
      if ((previewAppealExplanation?.value?.trim().length || 0) < 20) {
        if (previewAppealStatus) previewAppealStatus.textContent = "Add a specific explanation using at least 20 characters.";
        return;
      }
      if (previewAppealStatus) previewAppealStatus.textContent = "Preview appeal submitted for employee review.";
      previewAppealBuilder?.classList.add("hidden");
    };
    previewInlineExport?.classList.add("hidden");
  }

  if (previewFinalCard) {
    const finalClaim = getSelectedPreviewClaim();
    const reportReady = finalClaim.status_code === "finalized";
    const finalTotal = Number(finalClaim.adjusted_estimate || finalClaim.ai_estimate) || 0;
    if (previewFinalStatus) previewFinalStatus.textContent = reportReady ? "Finalized" : "Report unavailable";
    previewFinalEmpty?.classList.toggle("hidden", reportReady);
    previewFinalCard.classList.toggle("hidden", !reportReady);
    previewFinalExport?.classList.toggle("hidden", !reportReady);
    if (reportReady) {
      if (previewFinalReference) previewFinalReference.textContent = finalClaim.id;
      if (previewFinalVehicle) previewFinalVehicle.textContent = finalClaim.vehicle;
      if (previewFinalStatusCopy) previewFinalStatusCopy.textContent = "Finalized";
      if (previewFinalReviewer) previewFinalReviewer.textContent = finalClaim.agent;
      if (previewFinalAction) previewFinalAction.textContent = "Approved adjusted repair estimate";
      if (previewFinalTotal) previewFinalTotal.textContent = formatCurrency(finalTotal);
      if (previewFinalNote) previewFinalNote.textContent = "The customer accepted the reviewed decision and the claim package is finalized.";
      if (previewFinalHistory) previewFinalHistory.innerHTML = `<article><strong>Version 1 · ${formatCurrency(finalTotal)}</strong><p>${escapeHtml(finalClaim.agent)} · Final customer-approved report</p></article>`;
      if (previewFinalExport) {
        prepareReportDownload(previewFinalExport, {
          claim_reference: finalClaim.id,
          vehicle_type: finalClaim.vehicle,
          status_label: "Finalized",
          reviewer_name: finalClaim.agent,
          final_action: "Approved adjusted repair estimate",
          reviewed_total_cost_usd: finalTotal,
          adjuster_note: "The customer accepted the reviewed decision and the claim package is finalized.",
          reasoning: "The adjuster reviewed the AI first pass, submitted evidence, repair scope, and labor requirements.",
          estimate_line_items: finalClaim.estimate_line_items || [],
        }, previewFinalExportStatus);
      }
    }
  }

  previewSaveDocuments?.addEventListener("click", () => {
    const files = Array.from(previewSupportDocuments?.files || []);
    const vehicleContext = {
      year: parseOptionalInteger(previewVehicleYear?.value),
      make: previewVehicleMake?.value?.trim() || "",
      model: previewVehicleModel?.value?.trim() || "",
      trim: previewVehicleTrim?.value?.trim() || "",
      mileage: parseOptionalInteger(previewVehicleMileage?.value),
      usage: previewVehicleUsage?.value || "",
    };
    const vehicleLabel = buildVehicleLabel(vehicleContext, "2023 Toyota Camry");
    if (previewDetailVehicle) {
      previewDetailVehicle.textContent = vehicleLabel;
    }
    if (previewDetailDocuments && files.length) {
      files.forEach((file) => {
        const item = document.createElement("span");
        item.textContent = `Customer added later · ${file.name}`;
        previewDetailDocuments.appendChild(item);
      });
    }
    if (previewSupportDocuments) {
      previewSupportDocuments.value = "";
    }
    if (previewUpdateStatus) {
      previewUpdateStatus.textContent = files.length
        ? "Claim updated with vehicle changes and new evidence."
        : "Claim updated.";
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// EDIT CLAIM — live evidence checklist + upload tagging
//
// The checklist on edit-claim.html was static markup: "Clear damage
// photos" and "Accurate vehicle details" carried a hardcoded `needed`
// class, so they showed red permanently no matter what the claimant
// filled in or attached. Nothing in this file ever touched them.
//
// This module is deliberately self-contained and DOM-driven. The page
// has two population paths (the Firebase branch and the preview
// branch), and both write the same element ids, so observing the DOM
// covers each without editing either.
// ══════════════════════════════════════════════════════════════════
(() => {
  const detail = document.getElementById("consumer-claim-detail");
  const checkRows = document.querySelectorAll("[data-edit-check]");
  if (!detail || checkRows.length === 0) return;

  const docsInput = document.getElementById("consumer-supporting-documents");
  const docLinks = document.getElementById("consumer-doc-links");
  const existingDocs = document.getElementById("consumer-detail-documents");
  const saveButton = document.getElementById("consumer-save-documents");
  const updateStatus = document.getElementById("consumer-update-status");

  const vehicleFields = [
    "consumer-vehicle-make",
    "consumer-vehicle-model",
    "consumer-vehicle-year",
    "consumer-vehicle-mileage",
    "consumer-vehicle-usage",
  ].map((id) => document.getElementById(id));

  const evidenceTypes = [
    { key: "photos", label: "Damage photo" },
    { key: "estimate", label: "Repair estimate or invoice" },
    { key: "documents", label: "Police, tow, or storage document" },
  ];

  // Object URLs for staged files, revoked whenever the list is rebuilt
  // so picking new files repeatedly does not leak them.
  let objectUrls = [];
  const releaseObjectUrls = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls = [];
  };

  const fileKindLabel = (file) => {
    const name = file.name.toLowerCase();
    if (file.type.includes("pdf") || name.endsWith(".pdf")) return "PDF";
    if (file.type.includes("word") || /\.(docx?|rtf)$/.test(name)) return "DOC";
    return "FILE";
  };

  // A staged upload is only a filename until you can look at it, so
  // each row gets a thumbnail (real image preview where possible) and
  // a View control that opens the existing document preview modal —
  // the same one saved attachments use.
  const stagedPreview = (file) => {
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    const isImage = file.type.startsWith("image/");

    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = `evidence-link-thumb${isImage ? " photo" : ""}`;
    thumb.setAttribute("aria-label", `Preview ${file.name}`);
    if (isImage) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      thumb.appendChild(img);
    } else {
      const chip = document.createElement("span");
      chip.textContent = fileKindLabel(file);
      thumb.appendChild(chip);
    }

    const view = document.createElement("button");
    view.type = "button";
    view.className = "evidence-link-view";
    view.textContent = "View";

    const open = () => openDocumentPreview({
      name: file.name,
      type: file.type,
      size: file.size,
      preview_url: url,
    });
    thumb.addEventListener("click", open);
    view.addEventListener("click", open);

    return { thumb, view };
  };

  // Parallel to docsInput.files; a FileList cannot be annotated and is
  // replaced wholesale each time the claimant picks files.
  let tags = [];

  // What is already on the claim. The document cards mark image
  // attachments with .supporting-doc-icon.photo, which is a real
  // structural signal — unlike guessing from the filename. It does not
  // distinguish an estimate from any other PDF, so "Repair estimate"
  // is only satisfied by an upload the claimant tags as one.
  const existingPhoto = () => Boolean(existingDocs?.querySelector(".supporting-doc-icon.photo"));
  const existingOtherFile = () =>
    [...(existingDocs?.querySelectorAll(".supporting-doc-card") || [])]
      .some((card) => !card.querySelector(".supporting-doc-icon.photo"));

  const staged = (key) => tags.some((tag) => tag === key);

  const checks = {
    submitted: () => true,
    photos: () => existingPhoto() || staged("photos"),
    vehicle: () => vehicleFields.every((el) => Boolean(el && String(el.value).trim())),
    estimate: () => staged("estimate"),
    documents: () => existingOtherFile() || staged("documents"),
  };

  // The adjuster can reopen specific sections. Evidence already on the
  // claim does NOT satisfy a reopened row — the whole point is that
  // what is there was not good enough — so a reopened row only clears
  // once something *new* is staged for it in this session.
  let reopened = new Set();

  const satisfiedAfterRequest = (key) => {
    if (key === "vehicle") return checks.vehicle();
    return staged(key === "photos" ? "photos" : key);
  };

  const paintChecklist = () => {
    checkRows.forEach((row) => {
      const key = row.dataset.editCheck;
      const optional = row.classList.contains("optional");
      const isReopened = reopened.has(key);
      const done = isReopened ? satisfiedAfterRequest(key) : (checks[key]?.() ?? false);

      row.classList.toggle("complete", done);
      // A reopened row reads red even when it is optional: the adjuster
      // asked for it, so it is no longer merely nice to have.
      row.classList.toggle("needed", !done && (!optional || isReopened));
      row.classList.toggle("reopened", isReopened && !done);
    });
  };

  // Reads the reviewer's request off the claim detail and paints the
  // panel above the checklist.
  const applyReviewerRequest = (claim) => {
    const panel = document.getElementById("reviewer-request-panel");
    const noteEl = document.getElementById("reviewer-request-note");
    const itemsEl = document.getElementById("reviewer-request-items");
    const dueEl = document.getElementById("reviewer-request-due");
    if (!panel) return;

    const types = Array.isArray(claim?.requested_evidence_types) ? claim.requested_evidence_types : [];
    const note = claim?.reviewer_request_note || "";
    const open = claim?.status_code === "needs_info" && (types.length > 0 || Boolean(note));

    reopened = open ? new Set(types) : new Set();
    panel.classList.toggle("hidden", !open);

    if (open) {
      if (noteEl) noteEl.textContent = note || "Your adjuster needs clearer evidence before the review can continue.";
      const labels = {
        photos: "Damage photos",
        vin: "VIN / odometer photo",
        estimate: "Repair estimate or invoice",
        documents: "Police, tow, or storage documents",
        vehicle: "Vehicle details",
      };
      if (itemsEl) {
        const specifics = Array.isArray(claim.requested_evidence) ? claim.requested_evidence : [];
        itemsEl.innerHTML = types.map((t) => `<li>${labels[t] || t}</li>`).join("")
          + specifics.map((sItem) => `<li class="specific">${String(sItem).replace(/[&<>"']/g, (c) => (
              { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
            ))}</li>`).join("");
      }
      if (dueEl) {
        const due = Date.parse(claim.evidence_due_at || "");
        dueEl.textContent = due ? `Due ${new Date(due).toLocaleDateString()}` : "";
      }
    }
    paintChecklist();
  };

  window.ClaimSightReviewerRequest = applyReviewerRequest;

  const untaggedCount = () =>
    [...(docsInput?.files || [])].filter((_, i) => !tags[i]).length;

  const renderDocLinks = () => {
    if (!docLinks) return;
    const files = [...(docsInput?.files || [])];
    releaseObjectUrls();
    docLinks.innerHTML = "";
    docLinks.classList.toggle("hidden", files.length === 0);

    files.forEach((file, index) => {
      const row = document.createElement("div");
      row.className = "evidence-link-row";

      const { thumb, view } = stagedPreview(file);

      const name = document.createElement("span");
      name.className = "evidence-link-name";
      name.textContent = file.name;

      const select = document.createElement("select");
      select.className = "evidence-link-select";
      select.setAttribute("aria-label", `What ${file.name} shows`);
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
      select.value = tags[index] || "";
      select.addEventListener("change", () => {
        tags[index] = select.value;
        row.classList.toggle("untagged", !select.value);
        if (select.value) row.classList.remove("field-invalid");
        // stop the blocked-update warning showing once it is resolved
        if (untaggedCount() === 0 && updateStatus?.classList.contains("status-error")) {
          updateStatus.textContent = "Make changes, then press Update claim.";
          updateStatus.classList.remove("status-error");
        }
        paintChecklist();
      });

      row.classList.toggle("untagged", !tags[index]);
      row.append(thumb, name, select, view);
      docLinks.appendChild(row);
    });
  };

  docsInput?.addEventListener("change", () => {
    tags = [...(docsInput.files || [])].map(() => "");
    renderDocLinks();
    paintChecklist();
  });

  vehicleFields.forEach((el) => {
    el?.addEventListener("input", paintChecklist);
    el?.addEventListener("change", paintChecklist);
  });

  // An untagged upload says nothing about what was supplied, so it
  // blocks the update the same way a missing field blocks submit.
  saveButton?.addEventListener(
    "click",
    (event) => {
      const untagged = untaggedCount();
      if (!untagged) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      docLinks?.querySelectorAll(".evidence-link-row.untagged")
        .forEach((row) => row.classList.add("field-invalid"));
      if (updateStatus) {
        updateStatus.textContent = `${untagged} upload${untagged === 1 ? "" : "s"} ${
          untagged === 1 ? "needs" : "need"
        } an evidence type before you can update the claim.`;
        updateStatus.classList.add("status-error");
      }
    },
    true // capture, so this runs before the existing save handler
  );

  // The claim detail is filled in asynchronously by whichever branch is
  // live, so repaint when it changes rather than once at load.
  new MutationObserver(paintChecklist).observe(detail, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  paintChecklist();
})();
