import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startAudioBridge(router, producer, config) {
  const port = await availableUdpPort();
  const directory = await mkdtemp(join(tmpdir(), "voice-cli-"));
  const sdpPath = join(directory, "audio.sdp");
  const audioPath = join(directory, "audio.webm");
  const plainTransport = await router.createPlainTransport({ listenInfo: { protocol: "udp", ip: "127.0.0.1" }, rtcpMux: true, comedia: false });
  const consumer = await plainTransport.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities });
  await writeFile(sdpPath, createSdp(port, consumer.rtpParameters));
  const ffmpeg = spawn(config.ffmpegCommand, ["-y", "-loglevel", "error", "-protocol_whitelist", "file,udp,rtp", "-i", sdpPath, "-map", "0:a:0", "-c:a", "copy", audioPath], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  ffmpeg.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  await new Promise((resolve, reject) => {
    ffmpeg.once("error", reject);
    setTimeout(resolve, 100);
  });
  await plainTransport.connect({ ip: "127.0.0.1", port });
  return {
    async stop() {
      const [producerStats, consumerStats] = await Promise.all([producer.getStats(), consumer.getStats()]);
      console.log("Audio bridge stats", JSON.stringify({ producer: producerStats[0], consumer: consumerStats[0] }));
      await stopProcess(ffmpeg);
      consumer.close();
      plainTransport.close();
      await rm(sdpPath, { force: true });
      const info = await stat(audioPath).catch(() => null);
      if (!info?.size) {
        if (stderr.trim()) console.error(`FFmpeg audio bridge failed: ${stderr.trim()}`);
        throw new Error("No audio was captured from the SFU track.");
      }
      return { audioPath, directory };
    },
    abort() {
      consumer.close();
      plainTransport.close();
      ffmpeg.kill("SIGKILL");
      rm(directory, { recursive: true, force: true });
    }
  };
}

function availableUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function createSdp(port, rtpParameters) {
  const codec = rtpParameters.codecs[0];
  const channels = codec.channels || 2;
  const fmtp = Object.entries(codec.parameters || {}).map(([key, value]) => `${key}=${value}`).join(";");
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=mediasoup audio bridge",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${port} RTP/AVP ${codec.payloadType}`,
    `a=rtpmap:${codec.payloadType} opus/48000/${channels}`,
    ...(fmtp ? [`a=fmtp:${codec.payloadType} ${fmtp}`] : []),
    "a=rtcp-mux",
    "a=recvonly",
    ""
  ].join("\n");
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.stdin.write("q\n");
    setTimeout(() => child.kill("SIGINT"), 2000).unref();
    setTimeout(() => child.kill("SIGKILL"), 4000).unref();
  });
}
