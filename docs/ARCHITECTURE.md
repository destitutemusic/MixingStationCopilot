# Architecture

One chat message becomes a mixer change like this:

```
 ┌────────────────────────────┐
 │ Browser                    │
 │  public/ (chat + setup UI) │
 └─────────────┬──────────────┘
               │  HTTP + WebSocket, port 8085
               ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ Copilot server  (Node, server/index.js)                      │
 │                                                              │
 │  setup.js ── first-run download ──►  bin/<platform>-<arch>/   │
 │      │                              llama-server              │
 │      └───────────── model ────────►  models/<model>.gguf      │
 │                                                              │
 │  llama.js ── spawn sidecar ──────►  llama-server :8090        │
 │                                         (127.0.0.1 only)     │
 │                                                              │
 │  agent.js ── prompt + parse ─────►  "TOOL_CALL: fader_set"    │
 │      │                                         │             │
 │      ▼                                         ▼             │
 │  vendor/msmcp/msmcp-gateway.js  ──►  tool handler            │
 └──────────────────────────────────────────────┬───────────────┘
                                                │ HTTP REST, port 8080
                                                ▼
                                  ┌──────────────────────────┐
                                  │ Mixing Station Desktop   │
                                  │  (your mixer, e.g. X18)  │
                                  └──────────────────────────┘
```

## The request path, step by step

1. **Browser → server.** The chat UI posts a message over the WebSocket at
   `/api/chat` (or `POST /api/chat`). The UI is plain HTML/CSS/JS in `public/`.
2. **Server → model.** `server/agent.js` builds a system prompt that lists the
   available MsMcp tools and the exact output format (`TOOL_CALL: name` then a
   JSON argument block). It sends the conversation to the local
   `llama-server` at `http://127.0.0.1:8090/v1/chat/completions`.
3. **Model → tool calls.** The model (Qwen3, chosen in setup) replies in that
   text format. `parseToolCalls()` in `agent.js` extracts the tool name and
   arguments. This text protocol is deliberate: it works with small local
   models that do not implement the OpenAI `tools` parameter.
4. **Tool call → Mixing Station.** `vendor/msmcp/msmcp-gateway.js` validates the
   arguments against the discovered parameter map and calls the Mixing Station
   REST API (`/app/state`, parameter setters) on port 8080. The result is sent
   back to the model, which explains it in plain language.
5. **Streaming.** Tool events and the final reply are broadcast to the browser
   over the WebSocket.

## Ports

| port | who binds it | reachable from |
| ---: | --- | --- |
| 8080 | Mixing Station Desktop (HTTP REST) | local machine |
| 8085 | Copilot web UI (`server/index.js`) | local machine (add `--web-host` yourself if you need more) |
| 8090 | `llama-server` sidecar | **127.0.0.1 only** by default |

`--llama-host 0.0.0.0` (or `"host": "0.0.0.0"` under `llama` in `config.json`)
is the documented, deliberate opt-in for exposing the model server. Do not use
it on a shared venue network.

## First run

`server/setup.js` owns both downloads:

- **AI engine.** `ensureLlamaBinary()` picks the pinned llama.cpp build for
  `process.platform`/`process.arch` (`win/mac/linux` × `x64/arm64`), streams it
  with progress, verifies the exact byte size and SHA-256 from the pinned
  release, unpacks it into `bin/<platform>-<arch>/`, and makes the binary
  executable. macOS uses the `macos-arm64` or `macos-x64` asset — never a Linux
  build.
- **Model.** `downloadModel()` streams the chosen GGUF from the catalogue with
  the same progress reporting, checks the exact catalogue size, and verifies the
  `GGUF` magic bytes before use. A partial file stays `.part` and is rejected.

## Files

| path | role |
| --- | --- |
| `server/index.js` | HTTP/WebSocket server, setup endpoints, lifecycle |
| `server/setup.js` | model catalogue, RAM recommendation, both downloads |
| `server/llama.js` | platform/arch resolution, sidecar spawn/stop, host binding |
| `server/agent.js` | prompt, text tool-call parser, tool dispatch |
| `public/` | setup and chat UI |
| `vendor/msmcp/` | MsMcp gateway/client used to talk to Mixing Station |
| `bin/` | downloaded llama.cpp (gitignored) |
| `models/` | downloaded GGUF (gitignored) |
| `runtime/` | bundled Node runtime in release zips only |
| `config.json` | ports and the model-server host |

## Security notes

- The model server binds to loopback by default; the web UI and Mixing Station
  REST API are local.
- No API keys are used. Nothing is uploaded; the model and prompts stay on the
  machine.
- Downloaded binaries are pinned by version, exact size and SHA-256 before they
  are executed.
