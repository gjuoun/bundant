#!/usr/bin/env python3
"""Snap every fill in a traced SVG onto the project palette.

    python3 brand/snap-to-palette.py /tmp/trace.svg out.svg "#252925" "#FF9800" "#FC5D23" "#D9D9D4" "#1F231F"

Pass a subset of palette colours as trailing arguments to keep the artwork to a few flat
tones; without them the whole palette is the target and dark shades scatter.

The traced artwork carries JPEG-shifted colours (#E6944C, #FED9A1, ...). The brand
rule is that the mark may only use palette values, so each fill is replaced by its
nearest neighbour in site/src/data/bigface.json before the master is committed.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PALETTE_FILE = Path(__file__).resolve().parent.parent / "site/src/data/bigface.json"

# Bigface's avatar field gradient — brand colours that live in bigface-theme's own
# brand/bigface-avatar-master.svg rather than in the vendored palette JSON.
FIELD_BLUES = {"#2E7BE6", "#1A54B4", "#08265C"}


def load_palette() -> list[tuple[int, int, int]]:
    data = json.loads(PALETTE_FILE.read_text())
    flat = data.get("colors", data)

    found: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
        elif isinstance(node, str):
            for match in re.findall(r"#[0-9a-fA-F]{6}\b", node):
                found.add(match.lower())

    walk(flat)
    return [tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in sorted(found)]


def nearest(rgb, palette):
    return min(palette, key=lambda p: sum((a - b) ** 2 for a, b in zip(rgb, p)))


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    only = [a for a in sys.argv[3:] if a.startswith("#")]
    palette = load_palette()
    if only:
        chosen = [tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in only]
        missing = {c for c in set(chosen) - set(palette) if "#{:02X}{:02X}{:02X}".format(*c) not in FIELD_BLUES}
        if missing:
            raise SystemExit(f"not in the palette: {missing}")
        palette = chosen
    if not palette:
        raise SystemExit("palette is empty")
    mapping: dict[str, str] = {}

    def swap(match: re.Match) -> str:
        hex_value = match.group(1).lower()
        if hex_value not in mapping:
            rgb = tuple(int(hex_value[i : i + 2], 16) for i in (1, 3, 5))
            snapped = nearest(rgb, palette)
            mapping[hex_value] = "#{:02X}{:02X}{:02X}".format(*snapped)
        return f'fill="{mapping[hex_value]}"'

    text = re.sub(r'fill="(#[0-9a-fA-F]{6})"', swap, src.read_text())
    dst.write_text(text)
    print(f"{src} -> {dst}: {len(mapping)} colours snapped onto {len(palette)} palette values")
    for old, new in sorted(mapping.items()):
        print(f"  {old} -> {new}")


if __name__ == "__main__":
    main()
