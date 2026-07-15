import { config } from "./server/config.mjs";
import { readFile, rm } from "node:fs/promises";
import { createHttpServer } from "./server/http.mjs";
import { createRealtimeSfu } from "./server/realtime-sfu.mjs";
import { handleTerminalEvent, startTerminal, stopTerminal } from "./server/terminal.mjs";
import { createOpenAiVoice } from "./server/openai-voice.mjs";

const voice = createOpenAiVoice(config);
let sfu;
sfu = await createRealtimeSfu(config, {
  onWorkspaceCreated: (workspace, sendEvent) => startTerminal(workspace, config, sendEvent),
  onDataMessage: (connection, event, sendEvent) => {
    if (event.type === "audio.recording.start") void startVoiceRecording(connection, sendEvent);
    else if (event.type === "audio.recording.stop") void stopVoiceRecording(connection, sendEvent);
    else handleTerminalEvent(connection.workspace, event, config, sendEvent);
  },
  onWorkspaceClosed: stopTerminal
});
const server = createHttpServer(config, sfu, voice);

async function startVoiceRecording(connection, sendEvent) {
  try {
    if (!connection.audioStartPromise) connection.audioStartPromise = sfu.startAudioRecording(connection.id);
    await connection.audioStartPromise;
    sendEvent(connection, { type: "audio.recording.started", payload: {} });
  } catch (error) {
    connection.audioStartPromise = null;
    sendEvent(connection, { type: "error", payload: { message: error.message } });
  }
}

async function stopVoiceRecording(connection, sendEvent) {
  let recording;
  try {
    await connection.audioStartPromise;
    sendEvent(connection, { type: "audio.transcribing", payload: {} });
    recording = await sfu.stopAudioRecording(connection.id);
    const text = await voice.transcribe(await readFile(recording.audioPath), "audio/webm");
    if (!text) throw new Error("No speech was detected.");
    sfu.sendInput(connection.id, { type: "user.message", payload: { text } });
    sendEvent(connection, { type: "audio.transcribed", payload: { text } });
  } catch (error) {
    sendEvent(connection, { type: "error", payload: { message: error.message } });
  } finally {
    connection.audioStartPromise = null;
    if (recording) await rm(recording.directory, { recursive: true, force: true });
  }
}

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Voice CLI listening on http://127.0.0.1:${config.port}`);
  console.log(`mediasoup WebRTC listens on ${config.listenIp}${config.announcedAddress ? ` (${config.announcedAddress})` : ""}`);
});

process.on("SIGINT", () => server.close(() => sfu.close()));
