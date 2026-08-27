(() => {
const assistantStorageKey = "claimsight.claim-assistant-threads";
const currentClaimStorageKey = "claimsight.consumer-current-claim";
const assistantApiBaseUrl = (window.APP_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");

const readAssistantThreads = () => {
  try {
    const raw = window.localStorage.getItem(assistantStorageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const writeAssistantThreads = (threads) => {
  try {
    window.localStorage.setItem(assistantStorageKey, JSON.stringify(threads));
  } catch {
    // Local logging is best-effort in preview mode.
  }
};

const getClaimAssistantContext = () => {
  const visibleText = (selector) => document.querySelector(selector)?.textContent?.trim() || "";
  const urlClaim = new URLSearchParams(window.location.search).get("claim") || "";
  const storedClaim = window.localStorage.getItem(currentClaimStorageKey) || "";
  const claimReference = visibleText("#consumer-detail-reference")
    || visibleText("#consumer-final-reference")
    || urlClaim
    || storedClaim
    || "this claim";

  return {
    claim_reference: claimReference,
    page_title: document.title || "ClaimSight",
    status: visibleText("#consumer-detail-status-copy") || visibleText("#consumer-final-status-copy") || "not selected yet",
    vehicle: visibleText("#consumer-detail-vehicle") || visibleText("#consumer-final-vehicle") || "vehicle not selected yet",
    adjuster: visibleText("#consumer-detail-reviewer") || visibleText("#consumer-final-reviewer") || "your assigned adjuster",
    ai_view: visibleText("#consumer-detail-ai-action") || "AI first-pass details are not available on this page yet.",
    final_action: visibleText("#consumer-detail-final-action") || visibleText("#consumer-final-action") || "No final decision is available yet.",
    note: visibleText("#consumer-detail-note") || visibleText("#consumer-final-note") || "No adjuster note is available yet.",
  };
};

const assistantSystemNotice =
  "I can explain claim status, evidence, and next steps. I cannot promise payment, change a decision, or replace your adjuster.";

const buildAssistantResponse = (message) => {
  const context = getClaimAssistantContext();
  const question = message.toLowerCase();

  if (question.includes("payout") || question.includes("pay") || question.includes("guarantee") || question.includes("approve")) {
    return `I cannot promise a payout or approval. For ${context.claim_reference}, the current status is ${context.status}. I can explain the visible reasoning, but the official decision has to come from the adjuster and final report.`;
  }

  if (question.includes("appeal") || question.includes("dispute") || question.includes("wrong")) {
    return `If you disagree with the decision, use the appeal option once the claim is in final review. Strong appeals usually include clear photos, repair shop notes, receipts, prior condition details, and a short explanation of what you believe is missing. I cannot submit or decide the appeal for you.`;
  }

  if (question.includes("evidence") || question.includes("photo") || question.includes("document") || question.includes("upload")) {
    return `Helpful evidence usually includes wide photos, close-up damage photos, VIN/odometer photos, repair estimates, tow/storage bills, police reports, and notes about prior damage. Use Edit Claim to add files before final decision review.`;
  }

  if (question.includes("status") || question.includes("where") || question.includes("progress")) {
    return `${context.claim_reference} is currently marked as ${context.status}. If it is submitted or in review, the customer can update evidence and message the adjuster. If it reaches final review, the customer can accept or appeal the decision.`;
  }

  if (question.includes("ai") || question.includes("reason") || question.includes("why")) {
    return `Here is the visible reasoning for ${context.claim_reference}: AI view: ${context.ai_view} Adjuster action: ${context.final_action} Adjuster note: ${context.note} This is an explanation only, not a new decision.`;
  }

  if (question.includes("adjuster") || question.includes("human") || question.includes("message")) {
    return `The visible assigned reviewer is ${context.adjuster}. If something needs human attention, use Messages so the conversation stays tied to ${context.claim_reference}.`;
  }

  if (question.includes("report") || question.includes("export")) {
    return `Reports are available after a claim is finalized. If the claim is still ${context.status}, the report may not be ready yet. Once finalized, use Final Report or Export Report.`;
  }

  return `For ${context.claim_reference}, I can help explain status, evidence, decision reasoning, messages, appeals, and reports. ${assistantSystemNotice}`;
};

const getThreadKey = () => getClaimAssistantContext().claim_reference || "general";

const readCurrentAssistantHistory = () => {
  const threads = readAssistantThreads();
  return (threads[getThreadKey()] || []).slice(-8);
};

const saveAssistantMessage = (role, text) => {
  const threads = readAssistantThreads();
  const key = getThreadKey();
  const nextThread = [...(threads[key] || []), { role, text, created_at: new Date().toISOString() }].slice(-30);
  threads[key] = nextThread;
  writeAssistantThreads(threads);
};

const askAssistantBackend = async (question) => {
  const headers = { "Content-Type": "application/json" };
  try {
    const auth = window.firebase?.auth?.();
    const token = await auth?.currentUser?.getIdToken?.();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // Preview mode or unsigned users fall back to visible page context only.
  }

  const response = await fetch(`${assistantApiBaseUrl}/api/claim-assistant`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: question,
      context: {
        claim_reference: getClaimAssistantContext().claim_reference,
        page_title: document.title || "ClaimSight",
      },
      history: readCurrentAssistantHistory(),
    }),
  });

  if (!response.ok) {
    throw new Error("Assistant backend unavailable.");
  }

  const payload = await response.json();
  return payload.answer || buildAssistantResponse(question);
};

const appendAssistantMessage = (list, role, text) => {
  const message = document.createElement("article");
  message.className = `claim-assistant-message ${role}`;
  message.textContent = text;
  list.appendChild(message);
  list.scrollTop = list.scrollHeight;
};

const mountClaimAssistant = () => {
  if (document.getElementById("claim-assistant")) {
    return;
  }

  const widget = document.createElement("aside");
  widget.id = "claim-assistant";
  widget.className = "claim-assistant";
  widget.innerHTML = `
    <button id="claim-assistant-toggle" class="claim-assistant-toggle" type="button" aria-expanded="false" aria-label="Open ClaimSight assistant">
      <span class="material-symbols-outlined" aria-hidden="true">support_agent</span>
      <span>Ask ClaimSight</span>
    </button>
    <section id="claim-assistant-panel" class="claim-assistant-panel hidden" aria-label="ClaimSight assistant">
      <div class="claim-assistant-head">
        <div>
          <span>Claim Assistant</span>
          <strong>Safe guidance only</strong>
        </div>
        <button id="claim-assistant-close" type="button" aria-label="Close assistant">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
      <p class="claim-assistant-notice">${assistantSystemNotice}</p>
      <div id="claim-assistant-messages" class="claim-assistant-messages" aria-live="polite"></div>
      <div class="claim-assistant-prompts" aria-label="Suggested questions">
        <button type="button" data-assistant-prompt="What does my status mean?">Status</button>
        <button type="button" data-assistant-prompt="What evidence should I add?">Evidence</button>
        <button type="button" data-assistant-prompt="How do I appeal?">Appeal</button>
      </div>
      <form id="claim-assistant-form" class="claim-assistant-form">
        <input id="claim-assistant-input" type="text" placeholder="Ask about this claim..." autocomplete="off" />
        <button type="submit">Ask</button>
      </form>
    </section>
  `;
  document.body.appendChild(widget);

  const toggle = document.getElementById("claim-assistant-toggle");
  const close = document.getElementById("claim-assistant-close");
  const panel = document.getElementById("claim-assistant-panel");
  const list = document.getElementById("claim-assistant-messages");
  const form = document.getElementById("claim-assistant-form");
  const input = document.getElementById("claim-assistant-input");

  const setOpen = (open) => {
    panel.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open && !list.dataset.started) {
      list.dataset.started = "true";
      appendAssistantMessage(list, "assistant", assistantSystemNotice);
    }
    if (open) {
      input.focus();
    }
  };

  const ask = async (text) => {
    const question = text.trim();
    if (!question) {
      return;
    }
    appendAssistantMessage(list, "user", question);
    saveAssistantMessage("user", question);
    const waiting = document.createElement("article");
    waiting.className = "claim-assistant-message assistant";
    waiting.textContent = "Checking the claim assistant...";
    list.appendChild(waiting);
    list.scrollTop = list.scrollHeight;

    let response;
    try {
      response = await askAssistantBackend(question);
    } catch {
      response = buildAssistantResponse(question);
    }

    waiting.remove();
    appendAssistantMessage(list, "assistant", response);
    saveAssistantMessage("assistant", response);
    input.value = "";
  };

  toggle.addEventListener("click", () => setOpen(panel.classList.contains("hidden")));
  close.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value);
  });
  widget.querySelectorAll("[data-assistant-prompt]").forEach((button) => {
    button.addEventListener("click", () => ask(button.dataset.assistantPrompt || ""));
  });
};

if (document.body.dataset.portal === "consumer") {
  mountClaimAssistant();
}
})();
