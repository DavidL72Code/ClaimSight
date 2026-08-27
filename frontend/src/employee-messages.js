const firebaseConfig = window.FIREBASE_CONFIG || {};
const firebaseStorageEnabled = Boolean(
  window.firebase
  && typeof window.firebase.storage === "function"
  && firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.appId
);

const messageThreads = {
  "CLM-1048": {
    title: "CLM-1048",
    messages: [
      { from: "customer", text: "The report missed the hatch alignment issue. Can someone review the extra photo?", time: "2:14 PM" },
      { from: "employee", text: "We received the dispute and will re-check the liftgate and rear quarter-panel alignment.", time: "2:16 PM" },
      { from: "customer", text: "Thanks. The rear hatch still will not close after the impact.", time: "2:17 PM" },
    ],
  },
  "CLM-1047": {
    title: "CLM-1047",
    messages: [
      { from: "employee", text: "We need one closer photo of the passenger-side headlight and bumper seam.", time: "1:58 PM" },
      { from: "customer", text: "Which headlight photos do you still need?", time: "2:01 PM" },
    ],
  },
  "CLM-1046": {
    title: "CLM-1046",
    messages: [
      { from: "customer", text: "I want to dispute the estimate before final report.", time: "1:03 PM" },
      { from: "employee", text: "We can review the dispute. Please send the additional repair invoice or photos.", time: "1:08 PM" },
    ],
  },
};

const threadButtons = Array.from(document.querySelectorAll(".employee-thread"));
const chatHistory = document.getElementById("employee-chat-history");
const caseId = document.getElementById("message-case-id");
const caseLink = document.getElementById("message-case-link");
const messageForm = document.getElementById("employee-message-form");
const messageInput = document.getElementById("employee-message-input");
const messageFiles = document.getElementById("employee-message-files");
const attachmentPreview = document.getElementById("employee-message-attachments");
let activeThreadId = "CLM-1048";

const escapeMessageHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#039;",
}[char]));

const buildAttachments = () => Array.from(messageFiles?.files || []).map((file) => ({
  file,
  name: file.name,
  size: file.size,
  type: file.type || "application/octet-stream",
  source: "employee_message",
}));

const uploadAttachments = async (threadId) => {
  const attachments = buildAttachments();
  if (!attachments.length || !firebaseStorageEnabled) {
    return attachments.map(({ file, ...metadata }) => metadata);
  }

  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
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
  attachmentPreview.innerHTML = buildAttachments().map((file) => `
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

const renderThread = (threadId) => {
  const thread = messageThreads[threadId] || messageThreads["CLM-1048"];
  activeThreadId = thread.title;
  if (caseId) {
    caseId.textContent = thread.title;
  }
  if (caseLink) {
    caseLink.href = `./employee-assessment.html?claim=${encodeURIComponent(thread.title)}`;
  }
  if (chatHistory) {
    chatHistory.innerHTML = thread.messages.map((message) => `
      <article class="imessage-bubble ${message.from === "employee" ? "employee" : "customer"}">
        <p>${escapeMessageHtml(message.text)}</p>
        ${renderMessageAttachments(message.attachments)}
        <span>${escapeMessageHtml(message.time)}</span>
      </article>
    `).join("");
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
  threadButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.threadId === threadId);
  });
};

threadButtons.forEach((button) => {
  button.addEventListener("click", () => renderThread(button.dataset.threadId));
});

messageFiles?.addEventListener("change", renderAttachmentPreview);

messageForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput?.value.trim();
  const pendingAttachments = buildAttachments();
  if (!text && !pendingAttachments.length) {
    return;
  }
  const thread = messageThreads[activeThreadId] || messageThreads["CLM-1048"];
  const attachments = await uploadAttachments(activeThreadId);
  const time = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date());
  thread.messages.push({ from: "employee", text: text || "Attached claim file", time, attachments });
  if (messageInput) {
    messageInput.value = "";
  }
  if (messageFiles) {
    messageFiles.value = "";
  }
  renderAttachmentPreview();
  renderThread(activeThreadId);
});

renderThread("CLM-1048");
