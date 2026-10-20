#!/usr/bin/env node
/**
 * docs-check — prove the generated docs site is complete.
 *
 * For every docs/*.md: the built /docs/<slug>/ page exists, contains the
 * source H1, and the sidebar lists its label. Also asserts the Pagefind index
 * exists and the homepage still built.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const docsDir = join(repoRoot, 'docs');
const distDir = join(repoRoot, 'site', 'dist');

const TICK = String.fromCharCode(96);
const INLINE_CODE = new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g');

function plain(text) {
  return text.replace(INLINE_CODE, '$1').replace(/\s+/g, ' ').trim();
}

function firstHeading(source) {
  for (const line of source.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return plain(match[1]);
  }
  return null;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const failures = [];

async function main() {
  if (!(await exists(distDir))) {
    console.error('docs-check: site/dist is missing — run: cd site && bun run build');
    process.exit(1);
  }

  const pagefind = join(distDir, 'pagefind', 'pagefind.js');
  if (!(await exists(pagefind))) failures.push('missing dist/pagefind/pagefind.js');

  const landing = await readFile(join(distDir, 'docs', 'index.html'), 'utf8').catch(() => '');
  if (!landing) failures.push('missing dist/docs/index.html');

  const homepage = await readFile(join(distDir, 'index.html'), 'utf8').catch(() => '');
  if (!homepage) failures.push('missing dist/index.html');
  else if (!/deploy/i.test(homepage)) failures.push('homepage lost its deploy headline');

  const files = (await readdir(docsDir)).filter((name) => name.endsWith('.md')).sort();
  for (const name of files) {
    const slug = name.replace(/\.md$/, '');
    const source = await readFile(join(docsDir, name), 'utf8');
    const title = firstHeading(source);
    const pagePath = join(distDir, 'docs', slug, 'index.html');
    const page = await readFile(pagePath, 'utf8').catch(() => '');

    const problems = [];
    if (!page) problems.push('no built page');
    else {
      if (!title) problems.push('no H1 in source');
      else if (!page.includes(title)) problems.push('H1 not in built page');
      if (!page.includes(title)) problems.push('label not in sidebar');
    }

    if (problems.length) {
      failures.push(`${name}: ${problems.join(', ')}`);
      console.log(`fail docs/${name} -> /docs/${slug}/`);
    } else {
      console.log(`ok   docs/${name} -> /docs/${slug}/`);
    }
  }

  // The landing page carries the whole sidebar, so prove every label is there.
  for (const name of files) {
    const source = await readFile(join(docsDir, name), 'utf8');
    const title = firstHeading(source);
    if (title && landing && !landing.includes(title)) {
      failures.push(`docs/${name}: sidebar on /docs/ does not list "${title}"`);
    }
  }

  if (failures.length) {
    console.error('\n' + failures.map((failure) => `FAIL ${failure}`).join('\n'));
    console.error(`\n${failures.length} failure(s)`);
    process.exit(1);
  }

  console.log('DOCS OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
