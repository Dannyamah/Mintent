// A small static server for the built site, with no dependencies. The app routes by path (/dashboard, /cards/<name>), so any
// address that isn't a file gets index.html. A missing build file under /assets/ is a 404, not the page.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "dist");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain" };

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") return void res.writeHead(200).end("ok");
  // Resolve inside dist only.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  let exists = false;
  try {
    exists = statSync(file).isFile();
  } catch {
    exists = false;
  }
  if (!exists) {
    if (rel.startsWith("/assets/")) return void res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    file = join(root, "index.html");
  }
  const hashed = file.includes(`${join(root, "assets")}`);
  res.writeHead(200, {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT || 8080), () => console.log(`site on :${process.env.PORT || 8080}`));
