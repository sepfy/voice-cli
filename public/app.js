import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";

const container = document.querySelector("#terminal");
const connectionEl = document.querySelector("#connection");
const fitAddon = new FitAddon();
const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.18,
  letterSpacing: 0,
  scrollback: 10000,
  allowTransparency: false,
  theme: {
    background: "#0a0a0a",
    foreground: "#d0d0d0",
    cursor: "#f0f0f0",
    cursorAccent: "#0a0a0a",
    selectionBackground: "#3a3a3a99",
    black: "#1b1b1b",
    red: "#d96c75",
    green: "#8ccf7e",
    yellow: "#e5c07b",
    blue: "#70a5eb",
    magenta: "#c68aee",
    cyan: "#74bee9",
    white: "#d0d0d0",
    brightBlack: "#666666",
    brightRed: "#e8838f",
    brightGreen: "#a7da93",
    brightYellow: "#f0cf8e",
    brightBlue: "#86b6f2",
    brightMagenta: "#d4a0f3",
    brightCyan: "#8ac8ee",
    brightWhite: "#ffffff"
  }
});

terminal.loadAddon(fitAddon);
terminal.open(container);

let ws;
let resizeTimer;

function send(type, payload = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function fit() {
  fitAddon.fit();
  send("terminal.resize", { cols: terminal.cols, rows: terminal.rows });
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener("open", () => {
    connectionEl.textContent = "connected";
    connectionEl.className = "connected hidden";
    fit();
    terminal.focus();
  });

  ws.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "terminal.output") terminal.write(event.payload.data);
    if (event.type === "terminal.exit") {
      terminal.write(`\r\n\x1b[90m[OpenCode exited with code ${event.payload.exit_code}]\x1b[0m\r\n`);
      connectionEl.textContent = "process exited";
      connectionEl.className = "error";
    }
    if (event.type === "error") {
      terminal.write(`\r\n\x1b[31mvoice-cli: ${event.payload.message}\x1b[0m\r\n`);
      connectionEl.textContent = "error";
      connectionEl.className = "error";
    }
  });

  ws.addEventListener("close", () => {
    connectionEl.textContent = "disconnected · reload to reconnect";
    connectionEl.className = "error";
  });
}

terminal.onData((data) => send("terminal.input", { data }));
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fit, 40);
}).observe(container);

connect();
