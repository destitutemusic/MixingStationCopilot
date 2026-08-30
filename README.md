# Mixing Station Copilot v0.1.0

Control your mixer with natural language. A local Functionary LLM turns chat
messages into Mixing Station parameter changes through MsMcp.

## Install (3 steps)

1. **Install Node.js 20+** from https://nodejs.org
2. **Unzip** this archive
3. **Double-click `start.sh`** (Linux/macOS) or **`start.bat`** (Windows)

The first run downloads the AI model (~4.4 GB) and guides you through the
Mixing Station connection.

## Mixing Station setup

- Connect **Mixing Station Desktop** to your mixer (e.g. X AIR 18).
- Open the **gear icon menu** and enable the **HTTP REST** API on port `8080`.
- The copilot connects automatically once the REST API answers.

## Platform notes

- **Windows/Linux**: the matching `llama-server` binary is bundled under
  `bin/win-x64/` or `bin/linux-x64/` and is used automatically.

## Troubleshooting

- **Ports in use**: the copilot uses `8080` (Mixing Station), `8085` (web UI)
  and `8090` (local model server). Stop other apps on those ports, or pass
  `--ms-port`, `--web-port`, `--llama-port` to `node server/index.js`.
- **Model download interrupted**: the copilot resumes from a fresh start and
  validates the GGUF header before use.
- **Slow first response**: the local model loads on first start (can take a
  few minutes on CPU-only machines) and uses ~3.6 GB of RAM.

## Development

```
npm install
npm start            # starts the web UI + model server
npm run build        # syntax-checks all server and UI code
```
