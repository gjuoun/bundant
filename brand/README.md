# bundant brand marks

bundant's identity is one mark: **a content bear leaning into the frame from the lower right**, on a
dark field. Bigface — the theme — is the polar bear; bundant is its warmer cousin: same family of
shape, opposite temperament. Closed, happy eyes and a small smile; it has shipped the thing and it is
fine.

The pose is borrowed from the Guardian crocodile mark: a bust, not an avatar. The head runs out of the
right and bottom edges the way the crocodile does, so the animal is *in* the frame rather than
*centred* in it. No sparkles, no props, nothing floating: one face on one flat colour.

## Master

- File: `brand/content-bear-master.svg`
- Canvas: `512 × 512`, `viewBox="0 0 512 512"`, opaque, no external fonts, filters or linked assets
- Structure: 1 flat field, 2 ears + 2 inner ears, 1 head ellipse, 1 muzzle ellipse, 2 closed-eye arcs,
  1 nose, 1 smile stroke — 10 shapes in total
- Geometry: everything is drawn in **face-local coordinates** (origin at the head centre) and placed
  once with `translate(398 322) rotate(-9)`, so the features cannot drift out of alignment
- Colours, all from the Bigface palette:
  - field `#252925` (bg), flat
  - fur `#FF9800 → #FC5D23` (orange → burntOrange)
  - muzzle `#D9D9D4` (fg), solid
  - ink `#1F231F` (bgDeep)

The master is the single source. Nothing below edits it; every raster is rendered from it.

## Concept

- **A bear, not a second polar bear.** Bigface is cold and white; bundant is warm and orange. The
  silhouette is the same family, the colour and the expression are the opposite.
- **Bust, not badge.** The head is cropped by the right and bottom edges. That crop is the whole
  composition, so the validator asserts it: fur must cover ≥25 % of the right and bottom edges and
  0 % of the top and left.
- **Expression carries the name.** "bundant" is a full, satisfied system: closed eyes, one small
  smile, no fangs, no props.
- **The head fills the frame** (~36 % of the pixels are fur), so the same file works as favicon,
  header mark and social avatar without a second icon variant.

## Exports

`brand/export-content-bear.py` renders and copies everything the site serves:

| Output | Size | Used by |
|---|---|---|
| `exports/content-bear-16.png` | 16 | press kit only (see limits) |
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
- fur coverage at 512 px **0.363**, field coverage **0.522**
- crop at 512 px: right edge **65.6 %** fur, bottom **29.7 %**, top **0 %**, left **0 %**
- ink coverage: **2.7 % at 16 px**, **1.7 % at 32 px**, **1.4 % at 64 px**

## Known limits

- **16 px does not read as a bear.** It collapses to an orange shape with a pale muzzle; the eye
  arcs are sub-pixel there. 32 px is borderline — silhouette, ears and muzzle read, the expression
  does not. 64 px and up is the full mark. This is measured, not promised: see
  `brand/content-bear-contact-sheet.png`.
- The mark is **flat and hand-authored**. There is no pixel-fidelity target to report — the checks
  above are the whole story.
- No light-mode variant exists. On a light surface the dark field still gives the shape a border, but
  it has not been contrast-tested against white.
