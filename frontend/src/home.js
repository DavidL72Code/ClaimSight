const homeCard = document.querySelector(".claim-home-card");
const landingShell = document.querySelector(".claim-home-sticky-zone");
const proofSection = document.querySelector(".claim-proof-section");
const proofCards = Array.from(document.querySelectorAll(".claim-proof-grid figure"));
const heroPhotos = Array.from(document.querySelectorAll(".claim-home-photo"));
const loginOpen = document.getElementById("home-login-open");
const loginClose = document.getElementById("home-login-close");
const loginModal = document.getElementById("home-login-modal");
const customerForgotPassword = document.getElementById("customer-forgot-password");
const customerLoginStatus = document.getElementById("customer-login-status");
const customerLoginForm = document.getElementById("customer-login-form");
const customerGoogleLogin = document.getElementById("customer-google-login");
const authEnabled = Boolean(window.sbAuth?.ready());

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const easeOut = (value) => 1 - Math.pow(1 - value, 3);
let viewportHeight = window.innerHeight;
let scrollFrameRequested = false;
let lastHomeProgress = -1;
let lastProofProgress = -1;


/* ── hero carousel ────────────────────────────────────────────────
   The three hero photos ride a circle. Scroll progress through the
   sticky zone (0 -> 1) advances the whole ring by one full turn, so
   each photo rotates to the front and away again. Everything the CSS
   needs is written as custom properties; the transform itself lives
   in styles.css.

   The middle photo starts at the front: with three cards the angles
   are -120deg / 0deg / +120deg at progress 0. */
const CAROUSEL_TURN = Math.PI * 2;

const layoutHeroCarousel = (progress) => {
  const count = heroPhotos.length;
  if (count === 0) {
    return;
  }

  heroPhotos.forEach((photo, index) => {
    const offset = (index - (count - 1) / 2) / count;
    const angle = (offset + progress) * CAROUSEL_TURN;
    const depth = Math.cos(angle);        // +1 at the front, -1 at the back
    const lateral = Math.sin(angle);
    const front = (depth + 1) / 2;        // 0 -> 1 as the card comes forward

    photo.style.setProperty("--card-x", `${(lateral * 98).toFixed(2)}%`);
    photo.style.setProperty("--card-z", `${((depth - 1) * 130).toFixed(1)}px`);
    /* The ring is read from slightly above, so cards lift as they
       travel to the back. Without this the rear card hides dead
       centre behind the front one and the row looks like it has a
       hole in it at the halfway point. */
    photo.style.setProperty("--card-y", `${(((depth - 1) / 2) * 14).toFixed(2)}%`);
    photo.style.setProperty("--card-turn", `${(lateral * -26).toFixed(2)}deg`);
    photo.style.setProperty("--card-scale", (0.88 + front * 0.12).toFixed(4));
    photo.style.setProperty("--card-fade", (0.64 + front * 0.36).toFixed(4));
    photo.style.setProperty("--card-front", front.toFixed(4));
    photo.style.zIndex = String(Math.round(front * 100));
  });
};

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

  /* Under reduced motion the ring is laid out once and held: the
     transform is the photos' layout here, not decoration, so it can
     not simply be dropped the way the other scroll effects are. */
  layoutHeroCarousel(reducedMotion?.matches ? 0 : progress);
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
// Sends an employee to the adjuster portal and everyone else to the customer
// dashboard. The role rides on app_metadata in the session the SDK already
// holds, so this needs no extra token round trip.
const routeSignedInUser = () => {
  const role = window.sbAuth.currentUser()?.role || "customer";
  const employeeRoles = new Set(["employee", "manager", "admin"]);
  window.location.href = employeeRoles.has(role)
    ? "./employee-assessment.html"
    : "./dashboard.html";
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

  if (!authEnabled) {
    customerLoginStatus.textContent = "Password reset is not configured yet.";
    return;
  }

  try {
    customerLoginStatus.textContent = "Sending password reset...";
    await window.sbAuth.sendPasswordReset(email);
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

  if (!authEnabled) {
    customerLoginStatus.textContent = "Login is not configured yet. Preview mode can still open the dashboard.";
    window.location.href = "./dashboard.html";
    return;
  }

  try {
    customerLoginStatus.textContent = "Signing in...";
    await window.sbAuth.signIn(email, password);
    routeSignedInUser();
  } catch (error) {
    customerLoginStatus.textContent = error?.message || "Unable to sign in.";
  }
});

customerGoogleLogin?.addEventListener("click", async (event) => {
  event.preventDefault();
  if (!customerLoginStatus) {
    return;
  }

  if (!authEnabled) {
    customerLoginStatus.textContent = "Google login is not configured yet.";
    return;
  }

  try {
    customerLoginStatus.textContent = "Opening Google sign-in...";
    // Supabase redirects rather than opening a popup, so there is no
    // credential to route on here -- the provider sends the browser back to
    // the dashboard, where the session guard picks it up. This stays inert
    // until Google is enabled under Authentication -> Providers.
    await window.sbAuth.signInWithGoogle(`${window.location.origin}/dashboard.html`);
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
