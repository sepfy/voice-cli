import { config } from "./server/config.mjs";
import { createHttpServer } from "./server/http.mjs";
import { createRealtimeSfu } from "./server/realtime-sfu.mjs";
import { handleTerminalEvent, startTerminal, stopTerminal } from "./server/terminal.mjs";

const sfu = await createRealtimeSfu(config, {
  onSessionReady: (session, sendEvent) => startTerminal(session, config, sendEvent),
  onDataMessage: (session, event, sendEvent) => handleTerminalEvent(session, event, config, sendEvent),
  onSessionClosed: stopTerminal
});
const server = createHttpServer(config, sfu);

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Voice CLI listening on http://127.0.0.1:${config.port}`);
  console.log(`mediasoup WebRTC listens on ${config.listenIp}${config.announcedAddress ? ` (${config.announcedAddress})` : ""}`);
});

process.on("SIGINT", () => server.close(() => sfu.close()));
