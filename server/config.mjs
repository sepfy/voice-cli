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
  listenIp: process.env.MEDIASOUP_LISTEN_IP || "127.0.0.1",
  announcedAddress: process.env.MEDIASOUP_ANNOUNCED_ADDRESS || undefined
};
