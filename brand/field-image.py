#!/usr/bin/env python3
"""Put a generated background plate behind the traced bear.

    python3 brand/field-image.py brand/content-bear-master.svg brand/fields/field-1.png

The traced field layers are full-canvas shapes painted over the fur, so the plate cannot
simply sit underneath: it has to be clipped to the exact field outline. Build a
<clipPath> out of those field shapes, drop them, and draw the plate once, clipped.

(A <pattern> holding the image looks equivalent and is not: cairosvg resolves the pattern
origin per shape, so each field layer restarts the plate and the seams show as hard
diagonals.)
"""

from __future__ import annotations

import base64
import re
import sys
from pathlib import Path

FIELD_PAINT = "url(#field)"


def main() -> None:
    master, plate = Path(sys.argv[1]), Path(sys.argv[2])
    svg = master.read_text()
    data = base64.b64encode(plate.read_bytes()).decode()
    mime = "image/png" if plate.suffix.lower() == ".png" else "image/jpeg"

    paths = re.findall(r"<path\b[^>]*/>", svg)
    field_paths = [p for p in paths if FIELD_PAINT in p]

    if not field_paths:
        raise SystemExit(f"no {FIELD_PAINT} paths found — run blue-field-svg.py first")

    # Keep only the geometry; the clip does not care about paint.
    shapes = []
    for p in field_paths:
        d = re.search(r'd="([^"]+)"', p)
        if d:
            shapes.append(f'<path d="{d.group(1)}"/>')
    clip = f'<clipPath id="fieldclip" clipPathUnits="userSpaceOnUse">{"".join(shapes)}</clipPath>'

    for p in field_paths:
        svg = svg.replace(p, "", 1)

    image = (
        f'<image clip-path="url(#fieldclip)" x="0" y="0" width="1024" height="1024" '
        f'preserveAspectRatio="xMidYMid slice" href="data:{mime};base64,{data}"/>'
    )

    if "<defs>" in svg:
        svg = svg.replace("<defs>", f"<defs>{clip}</defs><defs>", 1)
    else:
        head = svg.index(">", svg.index("<svg")) + 1
        svg = svg[:head] + f"<defs>{clip}</defs>" + svg[head:]

    # Paint it last so it covers whatever the fur layer left in the field area.
    svg = svg.replace("</svg>", f"{image}</svg>")
    master.write_text(svg)
    print(f"{master}: {len(field_paths)} field shape(s) -> clipped plate ({len(data)//1024} KiB)")


if __name__ == "__main__":
    main()
