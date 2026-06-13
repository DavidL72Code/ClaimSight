const apiBaseUrl = (window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
const maxClientUploadBytes = 8 * 1024 * 1024;
const allowedClientMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const elements = {
  backendUrlLabel: document.getElementById("backend-url-label"),
  form: document.getElementById("upload-form"),
  fileInput: document.getElementById("claim-image"),
  dropzone: document.getElementById("dropzone"),
  emptyPreview: document.getElementById("empty-preview"),
  previewImage: document.getElementById("preview-image"),
  damageOverlay: document.getElementById("damage-overlay"),
  imageState: document.getElementById("image-state"),
  status: document.getElementById("status"),
  filename: document.getElementById("filename"),
  severity: document.getElementById("overall-severity"),
  repairability: document.getElementById("repairability"),
  estimatedCost: document.getElementById("estimated-cost"),
  recommendedAction: document.getElementById("recommended-action"),
  segmentationProvider: document.getElementById("segmentation-provider"),
  reportProvider: document.getElementById("report-provider"),
  fallbackNote: document.getElementById("fallback-note"),
  summaryText: document.getElementById("summary-text"),
  regions: document.getElementById("regions-list"),
  regionCount: document.getElementById("region-count"),
  downloadReport: document.getElementById("download-report"),
};

elements.backendUrlLabel.textContent = apiBaseUrl ? "Backend connected" : "Backend URL missing";

let latestAssessment = null;

const isValidClientImage = (file) => {
  if (!allowedClientMimeTypes.has(file.type)) {
    setStatus("Use a JPG, PNG, or WebP image.");
    return false;
  }

  if (file.size > maxClientUploadBytes) {
    setStatus("Image must be smaller than 8 MB.");
    return false;
  }

  return true;
};

const renderPreview = (file) => {
  if (!isValidClientImage(file)) {
    elements.fileInput.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    elements.previewImage.src = reader.result;
    elements.previewImage.classList.remove("hidden");
    elements.emptyPreview.classList.add("hidden");
    elements.imageState.textContent = "Photo loaded";
    elements.damageOverlay.innerHTML = "";
    latestAssessment = null;
    elements.downloadReport.classList.add("hidden");
    elements.dropzone.querySelector(".drop-title").textContent = file.name;
    elements.dropzone.querySelector(".drop-subtitle").textContent = "Ready to assess";
  };
  reader.readAsDataURL(file);
};

const setStatus = (message) => {
  elements.status.textContent = message;
};

const updateSummary = (payload) => {
  elements.filename.textContent = payload.filename;
  elements.severity.textContent = payload.overall_severity;
  elements.repairability.textContent = payload.repairability;
  elements.estimatedCost.textContent = `$${payload.estimated_total_cost_usd}`;
  elements.recommendedAction.textContent = payload.recommended_action;
  elements.segmentationProvider.textContent = payload.meta.segmentation_provider;
  elements.reportProvider.textContent = payload.meta.report_provider;
  elements.fallbackNote.textContent = payload.meta.fallback_used
    ? "Fallback summary used."
    : "Narrative generated from visual review.";
  elements.summaryText.textContent = payload.summary;
};

const renderRegions = (regions) => {
  elements.regions.innerHTML = "";
  elements.regionCount.textContent = `${regions.length} ${regions.length === 1 ? "region" : "regions"}`;
  regions.forEach((region, index) => {
    const card = document.createElement("article");
    card.className = "region-row";
    const indexNode = document.createElement("span");
    const panel = document.createElement("strong");
    const damage = document.createElement("span");
    const confidence = document.createElement("span");
    const cost = document.createElement("span");
    const source = document.createElement("span");

    indexNode.className = "region-index";
    indexNode.textContent = String(index + 1);
    panel.textContent = region.panel;
    damage.textContent = `${region.damage_type} / ${region.severity}`;
    confidence.textContent = `${(region.confidence * 100).toFixed(0)}%`;
    cost.textContent = `$${region.estimated_repair_cost_usd}`;
    source.textContent = region.source;

    card.append(indexNode, panel, damage, confidence, cost, source);
    elements.regions.appendChild(card);
  });
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

const renderDamageOverlay = (regions) => {
  elements.damageOverlay.innerHTML = "";

  if (!regions?.length || elements.previewImage.classList.contains("hidden")) {
    return;
  }

  regions.forEach((region, index) => {
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
    tag.dataset.index = String(index + 1);
    tag.textContent = `${region.panel}`;

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
  const [file] = elements.fileInput.files;
  if (file) {
    renderPreview(file);
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
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }

  if (!isValidClientImage(file)) {
    return;
  }

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  elements.fileInput.files = dataTransfer.files;
  renderPreview(file);
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [file] = elements.fileInput.files;

  if (!apiBaseUrl) {
    setStatus("Set VITE_API_BASE_URL before running the frontend.");
    return;
  }

  if (!file) {
    setStatus("Choose an image before submitting.");
    return;
  }

  if (!isValidClientImage(file)) {
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  setStatus("Assessing claim...");

  try {
    const response = await fetch(`${apiBaseUrl}/api/assess`, {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || "Assessment failed.");
    }

    updateSummary(payload);
    renderRegions(payload.regions);
    latestAssessment = payload;
    elements.downloadReport.classList.remove("hidden");
    renderDamageOverlay(payload.regions);
    setStatus("Assessment complete.");
  } catch (error) {
    setStatus(error.message || "Something went wrong.");
  }
});

elements.previewImage.addEventListener("load", () => {
  if (latestAssessment) {
    renderDamageOverlay(latestAssessment.regions);
  }
});

elements.downloadReport.addEventListener("click", downloadAssessmentReport);

window.addEventListener("resize", () => {
  if (latestAssessment) {
    renderDamageOverlay(latestAssessment.regions);
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
