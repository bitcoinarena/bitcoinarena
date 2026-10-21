// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS' CLIENT, VERSION 4 (kanban #564 and #523): written from version 3's client (client/index.html) in four steps -
//   1. the table drawn by React: draw(state) hands each new state to window.RpsView (packages/arena-web/src/rps, built to dist/rps.js
//      and inlined here, so the file still fetches no code its hash does not pin); tap() no longer marks buttons itself;
//   2. the page's names, not the old ones: window.parent.ARENA_* for BLWP_* (the page answers both);
//   3. no names, ticket numbers or old project names in the file: its comments go (the two SEATING markers stay, the seating test
//      reads the client between them) - the reasons live in version 3's file and in this tool;
//   4. checked: the file parses, the round logic (seatAt, paint, the taps) is version 3's line for line, nothing of the above is left.
//
//   node packages/rock-paper-scissors/tools/build-view.mjs && node packages/rock-paper-scissors/tools/build-client-v4.mjs
// Writes client/index-v4.html; a new hash, so the manifest is signed next (tools/sign-manifest-v4.mjs).
import { readFileSync, writeFileSync } from 'node:fs';

const V3 = new URL('../client/index.html', import.meta.url);
const OUT = new URL('../client/index-v4.html', import.meta.url);
const BUNDLE = new URL('../dist/rps-view.js', import.meta.url);

/** Replace exactly one occurrence, or stop: a v3 that changed under this tool is not rewritten blind. */
function once(text, from, to) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return text.replace(from, () => to);
}
/** Between two markers (the first included, the second not). */
function between(text, from, to, replacement) {
  const a = text.indexOf(from); const b = text.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`no ${JSON.stringify(from.slice(0, 40))} ... ${JSON.stringify(to.slice(0, 40))}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

/** A line without its trailing // comment - only where the code before it closes every string it opens (a URL keeps its //). */
export function trailing(line) {
  for (let at = line.indexOf(' //'); at >= 0; at = line.indexOf(' //', at + 1)) {
    const code = line.slice(0, at);
    if (!/[;{},)]\s*$/.test(code)) continue;
    if ([...code.matchAll(/'/g)].length % 2 || [...code.matchAll(/"/g)].length % 2 || [...code.matchAll(/`/g)].length % 2) continue;
    return code.replace(/\s+$/, '');
  }
  return line;
}

export function buildV4(v3, bundle) {
  let s = v3;
  // 1. THE TABLE IN REACT
  s = between(s, '    const draw = (s) => {', '    // THE STAGE, once Three.js', `    const table = window.RpsView.mount($('view'), { onTap: (id, i, closeMs) => tap(id, i, closeMs) });
    const draw = (s) => {
      live = null;
      due = null;
      const kind = $('kind');
      kind.hidden = s.phase === 'none';
      kind.className = 'chip ' + (s.free ? 'free' : 'paid');
      kind.textContent = s.free ? 'FREE' : 'PAID';
      if (stage) {
        if (s.phase !== 'none' && (s.phase !== 'pick' || pickedFor !== s.id)) { stage.preview(null); stage.iconChosen(null); pickedFor = s.id; }
        stage.show(s);
      }
      table.draw(s, { stage, stageFailed });
    };
`);
  s = once(s, '    const tap = async (id, i, closeMs, g, b) => {', '    const tap = async (id, i, closeMs) => {');
  s = once(s, "      for (const x of g.querySelectorAll('button')) x.disabled = true;\n", '');
  s = once(s, "      b.classList.add('chosen');\n", '');
  // 2. THE PAGE'S NAMES
  s = s.replace(/window\.parent\.BLWP_/g, 'window.parent.ARENA_');
  // 3. NO COMMENTS (but the seating markers): whole comment lines, the head's HTML comment, and a few trailing ones
  s = s.replace(/<!--[\s\S]*?-->\n?/g, '');
  s = s.split('\n').map((l) => { const m = l.match(/^(\s*)\/\/ SEATING (BEGIN|END)\b/); return m ? `${m[1]}// SEATING ${m[2]}` : l; })
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') && !/^\/\/ SEATING (BEGIN|END)$/.test(t)); }).join('\n');
  s = s.split('\n').map(trailing).join('\n').replace(/\/\* [^*]*\*\//g, '');
  // the inlined table, before the round's script (the second <script> of the file)
  const at = s.indexOf('<script>', s.indexOf('</script>'));
  s = s.slice(0, at) + '<script>\n' + bundle.trim() + '\n</script>\n' + s.slice(at);
  return s;
}

// a ticket as the comments named them: kanban #291, (#291, #292 ... - not a colour such as #000
export const FORBIDDEN = /kanban|the owner|BLWP|blwp|(?:\(|, |\bticket )#\d{3}\b/i;

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = buildV4(readFileSync(V3, 'utf8'), readFileSync(BUNDLE, 'utf8'));
  const left = out.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => FORBIDDEN.test(l));
  if (left.length) throw new Error(`still in the file: ${left.slice(0, 5).map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`).join(' | ')}`);
  writeFileSync(OUT, out);
  console.log(`client/index-v4.html: ${out.length} bytes`);
}
