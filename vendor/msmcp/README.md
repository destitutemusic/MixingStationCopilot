# Vendored MsMcp runtime

This directory is a **runtime subset** of [MsMcp](https://github.com/destitutemusic/MsMcp)
at commit `c1eddee` (version 0.1.0). It is vendored, not forked: copy the published
build, never edit these files.

## What the copilot imports

| file | imported by | why |
| --- | --- | --- |
| `mixingstation.js` | `server/index.js` | the Mixing Station REST/WebSocket client |
| `discovery.js` | `server/index.js` | parameter discovery |
| `msmcp-gateway.js` | `server/index.js` | the tool-facing wrapper around the client |
| `msmcp-server.js` | `server/agent.js` | registers the MsMcp tools for the in-process MCP server |

Those four are self-contained apart from `ws`, `zod` and
`@modelcontextprotocol/server`, which are declared in the copilot's
`package.json`. Nothing else under MsMcp is reached at runtime.

## What was dropped, and why

- **All `.ts` source files.** The copilot consumes the built `.js`; TypeScript
  sources were dead weight in every user download (9 extra files).
- `main.js`, `server.js`, `gateway.js`, `mapping.js`, `osc.js`. They belong to the
  standalone MCP server/CLI path, which the copilot does not import. Their
  functionality is not needed by the in-process gateway used here.

## Drift guard

`vendor/msmcp/VENDOR.json` pins the source commit and the SHA-256 of each file.
`npm run check:vendor` (also part of `npm run build`) fails if:

- a vendored file's hash differs from the manifest;
- the vendor directory gains or loses a `.js` file without updating the manifest;
- `mixingstation.js` no longer declares `DEFAULT_PORT = 8080`.

To refresh from a local MsMcp checkout, rebuild it and run:

```bash
MSMCP_DIR=/path/to/MsMcp node scripts/check-vendor.mjs
```

which also compares each vendored file byte-for-byte with `dist/src/`.

## Refreshing

```bash
cd /path/to/MsMcp && npm ci && npm run build
cp dist/src/{mixingstation,discovery,msmcp-gateway,msmcp-server}.js \
   /path/to/copilot/vendor/msmcp/
# update VENDOR.json (commit + hashes), then:
npm run check:vendor
```
