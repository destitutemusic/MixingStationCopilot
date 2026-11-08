# Troubleshooting

Every message below is written to be understood without a terminal. If one does
not fix it, include the exact text in a bug report.

## The page does not open

- **Check the launcher window.** It prints the address; open
  <http://localhost:8085> manually if the browser did not open.
- **Port 8085 is in use.** Something else is on it. Stop that app, or start with
  a different port:
  `runtime/node server/index.js --web-port 8086` (macOS/Linux) or
  `runtime\node.exe server\index.js --web-port 8086` (Windows).
- **Ports 8080 and 8090** are also used (Mixing Station and the model server).
  Stop the other program or pass `--ms-port` / `--llama-port`.

## "Mixing Station is not reachable"

- Open **Mixing Station Desktop** and connect it to the mixer first.
- Gear icon → enable **HTTP REST** on port **8080**.
- A firewall prompt for Mixing Station or Copilot must be allowed on the local
  network; the requests are local.
- The copilot retries every 5 seconds; the setup screen updates itself.

## The model download failed

The setup screen shows the URL that failed, the platform string, and the reason.
Common causes:

- **No internet / a captive portal.** Connect to the internet and press the
  button again.
- **Disk full.** The model is 400 MB – 9 GB. Free space and retry; a partial
  `.part` file is never used.
- **A proxy or firewall blocks huggingface.co.** Allow it, or choose a smaller
  model.
- The download is checked against its exact catalogue size and the `GGUF` magic
  bytes; a corrupt file is rejected rather than loaded.

## The AI engine (llama.cpp) download failed

The message names the platform (for example `mac-arm64`) and the GitHub URL.
Common causes:

- **No internet**, or github.com is blocked. Allow
  `github.com/ggml-org/llama.cpp` and retry.
- **An unsupported computer.** The app prints
  `This computer (<platform>/<arch>) is not a platform we ship an AI engine for.`
  You can still use **MsMcp**, the separate model-free MCP server, with an AI
  client you already have.
- The download is pinned by version, exact size and SHA-256; a mismatch is
  reported and nothing is executed.

## macOS: double-clicking start.command does nothing

macOS quarantines files downloaded through a browser. Open **Terminal**, type
`xattr -dr com.apple.quarantine ` (with a trailing space), drag the unzipped
folder into the window, press Enter, then double-click `start.command` again.
If Terminal says "permission denied", run `chmod +x start.command start.sh`
inside the folder once.

## Windows: "Windows protected your PC" / SmartScreen

Choose **More info → Run anyway**. The app is unsigned; signing is not part of
this release.

## Not enough RAM

The setup screen marks each model with the system RAM it recommends. If the
machine is short, choose a smaller tier or close other apps. A model that barely
fits will swap and feel broken; that is a hardware limit, not a bug. The 0.6B
tier runs on 4 GB, but it is also the least reliable at tool calls.

## The first response is slow

The first request loads the model into memory. On a CPU-only machine this can
take a minute or more for a 4B–14B model; later responses are much faster. The
setup screen says "Starting the model server" while this happens. Do not close
the launcher window: it owns the model process.

## The model answers but does nothing

- The model must be able to emit tool calls. All catalogue entries can, but very
  small models can still mis-format a complex request; try a larger tier.
- Check that Mixing Station's REST API is enabled and the channel exists.
- The chat shows each tool call and its result; that is the place to see what
  the model tried.

## Where the files are

- Downloaded AI engine: `bin/<platform>-<arch>/`
- Downloaded models: `models/*.gguf`
- Logs: the launcher window; copy its text into a report.

No credentials are used or stored by this app.
