#!/usr/bin/env node
// Records every line that carries the fork's brand in the files the rebrand
// commit touched. The fork guard test fails when a sync drops one of these
// lines, so a conflict that took upstream's side can't undo the rebrand.
// New upstream text with the old name is allowed, because it isn't listed.
//
// Run it again after you rebrand more text on purpose:
//   node scripts/fork/gen-rebrand-manifest.mjs [--ref <git-ref>]
// With --ref, the lines come from that commit instead of the work tree.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REBRAND_COMMIT = '2ff11f45';
export const BRAND = /FreeTier Router|freetier-router|FreeTierRouter|viraj-s15/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'scripts', 'fork', 'rebrand-manifest.json');

const refIndex = process.argv.indexOf('--ref');
const ref = refIndex > 0 ? process.argv[refIndex + 1] : undefined;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function readAt(file) {
  if (!ref) return existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined;
  try { return git('show', `${ref}:${file}`); } catch { return undefined; }
}

const files = git('show', '--name-only', '--format=', REBRAND_COMMIT).split('\n').filter(Boolean);

const manifest = {};
for (const file of files.sort()) {
  const text = readAt(file);
  if (text === undefined) continue;
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => BRAND.test(l));
  if (lines.length > 0) manifest[file] = [...new Set(lines)];
}

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
const total = Object.values(manifest).reduce((n, l) => n + l.length, 0);
console.log(`Wrote ${total} branded lines from ${Object.keys(manifest).length} files to ${out}`);
