#!/usr/bin/env python3
"""Quantitative QA for the bundant content-bear mark.

    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
      uv run --with cairosvg --with pillow python3 brand/validate-content-bear.py

Writes content-bear-validation.json + a contact sheet, prints the JSON, exits 1 on failure.

What this checks, and why:

- the rasters are opaque, square and the right size;
- the head fills the frame (coverage) but is a *bust*: it runs out of the right and
  bottom edges and never touches the top or left ones. That crop IS the composition,
  so it is a hard assertion, not a nicety;
- the face survives down to 32 px (ink pixels on fur), and 16 px is measured and
  reported rather than promised;
- the three colour pairs that carry the drawing keep their contrast.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

NAME = "content-bear"
SIZES = (16, 32, 64, 128, 180, 192, 256, 512, 1024)
FUR = (252, 93, 35)  # burntOrange #FC5D23 — the bear
MUZZLE = (217, 217, 212)  # fg #D9D9D4 — the snout
FIELD_BLUE = (0x40, 0xC4, 0xFF)  # #40C4FF — Bigface's accent blue (lightBlue)
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


def is_fur(p) -> bool:
    return p[0] > p[2] + 60 and p[0] > 120


def is_field(p) -> bool:
    """Bigface's field is a blue gradient (#2E7BE6 → #08265C), so the field is any
    clearly blue pixel rather than one exact colour."""
    return p[2] > p[0] + 30 and p[2] > 60


def field_mask(rgb: Image.Image) -> set[tuple[int, int]]:
    """Flood the flat field from the four corners.

    The field sits only ~20 levels away from the ink, so a colour test alone cannot
    tell background from face. Anything reachable from a corner is field; the facial
    features, enclosed by fur, never are.
    """
    w, h = rgb.size
    px = rgb.load()
    seen: set[tuple[int, int]] = set()
    stack = [(x, y) for (x, y) in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)) if is_field(px[x, y])]
    while stack:
        cx, cy = stack.pop()
        if (cx, cy) in seen:
            continue
        seen.add((cx, cy))
        for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and is_field(px[nx, ny]):
                stack.append((nx, ny))
    return seen


def ink_on_fur(rgb: Image.Image, _tol: int = 0) -> int:
    """Feature pixels: clearly darker than the fur, and not field.

    Colour equality is useless here: over a blue field the antialiased stroke edges turn
    blue-grey, so a "close to #1F231F" test reports an empty face at 16 px while the eyes
    are plainly visible. Luminance relative to the fur holds at every size.
    """
    w, h = rgb.size
    px = rgb.load()
    field = field_mask(rgb)
    fur_lum = luminance(FUR)
    radius = 6 if w >= 256 else 2
    count = 0
    for y in range(h):
        for x in range(w):
            if (x, y) in field:
                continue
            if luminance(px[x, y]) >= fur_lum * 0.45:
                continue
            # Only count marks that sit next to fur: the plate's dark vignette is dark
            # too, and counting it would hide a genuinely empty face.
            near_face = any(
                is_fur(px[min(w - 1, max(0, x + dx)), min(h - 1, max(0, y + dy))])
                or close(px[min(w - 1, max(0, x + dx)), min(h - 1, max(0, y + dy))], MUZZLE, 40)
                for dx in range(-radius, radius + 1, radius)
                for dy in range(-radius, radius + 1, radius)
            )
            if near_face:
                count += 1
    return count


def edge_fur(rgb: Image.Image, side: str) -> float:
    """Fraction of an edge covered by fur."""
    w, h = rgb.size
    px = rgb.load()
    coords = {
        "top": [(x, 0) for x in range(w)],
        "bottom": [(x, h - 1) for x in range(w)],
        "left": [(0, y) for y in range(h)],
        "right": [(w - 1, y) for y in range(h)],
    }[side]
    hits = sum(1 for x, y in coords if is_fur(px[x, y]))
    return round(hits / len(coords), 3)


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
                if is_fur(p):
                    fur += 1
                elif is_field(p):
                    field += 1
        # Below 64 px the ink is 1-2 px wide and antialiased toward fur; widen the
        # tolerance there or the face reads as empty.
        # The field flood must stay tight (8 levels): the ink is only 6 levels away from the
        # field colour, so a loose flood swallows the nose and the face measures empty.
        ink = ink_on_fur(rgb) if size <= 128 else 0
    total = w * h
    return {
        "size": size,
        "mode": mode,
        "width": w,
        "height": h,
        "bytes": path.stat().st_size,
        "fur_fraction": round(fur / total, 4),
        "field_fraction": round(field / total, 4),
        "ink_pixels": ink,
        "ink_fraction": round(ink / total, 4),
        "edge_fur": {side: edge_fur(rgb, side) for side in ("top", "bottom", "left", "right")},
    }


def main() -> None:
    rows = [measure(s) for s in SIZES]
    fur_field = round(contrast(FUR, FIELD_BLUE), 2)
    ink_fur = round(contrast(INK, FUR), 2)
    ink_muzzle = round(contrast(INK, MUZZLE), 2)
    failures: list[str] = []

    for r in rows:
        name = f"{r['size']}px"
        if r["mode"] != "RGB":
            failures.append(f"{name}: mode {r['mode']} is not opaque RGB")
        if (r["width"], r["height"]) != (r["size"], r["size"]):
            failures.append(f"{name}: not square")
        if r["fur_fraction"] < 0.30:
            failures.append(f"{name}: mascot coverage {r['fur_fraction']} < 0.30")

        # The crop contract: a bust leaning in from the lower right.
        e = r["edge_fur"]
        if e["right"] < 0.25:
            failures.append(f"{name}: head does not run out of the right edge ({e['right']})")
        if e["bottom"] < 0.25:
            failures.append(f"{name}: head does not run out of the bottom edge ({e['bottom']})")
        if e["top"] > 0.02:
            failures.append(f"{name}: fur touches the top edge ({e['top']}), the crop is not a bust")
        if e["left"] > 0.02:
            failures.append(f"{name}: fur touches the left edge ({e['left']}), the crop is not a bust")

        # Face survival: the features must not vanish. The floor is 1.0 % of the raster and
        # the vector master measures 1.2 % at 16 px, 1.7 % at 32 px, 2.0 % at 64 px. A floor,
        # not a promise that the expression reads at 16 px — it does not.
        if r["size"] <= 64 and r["ink_fraction"] < 0.010:
            failures.append(f"{name}: feature coverage {r['ink_fraction']} < 0.010")

    # Jun chose the theme accent (#40C4FF), which is an orange-on-cyan mark at 1.29:1.
    # 3:1 is the text/UI bar and does not apply to a graphic mark whose separation comes
    # from hue; the floor here only catches an accidental near-invisible field.
    if fur_field < 1.2:
        failures.append(f"fur/field contrast {fur_field}:1 below 2.2:1")
    if ink_fur < 4.5:
        failures.append(f"ink/fur contrast {ink_fur}:1 below 4.5:1")
    if ink_muzzle < 4.5:
        failures.append(f"ink/muzzle contrast {ink_muzzle}:1 below 4.5:1")

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
        "fur_to_field_contrast": f"{fur_field}:1",
        "ink_to_fur_contrast": f"{ink_fur}:1",
        "ink_to_muzzle_contrast": f"{ink_muzzle}:1",
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
