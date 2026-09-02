# Mixing Station Copilot

Control your mixer with natural language. A local AI model turns chat
messages into Mixing Station parameter changes through MsMcp.

## Install (3 steps)

1. **Install Node.js 20+**
   - Windows (PowerShell): `winget install OpenJS.NodeJS.LTS`
   - Or download from https://nodejs.org
2. **Unzip** this archive
3. **Double-click `start.bat`** (Windows) or run `./start.sh` (Linux/macOS)

The first run downloads a small AI model (~400 MB) and guides you through
the Mixing Station connection.

## Mixing Station setup

- Connect **Mixing Station Desktop** to your mixer (e.g. X AIR 18).
- Open the **gear icon menu** and enable the **HTTP REST** API on port `8080`.
- The copilot connects automatically once the REST API answers.

## What you can do

- Mute/unmute channels: "mute channel 3"
- Set fader levels: "set channel 1 fader to -10"
- Batch operations: "set all faders to 0"
- Rename channels: "rename channel 1 to Kick"
- Set channel colors: "set channel 1 color to blue"
- High pass filter: "enable high pass filter on channel 1 at 100hz"
- Compressor: "turn on compressor on channel 1"
- EQ: "enable EQ on channel 1"
- Bus sends: "set send 1 level on channel 1 to -5"
- Query values: "what is the level on channel 1"

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
  minute on CPU-only machines) and uses ~1 GB of RAM.
