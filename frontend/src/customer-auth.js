const customerFirebaseConfig = window.FIREBASE_CONFIG || {};
const customerAuthEnabled = Boolean(
  window.firebase
  && customerFirebaseConfig.apiKey
  && customerFirebaseConfig.projectId
  && customerFirebaseConfig.appId
);

const customerProtectedPortals = new Set(["consumer"]);
const customerPortal = document.body.dataset.portal || "";

if (customerAuthEnabled) {
  const app = window.firebase.apps?.length
    ? window.firebase.app()
    : window.firebase.initializeApp(customerFirebaseConfig);
  const auth = window.firebase.auth(app);

  auth.onAuthStateChanged((user) => {
    if (customerProtectedPortals.has(customerPortal) && !user) {
      window.location.href = "./index.html";
    }
  });

  document.getElementById("customer-logout")?.addEventListener("click", async () => {
    try {
      await auth.signOut();
      window.localStorage.removeItem("claimsight.consumer-current-claim");
      window.localStorage.removeItem("claimsight.consumer-draft");
    } finally {
      window.location.href = "./index.html";
    }
  });
}
