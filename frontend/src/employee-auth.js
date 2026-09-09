// Employee session guard: sign-in, role check, and the logout buttons.
//
// The role now comes from the Supabase JWT's app_metadata, which is what
// public.jwt_role() reads in the RLS policies and what the backend's
// SupabaseAuth reads too -- so the page, the API and the database all agree
// on who someone is. app_metadata is only writable with the service key;
// user_metadata is self-service, so a role there would let anyone promote
// themselves.

const employeePreviewAuthKey = "claimsight.employee-preview-auth";
const employeePreviewEmailKey = "claimsight.employee-preview-email";
const employeeRoles = new Set(["employee", "manager", "admin"]);
const previewAuthAllowed = window.location.protocol === "file:"
  || ["localhost", "127.0.0.1"].includes(window.location.hostname);
const authEnabled = Boolean(window.sbAuth?.ready());

const employeeProtectedPortals = new Set([
  "employee", "employee-adjustment", "employee-reasoning", "employee-report",
]);

const gotoEmployeeLogin = () => {
  window.location.href = "./employee-login.html";
};

if (authEnabled) {
  const bodyPortal = document.body.dataset.portal || "";
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

  // Replaces getIdTokenResult().claims.role. The role travels on the user
  // object the SDK already holds, so this needs no extra round trip and no
  // forceRefresh argument: Supabase issues a fresh token on sign-in, and a
  // role change lands when the token next refreshes.
  const hasEmployeeRole = (user) => Boolean(user && employeeRoles.has(user.role));

  window.sbAuth.onChange(async (user) => {
    if (!user) {
      if (employeeProtectedPortals.has(bodyPortal)) gotoEmployeeLogin();
      return;
    }
    if (!hasEmployeeRole(user)) {
      await window.sbAuth.signOut();
      setStatus("This account does not have employee access.");
      if (employeeProtectedPortals.has(bodyPortal)) gotoEmployeeLogin();
      return;
    }
    if (bodyPortal === "employee-login") {
      gotoEmployeeHome();
    }
  });

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
      await window.sbAuth.signIn(email, password);
      // Read the role off the session the sign-in just established rather
      // than the credential, so it reflects the new token.
      if (!hasEmployeeRole(window.sbAuth.currentUser())) {
        await window.sbAuth.signOut();
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
      await window.sbAuth.sendPasswordReset(email);
      setStatus(`Password reset instructions sent to ${email}.`);
    } catch (error) {
      setStatus(error?.message || "Unable to send password reset.");
    }
  });
}

if (!authEnabled) {
  const bodyPortal = document.body.dataset.portal || "";
  const loginForm = document.getElementById("employee-login-form");
  const forgotPassword = document.getElementById("employee-forgot-password");
  const statusEl = document.getElementById("employee-login-status");
  if (!previewAuthAllowed) {
    window.localStorage.removeItem(employeePreviewAuthKey);
    window.localStorage.removeItem(employeePreviewEmailKey);
  }
  if (employeeProtectedPortals.has(bodyPortal)
      && (!previewAuthAllowed || window.localStorage.getItem(employeePreviewAuthKey) !== "true")) {
      gotoEmployeeLogin();
  }
  loginForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!previewAuthAllowed) {
      if (statusEl) statusEl.textContent = "Employee authentication is not configured.";
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
        ? "Password reset is not configured yet."
        : "Enter your employee email first.";
    }
  });
}

document.querySelectorAll("[data-employee-logout]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      if (authEnabled) {
        await window.sbAuth.signOut();
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
