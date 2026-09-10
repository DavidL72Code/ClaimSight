import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const assetsDir = path.join(srcDir, "assets");

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

const copyFiles = [
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
  "attachments.js",
  "supabase-client.js",
  "data.js",
  "home.js",
  "customer-auth.js",
  "claim-assistant.js",
  "adjustment.js",
  "employee-auth.js",
  "employee-dashboard.js",
  "employee-messages.js",
  "employee-notifications.js",
  "customer-messages.js",
  "reasoning.js",
  "consumer-case.js",
];
for (const file of copyFiles) {
  await fs.copyFile(path.join(srcDir, file), path.join(distDir, file));
}
const scriptFiles = copyFiles.filter((f) => f.endsWith(".js"));

// Fail the build on a leftover Firebase handle.
//
// Removing Firebase left several identifiers referenced but never declared --
// `auth`, `db`, `casesCollection`. Each threw a ReferenceError at runtime and
// each one shipped: node --check only parses, and the unit tests never load
// these files. Greps missed them repeatedly too, because `auth?.x` hides from
// a pattern expecting a dot and one filter skipped every line mentioning
// sbAuth.
//
// The rule is deliberately blunt rather than clever. An earlier version tried
// to work out whether the name was declared in the file and accepted
// `if (auth && ...)` as a parameter list, so it caught nothing. Instead: these
// names are banned as bare identifiers everywhere except the one file that
// legitimately owns them.
const BANNED_IDENTIFIERS = {
  auth: ["supabase-client.js"],
  db: [],
  casesCollection: [],
  firestore: [],
  firebaseAuth: [],
  firebaseApp: [],
  firebaseStorage: [],
  firebaseConfig: [],
};

const stripCommentsAndStrings = (code) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');

const leftovers = [];
for (const file of scriptFiles) {
  const raw = await fs.readFile(path.join(srcDir, file), "utf8");
  const code = stripCommentsAndStrings(raw);
  for (const [name, allowed] of Object.entries(BANNED_IDENTIFIERS)) {
    if (allowed.includes(file)) continue;
    const re = new RegExp(`(?<![\\w.$])${name}(?![\\w$])`, "g");
    let match;
    while ((match = re.exec(code)) !== null) {
      const line = code.slice(0, match.index).split("\n").length;
      leftovers.push(`${file}:${line} uses '${name}', a Firebase handle that no longer exists`);
    }
  }
}
if (leftovers.length > 0) {
  throw new Error(
    "Leftover Firebase references would throw at runtime:\n  " + leftovers.join("\n  ")
  );
}

const apiBaseUrl = process.env.VITE_API_BASE_URL || "";
const configSource = `window.APP_CONFIG = { API_BASE_URL: ${JSON.stringify(apiBaseUrl)} };`;
await fs.writeFile(path.join(distDir, "config.js"), configSource);

// Compiled into the bundle and therefore public. It identifies the project;
// the RLS policies decide what any request may see.
const supabaseConfig = {
  url: process.env.VITE_SUPABASE_URL || "",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || "",
};
const supabaseConfigSource = `window.SUPABASE_CONFIG = ${JSON.stringify(supabaseConfig)};`;
await fs.writeFile(path.join(distDir, "supabase-config.js"), supabaseConfigSource);

try {
  await fs.cp(assetsDir, path.join(distDir, "assets"), { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
