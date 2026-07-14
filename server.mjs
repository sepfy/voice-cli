import { config } from "./server/config.mjs";
import { readFile, rm } from "node:fs/promises";
import { createHttpServer } from "./server/http.mjs";
import { createRealtimeSfu } from "./server/realtime-sfu.mjs";
import { handleTerminalEvent, startTerminal, stopTerminal } from "./server/terminal.mjs";
import { createOpenAiVoice } from "./server/openai-voice.mjs";

const voice = createOpenAiVoice(config);
let sfu;
sfu = await createRealtimeSfu(config, {
  onSessionReady: (session, sendEvent) => startTerminal(session, config, sendEvent),
  onDataMessage: (session, event, sendEvent) => {
    if (event.type === "audio.recording.start") void startVoiceRecording(session, sendEvent);
    else if (event.type === "audio.recording.stop") void stopVoiceRecording(session, sendEvent);
    else handleTerminalEvent(session, event, config, sendEvent);
  },
  onSessionClosed: stopTerminal
});
const server = createHttpServer(config, sfu, voice);

async function startVoiceRecording(session, sendEvent) {
  try {
    if (!session.audioStartPromise) session.audioStartPromise = sfu.startAudioRecording(session.id);
    await session.audioStartPromise;
    sendEvent(session, { type: "audio.recording.started", payload: {} });
  } catch (error) {
    session.audioStartPromise = null;
    sendEvent(session, { type: "error", payload: { message: error.message } });
  }
}

async function stopVoiceRecording(session, sendEvent) {
  let recording;
  try {
    await session.audioStartPromise;
    sendEvent(session, { type: "audio.transcribing", payload: {} });
    recording = await sfu.stopAudioRecording(session.id);
    const text = await voice.transcribe(await readFile(recording.audioPath), "audio/webm");
    if (!text) throw new Error("No speech was detected.");
    sfu.sendInput(session.id, { type: "user.message", payload: { text } });
    sendEvent(session, { type: "audio.transcribed", payload: { text } });
  } catch (error) {
    sendEvent(session, { type: "error", payload: { message: error.message } });
  } finally {
    session.audioStartPromise = null;
    if (recording) await rm(recording.directory, { recursive: true, force: true });
  }
}

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Voice CLI listening on http://127.0.0.1:${config.port}`);
  console.log(`mediasoup WebRTC listens on ${config.listenIp}${config.announcedAddress ? ` (${config.announcedAddress})` : ""}`);
});

process.on("SIGINT", () => server.close(() => sfu.close()));
