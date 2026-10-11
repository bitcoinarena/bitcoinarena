// THE SEED CHECK IS IN SETTINGS, NOT IN THE FIRST RUN (kanban #340, the owner 2026-10-11: "The wallet should be deterministic, so
// showing the seed and forcing a check interrupts the flow. Put the seed display and the mandatory check in settings, as a
// backup."). On the page's own code: Create on the start screen makes the wallet and opens no dialog; a Nostr login shows no
// words after its reload; Settings keeps the 24 words and their check, and the lobby's backup line leads there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 50)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };

test('Create makes the wallet and goes straight on: no 24-word dialog is opened', () => {
  const CREATE = slice("      $('ws-new').onclick = () => {", '\n      };\n');
  const els = {}; const clicked = [];
  const $ = (id) => (els[id] = els[id] || { id, style: {}, click: () => clicked.push(id) });
  const box = $('arena-wallet-start'); box.style.display = 'flex';
  const window = { ARENA_WALLET_SCREEN: { shown: true }, sessionStorage: {}, BLWP_SEED_KEEPER: { beat: () => clicked.push('beat') } };
  let minted = 0;
  const BLWPCLIENT = { tabSeed: () => { minted++; return new Uint8Array(32); } };
  const done = () => { box.style.display = 'none'; window.ARENA_WALLET_SCREEN.done = true; };
  pageFunction(PAGE, ['$', 'window', 'BLWPCLIENT', 'crypto', 'busy', 'done'], CREATE, 'return 0;')($, window, BLWPCLIENT, { getRandomValues: (a) => a }, () => {}, done);
  els['ws-new'].onclick();
  assert.equal(minted, 1, 'the wallet is made');
  assert.equal(box.style.display, 'none', 'the start screen is done');
  assert.deepEqual(clicked, ['beat'], 'and no seed dialog is opened');
  assert.match(HTML, /Create a new wallet<small>Ready at once - back up its 24 words any time in Settings<\/small>/);
});

test('a Nostr login shows no words after its reload', () => {
  assert.doesNotMatch(HTML, /setItem\('arena\.nostr\.showWords'/, 'nothing asks for the words after a login');
  assert.doesNotMatch(HTML, /if \(words && already\)/);
});

test('Settings keeps the 24 words and their check; the lobby\'s backup line leads there', () => {
  assert.match(HTML, /<button id="blwp-phrase-show"[^>]*>Show seed phrase<\/button>/);
  assert.ok(HTML.includes('id="blwp-verify-start"'), 'the check of the words');
  assert.ok(HTML.includes("document.getElementById('blwp-backup-cta').addEventListener('click'"), 'the lobby line opens Settings on the words');
});
