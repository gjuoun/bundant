#!/usr/bin/env python3
"""Ask Gemini what it thinks of the mark, and print its answer.

    opk get GEMINI_API_KEY -- python3 brand/ask-gemini.py brand/content-bear-master.png "prompt"

The key is injected by opk; nothing here prints it.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request

MODELS = ("gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash")
URL = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"


def ask(model: str, image_b64: str, prompt: str) -> str:
    body = json.dumps({
        "contents": [{
            "role": "user",
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": "image/png", "data": image_b64}},
            ],
        }]
    }).encode()
    req = urllib.request.Request(
        URL.format(model),
        data=body,
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    out = []
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if "text" in part:
                out.append(part["text"])
    return "\n".join(out).strip() or json.dumps(data)[:400]


def main() -> None:
    path, prompt = sys.argv[1], sys.argv[2]
    image_b64 = base64.b64encode(open(path, "rb").read()).decode()
    last = ""
    for model in MODELS:
        try:
            print(f"[model: {model}]\n")
            print(ask(model, image_b64, prompt))
            return
        except urllib.error.HTTPError as exc:
            last = f"{model}: HTTP {exc.code} {exc.read()[:200]!r}"
            print(f"({last}, trying next)", file=sys.stderr)
    raise SystemExit(f"all models failed: {last}")


if __name__ == "__main__":
    main()
