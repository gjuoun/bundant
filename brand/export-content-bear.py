#!/usr/bin/env python3
"""Render content-bear-master.svg into every raster the site needs.

    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
      uv run --with cairosvg --with pillow python3 brand/export-content-bear.py

Writes brand/exports/content-bear-<size>.png (opaque RGB) and refreshes the copies the site serves.
The master SVG is the only source; nothing here edits it.
"""

from __future__ import annotations

import base64
import shutil
from pathlib import Path

import cairosvg
from PIL import Image

NAME = "content-bear"
SIZES = (16, 32, 64, 128, 180, 192, 256, 512, 1024)

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
MASTER = ROOT / f"{NAME}-master.svg"
EXPORTS = ROOT / "exports"
SITE_PUBLIC = REPO / "site" / "public"
OG_SVG = ROOT / "og-card.svg"
OG_PNG = SITE_PUBLIC / "img" / "og.png"


def render(svg: Path, out: Path, size: int) -> None:
    cairosvg.svg2png(url=str(svg), write_to=str(out), output_width=size, output_height=size)
    with Image.open(out) as im:  # cairosvg emits RGBA; favicons and stores want opaque RGB
        im.convert("RGB").save(out, "PNG", optimize=True)


def main() -> None:
    if not MASTER.is_file():
        raise SystemExit(f"missing master: {MASTER}")
    EXPORTS.mkdir(exist_ok=True)
    (SITE_PUBLIC / "img").mkdir(exist_ok=True)

    for size in SIZES:
        target = EXPORTS / f"{NAME}-{size}.png"
        render(MASTER, target, size)
        print(f"  {target.relative_to(REPO)}  {size}x{size}")

    shutil.copyfile(MASTER, SITE_PUBLIC / "favicon.svg")
    shutil.copyfile(MASTER, SITE_PUBLIC / "img" / f"{NAME}.svg")
    shutil.copyfile(EXPORTS / f"{NAME}-32.png", SITE_PUBLIC / "favicon-32.png")
    shutil.copyfile(EXPORTS / f"{NAME}-180.png", SITE_PUBLIC / "apple-touch-icon.png")
    print("  favicon.svg, favicon-32.png, apple-touch-icon.png, img/%s.svg" % NAME)

    if OG_SVG.is_file():
        mark = base64.b64encode((EXPORTS / f"{NAME}-512.png").read_bytes()).decode()
        svg = OG_SVG.read_text().replace(f"exports/{NAME}-512.png", f"data:image/png;base64,{mark}")
        cairosvg.svg2png(
            bytestring=svg.encode(), write_to=str(OG_PNG), output_width=1200, output_height=630
        )
        with Image.open(OG_PNG) as im:
            im.convert("RGB").save(OG_PNG, "PNG", optimize=True)
        print(f"  {OG_PNG.relative_to(REPO)}  1200x630")


if __name__ == "__main__":
    main()
