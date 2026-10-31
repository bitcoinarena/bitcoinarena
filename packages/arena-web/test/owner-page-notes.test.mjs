// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE WITHOUT ITS NOTES (kanban #838): what a node serves and the site copies has no comment, name or ticket number left, and the
// code still means the same; comments stay in pages/owner.html. dist-fresh checks that dist/owner-page.html is the build of that source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withoutNotes } from '../tools/page-notes.mjs';

const read = (u) => readFileSync(new URL(u, import.meta.url), 'utf8');
const SOURCE = read('../../arena-node/pages/owner.html'), BUILT = read('../dist/owner-page.html');
const scripts = (html) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

test('no note left: comments, ticket numbers, names, hosts, quotes', () => {
  for (const note of [/kanban/i, /the owner/, /a tester/i, /test host/i, /test host/i, /playtest/i, /127\.0\.0\.1:8770/, /no fall ?backs/i, /Das reicht nicht/, /<!--/, /\/\*/, /#\d{3}\b/]) assert.doesNotMatch(BUILT, note);
  assert.match(SOURCE, /kanban #838|kanban #553/, 'they stay in the source');
  assert.ok(BUILT.length < SOURCE.length * 0.75, `${BUILT.length} of ${SOURCE.length} bytes`);
});

test('what the page does is all there: URLs and regular expressions with //, strings, styles and the markup', () => {
  for (const kept of ["https://testnet.bitcoin-arena.io/owner/", 'https://tn4.bitcoin-arena.io/guardian-1', '/^https?:\\/\\//', 'arena-owner-seed:node:', 'Loading from your node…',
    '/\\/[Dd]ashboard\\/owner\\/?$/', 'color-mix(in srgb', 'data:image/svg+xml', 'https://x.com/bitcoinarena_io', 'id="view"', 'id="public-line"', '<script type="module">', 'nav.side']) assert.ok(BUILT.includes(kept), kept);
  assert.equal(scripts(BUILT).length, scripts(SOURCE).length);
  assert.equal((BUILT.match(/<style/g) || []).length, (SOURCE.match(/<style/g) || []).length);
  // the markup outside the scripts and styles: the source's, less its comments
  const markup = (h) => h.replace(/<!--[\s\S]*?-->\n?/g, '').replace(/<script\b[\s\S]*?<\/script>/g, '<S>').replace(/<style\b[\s\S]*?<\/style>/g, '<C>');
  assert.equal(markup(BUILT), markup(SOURCE));
});

test('the built script parses as a module, top-level await and all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-page-'));
  try {
    const f = join(dir, 'page.mjs');
    writeFileSync(f, scripts(BUILT)[0]);
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only comments go: a // or /* inside a string, a template or a regular expression stays', async () => {
  const out = await withoutNotes(`<!doctype html><!-- a <script>note</script> -->
<!-- a whole line -->
<style>/* note */a{background:url(http://x.example//y.png)}b::before{content:"/* not a note */"}</style>
<p title="<!-- attr">http://x.example//y /* text */</p>
<script type="module">// note
const u = 'http://x.example//y'; /* note */ const d = "a // b /* c */";
const t = \`// \${u} /* d */\`, r = /\\/\\/z\\/\\*/, c = 'x<!--y'; // note
globalThis.R = [u, d, t, r.source, c, 1 / 2 / 4];
</script>`);
  assert.doesNotMatch(out, /note\b(?! \*\/")/);
  assert.match(out, /url\(http:\/\/x\.example\/\/y\.png\)/);
  assert.match(out, /content:"\/\* not a note \*\/"/);
  assert.match(out, /<p title="<!-- attr">http:\/\/x\.example\/\/y \/\* text \*\/<\/p>/);
  const code = out.slice(out.indexOf('<script type="module">') + 22, out.indexOf('</script>'));
  new Function(code)();
  assert.deepEqual(globalThis.R, ['http://x.example//y', 'a // b /* c */', '// http://x.example//y /* d */', '\\/\\/z\\/\\*', 'x<!--y', 0.125]);
  delete globalThis.R;
});
