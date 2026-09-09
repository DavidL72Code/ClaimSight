// Customer session guard. Redirects a signed-out visitor away from the
// consumer portal and wires the logout button.

const customerAuthEnabled = Boolean(window.sbAuth?.ready());
const customerProtectedPortals = new Set(["consumer"]);
const customerPortal = document.body.dataset.portal || "";

if (customerAuthEnabled) {
  // onChange fires immediately with the current session, so a signed-in
  // visitor is not bounced on load the way a bare subscribe would do.
  window.sbAuth.onChange((user) => {
    if (customerProtectedPortals.has(customerPortal) && !user) {
      window.location.href = "./index.html";
    }
  });

  document.getElementById("customer-logout")?.addEventListener("click", async () => {
    try {
      await window.sbAuth.signOut();
      window.localStorage.removeItem("claimsight.consumer-current-claim");
      window.localStorage.removeItem("claimsight.consumer-draft");
    } finally {
      window.location.href = "./index.html";
    }
  });
}
