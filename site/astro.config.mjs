import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

const BASE = '/bundant';

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
  integrations: [react()],
  markdown: {
    rehypePlugins: [rehypeDocLinks],
    shikiConfig: { theme: 'github-light' },
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
  },
});
