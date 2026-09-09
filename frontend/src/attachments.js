// Claim attachment uploads.
//
// These used to go straight from the browser to Firebase Storage, but
// Firebase will not provision a bucket without the Blaze plan. Attachments
// now go to Supabase Storage via the backend: POST /api/attachments verifies
// the caller's Firebase ID token and checks case ownership before storing
// anything, because the Admin SDK bypasses Security Rules and so storage.rules
// can no longer police this path.
//
// The Supabase credentials stay on the server; nothing here knows them.

(() => {
  const apiBase = (window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");

  // Set from /api/health on first call and cached, so a deployment without
  // storage configured hides its attachment controls instead of throwing.
  let enabledPromise = null;

  const attachmentsEnabled = () => {
    if (!apiBase) return Promise.resolve(false);
    if (!enabledPromise) {
      enabledPromise = fetch(`${apiBase}/api/health`)
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => Boolean(payload?.attachments_enabled))
        .catch(() => false);
    }
    return enabledPromise;
  };

  const idToken = async () => {
    const token = await window.sbAuth?.accessToken?.();
    if (!token) throw new Error("Not signed in.");
    return token;
  };

  // folder is one of: "supporting-documents" | "messages" | "reviewer-evidence"
  const uploadClaimAttachment = async (caseId, file, folder) => {
    if (!apiBase) throw new Error("API base URL is not configured.");
    const body = new FormData();
    body.append("case_id", caseId);
    body.append("folder", folder);
    body.append("file", file);

    const response = await fetch(`${apiBase}/api/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await idToken()}` },
      body,
    });

    if (!response.ok) {
      let detail = "Upload failed.";
      try {
        detail = (await response.json())?.detail || detail;
      } catch {
        // non-JSON error body; keep the generic message
      }
      throw new Error(detail);
    }
    return response.json();
  };

  // Uploads several files, keeping the per-file best-effort behaviour the
  // message composers relied on: one bad file does not sink the rest.
  const uploadClaimAttachments = async (caseId, files, folder) => {
    const out = [];
    for (const file of Array.from(files || [])) {
      try {
        const stored = await uploadClaimAttachment(caseId, file, folder);
        out.push({ name: stored.name, download_url: stored.download_url });
      } catch (error) {
        console.warn("Attachment upload failed:", error?.message || error);
      }
    }
    return out;
  };

  // Hides an attachment control when the deployment has no storage backend,
  // so the button is absent rather than broken.
  const hideAttachmentControlsIfUnavailable = async (...elements) => {
    if (await attachmentsEnabled()) return true;
    for (const element of elements) {
      const control = element?.closest?.("label") || element;
      if (control) control.hidden = true;
    }
    return false;
  };

  window.attachmentsEnabled = attachmentsEnabled;
  window.uploadClaimAttachment = uploadClaimAttachment;
  window.uploadClaimAttachments = uploadClaimAttachments;
  window.hideAttachmentControlsIfUnavailable = hideAttachmentControlsIfUnavailable;
})();
