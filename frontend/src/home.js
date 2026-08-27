const homeCard = document.querySelector(".claim-home-card");
const landingShell = document.querySelector(".claim-home-sticky-zone");
const proofSection = document.querySelector(".claim-proof-section");
const proofCards = Array.from(document.querySelectorAll(".claim-proof-grid figure"));
const loginOpen = document.getElementById("home-login-open");
const loginClose = document.getElementById("home-login-close");
const loginModal = document.getElementById("home-login-modal");
const customerForgotPassword = document.getElementById("customer-forgot-password");
const customerLoginStatus = document.getElementById("customer-login-status");
const customerLoginForm = document.getElementById("customer-login-form");
const customerGoogleLogin = document.getElementById("customer-google-login");
const firebaseConfig = window.FIREBASE_CONFIG || {};
const firebaseAuthEnabled = Boolean(
  window.firebase
  && firebaseConfig.apiKey
  && firebaseConfig.projectId
  && firebaseConfig.appId
);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const easeOut = (value) => 1 - Math.pow(1 - value, 3);
let viewportHeight = window.innerHeight;
let scrollFrameRequested = false;
let lastHomeProgress = -1;
let lastProofProgress = -1;

const updateHomeScroll = () => {
  if (!homeCard || !landingShell) {
    return;
  }
  const rect = landingShell.getBoundingClientRect();
  const scrollable = Math.max(1, rect.height - viewportHeight);
  const progress = clamp(-rect.top / scrollable, 0, 1);

  if (Math.abs(progress - lastHomeProgress) < 0.001) {
    return;
  }

  lastHomeProgress = progress;
  homeCard.style.setProperty("--home-progress", progress.toFixed(4));
};

const updateProofScroll = () => {
  if (!proofSection || proofCards.length === 0) {
    return;
  }

  const rect = proofSection.getBoundingClientRect();
  const startLine = viewportHeight * 0.46;
  const travelDistance = Math.max(viewportHeight * 0.95, rect.height - viewportHeight * 0.15);
  const sectionProgress = clamp((startLine - rect.top) / travelDistance, 0, 1);
  const easedSectionProgress = easeOut(sectionProgress);

  if (Math.abs(easedSectionProgress - lastProofProgress) >= 0.001) {
    lastProofProgress = easedSectionProgress;
    proofSection.style.setProperty("--proof-progress", easedSectionProgress.toFixed(4));
  }

  proofCards.forEach((card, index) => {
    const start = 0.18 + index * 0.13;
    const end = start + 0.36;
    const rawProgress = clamp((sectionProgress - start) / (end - start), 0, 1);
    const progress = easeOut(rawProgress);
    card.style.setProperty("--proof-card-progress", progress.toFixed(4));
    card.style.setProperty("--proof-card-inverse", (1 - progress).toFixed(4));
    card.style.setProperty("--proof-card-delay", String(index * 0.08));
  });
};

const updateScrollEffects = () => {
  updateHomeScroll();
  updateProofScroll();
};

const requestScrollUpdate = () => {
  if (scrollFrameRequested) {
    return;
  }

  scrollFrameRequested = true;
  window.requestAnimationFrame(() => {
    updateScrollEffects();
    scrollFrameRequested = false;
  });
};

updateScrollEffects();
window.addEventListener("scroll", requestScrollUpdate, { passive: true });
window.addEventListener("resize", () => {
  viewportHeight = window.innerHeight;
  requestScrollUpdate();
});

const setLoginOpen = (open) => {
  if (!loginModal || !loginOpen) {
    return;
  }
  loginModal.classList.toggle("hidden", !open);
  loginOpen.setAttribute("aria-expanded", String(open));
  if (open) {
    loginModal.querySelector("input")?.focus();
  }
};

loginOpen?.addEventListener("click", () => setLoginOpen(true));
loginClose?.addEventListener("click", () => setLoginOpen(false));
const getFirebaseAuth = () => {
  if (!firebaseAuthEnabled) {
    return null;
  }

  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(firebaseConfig);
  return window.firebase.auth(app);
};

const routeSignedInUser = async (user) => {
  const token = await user.getIdTokenResult?.();
  const role = token?.claims?.role || "customer";
  window.location.href = role === "employee" ? "./employee-assessment.html" : "./dashboard.html";
};

customerForgotPassword?.addEventListener("click", async () => {
  const email = loginModal?.querySelector("input[type='email']")?.value?.trim();
  if (!customerLoginStatus) {
    return;
  }

  if (!email) {
    customerLoginStatus.textContent = "Enter your email first, then request a password reset.";
    return;
  }

  const auth = getFirebaseAuth();
  if (!auth) {
    customerLoginStatus.textContent = "Firebase password reset is not configured yet.";
    return;
  }

  try {
    customerLoginStatus.textContent = "Sending password reset...";
    await auth.sendPasswordResetEmail(email);
    customerLoginStatus.textContent = `Password reset instructions sent to ${email}.`;
  } catch (error) {
    customerLoginStatus.textContent = error?.message || "Unable to send password reset.";
  }
});

customerLoginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!customerLoginStatus) {
    return;
  }

  const email = customerLoginForm.querySelector("input[type='email']")?.value?.trim();
  const password = customerLoginForm.querySelector("input[type='password']")?.value || "";
  const auth = getFirebaseAuth();

  if (!auth) {
    customerLoginStatus.textContent = "Firebase login is not configured yet. Preview mode can still open the dashboard.";
    window.location.href = "./dashboard.html";
    return;
  }

  try {
    customerLoginStatus.textContent = "Signing in...";
    const credential = await auth.signInWithEmailAndPassword(email, password);
    await routeSignedInUser(credential.user);
  } catch (error) {
    customerLoginStatus.textContent = error?.message || "Unable to sign in.";
  }
});

customerGoogleLogin?.addEventListener("click", async (event) => {
  event.preventDefault();
  if (!customerLoginStatus) {
    return;
  }

  const auth = getFirebaseAuth();
  if (!auth || typeof window.firebase.auth.GoogleAuthProvider !== "function") {
    customerLoginStatus.textContent = "Google login is not configured yet.";
    return;
  }

  try {
    customerLoginStatus.textContent = "Opening Google sign-in...";
    const provider = new window.firebase.auth.GoogleAuthProvider();
    const credential = await auth.signInWithPopup(provider);
    await routeSignedInUser(credential.user);
  } catch (error) {
    customerLoginStatus.textContent = error?.message || "Unable to sign in with Google.";
  }
});
loginModal?.addEventListener("click", (event) => {
  if (event.target === loginModal) {
    setLoginOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setLoginOpen(false);
  }
});
