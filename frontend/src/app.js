const apiBaseUrl = (window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
const maxClientUploadBytes = 8 * 1024 * 1024;
const maxImages = 8;
const allowedClientMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const elements = {
  backendUrlLabel: document.getElementById("backend-url-label"),
  form: document.getElementById("upload-form"),
  fileInput: document.getElementById("claim-image"),
  dropzone: document.getElementById("dropzone"),
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
  severity: document.getElementById("overall-severity"),
  repairability: document.getElementById("repairability"),
  estimatedCost: document.getElementById("estimated-cost"),
  recommendedAction: document.getElementById("recommended-action"),
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
  regions: document.getElementById("regions-list"),
  regionCount: document.getElementById("region-count"),
  downloadReport: document.getElementById("download-report"),
};

elements.backendUrlLabel.textContent = apiBaseUrl ? "Backend connected" : "Backend URL missing";

let latestAssessment = null;
// Ordered list of { file, dataUrl }. The array index is the image_index the
// backend uses for each detected region.
let selectedImages = [];
let activeImageIndex = 0;

const setStatus = (message) => {
  elements.status.textContent = message;
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

// The upload queue is the primary "what have I added" view, shown under the dropzone.
const renderQueue = () => {
  elements.queueList.innerHTML = "";
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

    // Clicking the item previews that image.
    li.addEventListener("click", () => setActiveImage(index));
    li.append(thumb, meta, remove);
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
    selectedImages.push({ file, dataUrl });
    added += 1;
  }

  if (added === 0 && selectedImages.length === 0) {
    return;
  }

  // New images invalidate any prior assessment.
  latestAssessment = null;
  elements.damageOverlay.innerHTML = "";
  elements.downloadReport.classList.add("hidden");
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
  elements.downloadReport.classList.add("hidden");
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
  elements.downloadReport.classList.add("hidden");
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
  elements.filename.textContent =
    imageCount > 1 ? `${imageCount} images` : payload.filename;
  elements.vehicleType.textContent = payload.vehicle_type || "—";
  const vehicleValue = payload.estimated_vehicle_value_usd || 0;
  elements.vehicleValue.textContent =
    vehicleValue > 0 ? `$${vehicleValue.toLocaleString()}` : "Unknown";
  elements.severity.textContent = payload.overall_severity;
  elements.repairability.textContent = payload.repairability;
  elements.estimatedCost.textContent = `$${payload.estimated_total_cost_usd.toLocaleString()}`;
  elements.recommendedAction.textContent = payload.recommended_action;
  elements.segmentationProvider.textContent = payload.meta.segmentation_provider;
  elements.reportProvider.textContent = payload.meta.report_provider;
  elements.fallbackNote.textContent = payload.meta.fallback_used
    ? "Fallback summary used."
    : "Narrative generated from visual review.";
  elements.summaryText.textContent = payload.summary;
  renderEvidence(payload);
};

// Show the reasoning and the web sources behind the valuation / total-loss call,
// so the AI decision is backed by evidence an adjuster can check.
const renderEvidence = (payload) => {
  const reason = payload.total_loss_reason || "";
  const sources = payload.sources || [];
  const queries = payload.search_queries || [];

  if (reason) {
    elements.totalLossReason.textContent = reason;
    elements.reasonBlock.classList.remove("hidden");
  } else {
    elements.reasonBlock.classList.add("hidden");
  }

  elements.sourcesList.innerHTML = "";
  if (sources.length) {
    sources.forEach((src) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = src.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = src.title || src.url;
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

  elements.evidence.classList.toggle("hidden", !reason && !sources.length);
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

    const tag = document.createElement("span");
    tag.className = "damage-tag";
    tag.textContent = `${region.part_id || ""} ${region.panel}`.trim();

    box.appendChild(tag);
    elements.damageOverlay.appendChild(box);
  });
};

const downloadAssessmentReport = () => {
  if (!latestAssessment) {
    return;
  }

  const blob = new Blob([JSON.stringify(latestAssessment, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${latestAssessment.filename || "claim-assessment"}.json`;
  link.click();
  URL.revokeObjectURL(url);
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

  if (!apiBaseUrl) {
    setStatus("Set VITE_API_BASE_URL before running the frontend.");
    return;
  }

  if (selectedImages.length === 0) {
    setStatus("Add at least one image before submitting.");
    return;
  }

  const formData = new FormData();
  selectedImages.forEach((item) => formData.append("files", item.file));

  setStatus(
    selectedImages.length > 1
      ? `Assessing ${selectedImages.length} images...`
      : "Assessing claim..."
  );

  try {
    const response = await fetch(`${apiBaseUrl}/api/assess`, {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || "Assessment failed.");
    }

    latestAssessment = payload;
    updateSummary(payload);
    renderRegions(payload.regions);
    renderThumbs();
    renderQueue();
    elements.downloadReport.classList.remove("hidden");
    renderActiveOverlay();
    setStatus("Assessment complete.");
  } catch (error) {
    setStatus(error.message || "Something went wrong.");
  }
});

elements.previewImage.addEventListener("load", renderActiveOverlay);

elements.downloadReport.addEventListener("click", downloadAssessmentReport);

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
