import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";

const container = document.querySelector("#terminal");
const connectionEl = document.querySelector("#connection");
const voiceButton = document.querySelector("#voice");
const toastEl = document.querySelector("#toast");
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
  inputDataChannel = peerConnection.createDataChannel("agent-control", { ordered: true });
  inputDataChannel.addEventListener("open", () => {
    connectionEl.textContent = "connected";
    connectionEl.className = "connected hidden";
    fit();
    terminal.focus();
    publishAudio();
  });
  inputDataChannel.addEventListener("close", () => {
    connectionEl.textContent = "disconnected · reload to reconnect";
    connectionEl.className = "error";
  });
  inputDataChannel.addEventListener("message", (message) => handleEvent(JSON.parse(message.data)));

  try {
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneTrack = microphoneStream.getAudioTracks()[0];
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
    window.addEventListener("beforeunload", () => fetch(response.headers.get("Location"), { method: "DELETE", keepalive: true }));
  } catch (error) {
    connectionEl.textContent = "connection error";
    connectionEl.className = "error";
    showToast(error.message);
    peerConnection.close();
  }
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
  if (event.type === "audio.ready" && microphoneTrack) microphoneTrack.enabled = false;
  if (event.type === "audio.transcribing") {
    voiceButton.disabled = true;
    voiceButton.textContent = "Transcribing...";
  }
  if (event.type === "audio.transcribed") resetVoiceButton();
  if (event.type === "terminal.output") terminal.write(event.payload.data);
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

connect();
