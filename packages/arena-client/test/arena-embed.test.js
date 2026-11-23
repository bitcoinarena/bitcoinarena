// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EMBED KIT (kanban #678; kanban #3531, feedback #392 high): src/arena-ui/arena-embed.js puts the Arena into the host page's box as a
// frame on the Arena's own origin - the wallet, its storage, its words, restore and backup stay there, never in the host page's scripts or
// storage. The bridge: one MessageChannel port posted to the Arena origin only, taken by the page only from its own parent; the page says
// only 'ready' and the balance in sat. The two-origin measurement in a real browser is e2e/embed-seed-3531.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const UI = (p) => readFileSync(new URL('../../../src/arena-ui/' + p, import.meta.url), 'utf8');
const KIT = UI('arena-embed.js');
const plain = (x) => JSON.parse(JSON.stringify(x));   // a value made in the sandbox's realm, compared as data

// a host page in a sandbox of its own: the kit runs as it would after <script src="https://testnet.bitcoinarena.io/arena-embed.js" ...>
function hostPage({ dataset = { game: 'rock-paper-scissors', target: '#arena-game' } } = {}) {
  const made = [];
  const el = (tag) => {
    const e = { tagName: tag.toUpperCase(), style: {}, children: [], attrs: {}, listeners: {},
      append(...n) { e.children.push(...n); }, after(n) { made.push(['after', n]); },
      setAttribute(k, v) { e.attrs[k] = v; }, addEventListener(t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); },
      getBoundingClientRect: () => ({ height: 720 }) };
    made.push(e);
    return e;
  };
  const target = el('div');
  const posted = [];
  const ports = [];
  class MessageChannel { constructor() { this.port1 = { sent: [], postMessage(m) { this.sent.push(m); }, close() { this.closed = true; } }; this.port2 = { the: 'port2' }; ports.push(this); } }
  const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), get length() { return m.size; } }; };
  const window = { localStorage: storage(), sessionStorage: storage() };
  const document = {
    currentScript: { src: 'https://testnet.bitcoinarena.io/arena-embed.js', dataset, crossOrigin: null, attributes: [] },
    querySelector: (s) => (s === '#arena-game' ? target : null),
    createElement: (t) => el(t),
    head: { appendChild() { throw new Error('the kit puts no script into the host page'); } },
  };
  const ctx = { window, document, location: { href: 'https://host.example/page', origin: 'https://host.example' }, console: { log() {}, warn() {}, error() {} },
    URL, MessageChannel, Number, Math, Promise, Set, encodeURIComponent };
  ctx.eval = () => { throw new Error('the kit evaluates no engine code in the host page'); };
  ctx.fetch = () => { throw new Error('the kit fetches no engine file into the host page'); };
  vm.runInNewContext(KIT, ctx);
  const frame = made.find((e) => e.tagName === 'IFRAME');
  if (frame) frame.contentWindow = { postMessage: (m, origin, transfer) => posted.push({ m, origin, transfer }) };
  return { window, frame, posted, ports, made };
}

test('#3531 the kit frames the Arena page on its own origin with the snippet\'s game and program; no engine script runs in the host page', () => {
  const ref = '02' + 'ab'.repeat(32);
  const h = hostPage({ dataset: { game: 'rock-paper-scissors', ref, target: '#arena-game' } });
  assert.ok(h.frame, 'a frame');
  assert.equal(h.frame.src, 'https://testnet.bitcoinarena.io/?game=rock-paper-scissors&ref=' + ref + '&embed=1');
  assert.ok(h.made.every((e) => e.tagName !== 'SCRIPT'), 'no script element made');
  const api = h.window.ARENA_EMBED;
  assert.equal(api.base, 'https://testnet.bitcoinarena.io/');
  assert.equal(api.ref, ref);
  // the old kit's handles into the engine (its window, document, scope) are gone: nothing of the engine is the host's
  for (const k of ['scope', 'window', 'document', 'clientElement', 'clientScope']) assert.equal(api[k], undefined, k);
  // nothing in the host's storage
  assert.equal(h.window.localStorage.length + h.window.sessionStorage.length, 0);
  assert.doesNotMatch(KIT.replace(/^\s*\/\/.*$/gm, ''), /\beval\b|new Function|localStorage|sessionStorage|document\.head/);
});

test('#3531 the bridge: a port posted to the Arena origin only, at every load; only "ready" and a balance in sat are heard', async () => {
  const h = hostPage();
  const api = h.window.ARENA_EMBED;
  h.frame.listeners.load[0]();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].origin, 'https://testnet.bitcoinarena.io');
  assert.deepEqual(plain(h.posted[0].m), { type: 'arena-embed-hello', v: 1 });
  assert.equal(h.posted[0].transfer[0], h.ports[0].port2);
  const port = h.ports[0].port1;
  const heard = [];
  api.on('balance', (b) => heard.push(b));
  port.onmessage({ data: { type: 'ready', game: 'rock-paper-scissors' } });
  assert.deepEqual(plain(await api.ready), { game: 'rock-paper-scissors' });
  port.onmessage({ data: { type: 'balance', sats: 1234.9, pending: 5, seed: 'ff'.repeat(32) } });
  assert.deepEqual(plain(heard), [{ sats: 1234, pending: 5 }], 'numbers only; anything else on the message is dropped');
  port.onmessage({ data: { type: 'balance', sats: 'x' } });
  port.onmessage({ data: { type: 'seed', hex: 'ff'.repeat(32) } });
  assert.equal(heard.length, 1);
  // a reload of the frame (a restore) gets a new channel; the old port is closed
  h.frame.listeners.load[0]();
  assert.equal(h.posted.length, 2);
  assert.equal(port.closed, true);
});

test('#3531 the Arena page takes the bridge only from its own parent, under ?embed=1, and says only ready and the balance', () => {
  const page = UI('index.html');
  const at = page.indexOf('// THIS PAGE IN ANOTHER SITE\'S PAGE (kanban #3531');
  assert.ok(at > 0);
  const code = page.slice(page.indexOf('(function () {', at), page.indexOf('})();', at) + 5);
  const run = ({ search = '?game=rock-paper-scissors&embed=1', framed = true } = {}) => {
    const listeners = [];
    const parent = {};
    const window = { addEventListener: (t, f) => listeners.push([t, f]), ARENA_WALLET_BALANCE: { sats: 21000, pending: 0, parts: [{ federation: 'f' }] } };
    window.parent = framed ? parent : window;
    const head = []; const document = { createElement: () => ({}), head: { appendChild: (n) => head.push(n) } };
    vm.runInNewContext(code, { window, document, location: { search }, URLSearchParams, setInterval: () => 1, Math, Number, String });
    return { window, parent, listeners, head };
  };
  assert.equal(run({ framed: false }).listeners.length, 0, 'not framed: nothing');
  assert.equal(run({ search: '?game=rock-paper-scissors' }).listeners.length, 0, 'no ?embed=1: nothing');
  const r = run();
  assert.equal(r.head.length, 1, 'the way back to the games is hidden');
  const [[type, on]] = r.listeners;
  assert.equal(type, 'message');
  const sent = [];
  const port = { postMessage: (m) => sent.push(m), close() {} };
  on({ source: {}, data: { type: 'arena-embed-hello' }, ports: [port], origin: 'https://evil.example' });
  assert.equal(sent.length, 0, 'a hello from a window that is not the parent is not taken');
  on({ source: r.parent, data: { type: 'arena-embed-hello' }, ports: [port], origin: 'https://host.example' });
  assert.deepEqual(plain(sent), [{ type: 'ready', game: 'rock-paper-scissors' }, { type: 'balance', sats: 21000, pending: 0 }]);
  for (const m of sent) assert.doesNotMatch(JSON.stringify(m), /[0-9a-f]{32}/);
});

test('#3531 the demo site embeds the kit with its program\'s key; the how-to and the owner area hand out the kit\'s snippet and say the wallet stays with the Arena', () => {
  const demo = UI('referral-demo/index.html');
  assert.doesNotMatch(demo, /<iframe/);
  assert.match(demo, /<div class="game" id="arena-game"><\/div>/);
  assert.match(demo, /kit\.src = '\/arena-embed\.js';/);
  assert.match(demo, /kit\.setAttribute\('data-ref', key\);/);
  const howto = UI('referral/index.html');
  assert.doesNotMatch(howto, /&lt;iframe/);
  assert.match(howto, /&lt;script src="https:\/\/testnet\.bitcoin-?arena\.io\/arena-embed\.js" data-game="rock-paper-scissors"/);
  assert.doesNotMatch(howto, /kept in your site's browser storage|unsafe-eval/);
  assert.match(howto, /never touch your page or your site's storage/);
  const owner = readFileSync(new URL('../../arena-web/src/owner/ReferrerPanel.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(owner, /kept in your site's browser storage/);
});

test('the engine mounts a game\'s client in a frame of its own (no kit hook in the framed page); the client file is asked of the page\'s own site', () => {
  const page = UI('index.html');
  assert.match(page, /url: new URL\('games\/' \+ encodeURIComponent\(game\.name\) \+ '\/index\.html', location\.href\)\.href, digest/);
});
