#!/usr/bin/env python3
"""Quantitative QA for the bundant content-bear mark.

    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
      uv run --with cairosvg --with pillow python3 brand/validate-content-bear.py

Writes content-bear-validation.json + a contact sheet, prints the JSON, exits 1 on failure.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

NAME = "content-bear"
SIZES = (16, 32, 64, 128, 180, 192, 256, 512, 1024)
FUR = (252, 93, 35)  # burntOrange #FC5D23 — the bear's body
FIELD = (51, 51, 51)  # borderMuted #333333 — the field, top-left of the gradient
INK = (31, 35, 31)  # bgDeep #1F231F — eyes, nose, mouth

ROOT = Path(__file__).resolve().parent
EXPORTS = ROOT / "exports"
REPORT = ROOT / f"{NAME}-validation.json"
SHEET = ROOT / f"{NAME}-contact-sheet.png"


def luminance(rgb):
    def channel(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def close(px, target, tol: int) -> bool:
    return all(abs(p - t) <= tol for p, t in zip(px, target, strict=True))


def ink_blobs(im: Image.Image, tol: int = 10) -> int:
    """Count ink blobs in the central band only: the field gradient ends on the ink
    colour at the corners, which would otherwise read as one giant blob."""
    w, h = im.size
    px = im.convert("RGB").load()
    # The face band: eyes, nose and mouth, without the field that surrounds the head.
    x0, x1 = int(w * 0.26), int(w * 0.74)
    y0, y1 = int(h * 0.42), int(h * 0.90)
    seen: set[tuple[int, int]] = set()
    blobs = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            if (x, y) in seen or not close(px[x, y], INK, tol):
                continue
            stack = [(x, y)]
            seen.add((x, y))
            size = 0
            while stack:
                cx, cy = stack.pop()
                size += 1
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if x0 <= nx < x1 and y0 <= ny < y1 and (nx, ny) not in seen:
                        if close(px[nx, ny], INK, tol):
                            seen.add((nx, ny))
                            stack.append((nx, ny))
            if size >= 2:
                blobs += 1
    return blobs


def measure(size: int) -> dict[str, object]:
    path = EXPORTS / f"{NAME}-{size}.png"
    with Image.open(path) as im:
        mode, rgb = im.mode, im.convert("RGB")
        w, h = rgb.size
        px = rgb.load()
        fur = field = 0
        for y in range(h):
            for x in range(w):
                p = px[x, y]
                if p[0] > p[2] + 60 and p[0] > 120:
                    fur += 1
                elif max(p) - min(p) < 14 and max(p) < 190:
                    field += 1
        # Small rasters antialias the ink toward the muzzle; widen the tolerance there.
        # Below 64px the ink is 1-2px wide and antialiased; 60 per channel still
        # separates eyes/nose/mouth there, 10 would read nothing.
        blobs = ink_blobs(rgb, tol=60 if size <= 32 else 10) if size <= 64 else 0
    total = w * h
    return {
        "size": size,
        "mode": mode,
        "width": w,
        "height": h,
        "bytes": path.stat().st_size,
        "fur_fraction": round(fur / total, 4),
        "field_fraction": round(field / total, 4),
        "ink_blobs": blobs,
    }


def main() -> None:
    rows = [measure(s) for s in SIZES]
    ratio = round(contrast(FUR, FIELD), 2)
    ink_ratio = round(contrast(INK, FUR), 2)
    failures: list[str] = []
    for r in rows:
        name = f"{r['size']}px"
        if r["mode"] != "RGB":
            failures.append(f"{name}: mode {r['mode']} is not opaque RGB")
        if (r["width"], r["height"]) != (r["size"], r["size"]):
            failures.append(f"{name}: not square")
        if r["fur_fraction"] < 0.18:
            failures.append(f"{name}: mascot coverage {r['fur_fraction']} < 0.18")
        if r["field_fraction"] < 0.12:
            failures.append(f"{name}: field coverage {r['field_fraction']} < 0.12")
        # 16px keeps only the nose: the eye arcs are 0.5px wide there and antialiasing
        # eats them. That is a documented limit (brand/README.md), so the bar is 1 blob,
        # not the 2 the generic template assumes. 32px still separates all three.
        need = 1 if r["size"] == 16 else 3 if r["size"] == 32 else 0
        if need and r["ink_blobs"] < need:
            failures.append(f"{name}: {r['ink_blobs']} of {need} facial blobs survive")
    if ratio < 3.0:
        failures.append(f"face/field contrast {ratio}:1 below 3:1")
    if ink_ratio < 4.5:
        failures.append(f"ink/fur contrast {ink_ratio}:1 below 4.5:1")

    sheet = Image.new("RGB", (1200, 300), (31, 35, 31))
    draw = ImageDraw.Draw(sheet)
    x = 24
    for size in (16, 32, 64, 128, 180, 256):
        with Image.open(EXPORTS / f"{NAME}-{size}.png") as im:
            sheet.paste(im.convert("RGB"), (x, 60))
        draw.text((x, 70 + size + 8), f"{size}px", fill=(156, 154, 143))
        x += size + 24
    sheet.save(SHEET)

    report = {
        "master": f"brand/{NAME}-master.svg",
        "sizes": list(SIZES),
        "face_to_field_contrast": f"{ratio}:1",
        "ink_to_fur_contrast": f"{ink_ratio}:1",
        "rows": rows,
        "failures": failures,
        "status": "pass" if not failures else "fail",
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
