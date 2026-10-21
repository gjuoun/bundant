#!/usr/bin/env python3
"""Recompose a traced mark onto a real gradient field.

    python3 brand/blue-field-svg.py in.svg out.svg

The raster-side field swap (blue-field.py) can only give flat bands, because a traced
smooth ramp collapses into hundreds of near-blues. So: trace the artwork over the keyed
field, delete the field paths, and put a genuine SVG gradient underneath. Same colours
as Bigface's avatar field, smooth at every size.
"""

from __future__ import annotations

import re
import sys

BLUES = {"#2E7BE6", "#1A54B4", "#08265C"}
HEADER = """<defs>
    <linearGradient id="field" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1024" y2="1024">
      <stop offset="0" stop-color="#2E7BE6"/>
      <stop offset="0.38" stop-color="#1A54B4"/>
      <stop offset="0.72" stop-color="#08265C"/>
      <stop offset="1" stop-color="#08265C"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#field)"/>"""


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    text = open(src).read()

    removed = 0

    def repaint(match: re.Match) -> str:
        """Repaint field layers with the gradient instead of deleting them.

        A stacked trace draws every colour layer as a full-canvas path with holes, so
        deleting the field layers leaves the fur layer bleeding across the canvas.
        """
        nonlocal removed
        if match.group(1).upper() in BLUES:
            removed += 1
            return match.group(0).replace(match.group(1), "url(#field)")
        return match.group(0)

    body = re.sub(r'<path[^>]*fill="(#[0-9A-Fa-f]{6})"[^>]*/>', repaint, text)

    opened = body.index(">", body.index("<svg")) + 1
    out = body[:opened] + "\n  " + HEADER + body[opened:]
    open(dst, "w").write(out)
    print(f"repainted {removed} field path(s) with the gradient; written to {dst}")


if __name__ == "__main__":
    main()
