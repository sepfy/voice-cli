# Voice CLI

A browser terminal frontend for the native OpenCode TUI.

```text
Browser xterm.js
  -> WebSocket
  -> node-pty
  -> native OpenCode TUI
```

This intentionally avoids LiveKit/WHIP/SFU so the core protocol can be tested locally.

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

For development, `npm start` still starts the server directly for the current directory.

## Requirements

- Node.js 20 or newer
- OpenCode installed and authenticated
- A browser with WebSocket support

## How it works

Each browser connection starts OpenCode in a dedicated pseudo-terminal. xterm.js forwards keyboard input and terminal dimensions over WebSocket, while `node-pty` sends OpenCode's native ANSI output back to the browser. The server listens on `127.0.0.1` only.
