const statusEl = document.querySelector("#status");
const messagesEl = document.querySelector("#messages");
const form = document.querySelector("#composer");
const input = document.querySelector("#input");
const micBtn = document.querySelector("#micBtn");

let ws = null;
let recorder = null;
let micStream = null;
let currentAgentMessage = null;

function addMessage(kind, text) {
  const item = document.createElement("div");
  item.className = `message ${kind}`;
  item.textContent = text;
  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return item;
}

function sendJson(type, payload = {}) {
  ws?.send(JSON.stringify({ type, payload }));
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    statusEl.textContent = "Connected";
  });

  ws.addEventListener("close", () => {
    statusEl.textContent = "Disconnected";
    setTimeout(connect, 1000);
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleEvent(message);
  });
}

function handleEvent(event) {
  const { type, payload } = event;

  if (type === "runtime.ready") {
    statusEl.textContent = payload.stt_configured
      ? `Connected. STT enabled. session=${payload.session_id}`
      : `Connected. STT not configured. session=${payload.session_id}`;
    addMessage("system", "Runtime is ready.");
    return;
  }

  if (type === "agent.started") {
    currentAgentMessage = addMessage("agent", "");
    return;
  }

  if (type === "agent.delta") {
    if (!currentAgentMessage) currentAgentMessage = addMessage("agent", "");
    currentAgentMessage.textContent += payload.text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  if (type === "agent.done") {
    currentAgentMessage = null;
    return;
  }

  if (type === "agent.message") {
    addMessage("agent", payload.text);
    return;
  }

  if (type === "audio.started") {
    addMessage("system", `Audio stream started: ${payload.mime_type}`);
    return;
  }

  if (type === "audio.progress") {
    statusEl.textContent = `Recording: ${payload.chunks} chunks, ${payload.bytes} bytes`;
    return;
  }

  if (type === "audio.saved") {
    addMessage("system", `Audio saved locally: ${payload.bytes} bytes\n${payload.path}`);
    statusEl.textContent = "Audio saved";
    return;
  }

  if (type === "stt.started") {
    addMessage("system", `STT started: ${payload.command}`);
    return;
  }

  if (type === "stt.final") {
    addMessage("user", payload.text);
    return;
  }

  if (type === "error") {
    addMessage("system", `Error: ${payload.message}`);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage("user", text);
  input.value = "";
  sendJson("user.message", { text });
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

micBtn.addEventListener("click", async () => {
  if (recorder?.state === "recording") {
    recorder.stop();
    micBtn.classList.remove("recording");
    micBtn.textContent = "Record";
    return;
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  sendJson("audio.start", { mime_type: mimeType });

  recorder = new MediaRecorder(micStream, { mimeType });
  recorder.addEventListener("dataavailable", async (event) => {
    if (event.data.size > 0 && ws?.readyState === WebSocket.OPEN) {
      ws.send(await event.data.arrayBuffer());
    }
  });

  recorder.addEventListener("stop", () => {
    sendJson("audio.stop");
    for (const track of micStream?.getTracks() || []) track.stop();
    micStream = null;
  });

  recorder.start(250);
  micBtn.classList.add("recording");
  micBtn.textContent = "Stop";
});

connect();

