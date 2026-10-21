#!/usr/bin/env python3
"""Composite the approved bear over a generated background plate.

    uv run --with pillow python3 brand/composite.py brand/candidates/v4.png brand/fields/field-1.png

The bear is cut out of the generation with the same corner flood used by blue-field.py,
eroded by one pixel and feathered, so no charcoal fringe survives against a blue plate.
Output: brand/content-bear-master.png (1024) plus an SVG wrapper for favicon use.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
MASTER_PNG = ROOT / "content-bear-master.png"
MASTER_SVG = ROOT / "content-bear-master.svg"


def close(p, target, tol=26):
    return all(abs(a - b) <= tol for a, b in zip(p[:3], target))


def cut_out(im: Image.Image) -> Image.Image:
    """Return the bear with an alpha mask built from the flat field."""
    w, h = im.size
    px = im.load()
    corner = px[0, 0]
    field = set()
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    while stack:
        cx, cy = stack.pop()
        if (cx, cy) in field:
            continue
        field.add((cx, cy))
        for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in field and close(px[nx, ny], corner):
                stack.append((nx, ny))

    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    for (x, y) in field:
        mp[x, y] = 0
    mask = mask.filter(ImageFilter.MinFilter(3))   # erode one pixel: no background fringe
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    out = im.convert("RGBA")
    out.putalpha(mask)
    return out


def main() -> None:
    subject_path, plate_path = Path(sys.argv[1]), Path(sys.argv[2])
    subject = Image.open(subject_path).convert("RGB")
    plate = Image.open(plate_path).convert("RGB").resize(subject.size, Image.LANCZOS)

    bear = cut_out(subject)
    master = plate.convert("RGBA")
    master.alpha_composite(bear)
    master = master.convert("RGB")
    master.save(MASTER_PNG, "PNG", optimize=True)

    # An SVG wrapper keeps the favicon link working without a raster-specific URL.
    data = base64.b64encode(MASTER_PNG.read_bytes()).decode()
    w, h = master.size
    MASTER_SVG.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
        '<image href="data:image/png;base64,%s" width="%d" height="%d"/></svg>\n'
        % (w, h, w, h, data, w, h)
    )
    print(f"wrote {MASTER_PNG.name} and {MASTER_SVG.name} ({MASTER_PNG.stat().st_size // 1024} KiB)")


if __name__ == "__main__":
    main()
