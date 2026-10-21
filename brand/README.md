# bundant brand marks

bundant's identity is one mark: **a content bear on a dark field**. Bigface — the theme — is the
polar bear; bundant is its warmer cousin: same family of shape, opposite temperament. Closed, happy
eyes and a small smile; it has shipped the thing and it is fine.

## Master

- File: `brand/content-bear-master.svg`
- Canvas: `512 × 512`, `viewBox="0 0 512 512"`, opaque, no external fonts, filters or linked assets
- Structure: 1 field gradient, 1 radial glow, 3 sparkles, 2 ears + 2 inner ears, 1 head path,
  1 muzzle ellipse, 2 closed-eye arcs, 1 nose, 3 mouth strokes
- Colours, all from the Bigface palette:
  - field `#333333 → #252925 → #1F231F` (borderMuted → bg → bgDeep)
  - glow `#40C4FF` at 30 % (lightBlue)
  - fur `#FF9800 → #FC5D23 → #C9430F` (orange → burntOrange)
  - muzzle `#FFC46B → #FF9800`
  - ink `#1F231F` (bgDeep)

The master is the single source. Nothing below edits it; every raster is rendered from it.

## Concept

- **A bear, not a second polar bear.** Bigface is cold and white; bundant is warm and orange. The
  silhouette is recognisably the same family, the colour and the expression are the opposite.
- **Expression carries the name.** "bundant" is a full, satisfied system: closed eyes (satisfied),
  a small smile, no fangs, no props.
- **Head fills ~62 % of the width** so the same file works as a favicon, a header mark and a social
  avatar without a separate icon variant.
- **Dark field, blue glow.** The field is the site's own backgrounds, so the mark sits on the product
  without a visible box; the complementary glow separates the warm face from the cool field.

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

- face / field contrast **4.05:1** (threshold 3:1 for an icon)
- ink / fur contrast **5.1:1** (threshold 4.5:1)
- mascot coverage at 512 px **0.363**, field coverage **0.487**
- distinct ink blobs: **1 at 16 px**, **4 at 32 px**, **7 at 64 px**

## Known limits

- **At 16 px only the nose survives.** The eye arcs are ~1 px wide there and antialiasing eats them,
  so the tab icon reads as an orange bear head with a dark nose, not as a face. 32 px separates the
  eyes; 64 px and up is the full expression. This is a documented limit, not a pass.
- The mark is **flat and hand-authored**. There is no pixel-fidelity target to report — the checks
  above are the whole story.
- No light-mode variant exists. On a light surface the dark field still gives the shape a border, but
  it has not been contrast-tested against white.
