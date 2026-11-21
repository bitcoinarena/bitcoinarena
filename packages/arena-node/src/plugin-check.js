// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLUGIN STORE'S CHECKS, IN THE PAGE AND ON THE SEAT ALIKE (2026-10-10: "Everything with
// loading plugins must happen in the browser including updating games and networks like an AppStore. Malicious code checks
// are very important"). Isomorphic - no Node API: the owner page bundles it and shows its report before Install; the seat
// runs the same checks again, and its own sandboxed trial run (plugin-trial.js), before anything is written or activated.
//   - the manifest stands (its developer's signature over its body, as every seat checks a game);
//   - the donation set is the one the manifest names;
//   - every core and client is byte for byte the file the manifest names by sha-256;
//   - every core passes the scan (below);
//   - an update is the same developer's next version of the game it replaces.
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { decodeManifest, gameIdOf, manifestStands, manifestBodyId } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { gameInfoStands } from '../../arena-protocol/src/game-info.js';

export const fromBase64 = (s) => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(String(s || ''), 'base64'))
  : Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0)));
const utf8 = (b) => new TextDecoder().decode(b);
const shaHex = (b) => toHex(sha256(b));

// A TREE CORE IN A PACKAGE (kanban #3085): a core named by its tree hash (Next Block: frozen/<hash>/, 25-26 .js files, ~450 kB) is carried as
// { hash, name, configs, entry, files: [{ path, body }] } beside the one-file form { ..., source }. Its limits, and its hash by core-hash.js's
// exact rule recomputed from the bytes in memory (isomorphic: the owner page runs this too).
export const TREE_LIMITS = Object.freeze({ files: 256, pathBytes: 256, fileBytes: 2 * 1024 * 1024, treeBytes: 8 * 1024 * 1024 });
const TREE_PATH = /^[A-Za-z0-9._/-]+$/;
/** The one file a tree core runs from (kanban #3097, #3099): Next Block's frozen/<hash>/adapter.js; fixed, so the tree hash signs it. */
export const TREE_ENTRY = 'adapter.js';
/** Why a tree file's path is refused, or null: relative with "/", only [A-Za-z0-9._/-], ends in .js, no "", "." or ".." segment. */
export function treePathRefusal(path) {
  const p = String(path);
  if (!p || new TextEncoder().encode(p).length > TREE_LIMITS.pathBytes) return `a path of 1 to ${TREE_LIMITS.pathBytes} bytes`;
  if (!TREE_PATH.test(p)) return 'only letters, digits and . _ / - in a path';
  if (!p.endsWith('.js')) return 'a tree holds .js files only';
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'no empty, "." or ".." segment, no leading "/"';
  return null;
}
const NUL_TREE_TAG = new TextEncoder().encode('\0arena-core-tree-framed\0');
/** A tree's hash from its files in memory ([{ path, bytes }]), by core-hash.js coreTree's rule: sorted by path, `path \0 bytes \0` each, or the
 *  length-framed form after NUL_TREE_TAG when a path or a file holds a NUL (kanban #1625). */
export function treeHashHex(files) {
  const enc = new TextEncoder();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const nul = sorted.some((f) => f.path.includes('\0') || f.bytes.includes(0));
  const parts = [];
  if (nul) {
    parts.push(NUL_TREE_TAG);
    for (const f of sorted) {
      const r = enc.encode(f.path), l32 = new Uint8Array(4), l64 = new Uint8Array(8);
      new DataView(l32.buffer).setUint32(0, r.length); new DataView(l64.buffer).setBigUint64(0, BigInt(f.bytes.length));
      parts.push(l32, r, l64, f.bytes);
    }
  } else for (const f of sorted) parts.push(enc.encode(f.path), new Uint8Array([0]), f.bytes, new Uint8Array([0]));
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let at = 0;
  for (const x of parts) { all.set(x, at); at += x.length; }
  return shaHex(all);
}
/** Where a relative import from `from` lands inside the tree, or null when it leaves the tree or is not relative. */
export function treeResolve(from, spec) {
  if (!/^\.{1,2}\//.test(spec)) return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) { if (seg === '.' || seg === '') continue; if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg); }
  return parts.join('/');
}
/**
 * A TREE'S SCAN (kanban #3085, measured on Next Block v8 7d197042: 21 "loads another module" - its files import one another - and 8 more
 * findings, every one on a comment line: "window's", "C# process", "a global"). scanSource per file, with two exceptions and no other:
 * - "loads another module" on a static import/export ... from '<relative path>' that resolves to another file of the same tree (an import()
 *   or require(), a bare or absolute specifier, or a path leaving the tree is still refused);
 * - the files are scanned with their comments blanked (blankComments): a word in a comment is not code. The sandbox still runs the tree
 *   with no global, no import beyond its files and no process.
 * Answers the findings left: [{ file, rule, line }].
 */
/**
 * THE SOURCE WITH ITS COMMENTS BLANKED (kanban #3085): every comment character turned to a space, newlines kept (line numbers stay), strings,
 * template literals (with their ${...} code, nested) and regex literals left as they are.
 * ONLY WHAT IS SURELY A COMMENT IS BLANKED (kanban #3100, #1489 r1120-refute-5-2): a slash after `)` was guessed a division, so in
 * `if (1) /[/*]/.test('')` the regex's "/*" was read as a comment start and every line up to a later "*" "/" was blanked - code the one-file
 * scan refuses (globalThis, Reflect) passed the tree scan. The lexer now follows every reading it cannot rule out at once: a slash is a regex
 * or a division by the token before it, exactly where the grammar decides (after `)`: the regex reading only when the `(` followed
 * if / while / for / with), and where it cannot tell (after `}`, `++` / `--`, `of`, a `)` of `await (`), both readings are lexed side by side.
 * A character is blanked only when every live reading has it inside a comment; a line comment ends at every JS line terminator (\n \r
 * U+2028 U+2029), a string only at \n \r. More readings than STATES_MOST: nothing further in the file is blanked (more findings, never fewer).
 */
const STATES_MOST = 64, DEPTH_KEPT = 64;   // readings followed at once; paren kinds and template nestings kept (deeper parens: either reading)
// BOUNDED WORK IN ALL (kanban #3135, #1489 r1120-refute-5-s4): STATES_MOST bounds the readings per character, not the characters they live for.
// 60 `(` then 22 lines of `}/(1/` kept ~60 readings live (none merging, never crossing 64) for a whole 2 MiB file: each character lexed and
// keyed ~60 times, ~110x the plain cost (34 s for three such files, synchronous on the seat before the trial and its deadline). Every reading
// beyond the first on every character is now paid from a budget - per file, and shared by the whole tree when scanTree passes one; once it
// runs out nothing further is blanked (the raw text is scanned: more findings, never fewer). An honest file forks rarely (a slash after
// `}`, `++`, `of`) and its readings merge again within a line or two, far below it.
export const LEX_EXTRA_MOST = 1 << 20;   // extra reading-steps one file may take
export const LEX_TREE_EXTRA_MOST = 1 << 21;   // extra reading-steps a whole tree may take
const STR_END = '\u0001', RE_END = '\u0002';   // not word chars: a string's or a regex's end as `last`
const LINE_END = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
const WORD = /[A-Za-z0-9_$\u0080-\uffff]/;
const SPACE = /\s/;
const KW_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'default', 'extends']);
const KW_CTRL = new Set(['if', 'while', 'for', 'with']);
export function blankComments(src, budget = null) {   // budget: { left } shared across a tree's files (kanban #3135)
  const n = src.length, out = src.split('');
  let fileLeft = LEX_EXTRA_MOST;
  // a reading: m mode (c code, l line comment, bs/b/be block comment start/inside/end, s string, t template text, tb the "{" of "${", r regex),
  // q its quote, e an escape pending, k in a regex class, ts template nesting (open braces in each ${...}), ps paren kinds ("r" regex after,
  // "d" division, "f" either), last the last significant char (STR_END, RE_END, "`" template end, ")" with pk its paren's kind),
  // w the word that char ends (identifier or number), bw the char before that word, pp the char before last
  // A HASHBANG IS A LINE COMMENT (kanban #3126, #1489 r1120-refute-5-s3): a module may start with `#!...` (after a BOM, which the loader
  // strips), a comment to the end of that line. Lexed as code, `#!/*` opened a block comment that blanked every line up to a later `*/`
  // (on a `//*/` line, a line comment to JS) - code the one-file scan refuses (globalThis, Reflect) passed the tree scan and ran.
  const hashbang = /^\uFEFF?#!/.test(src);
  let states = [{ m: hashbang ? 'l' : 'c', q: '', e: 0, k: 0, ts: [], ps: '', last: '', pk: '', w: '', bw: '', pp: '', inw: 0, nl: 0, pd: 0 }];
  const clone = (s) => ({ ...s, ts: [...s.ts] });
  const key = (s) => `${s.m}${s.q}${s.e}${s.k}|${s.ts.join(',')}|${s.pd}${s.ps}|${s.last}${s.pk}|${s.w}|${s.bw}${s.pp}${s.inw}${s.nl}`;
  // what a slash in code starts in this reading: 'r' regex, 'd' division, 'f' either
  const slashIs = (s) => {
    const l = s.last;
    if (!l) return 'r';
    // a word: a keyword that takes an expression -> regex; a property name or another word -> division, unless a line ended since (a
    // `break label` / `continue label` / `debugger` ended by ASI: the slash then starts a statement) - then both
    // (a word after '#' is a private name - `this.#in / 2` - a name like one after '.', never a keyword: kanban #3113, #1489 r1120-refute-5-s2)
    if (s.w && WORD.test(l)) { if (s.bw === '.' || s.bw === '#') return 'd'; if (s.w === 'of') return 'f'; return KW_REGEX.has(s.w) ? 'r' : s.nl ? 'f' : 'd'; }
    if (l === ')') return s.pk || 'd';
    if (l === ']' || l === STR_END || l === RE_END || l === '`' || l === '.') return 'd';
    if (l === '}') return 'f';
    if ((l === '+' || l === '-') && s.pp === l) return 'f';
    return 'r';
  };
  const sig = (s, c) => { s.pp = s.last; s.last = c; if (!WORD.test(c)) { s.w = ''; } s.inw = 0; s.pk = ''; s.nl = 0; };
  // an escape takes the next char, and a CR LF line continuation whole
  const esc = (s, c, d) => { s.e = c === '\r' && d === '\n' ? 1 : 0; };
  for (let i = 0; i < n; i++) {
    const c = src[i], d = src[i + 1];
    let allComment = true; const next = [];
    for (const s of states) {
      let comment = false;
      if (LINE_END(c) && s.m !== 's' && s.m !== 't' && s.m !== 'r') s.nl = 1;
      switch (s.m) {
        case 'l': if (LINE_END(c)) s.m = 'c'; else comment = true; break;
        case 'bs': comment = true; s.m = 'b'; break;
        case 'b': comment = true; if (c === '*' && d === '/') s.m = 'be'; break;
        case 'be': comment = true; s.m = 'c'; break;
        case 's':
          if (s.e) esc(s, c, d); else if (c === '\\') s.e = 1;
          else if (c === s.q) { s.m = 'c'; sig(s, STR_END); } else if (c === '\n' || c === '\r') s.m = 'c';
          break;
        case 't':
          if (s.e) esc(s, c, d); else if (c === '\\') s.e = 1;
          else if (c === '`') { s.m = 'c'; sig(s, '`'); } else if (c === '$' && d === '{') { s.m = 'tb'; s.ts.push(0); }
          break;
        case 'tb': s.m = 'c'; s.pp = s.last; s.last = '{'; s.w = ''; s.inw = 0; break;
        case 'r':
          if (s.e) esc(s, c, d); else if (c === '\\') s.e = 1;
          else if (c === '[') s.k = 1; else if (c === ']') s.k = 0;
          else if (c === '/' && !s.k) { s.m = 'c'; s.k = 0; sig(s, RE_END); } else if (LINE_END(c)) { s.m = 'c'; s.k = 0; }
          break;
        default: {   // code
          if (SPACE.test(c)) { s.inw = 0; break; }
          if (c === '/' && d === '/') { s.m = 'l'; comment = true; break; }
          if (c === '/' && d === '*') { s.m = 'bs'; comment = true; break; }
          if (c === '/') {
            const is = slashIs(s);
            if (is === 'f') { const r = clone(s); r.m = 'r'; r.e = 0; r.k = 0; r.nl = 0; next.push(r); sig(s, '/'); }
            else if (is === 'r') { s.m = 'r'; s.e = 0; s.k = 0; }
            else sig(s, '/');
            break;
          }
          if (c === '"' || c === "'") { s.m = 's'; s.q = c; s.e = 0; break; }
          if (c === '`') { s.m = 't'; s.e = 0; break; }
          if (c === '{') { if (s.ts.length) s.ts[s.ts.length - 1]++; sig(s, '{'); break; }
          if (c === '}') {
            if (s.ts.length && s.ts[s.ts.length - 1] === 0) { s.ts.pop(); s.m = 't'; s.e = 0; break; }
            if (s.ts.length) s.ts[s.ts.length - 1]--;
            sig(s, '}'); break;
          }
          if (c === '(') {
            const ctrl = s.w && WORD.test(s.last) && s.bw !== '.' && s.bw !== '#' ? (KW_CTRL.has(s.w) ? 'r' : s.w === 'await' ? 'f' : 'd') : 'd';
            s.pd++; s.ps = (s.ps + ctrl).slice(-DEPTH_KEPT); sig(s, '('); break;
          }
          if (c === ')') { const k = s.ps ? s.ps.slice(-1) : s.pd > 0 ? 'f' : 'd'; s.ps = s.ps.slice(0, -1); if (s.pd > 0) s.pd--; sig(s, ')'); s.pk = k; break; }
          if (WORD.test(c)) {
            if (s.inw && s.w) s.w = s.w.length < 12 ? s.w + c : '~long'; else { s.bw = s.last; s.w = c; }
            s.pp = s.last; s.last = c; s.inw = 1; s.pk = ''; s.nl = 0; break;
          }
          sig(s, c);
        }
      }
      if (!comment) allComment = false;
    }
    for (const r of next) { r.m === 'r' && (allComment = false); states.push(r); }
    if (allComment && c !== '\n') out[i] = ' ';
    // BOUNDED WORK PER CHARACTER: at most STATES_MOST readings, each keyed in O(DEPTH_KEPT); a deeper template nesting stops the blanking
    if (states.some((s) => s.ts.length > DEPTH_KEPT)) return out.slice(0, i + 1).join('') + src.slice(i + 1);
    if (states.length > 1) {
      fileLeft -= states.length - 1; if (budget) budget.left -= states.length - 1;
      if (fileLeft < 0 || (budget && budget.left < 0)) return out.slice(0, i + 1).join('') + src.slice(i + 1);
      const seen = new Set(); states = states.filter((s) => { const k = key(s); if (seen.has(k)) return false; seen.add(k); return true; });
      if (states.length > STATES_MOST) return out.slice(0, i + 1).join('') + src.slice(i + 1);
    }
  }
  return out.join('');
}

// EVERY MODULE LOAD IN A TREE FILE IS EXEMPTED ON ITS OWN (kanban #3112, #1489 r1120-refute-5-s2): scanSource names only the first hit of a
// rule, so one allowed `import { h } from a helper file` on line 1 hid an `await import('node:fs')`, a `require(...)` or an `import 'node:fs'`
// further down from the tree scan. moduleLoadLines lists every line a load starts on (each rule pattern's hit and each `import ... from`
// line, all in one pass each); a line is let through only when its whole statement is a static import from a file of the same tree.
const MODULE_RULE = 'loads another module';
function moduleLoadLines(text) {
  const t = String(text), starts = [0];
  for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (index) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; } return lo + 1; };
  const out = new Set();
  const re = new RegExp(SCAN_RULES.find(([r]) => r === MODULE_RULE)[1].source, 'gm');
  for (let m; (m = re.exec(t));) { out.add(lineOf(m.index + Math.max(0, m[0].search(/\S/)))); if (m[0].length === 0) re.lastIndex++; }
  for (const at of importFromAt(t, true)) out.add(lineOf(at));
  return [...out].sort((a, b) => a - b);
}
export function scanTree(files) {
  const paths = new Set(files.map((f) => f.path)), left = [], budget = { left: LEX_TREE_EXTRA_MOST };   // kanban #3135: one lexer budget per tree
  for (const f of files) {
    const src = blankComments(utf8(f.bytes), budget), lines = src.split('\n');
    // a line's statement is a static import/export ... from '<path>' landing on another tree file
    // AN IMPORT ENDS AT ITS SPECIFIER, NOT AT A ';' (kanban #3137, #1489 r1120-refute-5-s4): the statement was read up to the first line
    // holding a ';', so an honest `import { DRAW } from the lib draw file` written without semicolons ran on into the code below, failed the
    // anchored pattern and was refused. It now ends at its closing specifier string (no ; ( ) or quote before it, so no import() or require()
    // inside), and only whitespace or one ';' may follow on that line; the lines below are scanned on their own.
    const inTree = (line) => {
      const stmt = lines.slice(line - 1, line + 40).join('\n');
      const m = /^\s*(?:import|export)\b[^;()'"`]*?\bfrom\s*(['"])([^'"\n]+)\1([^\n]*)/.exec(stmt);
      if (!m || !/^\s*;?\s*$/.test(m[3])) return false;
      const to = treeResolve(f.path, m[2]); return !!(to && paths.has(to));
    };
    for (const x of scanSource(src)) {
      if (x.rule !== MODULE_RULE) { left.push({ file: f.path, ...x }); continue; }
      const line = moduleLoadLines(src).find((l) => !inTree(l));
      if (line !== undefined) left.push({ file: f.path, rule: MODULE_RULE, line, text: (lines[line - 1] || '').trim().slice(0, 120) });
    }
  }
  return left;
}

/** A tree core entry's files decoded and checked against TREE_LIMITS and the path rule: { ok, files } or { ok: false, why }. */
export function treeFilesOf(c) {
  if (!Array.isArray(c.files) || !c.files.length || c.files.length > TREE_LIMITS.files) return { ok: false, why: `a tree of 1 to ${TREE_LIMITS.files} files` };
  const seen = new Set(), folded = new Map(), dirs = new Map(), files = []; let total = 0;
  for (const f of c.files) {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string' || typeof f.body !== 'string') return { ok: false, why: 'each tree file is { path, body }' };
    const why = treePathRefusal(f.path); if (why) return { ok: false, why: `${f.path.slice(0, 64)}: ${why}` };
    if (seen.has(f.path)) return { ok: false, why: `${f.path} is in the tree twice` };
    // ONE NAME, ONE KIND, ON EVERY FILE SYSTEM (kanban #3127, #1489 r1120-refute-5-s3): x.js and x.js/y.js (a file and a directory of one
    // name), or X.js and x.js (one file on a case-insensitive disk), passed the checks and the trial (files in memory), then installPackage
    // threw EEXIST / EISDIR out of adoptPackage. Refused here, on the path folded to lower case and on every directory it lies in.
    const low = f.path.toLowerCase();
    if (folded.has(low)) return { ok: false, why: `${f.path} and ${folded.get(low)} are one file on a case-insensitive disk` };
    // ONE DIRECTORY, ONE SPELLING (kanban #3136, #1489 r1120-refute-5-s4): lib/a.js and LIB/b.js were two directories here and one on a
    // case-insensitive disk (APFS, NTFS): installed there, coreTree read lib/b.js and the verified game did not load ("changed on disk") on
    // Mac and Windows seats while Linux seats hosted it. Every directory a path lies in must be spelled as the first path that named it.
    // NOR A NAME WINDOWS CHANGES: a segment ending in "." (Windows drops it: a./x.js lands in a/) or a reserved device name (con, prn, aux,
    // nul, com1-9, lpt1-9, with or without an extension) is refused - the installed tree would not be the tree that was hashed.
    const segs = low.split('/'), exact = f.path.split('/');
    for (const seg of segs) {
      if (seg.endsWith('.')) return { ok: false, why: `${f.path}: a name ending in "." is another name on Windows` };
      if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(seg)) return { ok: false, why: `${f.path}: ${seg} is a reserved device name on Windows` };
    }
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/'), spelled = exact.slice(0, i).join('/');
      if (folded.has(d)) return { ok: false, why: `${folded.get(d)} is a file and a directory of ${f.path}` };
      const had = dirs.get(d);
      if (had !== undefined && had.spelled !== spelled) return { ok: false, why: `${spelled}/ and ${had.spelled}/ are one directory on a case-insensitive disk (${f.path}, ${had.path})` };
      if (had === undefined) dirs.set(d, { spelled, path: f.path });
    }
    if (dirs.has(low)) return { ok: false, why: `${f.path} is a file and a directory of ${dirs.get(low).path}` };
    folded.set(low, f.path);
    seen.add(f.path);
    const bytes = fromBase64(f.body);
    if (bytes.length > TREE_LIMITS.fileBytes) return { ok: false, why: `${f.path} is more than ${TREE_LIMITS.fileBytes} bytes` };
    total += bytes.length; if (total > TREE_LIMITS.treeBytes) return { ok: false, why: `the tree is more than ${TREE_LIMITS.treeBytes} bytes` };
    files.push({ path: f.path, bytes });
  }
  if (typeof c.entry !== 'string' || !seen.has(c.entry)) return { ok: false, why: 'its entry is not one of its files' };
  // ITS ENTRY IS SIGNED BECAUSE IT IS FIXED (kanban #3097, #3099, #1489 r1120-refute-5): the manifest names only the tree hash, which covers
  // each file's path and bytes but not which file is the entry - a relaying seat could hand the genuine signed tree with a helper file as
  // its entry (the trial refused, and autoUpdate kept that verdict on the game id 24 h) or another DECIDE file of the tree (other code run
  // under the same game id). A tree core runs from TREE_ENTRY, a path the tree hash covers, and nothing else.
  if (c.entry !== TREE_ENTRY) return { ok: false, why: `a tree core runs from its ${TREE_ENTRY}, not from ${String(c.entry).slice(0, 64)}` };
  return { ok: true, files };
}

// THE SCAN: what a decide adapter may not do, by pattern on its source (comments included - an honest adapter has no reason to
// spell any of these). Each finding names the rule and the line.
export const SCAN_RULES = Object.freeze([
  // kanban #2751: the `import ... from` form is found by importFromAt below, linearly - as /^\s*import\s[^;]*\bfrom\b/m every line starting
  // `import ` with no ';' after it ran to the end of the text and back (O(lines x length): 10 s for a 352 kB core, hours for a 24 MB one)
  ['loads another module', /\bimport\s*\(|\brequire\s*\(|^\s*import\s+['"]/m],
  ['evaluates code', /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/],
  ['reaches the network', /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bhttp[s]?\b\s*\.\s*request|\bnet\s*\.\s*connect|\bnavigator\b/],
  ['reaches the file system or the process', /\bprocess\b|\bchild_process\b|\bfs\s*\.|\bDeno\b|\bBun\b/],
  ['reaches the global scope', /\bglobalThis\b|\bwindow\b|\bself\b\s*\.|\bglobal\b\s*\.|\bdocument\b/],
  ['runs later or forever', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b|\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/],
  ['reaches its own constructor', /\bconstructor\s*\.\s*constructor\b|__proto__|\bprototype\s*\[|\bReflect\b|\bProxy\b/],
  ['hides its text', /\\u\{?[0-9a-fA-F]{2,}|\\x[0-9a-fA-F]{2}|\batob\s*\(|\bString\s*\.\s*fromCharCode\b/],
]);
/**
 * WHERE A LINE `import <whitespace>...` IS FOLLOWED BY A WORD `from` BEFORE ANY ';' (the old /^\s*import\s[^;]*\bfrom\b/m), or -1 - in one pass
 * (kanban #2751): the next ';' and the next whole word `from` are known for every position from one scan back to front, so each import line
 * costs one look-up, not a scan to the end of the text.
 */
export function importFromAt(text, all = false) {   // all: every such line's index, in order (kanban #3112)
  const t = String(text), n = t.length;
  const word = (c) => /[A-Za-z0-9_$]/.test(c);
  const nextSemi = new Int32Array(n + 1), nextFrom = new Int32Array(n + 1);
  nextSemi[n] = -1; nextFrom[n] = -1;
  for (let i = n - 1; i >= 0; i--) {
    nextSemi[i] = t[i] === ';' ? i : nextSemi[i + 1];
    nextFrom[i] = t.startsWith('from', i) && (i === 0 || !word(t[i - 1])) && (i + 4 >= n || !word(t[i + 4])) ? i : nextFrom[i + 1];
  }
  const found = [];
  for (let at = 0; at < n;) {
    const end = t.indexOf('\n', at), stop = end < 0 ? n : end;
    let i = at; while (i < stop && /\s/.test(t[i])) i++;
    if (t.startsWith('import', i) && i + 6 < n && /\s/.test(t[i + 6])) {
      const f = nextFrom[i + 7], s = nextSemi[i + 7];
      if (f >= 0 && (s < 0 || f < s)) { if (!all) return i; found.push(i); }
    }
    at = stop + 1;
  }
  return all ? found : -1;
}
export function scanSource(text) {
  const findings = [];
  const lines = String(text).split('\n');
  const lineAt = (index) => String(text).slice(0, index).split('\n').length;
  for (const [rule, re] of SCAN_RULES) {
    let hit = new RegExp(re.source, re.flags.includes('m') ? re.flags : re.flags + 'm').exec(text);
    let index = hit ? hit.index : -1;
    if (rule === 'loads another module') { const f = importFromAt(text); if (f >= 0 && (index < 0 || f < index)) index = f; }   // kanban #2751
    if (index >= 0) { const line = lineAt(index); findings.push({ rule, line, text: (lines[line - 1] || '').trim().slice(0, 120) }); }
  }
  return findings;
}

/** The most earlier versions (ancestors) of a package this check decodes and verifies: its newest ones (kanban #1854, #2251, #2262). */
export const MAX_PACKAGE_ANCESTORS = 64;

/**
 * THE PART OF A PACKAGE'S EARLIER VERSIONS A NODE READS, KEEPS AND SERVES (kanban #1854, #2332, #2346): `window` is the newest
 * MAX_PACKAGE_ANCESTORS (oldest first) - the ones checkPackage decodes and checks; `cut` is the one entry right below them when
 * the package carried more, kept only as the marker that the chain goes on below (never decoded, never sorted, never trusted).
 * Everything below the cut is dropped: a node never keeps, decodes or re-serves an earlier version it did not check.
 */
export function packageWindow(ancestors) {
  const all = Array.isArray(ancestors) ? ancestors : [];
  if (all.length <= MAX_PACKAGE_ANCESTORS) return { cut: null, window: all, carried: all.length };
  return { cut: all[all.length - MAX_PACKAGE_ANCESTORS - 1], window: all.slice(all.length - MAX_PACKAGE_ANCESTORS), carried: all.length };
}
/** The earlier versions as kept on disk and served: the cut marker (when there is one) and the checked window, oldest first. */
export const boundedAncestors = (ancestors) => { const w = packageWindow(ancestors); return w.cut === null ? [...w.window] : [w.cut, ...w.window]; };

/**
 * THE REPORT ON A PACKAGE: `verify(sig, msg, key)` is Ed25519. Answers { ok, gameId, name, version, devKey, parent, checks:
 * [{ check, ok, detail }], findings, why }. Every check is listed, passed or not, so the page shows the whole report.
 */
export function checkPackage(pkg, { verify, want = null, parentOf = () => null } = {}) {
  const checks = [], findings = [];
  const add = (check, ok, detail = '') => { checks.push({ check, ok, detail }); return ok; };
  const out = (why, extra = {}) => ({ ok: !why, why: why || null, checks, findings, ...extra });
  if (!add('a package of this store', !!pkg && pkg.format === 'arena-plugin/v1')) return out('that is not an arena-plugin/v1 package');
  let manifest;
  try { manifest = decodeManifest(fromHex(String(pkg.manifest))); add('the manifest reads', true); }
  catch (e) { add('the manifest reads', false, e.message); return out(`its manifest does not decode: ${e.message}`); }
  const gameId = toHex(gameIdOf(manifest));
  const who = { gameId, name: manifest.gameName, version: manifest.version, devKey: toHex(manifest.gameDevPubkey), parent: toHex(manifest.parentManifestId) };
  // THE MAIN MANIFEST'S OWN SIGNATURE FIRST, one verify (kanban #2262): a package whose manifest its developer did not sign
  // costs nothing more - not one ancestor is decoded or verified for it. Its chain is checked below (manifestStands), and this
  // verify is not repeated there.
  let mainSigned = false;
  try { mainSigned = typeof verify === 'function' && verify(manifest.signature, manifestBodyId(manifest), manifest.gameDevPubkey) === true; } catch { mainSigned = false; }
  if (!mainSigned) {
    const s = manifestStands(manifest, { verify: typeof verify === 'function' ? () => false : verify });
    add('signed by its developer, and stands', false, s.why);
    return out(`its manifest does not stand: ${s.why}`, who);
  }
  const verifyRest = (sig, msg, key) => (sig === manifest.signature ? true : verify(sig, msg, key));
  // ITS ANCESTORS, oldest first: each must stand on the one before it (and the oldest on nothing, or on what the caller holds)
  const known = new Map();
  // AT MOST ITS NEWEST MAX_PACKAGE_ANCESTORS ARE READ (kanban #1854): a peer's package (16 MB body) could carry tens of
  // thousands of validly self-signed ancestors and spend this node's main thread on one ed25519 verify each. But an honest
  // seat packs a game's WHOLE chain (server.js hostSplit, adoptPackage, GET /plugin), and every new split is a new version,
  // so a count cap on the whole chain froze an honest game at version 65 for good (kanban #2251, #2262). So the package may
  // carry any number; only its newest MAX_PACKAGE_ANCESTORS are decoded and checked, each on the one before it. The oldest of
  // those stands on a version this node holds when it holds it; when the package carried more than these and this node does
  // not hold the one before, that one is the CUT: the oldest checked version stands on a version of the same developer one
  // lower, as its chain says - nothing below the cut is decoded. Every version this node already holds is taken as held,
  // not verified again.
  const { window: ancestors, cut: cutEntry, carried } = packageWindow(pkg.ancestors);
  const cutBelow = cutEntry !== null;
  add('its earlier versions are read up to a bound', true, cutBelow ? `the newest ${ancestors.length} of ${carried}` : `${carried}`);
  let cut = null;
  const parentFrom = (id) => known.get(toHex(id)) || parentOf(id) || (cut && toHex(id) === cut.id ? cut.stub : null);
  for (const [i, h] of ancestors.entries()) {
    let a;
    try { a = decodeManifest(fromHex(String(h))); } catch (e) { add('its earlier versions read', false, e.message); return out(`an earlier version in it does not decode: ${e.message}`); }
    const aid = toHex(gameIdOf(a));
    const held = parentOf(gameIdOf(a));
    if (held && toHex(gameIdOf(held)) === aid) { add(`its version ${a.version} is one this node holds`, true); known.set(aid, held); continue; }
    if (i === 0 && cutBelow && a.version > 1 && !parentFrom(a.parentManifestId))
      cut = { id: toHex(a.parentManifestId), stub: { gameDevPubkey: a.gameDevPubkey, version: a.version - 1 } };
    const s = manifestStands(a, { verify: verifyRest, parentOf: parentFrom });
    if (!add(`its version ${a.version} stands`, s.ok, s.ok ? '' : s.why)) return out(`its version ${a.version} does not stand: ${s.why}`);
    known.set(aid, a);
  }
  const stands = manifestStands(manifest, { verify: verifyRest, parentOf: parentFrom });
  if (!add('signed by its developer, and stands', stands.ok, stands.ok ? `developer ${who.devKey.slice(0, 16)}…` : stands.why)) return out(`its manifest does not stand: ${stands.why}`, who);
  if (want && !add('the game asked for', want === gameId, gameId.slice(0, 16))) return out(`that package is game ${gameId.slice(0, 16)}, not ${String(want).slice(0, 16)}`, who);
  // WHAT IS CHECKED IS WHAT IS HOSTED (kanban #2673): the set's fields are signed by nobody, so each entry must already be the
  // type the seat hosts - a hex string key, an integer share, a string label (or none). A relayed "10000" passed the id check
  // through Number() and then failed in hostedPlugins, after adoptPackage had counted it as the parent's one try.
  const rowOk = (r) => !!r && typeof r === 'object' && typeof r.recipientPk === 'string' && Number.isInteger(r.shareBps) && (r.label == null || typeof r.label === 'string');
  let set = null;
  if (pkg.donationSet != null && !(Array.isArray(pkg.donationSet) && pkg.donationSet.every(rowOk))) set = null;
  else try { set = (pkg.donationSet || []).map((r) => ({ recipientPk: fromHex(r.recipientPk), shareBps: Number(r.shareBps), label: String(r.label || '') })); } catch { set = null; }
  let setOk = false;
  try { setOk = !!set && toHex(donationSetId(set)) === toHex(manifest.gameDonationSetId); } catch { setOk = false; }
  if (!add('its donation set is the one its manifest names', setOk)) return out('its donation set is not the one its manifest names', who);
  // ITS FILES ARE ENTRIES, NOT ANYTHING (kanban #2307, refute of #1814): cores and clients are lists of objects with a string
  // hash and a string source/body, checked before either loop reads one - a relaying seat's `clients: [null]`, `cores: [null]`
  // or `clients: {}` (signed by nobody) is refused here, never a TypeError thrown out of adoptPackage and the autoUpdate sweep
  const entries = (list, field) => Array.isArray(list) && list.every((e) => !!e && typeof e === 'object' && typeof e.hash === 'string' && typeof e[field] === 'string');
  // kanban #3085: a core is one file (source) or a tree (entry + files), exactly one of the two
  const coreEntries = (list) => Array.isArray(list) && list.every((e) => !!e && typeof e === 'object' && typeof e.hash === 'string'
    && ((typeof e.source === 'string') !== (Array.isArray(e.files) && typeof e.entry === 'string')));
  if (!add('its cores are files', coreEntries(pkg.cores == null ? [] : pkg.cores))) return out('its cores are not a list of files (hash and source, or entry and files, each)', who);
  if (!add('its clients are files', entries(pkg.clients == null ? [] : pkg.clients, 'body'))) return out('its clients are not a list of files (hash and body each)', who);
  const named = new Set(manifest.cores.map((c) => toHex(c.hash)));
  if (!add('it carries every core its manifest names', (pkg.cores || []).length === named.size, `${(pkg.cores || []).length} of ${named.size}`))
    return out(`its manifest names ${named.size} core(s) and the package carries ${(pkg.cores || []).length}`, who);
  // EACH NAMED CORE ONCE (kanban #2240, refute of #1814): the count alone let a relaying seat list one signed core twice and
  // drop another - the package then passed and was hosted without that core (every round on it refused, kept on disk that
  // way). The package's cores must be exactly the manifest's set: no core twice, none missing.
  const coresSeen = new Set();
  for (const c of pkg.cores || []) {
    if (!add(`core ${String(c && c.hash).slice(0, 12)}… is carried once`, !coresSeen.has(String(c && c.hash))))
      return out(`core ${String(c && c.hash).slice(0, 16)} is in the package twice, so a core its manifest names is missing`, who);
    coresSeen.add(String(c && c.hash));
  }
  for (const c of pkg.cores || []) {
    if (Array.isArray(c.files)) {
      // A TREE CORE (kanban #3085): its files within the limits, its hash by core-hash.js's rule, every file scanned
      const t = treeFilesOf(c);
      if (!add(`core ${String(c.hash).slice(0, 12)}… is a well-formed tree`, t.ok, t.ok ? `${t.files.length} files` : t.why)) return out(`core ${String(c.hash).slice(0, 16)}: ${t.why}`, who);
      const th = treeHashHex(t.files);
      if (!add(`core ${String(c.hash).slice(0, 12)}… is the tree its manifest names`, th === c.hash && named.has(c.hash), `tree hash ${th.slice(0, 16)}…`))
        return out(`core ${String(c.hash).slice(0, 16)}: its files are not the tree its manifest names (tree hash ${th.slice(0, 16)})`, who);
      let found = 0;
      for (const x of scanTree(t.files)) { findings.push({ core: String(c.hash).slice(0, 16), ...x }); found++; }
      add(`core ${String(c.hash).slice(0, 12)}… passes the scan`, !found, findings.filter((x) => x.core === String(c.hash).slice(0, 16)).map((x) => `${x.file}: ${x.rule} (line ${x.line})`).join('; '));
      continue;
    }
    const src = fromBase64(c.source);
    // NOT A TREE'S HASH STREAM IN THE ONE-FILE FORM (kanban #3261, audit r21 hosting-1): the manifest signs only a core's hash, and a tree core's
    // hash is sha256 of its framed stream (path \0 bytes \0 ...) - one seat served that stream as a one-file source, it matched, failed the trial
    // and the genuine update was refused for 24 h. A core's source is JavaScript text: one with a NUL byte is refused here, before any trial
    if (!add(`core ${String(c.hash).slice(0, 12)}… is a source file, not a tree's hash stream`, !(src instanceof Uint8Array) || !src.includes(0)))
      return out(`core ${String(c.hash).slice(0, 16)}: its one-file source holds a NUL byte - a tree core's hash stream is not a source file`, who);
    const h = shaHex(src);
    if (!add(`core ${String(c.hash).slice(0, 12)}… is the file its manifest names`, h === c.hash && named.has(c.hash), `sha-256 ${h.slice(0, 16)}…`))
      return out(`core ${String(c.hash).slice(0, 16)}: its source is not the file its manifest names (sha-256 ${h.slice(0, 16)})`, who);
    const f = scanSource(utf8(src));
    for (const x of f) findings.push({ core: String(c.hash).slice(0, 16), ...x });
    add(`core ${String(c.hash).slice(0, 12)}… passes the scan`, !f.length, f.map((x) => `${x.rule} (line ${x.line})`).join('; '));
  }
  const clientsNamed = new Set(manifest.clients.map(toHex));
  for (const k of pkg.clients || []) {
    const h = shaHex(fromBase64(k.body));
    if (!add(`client ${String(k.hash).slice(0, 12)}… is a client its manifest names`, h === k.hash && clientsNamed.has(k.hash)))
      return out(`client ${String(k.hash).slice(0, 16)}: it is not a client its manifest names`, who);
  }
  if (findings.length) return out(`the scan refuses it: ${findings.map((f) => `${f.rule} (line ${f.line})`).join('; ')}`, who);
  // ITS DESCRIPTION AND WEBSITE: shown when its developer key signed them for this game id; never a reason to
  // refuse the game - a package with none, or with an unsigned one, installs the same game (the id is the manifest's)
  const info = pkg.info ? gameInfoStands(pkg.info, { gameId: gameIdOf(manifest), manifest, verify }) : null;
  if (pkg.info) add('its description and website are signed by its developer', info.ok, info.ok ? '' : info.why);
  return out(null, { ...who, info: info && info.ok ? { description: info.description, website: info.website, signed: true } : null });
}

/** AN UPDATE IS THE SAME DEVELOPER'S NEXT VERSION OF THE GAME IT REPLACES: its parent is that game, its version higher. */
export function checkUpdate(installed, next) {
  if (!installed || !next) return { ok: false, why: 'an update names the game it replaces' };
  if (installed.devKey !== next.devKey) return { ok: false, why: `that version is signed by another developer (${next.devKey.slice(0, 16)}) than the installed one's (${installed.devKey.slice(0, 16)})` };
  if (next.parent !== installed.gameId) return { ok: false, why: `that version names ${next.parent.slice(0, 16)} as its parent, not the installed ${installed.gameId.slice(0, 16)}` };
  if (!(next.version > installed.version)) return { ok: false, why: `that is version ${next.version}, not newer than the installed ${installed.version}` };
  return { ok: true };
}
