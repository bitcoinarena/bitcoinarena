// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REPOSITORIES, THE DOWNLOAD AND THE LATEST RELEASE FROM ONE PLACE (kanban #753, a tester 2026-10-28: "All repositories are live now.
// Since there are many, create a page on docs to link them all", "Link always latest release and mention the latest build number", "Add a
// section on the website to download the node"): docs.bitcoinarena.io/repos/ lists the five public repositories and the docs lead there;
// bitcoinarena.io has a download section per system; every release link is GitHub's releases/latest, and the number is written by
// js/release-latest.js from the update channel the release scripts publish - no page carries a release number of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const LATEST = 'https://github.com/bitcoinarena/bitcoinarena/releases/latest';
const REPOS = ['bitcoinarena', 'arena-app-next-block', 'arena-app-up-or-down', 'arena-app-rock-paper-scissors', 'arena-sdk'];
const SCRIPT = read('src/website/www/js/release-latest.js');

/** release-latest.js run against a page of the given elements and a channel answering `answer` (or throwing). */
async function run(answer, els) {
  const doc = {
    querySelectorAll: (q) => els.filter((e) => (q === '[data-arena-release-version]' ? 'version' in e.data : 'asset' in e.data)),
  };
  const asked = [];
  const window = {};
  vm.runInNewContext(SCRIPT, { window, document: { readyState: 'loading', addEventListener: () => {} } });
  const v = await window.ARENA_RELEASE_LATEST.show(doc, async (u, o) => {
    asked.push([u, o]);
    if (answer instanceof Error) throw answer;
    return { ok: true, json: async () => answer };
  });
  return { v, asked };
}
const span = () => ({ data: { version: '' }, textContent: '' });
const link = (asset) => ({ data: { asset }, href: LATEST, getAttribute: () => asset, setAttribute(k, x) { this[k] = x; } });

test('the version comes from the update channel only: release/latest.json on testnet.bitcoinarena.io, which tools/release/latest.mjs writes', async () => {
  const s = span(), a = link('bitcoin-arena-node-setup-{v}-windows-x64.exe'), d = link('bitcoin-arena-node_{v}_amd64.deb');
  const { v, asked } = await run({ version: '2026.1.9.11', tag: 'v2026.1.9.11' }, [s, a, d]);
  assert.equal(v, '2026.1.9.11');
  assert.deepEqual(asked.map((x) => x[0]), ['https://testnet.bitcoinarena.io/release/latest.json']);
  assert.equal(s.textContent, '2026.1.9.11');
  assert.equal(a.href, 'https://github.com/bitcoinarena/bitcoinarena/releases/download/v2026.1.9.11/bitcoin-arena-node-setup-2026.1.9.11-windows-x64.exe');
  assert.equal(d.href, 'https://github.com/bitcoinarena/bitcoinarena/releases/download/v2026.1.9.11/bitcoin-arena-node_2026.1.9.11_amd64.deb');
  // the next release is the next answer: nothing in a page changes
  const n = span();
  assert.equal((await run({ version: '2026.1.9.12', tag: 'v2026.1.9.12' }, [n])).v, '2026.1.9.12');
  assert.equal(n.textContent, '2026.1.9.12');
  // the channel is the release scripts' own file
  assert.match(read('tools/release/latest.mjs'), /writeFileSync\(`\$\{out\}\/latest\.json`/);
});

test('a channel that does not answer, or answers no version, leaves the links on releases/latest and no number', async () => {
  for (const answer of [new Error('offline'), { version: '<b>1</b>' }, { version: '2026.1.9.11', tag: 'v2026.1.9.10' }, {}]) {
    const s = span(), a = link('bitcoin-arena-node-{v}-darwin-arm64.dmg');
    assert.equal((await run(answer, [s, a])).v, null);
    assert.equal(s.textContent, '');
    assert.equal(a.href, LATEST);
  }
});

test('no page names a release number of its own; every release link is releases/latest', () => {
  for (const p of ['src/website/www/index.html', 'src/website/docs/docs-template.html', 'src/website/docs/repos-template.html', 'src/website/docs/www/repos/index.html',
    'src/website/docs/www/index.html', 'src/website/www/docs/index.html', 'src/website/www/js/release-latest.js']) {
    const src = read(p).replace(/<!--[\s\S]*?-->/g, '');
    // the one past release the docs name on purpose: "Until release 2026.1.9.8 the command was called arenanode"
    const nums = (src.match(/\b20\d\d\.\d+\.\d+(?:\.\d+)?\b/g) || []).filter((x) => x !== '2026.1.9.8' && x !== '2026.2.0');   // 2026.2.0: the planned release's name, not a number of its own (kanban #1362)
    assert.deepEqual(nums, [], `${p}: no release number`);
    for (const m of src.matchAll(/github\.com\/bitcoinarena\/bitcoinarena\/releases(\/[^"' )]*)?/g))
      assert.ok(!m[1] || m[1] === '/latest', `${p}: ${m[0]}`);
  }
  // the pages that show the number load the one script
  assert.match(read('src/website/www/index.html'), /<script src="\/?js\/release-latest\.js" defer><\/script>/);
  for (const p of ['src/website/docs/docs-template.html', 'src/website/docs/www/index.html', 'src/website/docs/repos-template.html', 'src/website/docs/www/repos/index.html'])
    assert.match(read(p), /<script src="https:\/\/bitcoin-?arena\.io\/js\/release-latest\.js" defer><\/script>/, p);
  // the docs: the repository is open now, the latest release linked with its number
  const docs = read('src/website/docs/docs-template.html');
  assert.ok(!docs.includes('invite-only'), 'the repository is public');
  assert.match(docs, /<a href="https:\/\/github\.com\/bitcoinarena\/bitcoinarena\/releases\/latest">The latest release<span class="relv" data-arena-release-version><\/span><\/a>/);
});

test('docs.bitcoinarena.io/repos/ links the five public repositories, each with its GitHub icon, and the docs lead to it', () => {
  const page = read('src/website/docs/www/repos/index.html');
  for (const r of REPOS) {
    assert.match(page, new RegExp(`<div class="repo" id="${r}"><a class="gh" href="https://github\\.com/bitcoinarena/${r}" aria-label="${r} on GitHub"><svg viewBox="0 0 24 24"`), r);
    assert.match(page, new RegExp(`<h3><a href="https://github\\.com/bitcoinarena/${r}">bitcoin-arena/${r}</a></h3>\\s*<p>[^<]{40,}`), r);
  }
  assert.equal((page.match(/class="repo"/g) || []).length, REPOS.length);
  assert.match(page, /<a class="rel" href="https:\/\/github\.com\/bitcoinarena\/bitcoinarena\/releases\/latest">Latest release<span class="v" data-arena-release-version><\/span><\/a>/);
  assert.match(page, /<body>\n<script src="https:\/\/testnet\.bitcoin-?arena\.io\/site-chrome\.js"><\/script>\n/);
  assert.ok(!page.includes('{{'), 'no token left');
  // the docs' contents and its first boxes lead to it, the GitHub icon in every footer too (footer-social.test.js)
  for (const p of ['src/website/docs/www/index.html', 'src/website/www/docs/index.html']) {
    const d = read(p);
    assert.match(d, /<b>Source<\/b>\n  <a href="https:\/\/docs\.bitcoin-?arena\.io\/repos\/">Repositories ↗<\/a>\n  <a href="https:\/\/github\.com\/bitcoinarena\/bitcoinarena\/releases\/latest">Latest release<span class="relv" data-arena-release-version><\/span> ↗<\/a>\n<\/aside>/, p);
    assert.match(d, /<a class="box link" href="https:\/\/docs\.bitcoin-?arena\.io\/repos\/"><h4>Repositories<\/h4>/, p);
  }
});

test('gen-docs.py writes the repos page from its template: the committed pages are its output', () => {
  const tmpl = read('src/website/docs/repos-template.html');
  const gh = read('src/website/docs/gen-docs.py').match(/^GH = '(.*)'$/m)[1];
  assert.equal(read('src/website/docs/www/repos/index.html'), tmpl.replaceAll('{{GH}}', gh));
  assert.equal(read('src/website/docs/www/index.html'), read('src/website/www/docs/index.html'), 'the homepage serves the same docs at /docs');
});

test('bitcoinarena.io has a download section: the latest release, every system the release ships, and the install docs', () => {
  const html = read('src/website/www/index.html');
  const i = html.indexOf('<section id="download"'), j = html.indexOf('</section>', i);
  assert.ok(i > 0 && j > i, 'the section is there');
  const sec = html.slice(i, j);
  assert.match(html, /<a href="#build">Build &amp; run<\/a><a href="#download">Download<\/a>/, 'the bar leads to it');
  assert.match(sec, /<a class="btn primary" href="https:\/\/github\.com\/bitcoinarena\/bitcoinarena\/releases\/latest">.*Latest release<\/a><span class="v" data-arena-release-version><\/span>/);
  // the twelve files v2026.1.9.11 ships, less the two checksum files: every one a link, its version filled from the channel
  const assets = [...sec.matchAll(/<a href="https:\/\/github\.com\/bitcoinarena\/bitcoinarena\/releases\/latest" data-arena-release-asset="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(assets.sort(), [
    'bitcoin-arena-node-setup-{v}-windows-x64.exe', 'bitcoin-arena-node-{v}-darwin-arm64.dmg', 'bitcoin-arena-node-{v}-darwin-arm64.tar.gz',
    'bitcoin-arena-node-{v}-darwin-x64.dmg', 'bitcoin-arena-node-{v}-darwin-x64.tar.gz', 'bitcoin-arena-node-{v}-linux-arm64.tar.gz',
    'bitcoin-arena-node-{v}-linux-x64.tar.gz', 'bitcoin-arena-node-{v}-windows-x64.zip', 'bitcoin-arena-node_{v}_amd64.deb', 'bitcoin-arena-node_{v}_arm64.deb'].sort());
  for (const h of ['Windows', 'macOS', 'Linux']) assert.ok(sec.includes(`<h3>${h}</h3>`), h);
  assert.match(sec, /<a href="https:\/\/docs\.bitcoin-?arena\.io\/#run">Run a node<\/a> in the docs/);
  assert.match(sec, /<a href="https:\/\/docs\.bitcoin-?arena\.io\/repos\/">all repositories<\/a>/);
});
