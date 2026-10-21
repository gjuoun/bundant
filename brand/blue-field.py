#!/usr/bin/env python3
"""Swap the flat charcoal field of a bear generation for Bigface's blue field.

    uv run --with pillow python3 brand/blue-field.py brand/candidates/v4.png /tmp/v4-blue.png

The background is found by flooding from the four corners (so interior shadows and the
muzzle are untouched) and is replaced by the same gradient the Bigface avatar uses:
#2E7BE6 -> #1A54B4 -> #08265C, laid diagonally so the light end stays in the empty
upper-left and the bear sits on the dark end.
"""

from __future__ import annotations

import sys

from PIL import Image

STOPS = ((0.00, (0x2E, 0x7B, 0xE6)), (0.38, (0x1A, 0x54, 0xB4)), (0.62, (0x08, 0x26, 0x5C)), (1.00, (0x08, 0x26, 0x5C)))

# The field is painted as three flat bands, not a smooth ramp: the tracer turns a smooth
# ramp into hundreds of near-blues, and nearest-colour snapping then folds the dark end
# into the ink colour. Flat stops survive tracing exactly.
BAND = True


def gradient(t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t0 <= t <= t1:
            f = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def close(p, target, tol=26) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(p[:3], target))


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert("RGB")
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

    out = im.copy()
    opx = out.load()
    for y in range(h):
        for x in range(w):
            if (x, y) in field:
                colour = gradient((x / w + y / h) / 2)
                if BAND:
                    colour = min((s[1] for s in STOPS), key=lambda c: sum((a - b) ** 2 for a, b in zip(c, colour)))
                opx[x, y] = colour
    out.save(dst)
    print(f"{len(field)} / {w * h} px replaced ({len(field) / (w * h):.1%}) -> {dst}")


if __name__ == "__main__":
    main()
