# Mixing Station Copilot v0.1.4

Control your mixer with natural language. A local Functionary LLM turns chat
messages into Mixing Station parameter changes through MsMcp.

## Install (3 steps)

1. **Install Node.js 20+**
   - Windows (PowerShell): `winget install OpenJS.NodeJS.LTS`
   - Or download from https://nodejs.org
2. **Unzip** this archive
3. **Double-click `start.bat`** (Windows) or run `./start.sh` (Linux/macOS)

The first run asks you to pick an AI model (see below) and guides you through
the Mixing Station connection.

## Choose your model (first run)

| Model | Download | RAM needed | Best for |
|---|---|---|---|
| **Functionary Small 2.5** (recommended) | ~4.4 GB | 8 GB+ | Best tool-calling accuracy; needs a reasonably modern PC |
| **Qwen2.5 1.5B** (light) | ~1.0 GB | 4 GB+ | Older/weaker PCs; slower to understand complex requests |

The setup screen shows a model picker before downloading. If the download
fails or the chat feels unresponsive on your machine, delete the file in
`models/` and pick the other model on the next start.

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
