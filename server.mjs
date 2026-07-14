import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");
const vendorFiles = new Map([
  ["/vendor/xterm.mjs", join(rootDir, "node_modules/@xterm/xterm/lib/xterm.mjs")],
  ["/vendor/addon-fit.mjs", join(rootDir, "node_modules/@xterm/addon-fit/lib/addon-fit.mjs")],
  ["/vendor/xterm.css", join(rootDir, "node_modules/@xterm/xterm/css/xterm.css")]
]);
const recordingsDir = join(rootDir, "recordings");
const port = Number(process.env.PORT || 8791);
const sttCommand = process.env.STT_COMMAND || "";
const projectDir = resolve(process.env.VOICE_PROJECT_DIR || process.cwd());
const opencodeCommand = process.env.OPENCODE_COMMAND || "opencode";
const opencodeModel = process.env.OPENCODE_MODEL || "";
const opencodeAgent = process.env.OPENCODE_AGENT || "";
const shouldOpenBrowser = process.env.VOICE_OPEN_BROWSER === "1";

const sockets = new Set();
const sessions = new Map();

function now() {
  return new Date().toISOString();
}

function sessionFor(socket) {
  let session = sessions.get(socket);
  if (!session) {
    session = {
      id: crypto.randomUUID(),
      audio: null,
      opencodeSessionId: null,
      agentProcess: null,
      terminal: null
    };
    sessions.set(socket, session);
  }
  return session;
}

function send(socket, event) {
  if (socket.destroyed) return;
  socket.write(encodeFrame(JSON.stringify({ ...event, at: now() })));
}

function broadcast(event) {
  for (const socket of sockets) send(socket, event);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = vendorFiles.get(pathname) || normalize(join(publicDir, pathname));

  if (!path.startsWith(publicDir) && !vendorFiles.has(pathname)) {
    respond(res, 403, { error: "Forbidden" });
    return;
  }

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
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    respond(res, 200, {
      ok: true,
      transport: "websocket",
      sttConfigured: Boolean(sttCommand),
      projectDir,
      opencodeCommand,
      clients: sockets.size
    });
    return;
  }

  await serveStatic(req, res);
});

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  sockets.add(socket);
  const session = sessionFor(socket);
  send(socket, {
    type: "runtime.ready",
    payload: {
      session_id: session.id,
      stt_configured: Boolean(sttCommand),
      project_dir: projectDir,
      opencode_command: opencodeCommand
    }
  });
  startTerminal(socket, session);

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const parsed = decodeFrame(buffer);
      if (!parsed) break;
      buffer = buffer.subarray(parsed.bytes);
      handleFrame(socket, parsed);
    }
  });

  socket.on("close", () => cleanupSocket(socket));
  socket.on("error", () => cleanupSocket(socket));
});

async function handleFrame(socket, frame) {
  if (frame.opcode === 0x8) {
    socket.end();
    return;
  }

  const session = sessionFor(socket);

  if (frame.opcode === 0x2) {
    await handleAudioChunk(socket, session, frame.payload);
    return;
  }

  if (frame.opcode !== 0x1) return;

  let message;
  try {
    message = JSON.parse(frame.payload.toString("utf8"));
  } catch {
    send(socket, { type: "error", payload: { message: "Invalid JSON message." } });
    return;
  }

  if (message.type === "user.message") {
    await runAgentLoop(socket, session, message.payload?.text || "");
    return;
  }

  if (message.type === "terminal.input") {
    session.terminal?.write(message.payload?.data || "");
    return;
  }

  if (message.type === "terminal.resize") {
    const cols = Math.max(2, Math.min(500, Number(message.payload?.cols) || 80));
    const rows = Math.max(1, Math.min(200, Number(message.payload?.rows) || 24));
    session.terminal?.resize(cols, rows);
    return;
  }

  if (message.type === "audio.start") {
    await startAudio(socket, session, message.payload || {});
    return;
  }

  if (message.type === "audio.stop") {
    await stopAudio(socket, session);
    return;
  }

  send(socket, { type: "error", payload: { message: `Unsupported type: ${message.type}` } });
}

function startTerminal(socket, session) {
  try {
    const args = [];
    if (opencodeModel) args.push("--model", opencodeModel);
    if (opencodeAgent) args.push("--agent", opencodeAgent);
    const terminal = pty.spawn(opencodeCommand, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: projectDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "voice-cli"
      }
    });
    session.terminal = terminal;
    terminal.onData((data) => send(socket, { type: "terminal.output", payload: { data } }));
    terminal.onExit(({ exitCode, signal }) => {
      session.terminal = null;
      send(socket, { type: "terminal.exit", payload: { exit_code: exitCode, signal } });
    });
  } catch (error) {
    send(socket, { type: "error", payload: { message: `Unable to start OpenCode terminal: ${error.message}` } });
  }
}

async function startAudio(socket, session, payload) {
  await mkdir(recordingsDir, { recursive: true });
  const startedAt = Date.now();
  const path = join(recordingsDir, `${session.id}-${startedAt}.webm`);
  const stream = createWriteStream(path);

  session.audio = {
    path,
    stream,
    chunks: 0,
    bytes: 0,
    mimeType: payload.mime_type || "audio/webm"
  };

  send(socket, {
    type: "audio.started",
    payload: {
      path,
      mime_type: session.audio.mimeType
    }
  });
}

async function handleAudioChunk(socket, session, chunk) {
  if (!session.audio) {
    send(socket, { type: "error", payload: { message: "Audio chunk received before audio.start." } });
    return;
  }

  session.audio.chunks += 1;
  session.audio.bytes += chunk.length;
  session.audio.stream.write(chunk);

  if (session.audio.chunks % 10 === 0) {
    send(socket, {
      type: "audio.progress",
      payload: {
        chunks: session.audio.chunks,
        bytes: session.audio.bytes
      }
    });
  }
}

async function stopAudio(socket, session) {
  const audio = session.audio;
  if (!audio) {
    send(socket, { type: "error", payload: { message: "No active audio stream." } });
    return;
  }

  await new Promise((resolve) => audio.stream.end(resolve));
  session.audio = null;

  send(socket, {
    type: "audio.saved",
    payload: {
      path: audio.path,
      chunks: audio.chunks,
      bytes: audio.bytes,
      mime_type: audio.mimeType
    }
  });

  if (!sttCommand) {
    send(socket, {
      type: "agent.message",
      payload: {
        text: `Audio received locally: ${audio.chunks} chunks, ${audio.bytes} bytes. Saved at ${audio.path}. Configure STT_COMMAND to transcribe it inside the agent runtime.`
      }
    });
    return;
  }

  send(socket, { type: "stt.started", payload: { command: sttCommand, path: audio.path } });
  try {
    const transcript = await runStt(audio.path);
    send(socket, { type: "stt.final", payload: { text: transcript } });
    await runAgentLoop(socket, session, transcript);
  } catch (error) {
    send(socket, { type: "error", payload: { message: `STT failed: ${error.message}` } });
  }
}

function runStt(audioPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(sttCommand, [audioPath], {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `STT command exited with ${code}`));
    });
  });
}

async function runAgentLoop(socket, session, text) {
  const prompt = text.trim();
  if (!prompt) {
    send(socket, { type: "error", payload: { message: "Empty prompt." } });
    return;
  }

  if (session.agentProcess) {
    send(socket, { type: "error", payload: { message: "OpenCode is already handling a request." } });
    return;
  }

  send(socket, {
    type: "agent.started",
    payload: {
      session_id: session.id,
      input: prompt
    }
  });

  const args = ["run", "--format", "json", "--dir", projectDir];
  if (session.opencodeSessionId) args.push("--session", session.opencodeSessionId);
  if (opencodeModel) args.push("--model", opencodeModel);
  if (opencodeAgent) args.push("--agent", opencodeAgent);
  args.push("--", prompt);

  try {
    const response = await runOpencode(socket, session, args);
    send(socket, { type: "agent.done", payload: { text: response } });
  } catch (error) {
    send(socket, { type: "error", payload: { message: error.message } });
    send(socket, { type: "agent.done", payload: { text: "" } });
  }
}

function runOpencode(socket, session, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(opencodeCommand, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    session.agentProcess = child;

    let buffer = "";
    let response = "";
    let stderr = "";
    let settled = false;

    function finish(error) {
      if (settled) return;
      settled = true;
      session.agentProcess = null;
      if (error) reject(error);
      else resolvePromise(response);
    }

    function handleLine(line) {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.sessionID) session.opencodeSessionId = event.sessionID;
      if (event.type === "text" && typeof event.part?.text === "string") {
        const delta = event.part.text;
        response += delta;
        send(socket, { type: "agent.delta", payload: { text: delta } });
      }
      if (event.type === "error") {
        const detail = event.error?.data?.message || event.error?.message || event.error?.name;
        if (detail) stderr += `${detail}\n`;
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
    });
    child.on("error", (error) => {
      const message = error.code === "ENOENT"
        ? `OpenCode executable not found: ${opencodeCommand}. Install OpenCode or pass --opencode <path>.`
        : `Unable to start OpenCode: ${error.message}`;
      finish(new Error(message));
    });
    child.on("exit", (code, signal) => {
      if (buffer) handleLine(buffer);
      if (code === 0) finish();
      else {
        const reason = stderr.trim() || (signal ? `terminated by ${signal}` : `exited with code ${code}`);
        finish(new Error(`OpenCode failed: ${reason}`));
      }
    });
  });
}

function cleanupSocket(socket) {
  sockets.delete(socket);
  const session = sessions.get(socket);
  if (session?.audio?.stream) session.audio.stream.destroy();
  if (session?.agentProcess) session.agentProcess.kill("SIGTERM");
  if (session?.terminal) session.terminal.kill();
  sessions.delete(socket);
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  let payload = buffer.subarray(offset, offset + length);
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }

  return {
    opcode,
    payload,
    bytes: offset + length
  };
}

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Voice CLI listening on ${url}`);
  console.log(`Project: ${projectDir}`);
  console.log(`OpenCode: ${opencodeCommand}`);
  console.log(`STT adapter: ${sttCommand || "(not configured)"}`);
  if (shouldOpenBrowser) openBrowser(url);
});

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error(`Could not open browser: ${error.message}`));
  child.unref();
}

process.on("SIGINT", () => {
  broadcast({ type: "runtime.stopping", payload: {} });
  for (const [socket, session] of sessions) {
    if (session.terminal) session.terminal.kill();
    socket.end();
  }
  server.close(() => process.exit(0));
});
