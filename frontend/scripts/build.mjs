import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const assetsDir = path.join(srcDir, "assets");

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js"]) {
  await fs.copyFile(path.join(srcDir, file), path.join(distDir, file));
}

const apiBaseUrl = process.env.VITE_API_BASE_URL || "";
const configSource = `window.APP_CONFIG = { API_BASE_URL: ${JSON.stringify(apiBaseUrl)} };`;
await fs.writeFile(path.join(distDir, "config.js"), configSource);

try {
  await fs.cp(assetsDir, path.join(distDir, "assets"), { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
