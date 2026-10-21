#!/usr/bin/env bash
# Generate image candidates with Nano Banana 2 on the Gemini key.
# The key is injected by `opk get GEMINI_API_KEY -- ...`; it is never printed.
set -euo pipefail

OUT="${OUT:?set OUT}"
PROMPT_FILE="${PROMPT_FILE:?set PROMPT_FILE}"
MODEL="${MODEL:-gemini-3.1-flash-image}"
REF="${REF:-}"

python3 - "$OUT" "$PROMPT_FILE" "$MODEL" "$REF" <<'PY'
import base64, json, os, sys, urllib.request

out, prompt_file, model, ref = sys.argv[1:5]
prompt = open(prompt_file).read().strip()

parts = [{"text": prompt}]
if ref:
    for path in ref.split(","):
        path = path.strip()
        if not path:
            continue
        mime = "image/png" if path.lower().endswith(".png") else "image/jpeg"
        parts.append({
            "inline_data": {
                "mime_type": mime,
                "data": base64.b64encode(open(path, "rb").read()).decode(),
            }
        })

body = json.dumps({
    "contents": [{"role": "user", "parts": parts}],
    "generationConfig": {
        "responseModalities": ["IMAGE"],
        "imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"},
    },
}).encode()

req = urllib.request.Request(
    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    data=body,
    headers={
        "x-goog-api-key": os.environ["GEMINI_API_KEY"],
        "content-type": "application/json",
    },
)
with urllib.request.urlopen(req, timeout=180) as resp:
    data = json.load(resp)

saved = 0
for cand in data.get("candidates", []):
    for part in cand.get("content", {}).get("parts", []):
        blob = part.get("inlineData") or part.get("inline_data")
        if not blob:
            continue
        saved += 1
        target = f"{out}-{saved}.png" if saved > 1 else f"{out}.png"
        with open(target, "wb") as fh:
            fh.write(base64.b64decode(blob["data"]))
        print(f"wrote {target}")
if not saved:
    print("no image in response:", json.dumps(data)[:600], file=sys.stderr)
    sys.exit(1)
PY
