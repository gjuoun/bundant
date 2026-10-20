# Site design

The product site (`site/`) renders on **Bigface**, Jun's own dark palette. The same
colours run in his JetBrains scheme, terminal themes and Obsidian theme, so the site
looks like the tools rather than a separate brand.

## Source of truth

- Upstream: [github.com/gjuoun/bigface-theme](https://github.com/gjuoun/bigface-theme) —
  `palette/bigface.json`
- Vendored copy: `site/src/data/bigface.json` (MIT, kept byte-for-byte at the palette
  level; the `_source` key records the upstream commit)
- Token mapping: `site/src/styles/global.css` (`:root` only — there is no `.dark`
  variant and no light theme)
- Code/terminal hooks: `site/src/styles/bigface.css`

## Mapping

| shadcn token | Bigface | value | role |
|---|---|---|---|
| `--background` | `bgDeep` | `#1f231f` | page |
| `--card` | `bg` | `#252925` | panels and cards |
| `--muted` | `bgPanel` | `#2e332e` | elements inside a panel, code surface |
| `--foreground` | `fg` | `#d9d9d4` | meaningful text |
| `--muted-foreground` | `fgMuted` | `#9c9a8f` | secondary labels, inactive tabs |
| `--border` | `border` | `#494848` | panel outlines |
| `--border-muted` | `borderMuted` | `#333333` | dividers inside a panel |
| `--primary` / `--ring` | `lightBlue` | `#40c4ff` | CTA, active-tab underline |
| `--primary-foreground` | `bgDeep` | `#1f231f` | ink on the light-blue button |
| `--accent` | `blue` | `#00b0ff` | accent surfaces |
| `--destructive` | `pink` | `#f52670` | destructive actions |

The hierarchy is always page `bgDeep` → panel `bg` → inner element `bgPanel`.
`fgDim` is reserved for purely decorative marks; labels never use it. Active tabs
render the panel surface plus a 2px `lightBlue` underline, inactive tabs stay
`fgMuted`.

Comments use `#75715e`, strings `yellow`, keywords `blue`, numbers `burntOrange`,
functions `lime`, types `cyan`, success ticks `green` and arrows `lightBlue`. Shiki
is pinned to a theme derived from these values in `site/astro.config.mjs` with its
editor background set to `bgPanel`.

## Re-syncing the palette

```sh
# from the bigface-theme checkout
git pull
jq '{\n  _source: "Vendored from … @ <commit>",\n  name, appearance, colors, ansi, syntax\n}' \
  palette/bigface.json > ../bundant/site/src/data/bigface.json
```

Then update the literal token values in `site/src/styles/global.css` if the palette
changed and run the gates:

```sh
node ~/.notebook/project/gjuoun/bundant/plan/scripts/contrast.mjs site/src/styles/global.css
BUNDANT_REPO=$PWD ~/.notebook/project/gjuoun/bundant/plan/scripts/site-smoke.sh
```

The contrast gate fails below WCAG AA (4.5:1 for text and links, 1.5:1 for hairlines).
Do not add a light theme or a theme toggle: Bigface is a single dark palette.
