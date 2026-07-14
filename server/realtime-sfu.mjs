import crypto from "node:crypto";
import * as mediasoup from "mediasoup";
import { startAudioBridge } from "./audio-bridge.mjs";

const outboundTypes = new Set(["terminal.output", "terminal.exit", "runtime.ready", "agent.started", "agent.delta", "agent.done", "error", "audio.ready", "audio.recording.started", "audio.transcribing", "audio.transcribed"]);

export async function createRealtimeSfu(config, handlers) {
  const sessions = new Map();
  const worker = await mediasoup.createWorker({ logLevel: "warn" });
  const router = await worker.createRouter({
    mediaCodecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, preferredPayloadType: 111, parameters: { useinbandfec: 1 } }]
  });
  const agentTransport = await router.createDirectTransport();
  worker.on("died", () => {
    console.error("mediasoup worker died");
    process.exit(1);
  });

  function sendEvent(session, event) {
    if (session.dataProducer && !session.dataProducer.closed) {
      session.dataProducer.send(JSON.stringify({ ...event, at: new Date().toISOString() }));
    }
  }

  async function createSession(offer) {
    const remote = parseWhipOffer(offer);
    const id = crypto.randomUUID();
    const transport = await createTransport(router, config);
    await transport.connect({ dtlsParameters: { role: "client", fingerprints: [{ algorithm: remote.fingerprint.algorithm, value: remote.fingerprint.value }] } });
    const session = { id, transport, dataProducer: null, dataConsumer: null, browserDataConsumer: null, terminal: null, pendingInput: [], agentProcess: null, opencodeSessionId: null };
    sessions.set(id, session);
    transport.on("close", () => cleanupSession(id));
    transport.on("icestatechange", (state) => {
      if (state === "disconnected" || state === "closed") cleanupSession(id);
    });
    transport.on("sctpstatechange", (state) => {
      if (state === "connected") initializeDataChannel(session);
    });
    return { location: `/whip/session/${id}`, answer: createWhipAnswer(transport, remote) };
  }

  async function initializeDataChannel(session) {
    if (session.dataProducer || session.transport.closed) return;
    try {
      session.dataProducer = await session.transport.produceData({ sctpStreamParameters: { streamId: 0, ordered: true }, label: "agent-control", protocol: "json" });
      session.dataConsumer = await agentTransport.consumeData({ dataProducerId: session.dataProducer.id });
      session.browserDataConsumer = await session.transport.consumeData({ dataProducerId: session.dataProducer.id });
      session.dataConsumer.on("message", (message) => handleDataMessage(session, message));
      handlers.onSessionReady(session, sendEvent);
    } catch (error) {
      console.error(`Unable to initialize DataChannel: ${error.message}`);
      cleanupSession(session.id);
    }
  }

  function handleDataMessage(session, message) {
    let event;
    try { event = JSON.parse(Buffer.from(message).toString("utf8")); } catch {
      return sendEvent(session, { type: "error", payload: { message: "Invalid DataChannel JSON." } });
    }
    if (event.type === "audio.produce") return produceAudio(session, event.payload, sendEvent);
    if (!outboundTypes.has(event.type)) handlers.onDataMessage(session, event, sendEvent);
  }

  async function produceAudio(session, payload, sendEvent) {
    if (session.audioProducer || !payload?.rtpParameters) return;
    try {
      session.audioProducer = await session.transport.produce({ kind: "audio", rtpParameters: payload.rtpParameters });
      sendEvent(session, { type: "audio.ready", payload: { producer_id: session.audioProducer.id } });
    } catch (error) {
      console.error(`Unable to publish microphone audio: ${error.message}`);
      sendEvent(session, { type: "error", payload: { message: `Unable to publish microphone audio: ${error.message}` } });
    }
  }

  function cleanupSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    handlers.onSessionClosed(session);
    session.dataConsumer?.close();
    session.dataProducer?.close();
    session.browserDataConsumer?.close();
    session.audioProducer?.close();
    session.audioRecording?.abort();
    session.transport.close();
  }

  return {
    clients: () => sessions.size,
    audioTracks: () => [...sessions.values()].filter((session) => session.audioProducer && !session.audioProducer.closed).length,
    createSession,
    sendInput: (sessionId, event) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Voice session is no longer connected.");
      handlers.onDataMessage(session, event, sendEvent);
    },
    async startAudioRecording(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.audioProducer) throw new Error("Microphone audio track is not ready.");
      if (session.audioRecording) return;
      session.audioRecording = await startAudioBridge(router, session.audioProducer, config);
    },
    async stopAudioRecording(sessionId) {
      const session = sessions.get(sessionId);
      if (!session?.audioRecording) throw new Error("No active voice recording.");
      const recording = session.audioRecording;
      session.audioRecording = null;
      return recording.stop();
    },
    closeSession: cleanupSession,
    close: () => {
      for (const id of [...sessions.keys()]) cleanupSession(id);
      worker.close();
    }
  };
}

async function createTransport(router, config) {
  const address = config.announcedAddress ? { ip: config.listenIp, announcedAddress: config.announcedAddress } : { ip: config.listenIp };
  return router.createWebRtcTransport({
    listenInfos: [{ protocol: "udp", ...address }, { protocol: "tcp", ...address }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: true,
    numSctpStreams: { OS: 1024, MIS: 1024 }
  });
}

function parseWhipOffer(sdp) {
  const application = mediaSection(sdp, "application");
  if (!application || !application.includes("webrtc-datachannel")) throw new Error("WHIP offer must include an SCTP DataChannel.");
  const fingerprint = application.match(/a=fingerprint:([\w-]+) ([^\r\n]+)/) || sdp.match(/a=fingerprint:([\w-]+) ([^\r\n]+)/);
  if (!fingerprint) throw new Error("WHIP offer is missing a DTLS fingerprint.");
  const mid = application.match(/a=mid:([^\r\n]+)/)?.[1];
  if (!mid) throw new Error("WHIP offer is missing an application MID.");
  const audioSection = mediaSection(sdp, "audio");
  const opus = audioSection?.match(/a=rtpmap:(\d+) opus\/48000(?:\/2)?/i);
  const audioMid = audioSection?.match(/a=mid:([^\r\n]+)/)?.[1];
  const fmtp = opus && audioSection.match(new RegExp(`a=fmtp:${opus[1]} ([^\\r\\n]+)`))?.[1];
  const extmaps = audioSection?.match(/a=extmap:[^\r\n]+/g) || [];
  return {
    mid,
    fingerprint: { algorithm: fingerprint[1], value: fingerprint[2].trim() },
    audio: opus && audioMid ? { mid: audioMid, payloadType: opus[1], fmtp, extmaps } : null
  };
}

function mediaSection(sdp, kind) {
  const match = new RegExp(`(?:^|\\n)m=${kind} [\\s\\S]*?(?=\\nm=|$)`).exec(sdp);
  return match?.[0] || "";
}

function createWhipAnswer(transport, remote) {
  const fingerprint = transport.dtlsParameters.fingerprints[0];
  const candidates = transport.iceCandidates.map((candidate) => {
    const tcpType = candidate.tcpType ? ` tcptype ${candidate.tcpType}` : "";
    return `a=candidate:${candidate.foundation} 1 ${candidate.protocol.toUpperCase()} ${candidate.priority} ${candidate.address} ${candidate.port} typ ${candidate.type}${tcpType}`;
  });
  const transportLines = [`a=ice-ufrag:${transport.iceParameters.usernameFragment}`, `a=ice-pwd:${transport.iceParameters.password}`, "a=ice-options:trickle", `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`, "a=setup:passive", ...candidates, "a=end-of-candidates"];
  const audioLines = remote.audio ? [
    `m=audio 9 UDP/TLS/RTP/SAVPF ${remote.audio.payloadType}`,
    "c=IN IP4 0.0.0.0",
    `a=mid:${remote.audio.mid}`,
    ...transportLines,
    "a=recvonly",
    "a=rtcp-mux",
    "a=rtcp-mux-only",
    `a=rtpmap:${remote.audio.payloadType} opus/48000/2`,
    ...(remote.audio.fmtp ? [`a=fmtp:${remote.audio.payloadType} ${remote.audio.fmtp}`] : []),
    ...remote.audio.extmaps
  ] : [];
  const bundleMids = [remote.audio?.mid, remote.mid].filter(Boolean).join(" ");
  return ["v=0", `o=- ${Date.now()} 1 IN IP4 0.0.0.0`, "s=-", "t=0 0", `a=group:BUNDLE ${bundleMids}`, "a=ice-lite", ...audioLines, "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0", `a=mid:${remote.mid}`, ...transportLines, "a=sctp-port:5000", "a=max-message-size:262144", "a=sendrecv", ""].join("\r\n");
}
