import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const root = process.cwd();
const srcDir = path.join(root, "src");
const port = Number(process.env.PORT || 4173);

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
    const contentType = filePath.endsWith(".css")
      ? "text/css"
      : filePath.endsWith(".js")
        ? "application/javascript"
        : filePath.endsWith(".png")
          ? "image/png"
        : "text/html";
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
