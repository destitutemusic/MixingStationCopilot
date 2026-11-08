# Third-party components

Mixing Station Copilot is Apache-2.0. It uses and can download the components
below, each under its own licence. Nothing here changes the licence of our own
code, and no third-party source is vendored into this repository — binaries and
models are downloaded at first run.

| component | licence | how it arrives | what it does |
| --- | --- | --- | --- |
| **llama.cpp** (`llama-server`) | MIT | downloaded at first run | runs the local language model |
| **Qwen3 GGUF models** | Apache-2.0 | downloaded at first run, user's choice (0.6B / 1.7B / 4B / 8B / 14B) | turns chat into tool calls |
| **adm-zip** | MIT | dependency (npm) | unpacks the Windows llama.cpp archive |
| **Node.js** | MIT | bundled in the release zip | runs this application |
| **MsMcp** | Apache-2.0 | dependency | talks to Mixing Station |
| **ConsoleMCP** (upstream of MsMcp) | Apache-2.0 | via MsMcp | original MCP server work |

---

## llama.cpp — MIT

<https://github.com/ggml-org/llama.cpp>

We download the official `llama-server` build for the user's platform. We do not
modify it. Its MIT licence text is included with the download and reproduced
here:

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## adm-zip — MIT

<https://github.com/cthackers/adm-zip>

Used only to unpack the official Windows `llama.cpp` zip at first run. It is a
pure-JavaScript dependency, so no external unzip tool is required on Windows.
Its MIT licence text:

```
Copyright (c) 2012-2024 Adrian Wielgosik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Qwen3 models — Apache-2.0

<https://huggingface.co/Qwen>

The downloadable models are Qwen3 GGUF quantisations (Q4_K_M) from the
`unsloth` Hugging Face repositories: 0.6B, 1.7B, 4B, 8B and 14B. The Qwen3
series is published under **Apache-2.0**; each entry in the in-app catalogue
names its licence. We only download the file the user selects and we do not
redistribute model weights. All five tiers are instruction-following models
that can emit the app's `TOOL_CALL:` protocol; larger tiers are materially
better at it.

---

## Node.js — MIT

<https://nodejs.org>

When the release zip bundles a Node.js runtime, that runtime's MIT licence and
its own `LICENSE` file are included in the `runtime/` directory of the zip.

---

## MsMcp and ConsoleMCP — Apache-2.0

See `NOTICE` for the required attribution text. ConsoleMCP is
Copyright 2026 Code Pro Quo Ltd, trading as Sonus Immersivus.

---

## Not covered by this project

**Mixing Station** is a separate third-party application. It is not distributed
with this project, not modified by it, and this project is not affiliated with
its authors. You install and run it yourself.
