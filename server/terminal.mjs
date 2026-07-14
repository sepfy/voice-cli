import { spawn } from "node:child_process";
import pty from "node-pty";

export function startTerminal(session, config, sendEvent) {
  if (session.terminal) return;
  try {
    const args = [];
    if (config.opencodeModel) args.push("--model", config.opencodeModel);
    if (config.opencodeAgent) args.push("--agent", config.opencodeAgent);
    const terminal = pty.spawn(config.opencodeCommand, args, {
      name: "xterm-256color", cols: 100, rows: 30, cwd: config.projectDir,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "voice-cli" }
    });
    session.terminal = terminal;
    for (const input of session.pendingInput) terminal.write(input);
    session.pendingInput = [];
    terminal.onData((data) => sendEvent(session, { type: "terminal.output", payload: { data } }));
    terminal.onExit(({ exitCode, signal }) => {
      session.terminal = null;
      sendEvent(session, { type: "terminal.exit", payload: { exit_code: exitCode, signal } });
    });
    sendEvent(session, { type: "runtime.ready", payload: { session_id: session.id, project_dir: config.projectDir } });
  } catch (error) {
    sendEvent(session, { type: "error", payload: { message: `Unable to start OpenCode terminal: ${error.message}` } });
  }
}

export function stopTerminal(session) {
  session.agentProcess?.kill("SIGTERM");
  session.terminal?.kill();
}

export function handleTerminalEvent(session, event, config, sendEvent) {
  if (event.type === "terminal.input") {
    const input = event.payload?.data || "";
    if (session.terminal) session.terminal.write(input);
    else session.pendingInput.push(input);
    return;
  }
  if (event.type === "terminal.resize") {
    const cols = Math.max(2, Math.min(500, Number(event.payload?.cols) || 80));
    const rows = Math.max(1, Math.min(200, Number(event.payload?.rows) || 24));
    session.terminal?.resize(cols, rows);
    return;
  }
  if (event.type === "user.message") runAgentLoop(session, event.payload?.text || "", config, sendEvent);
  else sendEvent(session, { type: "error", payload: { message: `Unsupported DataChannel event: ${event.type}` } });
}

async function runAgentLoop(session, text, config, sendEvent) {
  const prompt = text.trim();
  if (!prompt) return sendEvent(session, { type: "error", payload: { message: "Empty prompt." } });
  if (session.agentProcess) return sendEvent(session, { type: "error", payload: { message: "OpenCode is already handling a request." } });
  sendEvent(session, { type: "agent.started", payload: { session_id: session.id, input: prompt } });
  const args = ["run", "--format", "json", "--dir", config.projectDir];
  if (session.opencodeSessionId) args.push("--session", session.opencodeSessionId);
  if (config.opencodeModel) args.push("--model", config.opencodeModel);
  if (config.opencodeAgent) args.push("--agent", config.opencodeAgent);
  args.push("--", prompt);
  try {
    const response = await runOpencode(session, args, config, sendEvent);
    sendEvent(session, { type: "agent.done", payload: { text: response } });
  } catch (error) {
    sendEvent(session, { type: "error", payload: { message: error.message } });
  }
}

function runOpencode(session, args, config, sendEvent) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.opencodeCommand, args, { cwd: config.projectDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
      try { event = JSON.parse(line); } catch { return; }
      if (event.sessionID) session.opencodeSessionId = event.sessionID;
      if (event.type === "text" && typeof event.part?.text === "string") {
        response += event.part.text;
        sendEvent(session, { type: "agent.delta", payload: { text: event.part.text } });
      }
      if (event.type === "error") stderr += `${event.error?.data?.message || event.error?.message || "OpenCode error"}\n`;
    }
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000); });
    child.on("error", (error) => finish(new Error(error.code === "ENOENT" ? `OpenCode executable not found: ${config.opencodeCommand}.` : error.message)));
    child.on("exit", (code, signal) => {
      if (buffer) handleLine(buffer);
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || (signal ? `terminated by ${signal}` : `exited with code ${code}`)));
    });
  });
}
