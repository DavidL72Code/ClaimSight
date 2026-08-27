const firebaseConfig = window.FIREBASE_CONFIG || {};
const firebaseEnabled = Boolean(
  window.firebase
  && firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.appId
);

if (firebaseEnabled) {
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  const db = window.firebase.firestore(app);
  const auth = window.firebase.auth(app);
  const casesCollection = db.collection("cases");

  const elements = {
    casesList: document.getElementById("cases-list"),
    queueListPanel: document.getElementById("queue-list-panel"),
    refreshCases: document.getElementById("refresh-cases"),
    refreshQueue: document.getElementById("refresh-queue"),
  };

  const toIso = (value) => {
    if (!value) return "";
    return typeof value.toDate === "function" ? value.toDate().toISOString() : String(value);
  };

  const formatCurrency = (value) => `$${(Number(value) || 0).toLocaleString()}`;
  const escapeHtml = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");

  const getAuthenticatedEmployee = () => {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve, reject) => {
      const unsubscribe = auth.onAuthStateChanged((user) => {
        unsubscribe();
        if (user) resolve(user);
        else reject(new Error("Employee authentication required."));
      });
    });
  };

  const normalize = (docId, payload = {}) => ({
    id: docId,
    claim_reference: payload.review?.claim_reference || payload.claim_reference || docId,
    vehicle_type: payload.vehicle_type || "Vehicle unavailable",
    reviewed_total_cost_usd: payload.review?.reviewed_total_cost_usd || payload.reviewed_total_cost_usd || 0,
    final_action: payload.review?.final_action || payload.final_action || payload.recommended_action || "Pending",
    queue_bucket: payload.queue?.bucket || "routine",
    priority_score: payload.queue?.priority_score || 0,
    updated_at: toIso(payload.updated_at),
  });

  const renderList = (target, items, emptyTitle, emptyText, priority = false) => {
    if (!target) return;
    target.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("article");
      empty.className = "ops-item empty";
      empty.innerHTML = `<strong>${emptyTitle}</strong><p>${emptyText}</p>`;
      target.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const card = document.createElement("article");
      card.className = `ops-item${priority ? ` ${item.queue_bucket}` : ""}`;
      card.innerHTML = `
        <div class="ops-item-head">
          <strong>${escapeHtml(item.claim_reference)}</strong>
          <span>${escapeHtml(item.vehicle_type)}</span>
        </div>
        <p>${priority
          ? `${escapeHtml(item.queue_bucket)} priority · score ${Number(item.priority_score) || 0} · ${formatCurrency(item.reviewed_total_cost_usd)}`
          : `${escapeHtml(item.final_action)} · ${formatCurrency(item.reviewed_total_cost_usd)}`}</p>
      `;
      target.appendChild(card);
    });
  };

  const fetchCases = async () => {
    const employee = await getAuthenticatedEmployee();
    const snapshot = await casesCollection
      .where("assigned_agent.email", "==", employee.email)
      .orderBy("updated_at", "desc")
      .limit(25)
      .get();
    const items = snapshot.docs.map((doc) => normalize(doc.id, doc.data()));
    renderList(
      elements.casesList,
      items,
      "Recent case history",
      "Use this section to reopen prior assessments and compare reviewer decisions.",
      false
    );
  };

  const fetchQueue = async () => {
    const employee = await getAuthenticatedEmployee();
    const snapshot = await casesCollection
      .where("assigned_agent.email", "==", employee.email)
      .orderBy("queue.priority_score", "desc")
      .limit(25)
      .get();
    const items = snapshot.docs.map((doc) => normalize(doc.id, doc.data()));
    renderList(
      elements.queueListPanel,
      items,
      "Queue priority view",
      "High-risk, missing-evidence, or total-loss candidates can be reviewed on this page.",
      true
    );
  };

  elements.refreshCases?.addEventListener("click", fetchCases);
  elements.refreshQueue?.addEventListener("click", fetchQueue);

  Promise.allSettled([fetchCases(), fetchQueue()]);
}
