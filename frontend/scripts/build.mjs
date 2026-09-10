import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

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

// Cache-bust from file content, not by hand.
//
// Every page used to pin its scripts with a literal marker --
// consumer-case.js?v=pdf-export-fix-3 -- which only worked if someone
// remembered to change it. During the Supabase migration nobody did, so
// browsers that had already loaded the site kept serving the old JavaScript
// and threw ReferenceErrors against handles that no longer existed. A correct
// fix looked broken for several rounds because of it.
//
// The hash makes the URL change exactly when the bytes change: unchanged
// files keep their URL and stay cached, changed files are refetched once.
const hashOf = (contents) =>
  crypto.createHash("sha256").update(contents).digest("hex").slice(0, 10);

const distJs = (await fs.readdir(distDir)).filter((f) => f.endsWith(".js"));
const hashes = new Map();
for (const file of distJs) {
  hashes.set(file, hashOf(await fs.readFile(path.join(distDir, file))));
}

const distHtml = (await fs.readdir(distDir)).filter((f) => f.endsWith(".html"));
let rewritten = 0;
for (const page of distHtml) {
  const target = path.join(distDir, page);
  let html = await fs.readFile(target, "utf8");
  const before = html;
  // Only local scripts. The vendored SDK is versioned by its own directory
  // and the CDN fonts are not ours to fingerprint.
  html = html.replace(/src="\.\/([A-Za-z0-9._-]+\.js)(\?[^"]*)?"/g, (whole, file) => {
    const hash = hashes.get(file);
    return hash ? `src="./${file}?v=${hash}"` : whole;
  });
  if (html !== before) {
    await fs.writeFile(target, html);
    rewritten += 1;
  }
}

// A page referencing a script that was never copied would 404 in the browser
// but build fine, so check rather than trust.
//
// The check has to look at every local script reference, not only the ones
// that came out fingerprinted: an unknown file is precisely the one the
// rewrite above leaves alone, so scanning for `?v=` would skip it. That was
// the first version of this guard, and it caught nothing.
const missing = [];
for (const page of distHtml) {
  const html = await fs.readFile(path.join(distDir, page), "utf8");
  for (const m of html.matchAll(/src="\.\/([A-Za-z0-9._-]+\.js)(?:\?[^"]*)?"/g)) {
    if (!hashes.has(m[1])) missing.push(`${page} -> ${m[1]}`);
  }
}
if (missing.length > 0) {
  throw new Error("Pages reference scripts that were not built:\n  " + missing.join("\n  "));
}

console.log(`Fingerprinted ${hashes.size} scripts across ${rewritten} pages.`);
