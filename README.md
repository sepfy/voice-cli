# Local WebSocket Agent Demo

Local-first prototype for a device-agnostic agent runtime.

```text
Browser text/audio
  -> WebSocket
  -> Agent Runtime
  -> optional STT adapter
  -> local agent loop
  -> WebSocket response
```

This intentionally avoids LiveKit/WHIP/SFU so the core protocol can be tested locally.

## Run

```bash
cd /home/user/Workspace/cli/local-ws-agent-demo
npm start
```

Open:

```text
http://127.0.0.1:8791
```

## Audio / STT

The browser streams mic audio chunks to the server as `audio/webm;codecs=opus`.
The server writes each utterance to `recordings/`.

If `STT_COMMAND` is set, the runtime calls it after `audio.stop`.
The command receives the recorded file path as its first argument and must print the transcript to stdout:

```bash
STT_COMMAND=/path/to/transcribe npm start
```

Without `STT_COMMAND`, the demo still proves audio transport and returns the saved file path.

## Why WebSocket First

WebSocket is supported by every browser and works on plain localhost HTTP.
QUIC/WebTransport is a better long-term transport candidate for unreliable/low-latency streams, but local development requires HTTPS, HTTP/3, and a server stack that supports WebTransport.

