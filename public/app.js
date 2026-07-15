import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";

const container = document.querySelector("#terminal");
const connectionEl = document.querySelector("#connection");
const voiceButton = document.querySelector("#voice");
const toastEl = document.querySelector("#toast");
const sessionListEl = document.querySelector("#session-list");
const newSessionButton = document.querySelector("#new-session");
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
let peerConnection;
let resizeTimer;
let isRecording = false;
let pushToTalk = false;
let microphoneStream;
let microphoneTrack;
let audioSender;
let audioPublished = false;
let audioPublishing = false;
let toastTimer;
let activeSessionId;
let whipLocation;
let switchingSession = false;
let sessions = [];

function showToast(message) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000);
}

function beginPushToTalk() {
  if (pushToTalk || isRecording) return;
  pushToTalk = true;
  startRecording().then(() => {
    if (!pushToTalk && isRecording) stopRecording();
  }).catch((error) => {
    pushToTalk = false;
    showToast(error.message);
    resetVoiceButton();
  });
}

function endPushToTalk() {
  if (!pushToTalk) return;
  pushToTalk = false;
  if (isRecording) stopRecording();
}

function send(event) {
  if (inputDataChannel?.readyState === "open") inputDataChannel.send(JSON.stringify(event));
}

function fit() {
  fitAddon.fit();
  send({ type: "terminal.resize", payload: { cols: terminal.cols, rows: terminal.rows } });
}

function selectActiveSession() {
  if (activeSessionId) send({ type: "session.select", payload: { sessionId: activeSessionId } });
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
  peerConnection = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  // DCEP opens the SCTP stream after the WHIP offer/answer exchange.
  const channel = peerConnection.createDataChannel("agent-control", { ordered: true });
  inputDataChannel = channel;
  channel.addEventListener("open", () => {
    if (channel !== inputDataChannel) return;
    connectionEl.textContent = "connected";
    connectionEl.className = "connected hidden";
    selectActiveSession();
    setTimeout(() => {
      if (channel === inputDataChannel) selectActiveSession();
    }, 100);
    fit();
    terminal.focus();
    publishAudio();
  });
  channel.addEventListener("close", () => {
    if (channel !== inputDataChannel || switchingSession) return;
    connectionEl.textContent = "disconnected · reload to reconnect";
    connectionEl.className = "error";
  });
  channel.addEventListener("message", (message) => {
    if (channel === inputDataChannel) handleEvent(JSON.parse(message.data));
  });

  try {
    try {
      if (!microphoneStream) microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneTrack = microphoneStream.getAudioTracks()[0];
      microphoneTrack.enabled = false;
      audioSender = peerConnection.addTrack(microphoneTrack, microphoneStream);
    } catch (error) {
      showToast(`Microphone is unavailable: ${error.message}`);
    }
    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    await waitForIceGathering(peerConnection);
    const response = await fetch("/whip", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: peerConnection.localDescription.sdp
    });
    if (!response.ok) throw new Error(await response.text() || `WHIP request failed: ${response.status}`);
    await peerConnection.setRemoteDescription({ type: "answer", sdp: await response.text() });
    whipLocation = response.headers.get("Location");
  } catch (error) {
    connectionEl.textContent = "connection error";
    connectionEl.className = "error";
    showToast(error.message);
    peerConnection?.close();
  }
}

async function disconnect() {
  const location = whipLocation;
  whipLocation = undefined;
  inputDataChannel = undefined;
  peerConnection?.close();
  peerConnection = undefined;
  audioSender = undefined;
  audioPublished = false;
  audioPublishing = false;
  if (location) await fetch(location, { method: "DELETE", keepalive: true }).catch(() => {});
}

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function renderSessions() {
  sessionListEl.textContent = "";
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "No sessions";
    sessionListEl.append(empty);
    return;
  }
  for (const session of sessions) {
    const item = document.createElement("div");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.className = `session-item${session.id === activeSessionId ? " active" : ""}`;
    item.addEventListener("click", () => selectSession(session.id));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSession(session.id);
      }
    });
    const avatar = pixelAvatar(session.id);
    const details = document.createElement("span");
    details.className = "session-details";
    const name = document.createElement("span");
    name.className = "session-name";
    name.textContent = session.name;
    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = session.connected ? `${session.connected} connected` : session.running ? "idle" : "starting";
    details.append(name, meta);
    const controls = document.createElement("span");
    const status = document.createElement("span");
    status.className = `session-status${session.connected ? " connected" : session.running ? " running" : ""}`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "session-close";
    close.textContent = "x";
    close.title = `Close ${session.name}`;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSession(session.id);
    });
    controls.append(status, close);
    item.append(avatar, details, controls);
    sessionListEl.append(item);
  }
}

function pixelAvatar(id) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const palettes = [
    ["#d87e58", "#f1bb89", "#e7e5dc"],
    ["#627aa8", "#d4a47a", "#d9d9d2"],
    ["#8b5d94", "#d9a37d", "#b8d88b"],
    ["#b66a59", "#c99a62", "#86bdd1"]
  ];
  const [hair, skin, shirt] = palettes[Math.abs(hash) % palettes.length];
  const pixels = ["  HHHH  ", " HHHHHH ", "HSSSSSSH", "HS EES H", "HS NSS H", "H SSSS H", " TTTTTT ", "T T  T T"];
  const avatar = document.createElement("span");
  avatar.className = "pixel-avatar";
  for (const pixel of pixels.join("")) {
    const cell = document.createElement("i");
    if (pixel === "H") cell.style.background = hair;
    if (pixel === "S" || pixel === "N") cell.style.background = skin;
    if (pixel === "E") cell.style.background = "#151515";
    if (pixel === "T") cell.style.background = shirt;
    avatar.append(cell);
  }
  return avatar;
}

async function refreshSessions() {
  const data = await request("/sessions");
  sessions = data.sessions;
  renderSessions();
  return sessions;
}

async function createSession() {
  const name = `Session ${sessions.length + 1}`;
  const data = await request("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  await refreshSessions();
  await selectSession(data.session.id);
}

async function closeSession(id) {
  if (!confirm("Close this OpenCode session?")) return;
  if (id === activeSessionId) {
    activeSessionId = undefined;
    terminal.reset();
    localStorage.removeItem("voice-cli.session");
  }
  await request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refreshSessions();
  if (!activeSessionId && sessions.length) await selectSession(sessions[0].id);
  else if (!sessions.length) await createSession();
}

async function selectSession(id) {
  if (id === activeSessionId && peerConnection) return terminal.focus();
  if (isRecording) stopRecording();
  activeSessionId = id;
  localStorage.setItem("voice-cli.session", id);
  terminal.reset();
  renderSessions();
  selectActiveSession();
  fit();
  terminal.focus();
  await refreshSessions();
}

async function initializeSessions() {
  await refreshSessions();
  const saved = localStorage.getItem("voice-cli.session");
  const initial = sessions.find((session) => session.id === saved) || sessions[0];
  if (initial) {
    activeSessionId = initial.id;
    renderSessions();
  } else {
    const data = await request("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Session 1" }) });
    activeSessionId = data.session.id;
    localStorage.setItem("voice-cli.session", activeSessionId);
    await refreshSessions();
  }
  await connect();
}

async function publishAudio() {
  if (audioPublished || audioPublishing || !audioSender || !inputDataChannel || inputDataChannel.readyState !== "open") return;
  audioPublishing = true;
  try {
    const transceiver = peerConnection.getTransceivers().find((item) => item.sender === audioSender);
    const rtpParameters = audioSender.getParameters();
    const stats = await audioSender.getStats();
    const outbound = [...stats.values()].find((item) => item.type === "outbound-rtp" && item.kind === "audio" && item.ssrc);
    if (!transceiver?.mid || !rtpParameters.codecs?.length || !outbound) {
      setTimeout(publishAudio, 100);
      return;
    }
    rtpParameters.encodings = rtpParameters.encodings.map((encoding) => ({ ...encoding, ssrc: outbound.ssrc }));
    audioPublished = true;
    send({ type: "audio.produce", payload: { rtpParameters: { ...rtpParameters, mid: transceiver.mid } } });
  } catch {
    setTimeout(publishAudio, 100);
  } finally {
    audioPublishing = false;
  }
}

function handleEvent(event) {
  if (event.type === "session.selected" && event.sessionId === activeSessionId) {
    fit();
    terminal.focus();
  }
  if (event.type === "audio.ready" && microphoneTrack) microphoneTrack.enabled = false;
  if (event.type === "audio.transcribing") {
    voiceButton.disabled = true;
    voiceButton.textContent = "Transcribing...";
  }
  if (event.type === "audio.transcribed") resetVoiceButton();
  if (event.type === "terminal.output" && event.sessionId === activeSessionId) terminal.write(event.payload.data);
  if (event.type === "terminal.exit") {
    terminal.write(`\r\n\x1b[90m[OpenCode exited with code ${event.payload.exit_code}]\x1b[0m\r\n`);
    connectionEl.textContent = "process exited";
    connectionEl.className = "error";
  }
  if (event.type === "error") {
    showToast(event.payload.message);
    connectionEl.textContent = "error";
    connectionEl.className = "error";
    resetVoiceButton();
  }
}

async function startRecording() {
  if (!microphoneTrack) throw new Error("Microphone permission is required. Reload and allow microphone access.");
  microphoneTrack.enabled = true;
  isRecording = true;
  send({ type: "audio.recording.start", payload: {} });
  voiceButton.textContent = "Stop recording";
  voiceButton.classList.add("recording");
}

function stopRecording() {
  isRecording = false;
  microphoneTrack.enabled = false;
  send({ type: "audio.recording.stop", payload: {} });
  voiceButton.textContent = "Stopping...";
  voiceButton.classList.remove("recording");
}

function resetVoiceButton() {
  voiceButton.disabled = false;
  voiceButton.textContent = "Hold F8 to talk";
}

terminal.onData((data) => send({ type: "terminal.input", payload: { data } }));
newSessionButton.addEventListener("click", () => createSession().catch((error) => showToast(error.message)));
voiceButton.addEventListener("click", async () => {
  try {
    if (isRecording) stopRecording();
    else await startRecording();
  } catch (error) {
    showToast(error.message);
  }
});
window.addEventListener("keydown", (event) => {
  if (event.code !== "F8" || event.repeat) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  beginPushToTalk();
}, true);
window.addEventListener("keyup", (event) => {
  if (event.code !== "F8") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  endPushToTalk();
}, true);
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fit, 40);
}).observe(container);

window.addEventListener("beforeunload", () => {
  if (whipLocation) fetch(whipLocation, { method: "DELETE", keepalive: true });
  microphoneStream?.getTracks().forEach((track) => track.stop());
});
setInterval(() => refreshSessions().catch(() => {}), 5000);
initializeSessions().catch((error) => showToast(error.message));
