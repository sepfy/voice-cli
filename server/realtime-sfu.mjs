import crypto from "node:crypto";
import * as mediasoup from "mediasoup";

const outboundTypes = new Set(["terminal.output", "terminal.exit", "runtime.ready", "agent.started", "agent.delta", "agent.done", "error"]);

export async function createRealtimeSfu(config, handlers) {
  const sessions = new Map();
  const worker = await mediasoup.createWorker({ logLevel: "warn" });
  const router = await worker.createRouter({ mediaCodecs: [] });
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
    if (!outboundTypes.has(event.type)) handlers.onDataMessage(session, event, sendEvent);
  }

  function cleanupSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    handlers.onSessionClosed(session);
    session.dataConsumer?.close();
    session.dataProducer?.close();
    session.browserDataConsumer?.close();
    session.transport.close();
  }

  return {
    clients: () => sessions.size,
    createSession,
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
  const section = sdp.split("\r\nm=application")[1] || sdp.split("\nm=application")[1];
  if (!section || !section.includes("webrtc-datachannel")) throw new Error("WHIP offer must include an SCTP DataChannel.");
  const fingerprint = section.match(/a=fingerprint:([\w-]+) ([^\r\n]+)/) || sdp.match(/a=fingerprint:([\w-]+) ([^\r\n]+)/);
  if (!fingerprint) throw new Error("WHIP offer is missing a DTLS fingerprint.");
  const mid = section.match(/a=mid:([^\r\n]+)/)?.[1];
  if (!mid) throw new Error("WHIP offer is missing an application MID.");
  return { mid, fingerprint: { algorithm: fingerprint[1], value: fingerprint[2].trim() } };
}

function createWhipAnswer(transport, remote) {
  const fingerprint = transport.dtlsParameters.fingerprints[0];
  const candidates = transport.iceCandidates.map((candidate) => {
    const tcpType = candidate.tcpType ? ` tcptype ${candidate.tcpType}` : "";
    return `a=candidate:${candidate.foundation} 1 ${candidate.protocol.toUpperCase()} ${candidate.priority} ${candidate.address} ${candidate.port} typ ${candidate.type}${tcpType}`;
  });
  return ["v=0", `o=- ${Date.now()} 1 IN IP4 0.0.0.0`, "s=-", "t=0 0", `a=group:BUNDLE ${remote.mid}`, "a=ice-lite", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0", `a=mid:${remote.mid}`, `a=ice-ufrag:${transport.iceParameters.usernameFragment}`, `a=ice-pwd:${transport.iceParameters.password}`, "a=ice-options:trickle", `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`, "a=setup:passive", ...candidates, "a=end-of-candidates", "a=sctp-port:5000", "a=max-message-size:262144", "a=sendrecv", ""].join("\r\n");
}
