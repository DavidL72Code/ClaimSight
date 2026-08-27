const employeeAuthFirebaseConfig = window.FIREBASE_CONFIG || {};
const employeePreviewAuthKey = "claimsight.employee-preview-auth";
const employeePreviewEmailKey = "claimsight.employee-preview-email";
const employeeRoles = new Set(["employee", "manager", "admin"]);
const previewAuthAllowed = window.location.protocol === "file:"
  || ["localhost", "127.0.0.1"].includes(window.location.hostname);
const authEnabled = Boolean(
  window.firebase
  && employeeAuthFirebaseConfig.apiKey
  && employeeAuthFirebaseConfig.projectId
  && employeeAuthFirebaseConfig.appId
);

const gotoEmployeeLogin = () => {
  window.location.href = "./employee-login.html";
};

if (authEnabled) {
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(employeeAuthFirebaseConfig);
  const auth = window.firebase.auth(app);
  const bodyPortal = document.body.dataset.portal || "";
  const protectedPortals = new Set(["employee", "employee-adjustment", "employee-reasoning", "employee-report"]);
  const loginForm = document.getElementById("employee-login-form");
  const forgotPassword = document.getElementById("employee-forgot-password");
  const statusEl = document.getElementById("employee-login-status");

  const setStatus = (message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  const gotoEmployeeHome = () => {
    window.location.href = "./employee-assessment.html";
  };

  const hasEmployeeRole = async (user, forceRefresh = false) => {
    if (!user) return false;
    const token = await user.getIdTokenResult(forceRefresh);
    return employeeRoles.has(token.claims?.role);
  };

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      if (protectedPortals.has(bodyPortal)) gotoEmployeeLogin();
      return;
    }
    if (!await hasEmployeeRole(user)) {
      await auth.signOut();
      setStatus("This account does not have employee access.");
      if (protectedPortals.has(bodyPortal)) gotoEmployeeLogin();
      return;
    }
    if (bodyPortal === "employee-login") {
      gotoEmployeeHome();
    }
  });

  if (protectedPortals.has(bodyPortal) && !auth.currentUser) {
    auth.authStateReady?.().then(() => {
      if (!auth.currentUser) {
        gotoEmployeeLogin();
      }
    });
  }

  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("employee-email")?.value?.trim() || "";
    const password = document.getElementById("employee-password")?.value || "";
    if (!email || !password) {
      setStatus("Enter both email and password.");
      return;
    }
    try {
      setStatus("Signing in...");
      const credential = await auth.signInWithEmailAndPassword(email, password);
      if (!await hasEmployeeRole(credential.user, true)) {
        await auth.signOut();
        setStatus("This account does not have employee access.");
        return;
      }
      gotoEmployeeHome();
    } catch (error) {
      setStatus(error?.message || "Unable to sign in.");
    }
  });

  forgotPassword?.addEventListener("click", async () => {
    const email = document.getElementById("employee-email")?.value?.trim() || "";
    if (!email) {
      setStatus("Enter your employee email first.");
      return;
    }
    try {
      setStatus("Sending password reset...");
      await auth.sendPasswordResetEmail(email);
      setStatus(`Password reset instructions sent to ${email}.`);
    } catch (error) {
      setStatus(error?.message || "Unable to send password reset.");
    }
  });

}

if (!authEnabled) {
  const bodyPortal = document.body.dataset.portal || "";
  const protectedPortals = new Set(["employee", "employee-adjustment", "employee-reasoning", "employee-report"]);
  const loginForm = document.getElementById("employee-login-form");
  const forgotPassword = document.getElementById("employee-forgot-password");
  const statusEl = document.getElementById("employee-login-status");
  if (!previewAuthAllowed) {
    window.localStorage.removeItem(employeePreviewAuthKey);
    window.localStorage.removeItem(employeePreviewEmailKey);
  }
  if (protectedPortals.has(bodyPortal)
      && (!previewAuthAllowed || window.localStorage.getItem(employeePreviewAuthKey) !== "true")) {
      gotoEmployeeLogin();
  }
  loginForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!previewAuthAllowed) {
      if (statusEl) statusEl.textContent = "Employee Firebase authentication is not configured.";
      return;
    }
    if (statusEl) {
      statusEl.textContent = "Preview login accepted.";
    }
    const email = document.getElementById("employee-email")?.value?.trim() || "alex.morgan@claimsight.com";
    window.localStorage.setItem(employeePreviewAuthKey, "true");
    window.localStorage.setItem(employeePreviewEmailKey, email);
    window.location.href = "./employee-assessment.html";
  });
  forgotPassword?.addEventListener("click", () => {
    const email = document.getElementById("employee-email")?.value?.trim() || "";
    if (statusEl) {
      statusEl.textContent = email
        ? "Firebase password reset is not configured yet."
        : "Enter your employee email first.";
    }
  });
}

document.querySelectorAll("[data-employee-logout]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      if (authEnabled) {
        const app = window.firebase.apps?.length
          ? window.firebase.app()
          : window.firebase.initializeApp(employeeAuthFirebaseConfig);
        await window.firebase.auth(app).signOut();
      }
      window.localStorage.removeItem("claimsight.employee-selected-claim");
      window.localStorage.removeItem(employeePreviewAuthKey);
      window.localStorage.removeItem(employeePreviewEmailKey);
    } catch {
      // Preview mode may block storage/auth; still return to login.
    }
    gotoEmployeeLogin();
  });
});
