import crypto from "node:crypto";
import * as mediasoup from "mediasoup";
import { startAudioBridge } from "./audio-bridge.mjs";

const outboundTypes = new Set(["terminal.output", "terminal.exit", "runtime.ready", "agent.started", "agent.delta", "agent.done", "error", "audio.ready", "audio.recording.started", "audio.transcribing", "audio.transcribed"]);

export async function createRealtimeSfu(config, handlers) {
  const connections = new Map();
  const workspaces = new Map();
  let workspaceSequence = 0;
  const worker = await mediasoup.createWorker({ logLevel: "warn" });
  const router = await worker.createRouter({
    mediaCodecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, preferredPayloadType: 111, parameters: { useinbandfec: 1 } }]
  });
  const agentTransport = await router.createDirectTransport();
  worker.on("died", () => {
    console.error("mediasoup worker died");
    process.exit(1);
  });

  function sendEvent(connection, event) {
    if (connection.dataProducer && !connection.dataProducer.closed) {
      connection.dataProducer.send(JSON.stringify({ ...event, at: new Date().toISOString() }));
    }
  }

  function broadcast(workspace, event) {
    if (event.type === "terminal.output") {
      workspace.output = `${workspace.output}${event.payload.data}`.slice(-config.terminalOutputBufferBytes);
    }
    for (const connection of workspace.connections) sendEvent(connection, { ...event, sessionId: workspace.id });
  }

  function workspaceSummary(workspace) {
    return { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt, connected: workspace.connections.size, running: Boolean(workspace.terminal) };
  }

  function createWorkspace(name) {
    if (workspaces.size >= config.maxSessions) throw new Error(`Session limit reached (${config.maxSessions}). Close an existing session first.`);
    workspaceSequence += 1;
    const workspace = { id: crypto.randomUUID(), name: typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : `Session ${workspaceSequence}`, createdAt: new Date().toISOString(), connections: new Set(), output: "", started: false, terminal: null, pendingInput: [], agentProcess: null, opencodeSessionId: null };
    workspaces.set(workspace.id, workspace);
    handlers.onWorkspaceCreated(workspace, (_workspace, event) => broadcast(workspace, event));
    return workspaceSummary(workspace);
  }

  async function createSession(offer) {
    const remote = parseWhipOffer(offer);
    const id = crypto.randomUUID();
    const transport = await createTransport(router, config);
    await transport.connect({ dtlsParameters: { role: "client", fingerprints: [{ algorithm: remote.fingerprint.algorithm, value: remote.fingerprint.value }] } });
    const connection = { id, workspace: null, transport, dataProducer: null, dataConsumer: null, browserDataConsumer: null };
    connections.set(id, connection);
    transport.on("close", () => cleanupSession(id));
    transport.on("icestatechange", (state) => {
      if (state === "disconnected" || state === "closed") cleanupSession(id);
    });
    transport.on("sctpstatechange", (state) => {
      if (state === "connected") initializeDataChannel(connection);
    });
    return { location: `/whip/session/${id}`, answer: createWhipAnswer(transport, remote) };
  }

  async function initializeDataChannel(connection) {
    if (connection.dataProducer || connection.transport.closed) return;
    try {
      connection.dataProducer = await connection.transport.produceData({ sctpStreamParameters: { streamId: 0, ordered: true }, label: "agent-control", protocol: "json" });
      connection.dataConsumer = await agentTransport.consumeData({ dataProducerId: connection.dataProducer.id });
      connection.browserDataConsumer = await connection.transport.consumeData({ dataProducerId: connection.dataProducer.id });
      connection.dataConsumer.on("message", (message) => handleDataMessage(connection, message));
      handlers.onConnectionReady?.(connection, sendEvent);
    } catch (error) {
      console.error(`Unable to initialize DataChannel: ${error.message}`);
      cleanupSession(connection.id);
    }
  }

  function handleDataMessage(connection, message) {
    let event;
    try { event = JSON.parse(Buffer.from(message).toString("utf8")); } catch {
      return sendEvent(connection, { type: "error", payload: { message: "Invalid DataChannel JSON." } });
    }
    if (event.type === "audio.produce") return produceAudio(connection, event.payload, sendEvent);
    if (event.type === "session.select") return selectWorkspace(connection, event.payload?.sessionId);
    if (event.type === "terminal.sync") {
      if (connection.workspace?.output) sendEvent(connection, { type: "terminal.output", sessionId: connection.workspace.id, payload: { data: connection.workspace.output } });
      return;
    }
    // xterm can emit an initial resize before the ordered selection control arrives.
    if (!connection.workspace) return;
    if (!outboundTypes.has(event.type)) handlers.onDataMessage(connection, event, sendEvent);
  }

  function selectWorkspace(connection, workspaceId) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) return sendEvent(connection, { type: "error", payload: { message: "Unknown workspace session." } });
    connection.workspace?.connections.delete(connection);
    connection.workspace = workspace;
    workspace.connections.add(connection);
    sendEvent(connection, { type: "session.selected", sessionId: workspace.id, payload: workspaceSummary(workspace) });
    if (workspace.output) sendEvent(connection, { type: "terminal.output", sessionId: workspace.id, payload: { data: workspace.output } });
    sendEvent(connection, { type: "runtime.ready", sessionId: workspace.id, payload: { session_id: workspace.id, project_dir: config.projectDir } });
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
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    connection.workspace?.connections.delete(connection);
    handlers.onSessionClosed?.(connection);
    connection.dataConsumer?.close();
    connection.dataProducer?.close();
    connection.browserDataConsumer?.close();
    connection.audioProducer?.close();
    connection.audioRecording?.abort();
    connection.transport.close();
  }

  function closeWorkspace(id) {
    const workspace = workspaces.get(id);
    if (!workspace) return false;
    workspaces.delete(id);
    for (const connection of [...workspace.connections]) {
      workspace.connections.delete(connection);
      connection.workspace = null;
      sendEvent(connection, { type: "session.closed", sessionId: id, payload: {} });
    }
    handlers.onWorkspaceClosed(workspace);
    return true;
  }

  return {
    clients: () => connections.size,
    audioTracks: () => [...connections.values()].filter((connection) => connection.audioProducer && !connection.audioProducer.closed).length,
    createWorkspace,
    listWorkspaces: () => [...workspaces.values()].map(workspaceSummary),
    closeWorkspace,
    createSession,
    sendInput: (sessionId, event) => {
      const connection = connections.get(sessionId);
      if (!connection) throw new Error("Voice session is no longer connected.");
      handlers.onDataMessage(connection, event, sendEvent);
    },
    async startAudioRecording(sessionId) {
      const connection = connections.get(sessionId);
      if (!connection?.audioProducer) throw new Error("Microphone audio track is not ready.");
      if (connection.audioRecording) return;
      connection.audioRecording = await startAudioBridge(router, connection.audioProducer, config);
    },
    async stopAudioRecording(sessionId) {
      const connection = connections.get(sessionId);
      if (!connection?.audioRecording) throw new Error("No active voice recording.");
      const recording = connection.audioRecording;
      connection.audioRecording = null;
      return recording.stop();
    },
    closeSession: cleanupSession,
    close: () => {
      for (const id of [...workspaces.keys()]) closeWorkspace(id);
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
