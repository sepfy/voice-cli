import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

export function createHttpServer(config, sfu) {
  const publicDir = join(config.rootDir, "public");
  const vendorFiles = new Map([
    ["/vendor/xterm.mjs", join(config.rootDir, "node_modules/@xterm/xterm/lib/xterm.mjs")],
    ["/vendor/addon-fit.mjs", join(config.rootDir, "node_modules/@xterm/addon-fit/lib/addon-fit.mjs")],
    ["/vendor/xterm.css", join(config.rootDir, "node_modules/@xterm/xterm/css/xterm.css")]
  ]);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/whip")) {
      res.writeHead(204, { "Access-Control-Allow-Methods": "OPTIONS, POST, DELETE", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/health") return respond(res, 200, { ok: true, transport: "whip-mediasoup-datachannel", clients: sfu.clients(), projectDir: config.projectDir, opencodeCommand: config.opencodeCommand });
    if (req.method === "POST" && url.pathname === "/whip") return createWhipSession(req, res, sfu);
    if (req.method === "DELETE" && url.pathname.startsWith("/whip/session/")) {
      sfu.closeSession(url.pathname.slice("/whip/session/".length));
      res.writeHead(204);
      return res.end();
    }
    await serveStatic(req, res, publicDir, vendorFiles);
  });
}

async function createWhipSession(req, res, sfu) {
  if (!req.headers["content-type"]?.startsWith("application/sdp")) return respond(res, 415, { error: "WHIP requires application/sdp." });
  let offer = "";
  for await (const chunk of req) offer += chunk;
  try {
    const session = await sfu.createSession(offer);
    res.writeHead(201, { "Content-Type": "application/sdp", Location: session.location, "Access-Control-Expose-Headers": "Location" });
    res.end(session.answer);
  } catch (error) {
    respond(res, 400, { error: error.message });
  }
}

async function serveStatic(req, res, publicDir, vendorFiles) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = vendorFiles.get(pathname) || normalize(join(publicDir, pathname));
  if (!path.startsWith(publicDir) && !vendorFiles.has(pathname)) return respond(res, 403, { error: "Forbidden" });
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": contentType(path) });
    res.end(body);
  } catch {
    respond(res, 404, { error: "Not found" });
  }
}

function respond(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function contentType(path) {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    default: return "application/octet-stream";
  }
}
