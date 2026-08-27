/**
 * Adjuster message centre, backed by Firestore.
 *
 * This previously rendered a hardcoded messageThreads object for three claim
 * numbers that do not exist in the data, so an adjuster and a claimant could
 * never actually reach each other. Both sides now read and write the same
 * case_activity documents (type "message"), live.
 */
(() => {
  const firebaseConfig = window.FIREBASE_CONFIG || {};
  const firebaseEnabled = Boolean(
    window.firebase && firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
  );

  const threadList = document.getElementById("employee-thread-list");
  const threadCount = document.getElementById("employee-thread-count");
  const chatHistory = document.getElementById("employee-chat-history");
  const caseIdEl = document.getElementById("message-case-id");
  const caseLink = document.getElementById("message-case-link");
  const messageForm = document.getElementById("employee-message-form");
  const messageInput = document.getElementById("employee-message-input");
  const messageFiles = document.getElementById("employee-message-files");
  const attachmentPreview = document.getElementById("employee-message-attachments");

  const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const timeOf = (iso) => {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(d);
  };
  const tsToIso = (ts) => {
    if (!ts) return "";
    if (typeof ts.toDate === "function") return ts.toDate().toISOString();
    return typeof ts === "string" ? ts : "";
  };

  let app = null;
  let db = null;
  let auth = null;
  let claims = [];
  let activeClaimId = new URLSearchParams(location.search).get("claim") || null;
  let unsubMessages = null;
  let unsubClaims = null;

  const setEmpty = (node, text) => {
    if (node) node.innerHTML = `<article class="empty">${esc(text)}</article>`;
  };

  if (!firebaseEnabled) {
    setEmpty(chatHistory, "Messaging needs Firebase configuration.");
    setEmpty(threadList, "No claims available.");
    return;
  }

  try {
    app = window.firebase.apps?.length
      ? window.firebase.app()
      : window.firebase.initializeApp(firebaseConfig);
    db = window.firebase.firestore(app);
    auth = window.firebase.auth(app);
  } catch {
    setEmpty(chatHistory, "Messaging is unavailable right now.");
    return;
  }

  const storage = typeof window.firebase.storage === "function"
    ? window.firebase.storage(app)
    : null;

  // ── attachments ────────────────────────────────────────────────
  const renderAttachmentPreview = () => {
    if (!attachmentPreview) return;
    const files = Array.from(messageFiles?.files || []);
    attachmentPreview.innerHTML = files.length
      ? files.map((f) => `<span>${esc(f.name)}</span>`).join("")
      : "";
  };

  const uploadAttachments = async (claimId) => {
    const files = Array.from(messageFiles?.files || []);
    if (!files.length || !storage) return [];
    const out = [];
    for (const file of files) {
      try {
        const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "-");
        const ref = storage.ref().child(`claim-messages/${claimId}/${Date.now()}-${safe}`);
        await ref.put(file);
        out.push({ name: file.name, download_url: await ref.getDownloadURL() });
      } catch {
        // Attachment upload is best-effort; the message text still sends.
      }
    }
    return out;
  };

  const renderMessageAttachments = (attachments = []) => {
    if (!Array.isArray(attachments) || !attachments.length) return "";
    return `<div class="message-attachment-list">${attachments.map((a) => (
      a.download_url
        ? `<a href="${esc(a.download_url)}" target="_blank" rel="noopener noreferrer">${esc(a.name || "Attachment")}</a>`
        : `<span>${esc(a.name || "Attachment")}</span>`
    )).join("")}</div>`;
  };

  // ── thread list (assigned claims) ──────────────────────────────
  const renderThreads = () => {
    if (threadCount) {
      threadCount.textContent = `${claims.length} open`;
    }
    if (!threadList) return;
    if (!claims.length) {
      setEmpty(threadList, "No claims assigned to you.");
      return;
    }
    threadList.innerHTML = claims.map((c) => `
      <button class="employee-thread ${c.id === activeClaimId ? "active" : ""}" type="button" data-thread-id="${esc(c.id)}">
        <span class="employee-thread-avatar">${esc(String(c.id).slice(-2))}</span>
        <span class="employee-thread-copy">
          <strong>${esc(c.claim_reference || c.id)}</strong>
          <small>${esc(c.vehicle_type || "Vehicle not identified")}</small>
          <em>${esc(c.status_label || c.status || "")}</em>
        </span>
      </button>
    `).join("");
  };

  // ── conversation ───────────────────────────────────────────────
  const renderMessages = (events) => {
    if (caseIdEl) caseIdEl.textContent = activeClaimId || "—";
    if (caseLink && activeClaimId) {
      caseLink.href = `./employee-assessment.html?claim=${encodeURIComponent(activeClaimId)}`;
    }
    if (!chatHistory) return;
    if (!events.length) {
      setEmpty(chatHistory, "No messages on this claim yet.");
      return;
    }
    chatHistory.innerHTML = events.map((e) => `
      <article class="imessage-bubble ${e.actor_role === "employee" ? "employee" : "customer"}">
        <p>${esc(e.label || "")}</p>
        ${renderMessageAttachments(e.attachments)}
        <span>${esc(e.actor_name || (e.actor_role === "employee" ? "Adjuster" : "Customer"))} · ${esc(timeOf(tsToIso(e.created_at)))}</span>
      </article>
    `).join("");
    chatHistory.scrollTop = chatHistory.scrollHeight;
  };

  const subscribeMessages = (claimId) => {
    unsubMessages?.();
    unsubMessages = null;
    if (!claimId) return;
    setEmpty(chatHistory, "Loading messages...");
    try {
      unsubMessages = db.collection("case_activity")
        .where("case_id", "==", claimId)
        .where("type", "==", "message")
        .orderBy("created_at", "asc")
        .limit(200)
        .onSnapshot(
          (snap) => renderMessages(snap.docs.map((d) => d.data())),
          () => setEmpty(chatHistory, "Messages are unavailable for this claim.")
        );
    } catch {
      setEmpty(chatHistory, "Messages are unavailable for this claim.");
    }
  };

  const selectClaim = (claimId) => {
    if (!claimId) return;
    activeClaimId = claimId;
    renderThreads();
    subscribeMessages(claimId);
  };

  threadList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-thread-id]");
    if (button) selectClaim(button.dataset.threadId);
  });

  messageFiles?.addEventListener("change", renderAttachmentPreview);

  messageForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = messageInput?.value.trim() || "";
    const hasFiles = Array.from(messageFiles?.files || []).length > 0;
    if ((!text && !hasFiles) || !activeClaimId) return;

    const user = auth.currentUser;
    if (!user) return;

    const submit = messageForm.querySelector("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      const attachments = await uploadAttachments(activeClaimId);
      await db.collection("case_activity").add({
        case_id: activeClaimId,
        type: "message",
        label: text || "Attached claim file",
        actor_role: "employee",
        actor_uid: user.uid,
        actor_name: user.displayName || user.email || "Adjuster",
        attachments,
        created_at: window.firebase.firestore.FieldValue.serverTimestamp(),
      });
      if (messageInput) messageInput.value = "";
      if (messageFiles) messageFiles.value = "";
      renderAttachmentPreview();
      // The live listener repaints; no manual refresh needed.
    } catch {
      setEmpty(chatHistory, "Could not send that message. Try again.");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  const subscribeClaims = (email) => {
    unsubClaims?.();
    unsubClaims = null;
    if (!email) return;
    try {
      unsubClaims = db.collection("cases")
        .where("assigned_agent.email", "==", email)
        .orderBy("updated_at", "desc")
        .limit(25)
        .onSnapshot(
          (snap) => {
            claims = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            if (!activeClaimId || !claims.some((c) => c.id === activeClaimId)) {
              activeClaimId = claims[0]?.id || activeClaimId;
              if (activeClaimId) subscribeMessages(activeClaimId);
            }
            renderThreads();
          },
          () => setEmpty(threadList, "Could not load your claims.")
        );
    } catch {
      setEmpty(threadList, "Could not load your claims.");
    }
  };

  window.addEventListener("beforeunload", () => {
    unsubMessages?.();
    unsubClaims?.();
  });

  auth.onAuthStateChanged((user) => {
    if (!user) {
      setEmpty(threadList, "Sign in to see your claims.");
      setEmpty(chatHistory, "Sign in to view messages.");
      return;
    }
    subscribeClaims(user.email);
    if (activeClaimId) subscribeMessages(activeClaimId);
  });
})();
