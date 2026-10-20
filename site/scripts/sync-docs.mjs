#!/usr/bin/env node
/**
 * Sync the repo's docs/*.md into the Starlight content collection.
 *
 * The repository keeps exactly one copy of the documentation; Starlight needs
 * its files under src/content/docs. This script regenerates that directory
 * (gitignored) from ../../docs on every dev/build, deriving the frontmatter
 * from the markdown itself: title from the first H1, description from the
 * first prose paragraph.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const repoRoot = resolve(siteRoot, '..');
const sourceDir = join(repoRoot, 'docs');
const targetDir = join(siteRoot, 'src', 'content', 'docs', 'docs');

const TICK = String.fromCharCode(96);
const FENCE = new RegExp('^\\s*' + TICK.repeat(3));
const INLINE_CODE = new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g');

/** Strip the markdown that would leak into a <title> or meta description. */
function plain(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(INLINE_CODE, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first H1 in a markdown document, or null. */
function firstHeading(source) {
  for (const line of source.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return plain(match[1]);
    if (FENCE.test(line)) return null;
  }
  return null;
}

/** The first prose paragraph after the H1, skipping fenced code and headings. */
function firstParagraph(source) {
  const lines = source.split('\n');
  let inFence = false;
  let seenHeading = false;
  const paragraph = [];

  for (const line of lines) {
    if (FENCE.test(line)) {
      if (paragraph.length) break;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!seenHeading) {
      if (/^#\s+/.test(line)) seenHeading = true;
      continue;
    }
    if (!line.trim()) {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,6}\s+/.test(line) || /^\s*([-*+]|\d+\.)\s+/.test(line) || /^\|/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.trim());
  }

  return plain(paragraph.join(' '));
}

/** Remove the leading H1: Starlight renders the title from the frontmatter. */
function withoutTitle(source) {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => /^#\s+/.test(line));
  if (index === -1) return source.trim();
  lines.splice(index, 1);
  return lines.join('\n').replace(/^\s*\n/, '').trim();
}

async function main() {
  const files = (await readdir(sourceDir))
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));

  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  const manifest = [];
  for (const name of files) {
    const slug = name.replace(/\.md$/, '');
    const source = await readFile(join(sourceDir, name), 'utf8');
    const title = firstHeading(source) || slug;
    const description = firstParagraph(source);
    const body = withoutTitle(source);
    const frontmatter = [
      '---',
      'title: ' + JSON.stringify(title),
      'description: ' + JSON.stringify(description),
      '---',
      '',
    ].join('\n');

    await writeFile(join(targetDir, slug + '.md'), frontmatter + body + '\n', 'utf8');
    manifest.push({ slug, source: 'docs/' + name, title });
  }

  // Starlight needs an index route for /docs/; derive it from the same manifest.
  const index = [
    '---',
    'title: "Overview"',
    'description: "The bundant manual, generated from the repository docs at build time."',
    'tableOfContents: false',
    '---',
    '',
    'The bundant manual. Every page below is rendered from the repository docs at build time.',
    '',
    ...manifest.map((doc) => '- [' + doc.title + '](' + doc.slug + '/)'),
    '',
  ].join('\n');
  await writeFile(join(targetDir, 'index.md'), index, 'utf8');

  await writeFile(
    join(targetDir, 'sync.manifest.json'),
    JSON.stringify({ generatedFrom: 'docs/*.md', docs: manifest }, null, 2) + '\n',
    'utf8',
  );

  console.log('synced ' + manifest.length + ' docs');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
