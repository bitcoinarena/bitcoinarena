#!/usr/bin/env node
// HOW MUCH OF EACH PAGE'S OWN SCRIPT THE TESTS RAN (kanban #150). Coverage counts src/ only; the scripts that run in a
// player's browser - the WebGL page's index.html, the seats' rounds.html and replay.html - live inline in HTML. Tests run
// slices of them under the page's own name (test/page-script.js), which writes beside V8's raw coverage which characters
// of the page each lift held. This reads both and prints, per page, the lines inside its <script> blocks that hold code
// (markup, blank and comment-only lines are not counted), how many of them ran, and the named functions that ran.
//
//   NODE_V8_COVERAGE=<dir> node --test ...      then      node packages/blwp-client/tools/page-coverage.mjs <dir>
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2];
if (!dir) { console.error('usage: node page-coverage.mjs <NODE_V8_COVERAGE dir>'); process.exit(2); }
const PAGES = [
  ['index.html', new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url)],
  ['rounds.html', new URL('../../blwp-node/pages/rounds.html', import.meta.url)],
  ['replay.html', new URL('../../blwp-node/pages/replay.html', import.meta.url)],
];

// every lift's slices, by its own URL; every V8 entry of a lift
const slices = new Map();
const entries = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  if (f.startsWith('blwp-page-slices-')) slices.set(j.url, j.pieces);
  else if (Array.isArray(j.result)) for (const s of j.result) if (String(s.url).includes('?slice=')) entries.push(s);
}

const rows = [];
for (const [name, url] of PAGES) {
  const text = readFileSync(fileURLToPath(url), 'utf8');
  // the inline <script> blocks (not <script src>), as character ranges
  const blocks = [];
  for (const m of text.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc\s*=/.test(m[1] || '')) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    blocks.push([start, start + m[2].length]);
  }
  const inBlock = (o) => blocks.some(([a, b]) => o >= a && o < b);
  // line starts, and which lines inside the blocks hold code (not blank, not a comment-only line)
  const lineStart = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStart.push(i + 1);
  const lineOf = (o) => { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= o) lo = mid; else hi = mid - 1; } return lo; };
  const codeLines = new Set();
  for (let l = 0; l < lineStart.length; l++) {
    const a = lineStart[l], b = l + 1 < lineStart.length ? lineStart[l + 1] - 1 : text.length;
    const raw = text.slice(a, b), t = raw.trim();
    if (!t || !inBlock(a + raw.length - raw.trimStart().length)) continue;
    if (/^(\/\/|\/\*|\*|\*\/)/.test(t)) continue;
    codeLines.add(l);
  }
  const ran = new Set();
  const fns = new Map();                              // named function -> how often it ran, over every lift
  let lifts = 0;
  for (const e of entries) {
    if (e.url.slice(0, e.url.indexOf('?slice=')) !== url.href) continue;
    const pieces = slices.get(e.url);
    if (!pieces) continue;
    lifts++;
    const live = (o) => pieces.some(([a, b]) => o >= a && o < b);
    // V8's counts: each offset takes the count of the last range listed that holds it (the innermost)
    const lo = Math.min(...pieces.map((p) => p[0])), hi = Math.max(...pieces.map((p) => p[1]));
    const count = new Int32Array(hi - lo).fill(-1);
    for (const fn of e.functions) {
      for (const r of fn.ranges) {
        const a = Math.max(lo, r.startOffset), b = Math.min(hi, r.endOffset);
        for (let o = a; o < b; o++) count[o - lo] = r.count;
      }
      const top = fn.ranges[0];
      if (fn.functionName && live(top.startOffset) && inBlock(top.startOffset)) fns.set(fn.functionName, (fns.get(fn.functionName) || 0) + top.count);
    }
    for (let o = lo; o < hi; o++) {
      if (!live(o) || count[o - lo] <= 0 || /\s/.test(text[o]) || !inBlock(o)) continue;
      const l = lineOf(o);
      if (codeLines.has(l)) ran.add(l);
    }
  }
  const ranFns = [...fns].filter(([, c]) => c > 0).map(([n]) => n).sort();
  const never = [...fns].filter(([, c]) => c === 0).map(([n]) => n).sort();
  rows.push({ name, lines: codeLines.size, ran: ran.size, pct: codeLines.size ? (100 * ran.size / codeLines.size) : 0, lifts, functions: ranFns, never });
}
console.log('| page | script code lines | ran | % | lifts | named functions that ran |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.lines} | ${r.ran} | ${r.pct.toFixed(1)} | ${r.lifts} | ${r.functions.length} |`);
console.log();
for (const r of rows) console.log(`${r.name} - ran: ${r.functions.join(', ') || '(none)'}\n${r.name} - lifted, never ran: ${r.never.join(', ') || '(none)'}`);
console.log(JSON.stringify(rows.map(({ name, lines, ran, pct }) => ({ name, lines, ran, pct: +pct.toFixed(1) }))));
