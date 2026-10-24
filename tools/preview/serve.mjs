// Dev-only static server for the UI preview: node tools/preview/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "extension");
const PORT = Number(process.argv[2] || 8099);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname === "/") file = path.join(ROOT, "chat.html");
    if (url.pathname === "/host.html") {
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(fs.readFileSync(path.join(HERE, "host.html")));
      return;
    }
    if (url.pathname.endsWith(".html") && fs.existsSync(file)) {
      let body = fs.readFileSync(file, "utf8");
      body = body.replace(
        /<script type="module" src="(chat|options)\.js"><\/script>/,
        '<script src="/shim.js"></script>\n    <script type="module" src="$1.js"></script>'
      );
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(body);
      return;
    }
    if (url.pathname === "/shim.js") {
      res.writeHead(200, { "content-type": TYPES[".js"] });
      res.end(fs.readFileSync(path.join(HERE, "shim.js")));
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, "127.0.0.1", () => console.log(`preview → http://127.0.0.1:${PORT}/chat.html?url=https://example.com/article&lang=en`));
