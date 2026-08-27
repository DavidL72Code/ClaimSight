import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const assetsDir = path.join(srcDir, "assets");

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

for (const file of [
  "index.html",
  "dashboard.html",
  "new-claim.html",
  "edit-claim.html",
  "notifications.html",
  "messages.html",
  "employee-login.html",
  "employee-assessment.html",
  "employee-messages.html",
  "employee-notifications.html",
  "adjustment.html",
  "further-reasoning.html",
  "report-generator.html",
  "case-review.html",
  "final-report.html",
  "styles.css",
  "app.js",
  "home.js",
  "customer-auth.js",
  "claim-assistant.js",
  "adjustment.js",
  "employee-auth.js",
  "employee-dashboard.js",
  "employee-messages.js",
  "customer-messages.js",
  "reasoning.js",
  "consumer-case.js",
]) {
  await fs.copyFile(path.join(srcDir, file), path.join(distDir, file));
}

// On Vercel (or when REQUIRE_ENV=1) a missing variable means the deployed site
// would silently ship blank Firebase/API config and every page would fail to
// sign in. Fail the build instead of publishing a dead frontend.
const strictEnv =
  process.env.REQUIRE_ENV === "1" ||
  (process.env.VERCEL === "1" && process.env.REQUIRE_ENV !== "0");
const requiredEnv = [
  "VITE_API_BASE_URL",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

if (strictEnv) {
  const missing = requiredEnv.filter((name) => !(process.env[name] || "").trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required build environment variables: ${missing.join(", ")}. ` +
        "Set them in the Vercel project settings (or run with REQUIRE_ENV=0 for a local build)."
    );
  }
}

const apiBaseUrl = process.env.VITE_API_BASE_URL || "";
const configSource = `window.APP_CONFIG = { API_BASE_URL: ${JSON.stringify(apiBaseUrl)} };`;
await fs.writeFile(path.join(distDir, "config.js"), configSource);

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || "",
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: process.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: process.env.VITE_FIREBASE_APP_ID || "",
};
const firebaseConfigSource = `window.FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};`;
await fs.writeFile(path.join(distDir, "firebase-config.js"), firebaseConfigSource);

try {
  await fs.cp(assetsDir, path.join(distDir, "assets"), { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
