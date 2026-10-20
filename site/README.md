# bundant site

The product page for [bundant](https://github.com/gjuoun/bundant), built with
**Astro 5 + @astrojs/react + Tailwind v4 + shadcn/ui + lucide**.

- **Live (after Pages is enabled):** <https://gjuoun.github.io/bundant/>
- **Base:** `/bundant` — GitHub Pages project-page paths.
- **Content source of truth:** the CLI. Every command and flag on the page comes from
  `bun run src/cli.ts --help` and the subcommand helps; unshipped features are not listed.
- **Docs:** rendered at build time from `../docs/tutorial/` and `../docs/reference/`;
  each page's `slug:` frontmatter keeps its public `/bundant/docs/<slug>/` URL.

## Preview locally

```sh
cd site
bun install
bun run dev       # http://localhost:4321/bundant/
```

Production build:

```sh
cd site
bun run build     # writes site/dist
bun run preview   # serves the built site at http://localhost:4321/bundant/
bun run check     # astro check (types + templates)
```

## Visual smoke test

The plan's helper builds the site, serves it, asserts the headline and install snippet, checks
the generated docs pages, and writes three screenshots:

```sh
BUNDANT_REPO="$PWD" bash ~/.notebook/project/gjuoun/bundant/plan/scripts/site-smoke.sh
# screenshots: /tmp/bundant-site-shots/{phone,pad,desktop}.png
```

Target widths are phone 390x844, pad 834x1112 and desktop 1440x900. Headless Chrome on macOS
clamps its layout viewport to 500px, so `global.css` keeps the phone layout inside 390px between
500px and 519px; real devices below that range are unaffected.

## Publishing

`.github/workflows/pages.yml` builds `site/` on every push to `main` that touches
`site/**`, `docs/**` or the workflow itself, then deploys the artifact with
`actions/deploy-pages`. The repository's Pages source must be set to **GitHub Actions** once
(a repository-admin step outside this code).

## Repo hygiene

`site/` is not part of the npm tarball, the root `tsc` program, or `bun test`. It has its own
`tsconfig.json` and lockfile; run `bun run check` inside `site/` for its types.
