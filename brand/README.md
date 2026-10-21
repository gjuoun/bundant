# bundant brand marks

bundant's identity is one mark: **a content bear leaning into the frame from the lower right**, on a
dark field. Bigface — the theme — is the polar bear; bundant is its warmer cousin: same family of
shape, opposite temperament.

## How it was made (the original process, reused)

The blue-bear and guardian-crocodile marks in `~/code/gjuoun/notebook/hermes/projects/` were not drawn
by hand. They were **generated, picked, traced, then snapped to the palette**. This mark follows the
same four steps, and every step is a file in this directory.

| Step | Tool | Artefact |
|---|---|---|
| 1. Generate | Nano Banana 2 (`gemini-3.1-flash-image`) on the Gemini key | `brand/gen-image.sh`, `brand/prompts/*.txt` |
| 2. Pick | vision review of the candidates against the brief | `brand/candidates/v1..v4.png` |
| 3. Trace | `vtracer` (colour, spline, stacked) | `brand/content-bear-master.svg` |
| 4. Snap | `brand/snap-to-palette.py` — every fill to a Bigface palette value | in the master |

The chosen candidate is `brand/candidates/v4.png`; the untouched generation is kept as provenance in
`brand/content-bear-source.jpg`.

### Step 1 — generate

```sh
cd ~/code/gjuoun/bundant
OUT=brand/candidates/v4 PROMPT_FILE=brand/prompts/v4.txt \
  REF="$HOME/code/gjuoun/notebook/hermes/projects/guardian-crocodile-logo/guardian-crocodile-selected.png" \
  opk get GEMINI_API_KEY -- bash brand/gen-image.sh
```

The crocodile PNG is passed as a **composition reference only** — it teaches the model the bust crop
(head running out of the right and bottom edges, snout toward the upper left, flat colour behind), not
the species. The key is injected by `opk` and never printed.

### Step 2 — pick

Four prompts were written (`prompts/bear-bust.txt`, `v2`, `v3`, `v4`), all asking for the same thing in
slightly different words. All four came back with the correct crop — measured, fur covers 0 % of the
top and left edges and 42–81 % of the right and bottom. `v4` was chosen for the cleanest geometry: one
ear, two level closed eyes, uniform stroke weight, no stray shapes.

### Step 3 — trace

```sh
uv run --with vtracer python3 -c "
import vtracer
vtracer.convert_image_to_svg_py('$PWD/brand/content-bear-source.jpg', '/tmp/trace.svg',
  colormode='color', hierarchical='stacked', mode='spline', filter_speckle=8,
  color_precision=6, layer_difference=24, corner_threshold=60, length_threshold=4.0,
  max_iterations=10, splice_threshold=45, path_precision=2)"
```

`vtracer` needs an absolute path, and it rejects a JPEG that has been renamed `.png` — the generator
writes JPEG bytes, so the source file keeps the `.jpg` extension.

### Step 4 — snap to the palette

```sh
uv run python3 brand/snap-to-palette.py /tmp/trace.svg brand/content-bear-master.svg \
  "#252925" "#FF9800" "#FC5D23" "#D9D9D4" "#1F231F"
```

134 traced colours collapse onto five palette values: field `#252925`, fur `#FC5D23` (with `#FF9800`
available for a lighter tone), muzzle `#D9D9D4`, ink `#1F231F`. Restricting the target set matters: the
full 33-colour palette scatters dark shades into unrelated hues.

## Master

- File: `brand/content-bear-master.svg` — 1024 × 1024 viewBox, traced splines, palette-only fills
- Provenance: `brand/content-bear-source.jpg` (the untouched 1024 × 1024 generation)
- Composition: bust — fur covers ~81 % of the right edge and ~60 % of the bottom edge, 0 % of the top
  and left. The validator asserts this; it is not assumed.

## Concept

- **A bear, not a second polar bear.** Bigface is cold and white; bundant is warm and orange. The
  silhouette is the same family; the colour and the expression are the opposite.
- **Bust, not badge.** Borrowed from the Guardian crocodile: the head runs out of the right and bottom
  edges, so the animal is *in* the frame rather than *centred* in it. No sparkles, no props.
- **Expression carries the name.** "bundant" is a full, satisfied system: closed eyes, one small smile.

## Exports

`brand/export-content-bear.py` renders and copies everything the site serves:

| Output | Size | Used by |
|---|---|---|
| `exports/content-bear-16.png` | 16 | press kit (see limits) |
| `exports/content-bear-32.png` | 32 | `site/public/favicon-32.png` |
| `exports/content-bear-64.png` | 64 | press kit |
| `exports/content-bear-128.png` | 128 | press kit |
| `exports/content-bear-180.png` | 180 | `site/public/apple-touch-icon.png` |
| `exports/content-bear-192.png` | 192 | press kit |
| `exports/content-bear-256.png` | 256 | press kit |
| `exports/content-bear-512.png` | 512 | press kit, OG card source |
| `exports/content-bear-1024.png` | 1024 | press kit |
| `site/public/favicon.svg` | vector | `<link rel="icon">` |
| `site/public/img/content-bear.svg` | vector | header mark (home + docs) |
| `site/public/img/og.png` | 1200 × 630 | `og:image`, `twitter:image` |

## Reproduce

```sh
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
  uv run --with cairosvg --with pillow python3 brand/export-content-bear.py

DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
  uv run --with cairosvg --with pillow python3 brand/validate-content-bear.py
```

## Recorded metrics

From `brand/content-bear-validation.json` (verbatim):

- fur / field contrast **4.73:1** (threshold 3:1 for an icon)
- ink / fur contrast **5.1:1** (threshold 4.5:1)
- ink / muzzle contrast **11.25:1** (threshold 4.5:1)
- fur coverage at 512 px **0.46**, field coverage **0.47**
- crop at 512 px: right edge **81 %** fur, bottom **60 %**, top **0 %**, left **0 %**
- ink coverage: **3.5 % at 16 px**, **2.0 % at 32 px**, **1.1 % at 64 px**

## Known limits

- **16 px does not read as a bear.** It collapses to an orange block with a pale muzzle; the face needs
  the 32 px raster at minimum. Measured — see `brand/content-bear-contact-sheet.png`.
- The master is a **trace, not a redraw**. Curves carry spline-fitting error from the raster; a human
  redraw would be crisper at very large sizes. Nothing here is a pixel-fidelity replica of the
  generation.
- No light-mode variant exists. On a light surface the dark field gives the shape a border, but it has
  not been contrast-tested against white.
