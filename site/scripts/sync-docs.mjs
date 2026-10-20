#!/usr/bin/env node
/**
 * Sync the repository's docs into the Starlight content collection.
 *
 * The repository keeps exactly one copy of the documentation; Starlight needs
 * its files under src/content/docs. This script regenerates that directory
 * (gitignored) from ../../docs/tutorial and ../../docs/reference on every
 * dev/build. Source frontmatter is preserved for title, description, slug and
 * sidebar order; anything missing is derived from the markdown itself.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const repoRoot = resolve(siteRoot, '..');
const sourceDir = join(repoRoot, 'docs');
const targetDir = join(siteRoot, 'src', 'content', 'docs', 'docs');

/** The doc trees that become site pages, in sidebar order. */
const TREES = [
  { directory: 'tutorial', group: 'Tutorial' },
  { directory: 'reference', group: 'Reference' },
];

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

/** Parse the tiny YAML frontmatter used by docs pages (flat keys + sidebar). */
function frontmatter(source) {
  if (!source.startsWith('---\n')) return { data: {}, body: source };
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return { data: {}, body: source };

  const data = {};
  let sidebar = null;
  for (const raw of source.slice(4, end).split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (nested && sidebar) {
      sidebar[nested[1]] = unquote(nested[2]);
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!match) continue;
    if (match[1] === 'sidebar') {
      sidebar = {};
      data.sidebar = sidebar;
      continue;
    }
    sidebar = null;
    data[match[1]] = unquote(match[2]);
  }

  return { data, body: source.slice(end + 5) };
}

function unquote(value) {
  const text = value.trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
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

function yamlString(value) {
  return JSON.stringify(value ?? '');
}

async function listMarkdown(dir) {
  const names = await readdir(dir).catch(() => []);
  const files = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...(await listMarkdown(path)));
    else if (name.endsWith('.md') || name.endsWith('.mdx')) files.push(path);
  }
  return files;
}

async function main() {
  const manifest = [];

  // Regenerate from scratch: a chapter that moves from .md to .mdx must not leave
  // the old generated page behind, or Starlight would see two files for one slug.
  await rm(targetDir, { recursive: true, force: true });

  for (const tree of TREES) {
    const treeDir = join(sourceDir, tree.directory);
    for (const path of await listMarkdown(treeDir)) {
      const extension = path.endsWith('.mdx') ? '.mdx' : '.md';
      const relative = path.slice(treeDir.length + 1).replace(/\.mdx?$/, '');
      const source = await readFile(path, 'utf8');
      const { data, body: rawBody } = frontmatter(source);
      const title = data.title || firstHeading(rawBody) || relative;
      const description = data.description || firstParagraph(rawBody) || '';
      // Public path is /docs/<slug>/; Starlight's slug is relative to the collection root.
      const slug = data.slug || tree.directory + '/' + relative;
      const routeSlug = 'docs/' + slug;
      const order = data.sidebar?.order;
      const label = data.sidebar?.label;

      const lines = [
        '---',
        'title: ' + yamlString(title),
        'description: ' + yamlString(description),
        'slug: ' + yamlString(routeSlug),
      ];
      if (order !== undefined || label !== undefined) {
        lines.push('sidebar:');
        if (order !== undefined) lines.push('  order: ' + Number(order));
        if (label !== undefined) lines.push('  label: ' + yamlString(label));
      }
      lines.push('---', '');

      // Keep the source directory in the content tree so Starlight's autogenerated
      // sidebar groups stay populated; the frontmatter slug above still decides the URL.
      const target = join(targetDir, tree.directory, relative + extension);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, lines.join('\n') + withoutTitle(rawBody) + '\n', 'utf8');
      manifest.push({
        slug,
        route: '/' + routeSlug + '/',
        source: 'docs/' + tree.directory + '/' + relative + extension,
        title,
        label: label || title,
        group: tree.group,
        order: order === undefined ? null : Number(order),
      });
    }
  }

  // Starlight needs an index route for /docs/; derive it from the same manifest.
  const tutorial = manifest.filter((doc) => doc.group === 'Tutorial');
  const reference = manifest.filter((doc) => doc.group === 'Reference');
  const index = [
    '---',
    'title: "Documentation"',
    'description: "Install bundant, deploy a first service, then look up every command and field."',
    'tableOfContents: false',
    '---',
    '',
    'A five-chapter tutorial, then the reference behind it. Every command in the tutorial was run',
    'against a real host; the pages show the output it produced.',
    '',
    '## Tutorial',
    '',
    ...tutorial.map((doc) => '- [' + doc.title + '](' + doc.slug + '/)'),
    '',
    '## Reference',
    '',
    ...reference.map((doc) => '- [' + doc.title + '](' + doc.slug + '/)'),
    '',
  ].join('\n');
  await writeFile(join(targetDir, 'index.md'), index, 'utf8');

  // Starlight's autogenerate skips entries whose frontmatter overrides `slug`, so the
  // sidebar is generated from this manifest instead of from the directory tree.
  const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999) || a.label.localeCompare(b.label);
  const sidebar = [
    { label: 'Tutorial', items: tutorial.slice().sort(byOrder).map((doc) => ({ label: doc.label, link: doc.route })) },
    { label: 'Reference', items: reference.slice().sort(byOrder).map((doc) => ({ label: doc.label, link: doc.route })) },
  ];
  await writeFile(join(here, '..', 'src', 'data', 'sidebar.json'), JSON.stringify(sidebar, null, 2) + '\n', 'utf8');

  await writeFile(
    join(targetDir, 'sync.manifest.json'),
    JSON.stringify(
      {
        generatedFrom: 'docs/{tutorial,reference}/**/*.{md,mdx}',
        tutorial: tutorial.length,
        reference: reference.length,
        docs: manifest,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(
    'synced ' + tutorial.length + ' tutorial + ' + reference.length + ' reference docs',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
