#!/usr/bin/env node
/**
 * brand-check.mjs — the mark must ship, and the pages must declare it.
 *
 *   node scripts/brand-check.mjs [repo-root]
 *
 * A favicon that exists in the repo but not in dist/, or an og:image that no page
 * declares, is a brand that silently disappears on the next refactor. This fails on
 * either.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.env.BUNDANT_REPO ?? '.');
const dist = join(root, 'site/dist');
const pub = join(root, 'site/public');

const failures = [];
const ok = (label, detail = '') => console.log(`  ok   ${label.padEnd(38)} ${detail}`);
const fail = (label, detail = '') => {
  failures.push(label);
  console.log(`  FAIL ${label.padEnd(38)} ${detail}`);
};

// 1. Source assets copied into public/.
for (const file of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'img/og.png', 'img/content-bear.svg']) {
  existsSync(join(pub, file)) ? ok(`public/${file}`) : fail(`public/${file}`, 'missing');
}

// 2. Same assets land in dist/ when a build exists.
if (existsSync(dist)) {
  for (const file of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'img/og.png']) {
    existsSync(join(dist, file)) ? ok(`dist/${file}`) : fail(`dist/${file}`, 'missing');
  }
}

// 3. The OG card is really 1200x630 (PNG IHDR, bytes 16..24).
const ogPath = join(pub, 'img/og.png');
if (existsSync(ogPath)) {
  const buf = readFileSync(ogPath);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  width === 1200 && height === 630
    ? ok('og card size', `${width}x${height}`)
    : fail('og card size', `${width}x${height}, expected 1200x630`);
  statSync(ogPath).size > 10_000 ? ok('og card bytes', String(statSync(ogPath).size)) : fail('og card bytes', 'suspiciously small');
}

// 4. The homepage declares the icons and the social card.
const home = join(dist, 'index.html');
if (existsSync(home)) {
  const html = readFileSync(home, 'utf8');
  for (const [label, needle] of [
    ['favicon link', 'rel="icon"'],
    ['apple touch icon', 'rel="apple-touch-icon"'],
    ['og:image', 'property="og:image"'],
    ['twitter card', 'name="twitter:card"'],
    ['header mark', 'img/content-bear.png'],
  ]) {
    html.includes(needle) ? ok(label) : fail(label, `no ${needle} in index.html`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} brand failure(s)`);
  process.exit(1);
}
console.log('\nBRAND OK');
