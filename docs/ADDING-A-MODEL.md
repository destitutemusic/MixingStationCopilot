# Adding a model to the catalogue

The model list lives in **`server/setup.js`**, in `MODEL_CATALOG`. Adding an
entry makes it appear in the setup UI with its size, RAM note, quantisation and
licence; no other code change is needed.

## 1. Check the model is a candidate

A model may only be listed if **all** of these are true:

- it is a **GGUF** file that `llama-server` can load;
- it is **instruction-following and can emit tool calls** — this app asks the
  model for the text protocol `TOOL_CALL: name` followed by a JSON argument
  block. A base/completion-only model cannot drive the mixer and must not be
  listed, however small it is;
- its licence permits redistribution of the download URL (we never commit the
  weights; we only download what the user picks);
- you know its **exact byte size**.

## 2. Find the exact size

```bash
curl -sSI -L "<download-url>" | awk 'IGNORECASE=1 /^content-length:/{print $2}' | tail -1
```

Use that integer as `sizeBytes`. The downloader refuses a file whose size
differs, which is how a changed upstream file is caught instead of silently
loaded.

## 3. Add the entry

```js
{
  id: 'qwen3-4b',                       // stable id used by the API and UI
  label: 'Qwen3 4B',                    // shown to the user
  filename: 'Qwen3-4B-Q4_K_M.gguf',     // saved under models/
  url: 'https://huggingface.co/.../Qwen3-4B-Q4_K_M.gguf',
  sizeBytes: 2497281312,                // exact; verified after download
  parameters: '4B',                     // parameter count
  quantisation: 'Q4_K_M',               // quantisation
  minRamGb: 8,                          // TOTAL system RAM recommended (with headroom)
  ramNote: '8 GB+ system RAM',          // shown in the UI
  licence: 'Apache-2.0',                // shown in the UI; keep THIRD-PARTY.md accurate
  toolCalling: true,                    // must be true; see step 1
  description: 'One line on what it buys the user, including its tradeoff.',
}
```

`minRamGb` is **not** the bare model footprint: it is the total RAM you would
recommend for a comfortable machine (OS + Mixing Station + browser + model).
The setup screen preselects the largest entry that fits under the detected
total RAM, and the user can always override it. Never add a tier whose only
justification is "the machine can technically hold it".

## 4. Keep the licence truth accurate

Add the model family and licence to **`THIRD-PARTY.md`** (the Qwen3 section
already covers Apache-2.0). Do not modify `LICENSE` or `NOTICE`.

## 5. Verify

1. `npm run build` (syntax check) and start the app.
2. Open the UI; the new entry must appear with its size, RAM note and licence.
3. Select it on a machine with enough RAM and let the download finish; the GGUF
   magic check and exact-size check must pass.
4. Ask one simple request ("mute channel 3") and one multi-step request; the
   model must emit `TOOL_CALL:` lines. If it cannot, remove it from the
   catalogue — a model that cannot call tools is not a candidate.

## Why the RAM recommendation is conservative

A model that barely fits leaves no memory for the OS, Mixing Station and the
browser, and the machine will swap or the model will fail to load. The
recommendation deliberately picks the largest tier that fits **with headroom**,
and the UI explains that the user may choose a different one.
