import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8791),
  projectDir: resolve(process.env.VOICE_PROJECT_DIR || process.cwd()),
  opencodeCommand: process.env.OPENCODE_COMMAND || "opencode",
  opencodeModel: process.env.OPENCODE_MODEL || "",
  opencodeAgent: process.env.OPENCODE_AGENT || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiSttModel: process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe",
  openaiTtsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  openaiTtsVoice: process.env.OPENAI_TTS_VOICE || "alloy",
  ffmpegCommand: process.env.FFMPEG_COMMAND || "ffmpeg",
  listenIp: process.env.MEDIASOUP_LISTEN_IP || "127.0.0.1",
  announcedAddress: process.env.MEDIASOUP_ANNOUNCED_ADDRESS || undefined
};
