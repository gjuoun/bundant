import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

const BASE = '/bundant';

// scripts/sync-docs.mjs writes the sidebar from the docs manifest: Starlight's
// autogenerate skips entries that override `slug`, and every reference page does.
const here = dirname(fileURLToPath(import.meta.url));
const sidebarPath = join(here, 'src/data/sidebar.json');
const docsSidebar = existsSync(sidebarPath) ? JSON.parse(readFileSync(sidebarPath, 'utf8')) : [];

/**
 * Bigface theme for Expressive Code / Shiki, derived from site/src/data/bigface.json.
 * Keywords blue, strings yellow, numbers burntOrange, comments #75715e,
 * functions lime, types cyan — no stock GitHub rainbow.
 */
const bigfaceTheme = {
  name: 'bigface',
  type: 'dark',
  colors: {
    'editor.background': '#2e332e',
    'editor.foreground': '#d9d9d4',
    'editorLineNumber.foreground': '#6e6b68',
    'editor.selectionBackground': '#646464',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#75715e' } },
    { scope: ['keyword', 'storage', 'storage.type', 'entity.name.tag'], settings: { foreground: '#00b0ff' } },
    { scope: ['string', 'string.quoted', 'constant.other.symbol'], settings: { foreground: '#e5e500' } },
    { scope: ['constant.numeric'], settings: { foreground: '#fc5d23' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: '#c6ff00' } },
    { scope: ['entity.name.type', 'support.type', 'support.class'], settings: { foreground: '#66d9ef' } },
    { scope: ['variable', 'variable.other', 'entity.name.variable'], settings: { foreground: '#00c853' } },
    { scope: ['constant', 'constant.language', 'support.constant'], settings: { foreground: '#ae81ff' } },
    { scope: ['keyword.operator'], settings: { foreground: '#ffeb3b' } },
  ],
};

/** Rewrite relative `*.md` links so they resolve to generated `/bundant/docs/...` pages. */
function rehypeDocLinks() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'element' && node.tagName === 'a') {
        const href = node.properties?.href;
        if (typeof href === 'string' && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) {
          const [path, hash] = href.split('#');
          if (path.endsWith('.md')) {
            const slug = path.replace(/^\.\//, '').replace(/\.md$/, '');
            node.properties.href = `${BASE}/docs/${slug}/${hash ? `#${hash}` : ''}`;
          }
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// GitHub Pages project page: https://gjuoun.github.io/bundant/
export default defineConfig({
  site: 'https://gjuoun.github.io',
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [
    react(),
    starlight({
      title: 'bundant',
      description: 'bundant documentation: a five-chapter tutorial, then the deploy.yml, CLI and operational reference.',
      pagefind: true,
      social: [],
      sidebar: docsSidebar,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      disable404Route: false,
      customCss: ['./src/styles/starlight.css'],
      components: {
        Header: './src/components/starlight/Header.astro',
        Footer: './src/components/starlight/Footer.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
        MobileMenuFooter: './src/components/starlight/MobileMenuFooter.astro',
      },
      expressiveCode: {
        themes: [bigfaceTheme],
        useStarlightDarkModeSwitch: false,
        styleOverrides: {
          borderRadius: '0.5rem',
          codeBackground: '#2e332e',
          borderColor: '#494848',
          codeFontSize: '0.8125rem',
        },
      },
    }),
  ],
  markdown: {
    rehypePlugins: [rehypeDocLinks],
    shikiConfig: { theme: bigfaceTheme },
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
  },
});
