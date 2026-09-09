import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const root = process.cwd();
const srcDir = path.join(root, "src");
const port = Number(process.env.PORT || 4173);

// Anything missing from this table fell through to text/html, which broke
// every SVG on the homepage: browsers MIME-sniff raster images inside <img>
// but never sniff SVG, so it was rejected and rendered as a broken image.
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const pathname = url.parse(req.url).pathname || "/";
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(srcDir, normalizedPath);

  try {
    if (normalizedPath === "/config.js") {
      const apiBaseUrl = process.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
      const configSource = `window.APP_CONFIG = { API_BASE_URL: ${JSON.stringify(apiBaseUrl)} };`;
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(configSource);
      return;
    }

    const assetPath = normalizedPath.startsWith("/assets/")
      ? path.join(srcDir, normalizedPath)
      : filePath;
    const contents = await fs.readFile(assetPath);
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "text/html";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(contents);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Frontend dev server running on http://127.0.0.1:${port}`);
});
