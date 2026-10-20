#!/usr/bin/env node
/**
 * docs-check - prove the generated docs site is complete and tutorial-shaped.
 *
 * For every tutorial and reference source: the built /docs/<slug>/ page exists,
 * carries its title, and its sidebar label is on /docs/. A tutorial chapter is
 * one straight instruction: a <Steps> wrapper, a fenced command block, a "You
 * should see" proof line and a fenced mermaid diagram - and no <Aside>, no
 * <Badge> and no "Did it fail?" catalogue (that lives in
 * reference/troubleshooting.md, which must exist and appear in the Reference
 * group). Only the install step uses <Tabs>. The built pages must keep the
 * diagram source readable with JS off, and (when Chrome is available) render it
 * to SVG with JS on. Reference pages stay plain Markdown. The
 * legacy /docs/cli/, /docs/naming/ and /docs/transfer/ URLs must still resolve,
 * and /docs/design/ must be gone.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distDir = join(repoRoot, 'site', 'dist');
const generatedDir = join(repoRoot, 'site', 'src', 'content', 'docs', 'docs');
const manifestPath = join(generatedDir, 'sync.manifest.json');

const failures = [];

/** Chapters that must use a given component (from the tutorial's component map). */
const NEEDS_TREE = new Set(['01-quickstart', '02-first-service', '04-scale-and-groups']);

function chapterOf(source) {
  return source.replace(/^.*\//, '').replace(/\.mdx?$/, '');
}

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

/**
 * Serve site/dist the way the product does (/bundant prefix) and ask headless
 * Chrome for the rendered DOM. With JS off the page keeps <pre class="mermaid">;
 * with JS on the same page must contain an SVG flowchart. Chrome is optional so
 * the check still runs on a machine without it.
 */
async function checkMermaidRuntime() {
  const chrome =
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!(await exists(chrome))) {
    console.log('skip mermaid JS check (no Chrome at ' + chrome + ')');
    return;
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname).replace(/^\/bundant/, '');
    if (pathname.endsWith('/')) pathname += 'index.html';
    let file = join(distDir, pathname);
    if (!(await exists(file))) file = join(distDir, pathname, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    response.end(body);
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const page = 'http://127.0.0.1:' + port + '/bundant/docs/tutorial/01-quickstart/';

  const dom = await new Promise((done) => {
    const child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--virtual-time-budget=10000',
      '--dump-dom',
      page,
    ]);
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', () => done(''));
    child.on('close', () => done(stdout));
    setTimeout(() => child.kill(), 20000).unref();
  });

  server.close();

  if (!/aria-roledescription="[^"]*flowchart|id="mermaid-[0-9]/.test(dom)) {
    failures.push('mermaid did not render to SVG with JS on (only the <pre> source is present)');
    return;
  }
  console.log('ok   mermaid renders to SVG with JS on');
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
  if (reference.length !== 10) failures.push('expected 10 reference pages, found ' + reference.length);

  if (!reference.some((doc) => doc.slug === 'troubleshooting')) {
    failures.push('the Reference group has no troubleshooting page');
  }
  if (!(await exists(join(repoRoot, 'docs', 'reference', 'troubleshooting.md')))) {
    failures.push('docs/reference/troubleshooting.md is missing');
  }
  if (landing && !landing.includes('Troubleshooting')) {
    failures.push('the docs index does not link Troubleshooting');
  }

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
      const chapter = chapterOf(doc.source);
      if (!doc.source.endsWith('.mdx')) problems.push('tutorial source is not .mdx');
      if (!/\`\`\`sh\n/.test(source)) problems.push('no fenced sh command block');
      if (!/\`\`\`mermaid\n/.test(source)) problems.push('no fenced mermaid diagram');
      if (!/You should see/.test(source)) problems.push('no "You should see" block');

      // One straight instruction: no tips, cautions, badges or failure catalogue.
      if (/<Aside\b/.test(source)) problems.push('has an <Aside>');
      if (/<Badge\b/.test(source)) problems.push('has a <Badge>');
      if (/Did it fail\?/.test(source)) problems.push('has a "Did it fail?" section');

      // The components wrap content; they must never be the only copy of it.
      if (!/<Steps>/.test(source)) problems.push('no <Steps> wrapper');
      if (chapter === '01-quickstart' && (!/<Tabs>/.test(source) || !/<TabItem\b/.test(source))) {
        problems.push('no install <Tabs>');
      }
      if (chapter !== '01-quickstart' && /<Tabs>/.test(source)) {
        problems.push('has <Tabs> outside the install step');
      }
      if (!/<CardGrid>/.test(source) || !/<LinkCard\b/.test(source)) problems.push('no LinkCard footer');
      if (NEEDS_TREE.has(chapter) && !/<FileTree>/.test(source)) problems.push('no <FileTree>');

      if (page) {
        if (!page.includes('class="sl-steps"')) problems.push('built page has no sl-steps');
        if (chapter === '01-quickstart' && !page.includes('role="tab"')) problems.push('built page has no tab list');
        if (page.includes('class="starlight-aside')) problems.push('built page has an aside');
        if (NEEDS_TREE.has(chapter) && !page.includes('<starlight-file-tree')) problems.push('built page has no file tree');
        if (!page.includes('class="sl-link-card')) problems.push('built page has no link card');
        // JS off: the diagram source must still be in the HTML.
        if (!page.includes('<pre class="mermaid"')) problems.push('built page lost its mermaid source');
      }
    } else {
      if (!doc.source.endsWith('.md')) problems.push('reference source is not plain .md');
      if (/<Aside\b|<Steps>|<Tabs>/.test(source)) problems.push('reference page uses MDX components');
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
  const sourceFiles = (await readdir(join(repoRoot, "docs", "tutorial"))).filter(
    (name) => name.endsWith('.md') || name.endsWith('.mdx'),
  );
  for (const name of sourceFiles) {
    const body = await readFile(join(repoRoot, "docs", "tutorial", name), "utf8");
    const ip = body.match(/\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/);
    if (ip) failures.push(`${name} leaks a private address (${ip[0]})`);
    if (/\/Users\/[a-z]/.test(body)) failures.push(`${name} leaks a home directory path`);
  }

  await checkMermaidRuntime();

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
