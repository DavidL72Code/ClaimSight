(() => {
const customerMessageStorageKey = "claimsight.customer-message-threads";
const currentClaimStorageKey = "claimsight.consumer-current-claim";
const messageFirebaseConfig = window.FIREBASE_CONFIG || {};
const firebaseStorageEnabled = Boolean(
  window.firebase
  && typeof window.firebase.storage === "function"
  && messageFirebaseConfig.apiKey
  && messageFirebaseConfig.projectId
  && messageFirebaseConfig.appId
);

const defaultMessageThreads = {
  "CLM-1048": {
    title: "CLM-1048",
    subtitle: "Rear hatch dispute",
    latest: "We received your dispute and are checking the liftgate.",
    messages: [
      { from: "customer", text: "The final review missed that the hatch will not close after the impact.", time: "2:14 PM" },
      { from: "employee", text: "We received your dispute and are checking the liftgate alignment against the added photo.", time: "2:16 PM" },
      { from: "customer", text: "Thank you. I can upload another angle if needed.", time: "2:18 PM" },
    ],
  },
};

const escapeMessageHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#039;",
}[char]));

const readStoredThreads = () => {
  try {
    const raw = window.localStorage.getItem(customerMessageStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeStoredThreads = (threads) => {
  try {
    window.localStorage.setItem(customerMessageStorageKey, JSON.stringify(threads));
  } catch {
    // Preview mode may block storage; chat still works until refresh.
  }
};

const fallbackAdjusters = [
  { id: "adj-alex-morgan", name: "Alex Morgan", email: "alex.morgan@claimsight.com" },
  { id: "adj-jordan-lee", name: "Jordan Lee", email: "jordan.lee@claimsight.com" },
  { id: "adj-sam-rivera", name: "Sam Rivera", email: "sam.rivera@claimsight.com" },
  { id: "adj-taylor-kim", name: "Taylor Kim", email: "taylor.kim@claimsight.com" },
];

const fallbackAssignedAgent = (claimId = "") =>
  fallbackAdjusters[Math.abs(String(claimId).split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % fallbackAdjusters.length]
  || fallbackAdjusters[0];

const storedThreads = readStoredThreads();
const threads = storedThreads && Object.keys(storedThreads).length
  ? { ...defaultMessageThreads, ...storedThreads }
  : defaultMessageThreads;
let selectedThreadId = new URLSearchParams(window.location.search).get("claim")
  || window.localStorage.getItem(currentClaimStorageKey)
  || Object.keys(threads)[0];

if (selectedThreadId && !threads[selectedThreadId]) {
  const assignedAgent = fallbackAssignedAgent(selectedThreadId);
  threads[selectedThreadId] = {
    title: selectedThreadId,
    subtitle: `Assigned to ${assignedAgent.name}`,
    latest: `${assignedAgent.name} was assigned to your claim.`,
    messages: [
      {
        from: "employee",
        text: `Your claim has been assigned to ${assignedAgent.name}. You can message here if you need to add details, ask about evidence, or follow up on the review.`,
        time: new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date()),
      },
    ],
  };
}

if (!threads[selectedThreadId]) {
  selectedThreadId = Object.keys(threads)[0];
}

const threadList = document.getElementById("customer-message-threads");
const caseCount = document.getElementById("customer-message-case-count");
const chatHistory = document.getElementById("customer-chat-history");
const caseId = document.getElementById("customer-message-case-id");
const caseLink = document.getElementById("customer-message-case-link");
const messageForm = document.getElementById("customer-message-form");
const messageInput = document.getElementById("customer-message-input");
const messageFiles = document.getElementById("customer-message-files");
const attachmentPreview = document.getElementById("customer-message-attachments");

const buildAttachments = () => Array.from(messageFiles?.files || []).map((file) => ({
  file,
  name: file.name,
  size: file.size,
  type: file.type || "application/octet-stream",
  source: "customer_message",
}));

const uploadAttachments = async (threadId) => {
  const attachments = buildAttachments();
  if (!attachments.length || !firebaseStorageEnabled) {
    return attachments.map(({ file, ...metadata }) => metadata);
  }

  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(messageFirebaseConfig);
  const storage = window.firebase.storage(app);
  return Promise.all(attachments.map(async ({ file, ...metadata }) => {
    const safeName = metadata.name.replace(/[^A-Za-z0-9._-]+/g, "-");
    const ref = storage.ref().child(`claim-messages/${threadId}/${Date.now()}-${safeName}`);
    await ref.put(file);
    const download_url = await ref.getDownloadURL();
    return { ...metadata, download_url };
  }));
};

const renderAttachmentPreview = () => {
  if (!attachmentPreview) {
    return;
  }
  const attachments = buildAttachments();
  attachmentPreview.innerHTML = attachments.map((file) => `
    <span>${escapeMessageHtml(file.name)}</span>
  `).join("");
};

const renderMessageAttachments = (attachments = []) => {
  if (!attachments.length) {
    return "";
  }
  return `
    <div class="message-attachment-list">
      ${attachments.map((file) => {
        const label = escapeMessageHtml(file.name || "Attachment");
        return file.download_url
          ? `<a href="${escapeMessageHtml(file.download_url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : `<span>${label}</span>`;
      }).join("")}
    </div>
  `;
};

const renderThreads = () => {
  const visibleThreads = selectedThreadId ? [threads[selectedThreadId]].filter(Boolean) : Object.values(threads);
  if (caseCount) {
    caseCount.textContent = `${visibleThreads.length} active`;
  }
  if (!threadList) {
    return;
  }
  threadList.innerHTML = visibleThreads.map((thread) => `
    <button class="employee-thread ${thread.title === selectedThreadId ? "active" : ""}" type="button" data-thread-id="${escapeMessageHtml(thread.title)}">
      <span class="employee-thread-avatar">${escapeMessageHtml(thread.title.slice(-2))}</span>
      <span class="employee-thread-copy">
        <strong>${escapeMessageHtml(thread.title)}</strong>
        <small>${escapeMessageHtml(thread.subtitle)}</small>
        <em>${escapeMessageHtml(thread.latest)}</em>
      </span>
      <span class="employee-thread-time">Now</span>
    </button>
  `).join("");
};

const renderThread = (threadId) => {
  const thread = threads[threadId] || threads[selectedThreadId];
  selectedThreadId = thread.title;
  window.localStorage.setItem(currentClaimStorageKey, selectedThreadId);

  if (caseId) {
    caseId.textContent = thread.title;
  }
  if (caseLink) {
    caseLink.href = "./case-review.html";
  }
  if (chatHistory) {
    chatHistory.innerHTML = thread.messages.map((message) => `
      <article class="imessage-bubble ${message.from === "customer" ? "customer" : "employee"}">
        <p>${escapeMessageHtml(message.text)}</p>
        ${renderMessageAttachments(message.attachments)}
        <span>${escapeMessageHtml(message.time)}</span>
      </article>
    `).join("");
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
  renderThreads();
};

threadList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-thread-id]");
  if (!button) {
    return;
  }
  renderThread(button.dataset.threadId);
});

messageForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput?.value.trim();
  const pendingAttachments = buildAttachments();
  if (!text && !pendingAttachments.length) {
    return;
  }
  const attachments = await uploadAttachments(selectedThreadId);
  const thread = threads[selectedThreadId];
  const time = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date());
  thread.messages.push({ from: "customer", text: text || "Attached evidence", time, attachments });
  thread.latest = text || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} sent`;
  writeStoredThreads(threads);
  messageInput.value = "";
  if (messageFiles) {
    messageFiles.value = "";
  }
  renderAttachmentPreview();
  renderThread(selectedThreadId);
});

messageFiles?.addEventListener("change", renderAttachmentPreview);
renderThread(selectedThreadId);
})();
