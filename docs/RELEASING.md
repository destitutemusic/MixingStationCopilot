# Releasing

The release is built by one committed script, so it is reproducible and not a
manual act. It produces zips; **it does not publish anything** — creating the
GitHub release, signing and notarisation are the owner's call.

## Build

```bash
cd /path/to/MixingStationCopilot
npm ci
npm run build
bash scripts/package-release.sh              # all targets
bash scripts/package-release.sh mac-arm64    # one target
```

Zips are written to `dist/` (gitignored).

## Pinned components

| component | pin | verification |
| --- | --- | --- |
| Node runtime (bundled) | **v22.23.4** | downloaded from `nodejs.org/dist`, checked against `SHASUMS256.txt` |
| llama.cpp (first run) | **b12211** | exact byte size + SHA-256 from the GitHub release API, checked before extraction |
| models (first run) | Qwen3 Q4_K_M, five tiers | exact catalogue size + `GGUF` magic bytes |

Update the pins in **one** place each:

- Node: `NODE_VERSION` in `scripts/package-release.sh`.
- llama.cpp: `LLAMA_VERSION`, `LLAMA_BUILDS` (asset names, sizes, sha256) in
  `server/setup.js`.
- Models: `MODEL_CATALOG` in `server/setup.js`, and `THIRD-PARTY.md`.

Changing a llama.cpp pin means copying the new asset names, sizes and `digest`
values from `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/<tag>`.

## Targets

| zip | runtime | node binary |
| --- | --- | --- |
| `…-win-x64.zip` | Node win-x64 | `runtime/node.exe` |
| `…-win-arm64.zip` | Node win-arm64 | `runtime/node.exe` |
| `…-mac-arm64.zip` | Node darwin-arm64 | `runtime/node` |
| `…-mac-x64.zip` | Node darwin-x64 | `runtime/node` |
| `…-linux-x64.zip` | Node linux-x64 | `runtime/node` |
| `…-linux-arm64.zip` | Node linux-arm64 | `runtime/node` |

## What is inside a zip

- the app: `server/`, `public/`, `vendor/`, `package.json`, `package-lock.json`
- production `node_modules/`
- `runtime/` with the platform Node binary and its `LICENSE`
- `config.json`
- `README.md`, `LICENSE`, `NOTICE`, `THIRD-PARTY.md`
- `docs/`
- `start.bat`, `start.command` (executable), `start.sh` (executable)

**Not inside:** model weights and llama.cpp binaries. Both are downloaded on
first run into `models/` and `bin/<platform>-<arch>/`, so the zip stays small
and one build serves every architecture.

## What the user downloads afterwards

On first run, behind one progress bar:

1. the pinned llama.cpp build for their machine (13–25 MB);
2. the model they choose (397 MB – 9.0 GB).

## Verify a build

1. `unzip -l dist/<zip>` — check `runtime/node` (or `node.exe`), the three
   licence files, all three launchers and `config.json`.
2. Unzip into a fresh directory and run the launcher. The setup screen must show
   the platform's model tiers with sizes and RAM notes.
3. On a Mac, confirm `start.command` is executable and that the downloaded
   engine is a Mach-O binary for that Mac (`arm64` or `x86_64`), not a Linux ELF.
4. Confirm the first-run progress step downloads the engine then the model and
   starts the server.
5. `curl http://localhost:8085/api/health` returns `ok: true`.
6. Confirm the model server is bound to `127.0.0.1` (`lsof -iTCP:8090`), not
   `0.0.0.0`.

## Not done by this script

- Creating a GitHub release or uploading assets.
- Code signing (Windows) or notarisation (macOS). macOS users may see the
  Gatekeeper quarantine prompt; the README gives the one-line fix.
- Publishing to any store.
