const dataEnabled = Boolean(window.sbAuth?.ready() && window.claimData);

if (dataEnabled) {

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
    const current = window.sbAuth.currentUser();
    if (current) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const unsubscribe = window.sbAuth.onChange((user) => {
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
    queue_bucket: payload.queue_bucket || "routine",
    priority_score: payload.priority_score || 0,
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
    // No assignment filter: the select policy already restricts these rows
    // to the cases assigned to this adjuster.
    await getAuthenticatedEmployee();
    const rows = await window.claimData.listCases({ limit: 25 });
    const items = rows.map((row) => normalize(row.id, row));
    renderList(
      elements.casesList,
      items,
      "Recent case history",
      "Use this section to reopen prior assessments and compare reviewer decisions.",
      false
    );
  };

  const fetchQueue = async () => {
    await getAuthenticatedEmployee();
    // Ordered by the real priority_score column added in 0003. The old
    // orderBy("queue.priority_score") matched nothing, because no writer ever
    // set that field and Firestore omits documents missing the sort key.
    const rows = await window.claimData.listCasesByPriority({ limit: 25 });
    const items = rows.map((row) => normalize(row.id, row));
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
