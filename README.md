# Voice CLI

A browser terminal frontend for the native OpenCode TUI, connected through a mediasoup SFU.

```text
Browser xterm.js
  -> WHIP HTTP session setup
  -> WebRTC SCTP DataChannel
  -> mediasoup SFU
  -> node-pty
  -> native OpenCode TUI
```

The WHIP offer opens an SCTP DataChannel. A mediasoup DirectTransport terminates browser input in Node, while the same SFU DataChannel relays terminal output to the browser. HTTP is used only for WHIP session creation and teardown.

## Run

Install OpenCode and authenticate a model provider first. Then link this package locally and launch it from any project:

```bash
npm link
voice-cli /path/to/project
```

The browser opens automatically at `http://127.0.0.1:8791`. Use `--no-open` when running without a desktop session.

```bash
voice-cli . --no-open
voice-cli . --port 9000 --model provider/model
voice-cli --help
```

## Sessions

One server port can host multiple persistent OpenCode PTY sessions over one browser WebRTC connection. Use the left sidebar to create, select, and close them. A session remains active when its browser connection closes and is removed only from the sidebar or when the server stops. Reopening a session replays its recent terminal output. The default limit is 8 sessions; set `VOICE_MAX_SESSIONS` and `VOICE_TERMINAL_BUFFER_BYTES` to adjust the session count and per-session replay buffer.

For development, `npm start` still starts the server directly for the current directory.

## Requirements

- Node.js 22 or newer
- OpenCode installed and authenticated
- A browser with WebRTC DataChannel support

## How it works

Each browser connection creates a WHIP session and a dedicated mediasoup WebRTC transport with SCTP enabled. xterm.js forwards keyboard input and terminal dimensions through the `agent-control` DataChannel. Node terminates input with a DirectTransport, and `node-pty` sends OpenCode's native ANSI output back through the same channel.

## Network configuration

By default, the HTTP server and mediasoup listen on `127.0.0.1`, so the example is local-only. For remote clients, set `MEDIASOUP_LISTEN_IP` to the server interface and `MEDIASOUP_ANNOUNCED_ADDRESS` to the public address, then permit the mediasoup UDP/TCP ports in your firewall. Add TURN before exposing this beyond a controlled network.

## OpenAI voice

Set an OpenAI API key before using the voice button:

```bash
export OPENAI_API_KEY="..."
npm start
```

The browser negotiates an Opus audio track with the mediasoup SFU when it connects. The track is enabled only while recording. The local server bridges the SFU RTP stream through FFmpeg into an audio segment for OpenAI transcription, then injects the resulting text into the existing interactive OpenCode session. The CLI remains the single source of input and output. `OPENAI_TTS_MODEL` and `OPENAI_TTS_VOICE` are reserved for a future TTS bridge that can reliably identify completed TUI responses.
