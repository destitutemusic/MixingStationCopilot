# Mixing Station Copilot

**What:** control your mixer in plain English ("mute channel 3", "set the vocal
fader to -10"). **Who:** sound engineers and musicians using Mixing Station.
**What you need:** Mixing Station with its HTTP REST API enabled, and one of the
downloads below — no Node install, no account, no cloud.

> **Not the same thing as MsMcp.** [MsMcp](https://github.com/destitutemusic/MsMcp)
> is the separate, **model-free** MCP server for people who already have an AI
> client (Claude Desktop, an IDE agent, etc.). This app is the standalone
> Copilot: it bundles its own chat UI *and* a local AI model, so it works on its
> own.

## Install (3 steps)

1. **Download the zip** for your computer from the release page:
   - Windows: `…-win-x64.zip` (or `win-arm64`)
   - Apple Silicon Mac: `…-mac-arm64.zip`
   - Intel Mac: `…-mac-x64.zip`
   - Linux: `…-linux-x64.zip` (or `linux-arm64`)
2. **Unzip it** anywhere you can write (your desktop is fine).
3. **Double-click to start:**
   - Windows: `start.bat`
   - macOS: `start.command`
   - Linux: `start.sh` (or run `./start.sh` in a terminal)

The first run downloads the AI engine (llama.cpp, ~13–25 MB) and the model you
choose (400 MB – 9 GB), with one progress bar. After that it starts instantly.
No Node.js install is required: the zip contains its own runtime.

### macOS: if double-clicking does nothing

macOS quarantines files downloaded in a browser. Open **Terminal**, drag the
unzipped folder in, and run once:

```bash
xattr -dr com.apple.quarantine "/path/to/MixingStationCopilot"
```

Then double-click `start.command` again.

## Choose your model

The setup screen lists the models your computer can run, preselects the largest
one that fits comfortably, and lets you choose a different one. Bigger models
follow instructions and multi-step requests far more reliably — a 0.6B model
will mis-handle requests a 4B handles cleanly, so do not pick the smallest just
because it downloads fastest.

| model | download | system RAM | note |
| --- | ---: | ---: | --- |
| Qwen3 0.6B | ~397 MB | 4 GB+ | fastest; simple commands only |
| Qwen3 1.7B | ~1.1 GB | 6 GB+ | good on most laptops |
| Qwen3 4B | ~2.5 GB | 8 GB+ | **recommended on most machines** |
| Qwen3 8B | ~5.0 GB | 12 GB+ | best all-round on 16 GB |
| Qwen3 14B | ~9.0 GB | 20 GB+ | strongest; large download |

All five are instruction-following models that can emit tool calls, and all are
Apache-2.0. The model runs locally; nothing is uploaded.

## Mixing Station setup

- Connect **Mixing Station Desktop** to your mixer (e.g. X AIR 18).
- Open the **gear icon menu** and enable the **HTTP REST** API on port `8080`.
- The copilot connects automatically once the REST API answers.

## What you can do

- Mute/unmute channels: "mute channel 3"
- Set fader levels: "set channel 1 fader to -10"
- Batch operations: "set all faders to 0"
- Rename channels and set colours
- High-pass filter, compressor, EQ
- Bus sends
- Query values: "what is the level on channel 1"

## Ports

| port | service |
| ---: | --- |
| 8080 | Mixing Station HTTP REST API |
| 8085 | Copilot web UI |
| 8090 | local model server (bound to **127.0.0.1** only) |

The model server listens on localhost only. On a venue wifi, nobody else can
reach it. Widening it is a deliberate opt-in: `--llama-host 0.0.0.0` (or
`llama.host` in `config.json`).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how a message becomes a mixer change
- [Adding a model](docs/ADDING-A-MODEL.md) — extend the catalogue yourself
- [Troubleshooting](docs/TROUBLESHOOTING.md) — ports, downloads, Gatekeeper, RAM
- [Releasing](docs/RELEASING.md) — how the zips are built
- [Third-party components](THIRD-PARTY.md) — licences

## Licence

Apache-2.0. See `LICENSE`, `NOTICE` and `THIRD-PARTY.md`. Mixing Station is a
separate third-party application; this project is not affiliated with it.
