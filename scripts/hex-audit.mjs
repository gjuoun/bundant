#!/usr/bin/env node
/**
 * hex-audit.mjs — no colour may exist in the site that is not in the palette.
 *
 *   node scripts/hex-audit.mjs [repo-root]
 *
 * The palette is vendored at site/src/data/bigface.json (colours + ANSI). Anything
 * else - a hand-mixed tint, a framework default, a "close enough" grey - is a
 * defect: it means the page is no longer Bigface. Exits 1 listing every offender.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.env.BUNDANT_REPO ?? '.');
const palettePath = join(root, 'site/src/data/bigface.json');

const palette = JSON.parse(readFileSync(palettePath, 'utf8'));
const allowed = new Set();
for (const group of ['colors', 'ansi']) {
  for (const entry of Object.values(palette[group] ?? {})) {
    if (typeof entry === 'object' && typeof entry.hex === 'string') allowed.add(entry.hex.toLowerCase());
  }
}
if (allowed.size === 0) {
  console.error('hex-audit: no colours found in ' + palettePath);
  process.exit(1);
}

const roots = ['site/src', 'docs'];
const exts = new Set(['.css', '.ts', '.tsx', '.astro', '.mdx', '.json', '.mjs']);
const offenders = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (exts.has(path.slice(path.lastIndexOf('.')))) scan(path);
  }
}

function scan(path) {
  if (path.endsWith('bigface.json')) return; // the palette itself
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = '#' + match[1].toLowerCase();
    if (!allowed.has(hex)) {
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push({ file: relative(root, path), line, hex });
    }
  }
}

for (const dir of roots) {
  try {
    walk(join(root, dir));
  } catch {
    // a missing root is not an error (docs may not exist in a stripped checkout)
  }
}

if (offenders.length) {
  const byHex = new Map();
  for (const o of offenders) {
    if (!byHex.has(o.hex)) byHex.set(o.hex, []);
    byHex.get(o.hex).push(`${o.file}:${o.line}`);
  }
  for (const [hex, where] of byHex) {
    console.error(`FAIL ${hex} is not in the palette — ${where.slice(0, 4).join(', ')}${where.length > 4 ? ` (+${where.length - 4})` : ''}`);
  }
  console.error(`\n${byHex.size} off-palette colour(s), ${offenders.length} occurrence(s)`);
  process.exit(1);
}

console.log(`HEX OK — every colour in site/src and docs is one of the ${allowed.size} palette values`);
