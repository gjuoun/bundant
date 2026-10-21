/**
 * Asset URLs that work at any Astro `base`.
 *
 * `import.meta.env.BASE_URL` always ends with a slash ("/" at the root,
 * "/bundant/" under the GitHub Pages deploy), so the old
 * `${BASE_URL}/img/x.png` form produced `//img/x.png` at the root — a
 * protocol-relative URL that silently resolved to https://img/x.png and
 * rendered a broken image. Compose through here instead.
 */
export const basePath = import.meta.env.BASE_URL.replace(/\/+$/, "");

export function asset(path: string): string {
  return `${basePath}/${path.replace(/^\/+/, "")}`;
}
