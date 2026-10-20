#!/usr/bin/env node
/**
 * docs-check - prove the generated docs site is complete and tutorial-shaped.
 *
 * For every tutorial and reference source: the built /docs/<slug>/ page exists,
 * carries its title, and its sidebar label is on /docs/. Tutorial chapters must
 * also contain a fenced command block, a "You should see" proof block and a
 * fenced mermaid diagram. The
 * legacy /docs/cli/, /docs/naming/ and /docs/transfer/ URLs must still resolve,
 * and /docs/design/ must be gone.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distDir = join(repoRoot, 'site', 'dist');
const generatedDir = join(repoRoot, 'site', 'src', 'content', 'docs', 'docs');
const manifestPath = join(generatedDir, 'sync.manifest.json');

const failures = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function read(path) {
  return readFile(path, 'utf8').catch(() => '');
}

async function main() {
  if (!(await exists(distDir))) {
    console.error('docs-check: site/dist is missing - run: cd site && bun run build');
    process.exit(1);
  }

  if (!(await exists(join(distDir, 'pagefind', 'pagefind.js')))) {
    failures.push('missing dist/pagefind/pagefind.js');
  }

  const landing = await read(join(distDir, 'docs', 'index.html'));
  if (!landing) failures.push('missing dist/docs/index.html');
  if (landing && !landing.includes('Tutorial')) failures.push('sidebar is missing the Tutorial group');
  if (landing && !landing.includes('Reference')) failures.push('sidebar is missing the Reference group');

  const homepage = await read(join(distDir, 'index.html'));
  if (!homepage) failures.push('missing dist/index.html');
  else if (!/deploy/i.test(homepage)) failures.push('homepage lost its deploy headline');

  const manifest = JSON.parse(await read(manifestPath) || '{}');
  const docs = manifest.docs || [];
  const tutorial = docs.filter((doc) => doc.group === 'Tutorial');
  const reference = docs.filter((doc) => doc.group === 'Reference');

  if (tutorial.length !== 5) failures.push('expected 5 tutorial pages, found ' + tutorial.length);
  if (reference.length !== 9) failures.push('expected 9 reference pages, found ' + reference.length);

  for (const doc of docs) {
    const pagePath = join(distDir, 'docs', doc.slug, 'index.html');
    const page = await read(pagePath);
    const problems = [];

    if (!page) problems.push('no built page at /docs/' + doc.slug + '/');
    else if (!page.includes(doc.title)) problems.push('title not in built page');
    if (landing && !landing.includes(doc.label)) problems.push('sidebar label not on /docs/');

    const source = await read(join(repoRoot, doc.source));
    if (!source) problems.push('source is missing');

    if (doc.group === 'Tutorial') {
      if (!/\`\`\`sh\n/.test(source)) problems.push('no fenced sh command block');
      if (!/\`\`\`mermaid\n/.test(source)) problems.push('no fenced mermaid diagram');
      if (!/You should see/.test(source)) problems.push('no "You should see" block');
      if (!/## Did it fail\?/.test(source)) problems.push('no "Did it fail?" block');
    } else {
      if (!/^slug:\s/m.test(source)) problems.push('reference page has no slug frontmatter');
    }

    if (problems.length) {
      failures.push(doc.source + ': ' + problems.join(', '));
      console.log('fail ' + doc.source + ' -> /docs/' + doc.slug + '/');
    } else {
      console.log('ok   ' + doc.source + ' -> /docs/' + doc.slug + '/');
    }
  }

  // Old URLs that must survive the move.
  for (const slug of ['cli', 'naming', 'transfer']) {
    if (!(await exists(join(distDir, 'docs', slug, 'index.html')))) {
      failures.push('/docs/' + slug + '/ is missing');
    }
  }

  // The Design page left the site for good.
  if (await exists(join(distDir, 'docs', 'design', 'index.html'))) {
    failures.push('/docs/design/ still exists');
  }

  // The tutorial is published: no private addresses or machine paths may leak into it.
  const sourceFiles = (await readdir(join(repoRoot, "docs", "tutorial"))).filter((name) => name.endsWith('.md'));
  for (const name of sourceFiles) {
    const body = await readFile(join(repoRoot, "docs", "tutorial", name), "utf8");
    const ip = body.match(/\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/);
    if (ip) failures.push(`${name} leaks a private address (${ip[0]})`);
    if (/\/Users\/[a-z]/.test(body)) failures.push(`${name} leaks a home directory path`);
  }

  if (failures.length) {
    console.error('\n' + failures.map((failure) => 'FAIL ' + failure).join('\n'));
    console.error('\n' + failures.length + ' failure(s)');
    process.exit(1);
  }

  console.log('DOCS OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
