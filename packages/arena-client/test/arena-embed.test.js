// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EMBED KIT (kanban #678, 2026-10-26: "It shouldn't be just an iframe that is basically stealing a game. The demo site should take rps
// and take it as its own, embedding the code. Not an iframe."): src/arena-ui/arena-embed.js puts the engine's CSS into a box of the host page
// (boxCss: :root, @media by width, vh/vw, relative url()), answers the engine's matchMedia about width by the box (boxMedia); the engine
// mounts a game's client through the kit when it runs under it; the demo site and the snippets use the kit, not a frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const KIT = new URL('../../../src/arena-ui/arena-embed.js', import.meta.url);
const UI = (p) => readFileSync(new URL('../../../src/arena-ui/' + p, import.meta.url), 'utf8');
const TEXT = readFileSync(KIT, 'utf8');
const slice = (from, to) => { const at = TEXT.indexOf(from); assert.ok(at >= 0, from); return TEXT.slice(at, TEXT.indexOf(to, at) + to.length); };
const HELPERS = [
  slice('  const abs = (u, base) =>', '\n'),
  slice('  const relative = (u) =>', '\n'),
  slice('  const SIZE_FEATURE = ', '\n  // a media query the engine asks in code'),
  slice('  function boxMedia(box, q) {', '\n    return mql;\n  }\n'),
];
const lift = () => pageFunction(KIT, ['BASE', 'window', 'ResizeObserver'], HELPERS, ' return { sizeOnly, boxCss, boxMedia };');
const OBSERVED = [];
class FakeObserver { constructor(fn) { this.fn = fn; } observe(el) { OBSERVED.push([this.fn, el]); } }
const H = lift()('https://testnet.bitcoin-arena.io/', { matchMedia: (q) => ({ media: q, page: true }) }, FakeObserver);

test('the engine\'s CSS in the box: :root is its <html>, width rules and viewport units are the box\'s, a relative url() the site\'s', () => {
  const css = H.boxCss(':root { --bg: #000 } html.other-game :root{x:1}\n'
    + '@media (max-width: 560px) { a { height: 100dvh; width: 46vw } }\n'
    + '@media (orientation: landscape) and (max-height: 500px) { b { top: 23.5vh } }\n'
    + '@media (max-width:999px){c{min-height:1dvh}}\n'
    + '@media screen and (min-width: 900px), (max-height: 620px) { d { x: 1 } }\n'
    + '@media (pointer: coarse) { e { x: 1 } }\n'
    + '@media (max-width: 560px) and (hover: none) { f { x: 1 } }\n'
    + 'g { background: url(nextblock-icon.svg), url("data:image/png;base64,AA"), url(\'https://x.example/a.png\') } h { margin: 2px 5vmin }',
  'https://testnet.bitcoin-arena.io/');
  assert.match(css, /^html \{ --bg: #000 \} html\.other-game html\{x:1\}/);
  assert.match(css, /@container arena-box \(max-width: 560px\) \{ a \{ height: 100cqh; width: 46cqw \} \}/);
  assert.match(css, /@container arena-box \(orientation: landscape\) and \(max-height: 500px\) \{ b \{ top: 23\.5cqh \} \}/);
  assert.match(css, /@container arena-box \(max-width:999px\) \{c\{min-height:1cqh\}\}/);
  assert.match(css, /@container arena-box \(\(min-width: 900px\)\) or \(\(max-height: 620px\)\) \{ d/);
  // what a box cannot answer stays the screen's
  assert.match(css, /@media \(pointer: coarse\) \{ e/);
  assert.match(css, /@media \(max-width: 560px\) and \(hover: none\) \{ f/);
  assert.match(css, /url\(https:\/\/testnet\.bitcoin-arena\.io\/nextblock-icon\.svg\), url\("data:image\/png;base64,AA"\), url\('https:\/\/x\.example\/a\.png'\)/);
  assert.match(css, /margin: 2px 5cqmin/);
});

test('matchMedia about width or height reads the box; anything else is the window\'s', () => {
  const box = { clientWidth: 356, clientHeight: 700 };
  assert.equal(H.boxMedia(box, '(max-width: 560px)').matches, true);
  assert.equal(H.boxMedia(box, '(min-width: 900px)').matches, false);
  assert.equal(H.boxMedia(box, '(orientation: portrait) and (max-width: 600px)').matches, true);
  assert.equal(H.boxMedia(box, '(min-width: 900px), (max-height: 760px)').matches, true);
  assert.deepEqual(H.boxMedia(box, '(pointer: coarse)'), { media: '(pointer: coarse)', page: true });
  // a change of the box's width is said to the listeners, once
  const mql = H.boxMedia(box, '(max-width: 560px)');
  const heard = [];
  mql.addEventListener('change', (e) => heard.push(e.matches));
  const [fn] = OBSERVED[OBSERVED.length - 1];
  box.clientWidth = 900; fn(); fn();
  box.clientWidth = 400; fn();
  assert.deepEqual(heard, [false, true]);
});

test('the engine mounts a game\'s client through the kit under it, a frame otherwise; the client file is asked of the page\'s own site', () => {
  const page = UI('index.html');
  assert.match(page, /const frame = window\.ARENA_EMBED \? window\.ARENA_EMBED\.clientElement\(\) : document\.createElement\('iframe'\);/);
  assert.match(page, /url: new URL\('games\/' \+ encodeURIComponent\(game\.name\) \+ '\/index\.html', location\.href\)\.href, digest/);
});

test('the demo site embeds the kit with its program\'s key, no frame; the how-to hands out the kit\'s snippet', () => {
  const demo = UI('referral-demo/index.html');
  assert.doesNotMatch(demo, /<iframe/);
  assert.match(demo, /<div class="game" id="arena-game"><\/div>/);
  assert.match(demo, /kit\.src = '\/arena-embed\.js';/);
  assert.match(demo, /kit\.setAttribute\('data-ref', key\);/);
  const howto = UI('referral/index.html');
  assert.doesNotMatch(howto, /&lt;iframe/);
  assert.match(howto, /&lt;script src="https:\/\/testnet\.bitcoin-arena\.io\/arena-embed\.js" data-game="rock-paper-scissors"/);
  assert.match(howto, /The player's wallet is kept in your site's browser storage/);
});
