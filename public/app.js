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
  scrollback: 10000,
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
container.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  terminal.focus();
});

let inputDataChannel;
let resizeTimer;

function send(event) {
  if (inputDataChannel?.readyState === "open") inputDataChannel.send(JSON.stringify(event));
}

function fit() {
  fitAddon.fit();
  send({ type: "terminal.resize", payload: { cols: terminal.cols, rows: terminal.rows } });
}

function waitForIceGathering(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    peerConnection.addEventListener("icegatheringstatechange", () => {
      if (peerConnection.iceGatheringState === "complete") resolve();
    });
  });
}

async function connect() {
  const peerConnection = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  // DCEP opens the SCTP stream after the WHIP offer/answer exchange.
  inputDataChannel = peerConnection.createDataChannel("agent-control", { ordered: true });
  inputDataChannel.addEventListener("open", () => {
    connectionEl.textContent = "connected";
    connectionEl.className = "connected hidden";
    fit();
    terminal.focus();
  });
  inputDataChannel.addEventListener("close", () => {
    connectionEl.textContent = "disconnected · reload to reconnect";
    connectionEl.className = "error";
  });
  inputDataChannel.addEventListener("message", (message) => handleEvent(JSON.parse(message.data)));

  try {
    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    await waitForIceGathering(peerConnection);
    const response = await fetch("/whip", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: peerConnection.localDescription.sdp
    });
    if (!response.ok) throw new Error(await response.text() || `WHIP request failed: ${response.status}`);
    await peerConnection.setRemoteDescription({ type: "answer", sdp: await response.text() });
    window.addEventListener("beforeunload", () => fetch(response.headers.get("Location"), { method: "DELETE", keepalive: true }));
  } catch (error) {
    connectionEl.textContent = "connection error";
    connectionEl.className = "error";
    terminal.write(`\r\n\x1b[31mvoice-cli: ${error.message}\x1b[0m\r\n`);
    peerConnection.close();
  }
}

function handleEvent(event) {
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
}

terminal.onData((data) => send({ type: "terminal.input", payload: { data } }));
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fit, 40);
}).observe(container);

connect();
