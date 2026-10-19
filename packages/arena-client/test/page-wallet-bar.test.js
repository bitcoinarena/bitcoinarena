// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE DEPOSIT AND ONE WITHDRAW FOR EVERY GAME (2026-10-10: "Align the deposit process of nextblock, Rock
// Paper Scissors, and the prediction UI. It must be the same everywhere. A game must not implement deposit itself. It imports
// it from the protocol"). The page's own code (page-script.js) on a small fake page. Measured: Settings' buttons, the wallet
// bar over a game's own client and ARENA_GAME.wallet all reach the one openMoney - a deposit builds the same offer and opens
// the same modal, a withdraw opens Settings' own panel over whatever asked; a reason not to says itself where it was asked;
// the bar shows the balance the wallet read, only while a game's client runs; a client is handed the wallet, not a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const OPEN = slice('    function openMoney(which, say = ', '\n      })();\n    }\n');
const WIRED = slice("    for (const [id, which] of [['arena-deposit-go', 'deposit'], ['arena-move-go', 'move'],", '\n      setInterval(paintWalletBar, 1000);\n    }\n');

function page({ ctx = { ok: true, round: { stakeMsat: 100000n }, roundIdHex: 'ab'.repeat(32), roundStake: 100000n, invite: 'fed1', seed: 'seed', gateways: [] },
  ownClient = true, balance = { sats: 12345, pending: 0 }, settingsShown = false, depositFails = null } = {}) {
  const els = {}; const clicks = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {}, addEventListener: (k, f) => { clicks[id] = f; }, click: () => clicks[id] && clicks[id]() });
  for (const id of ['arena-deposit-go', 'arena-move-go', 'arena-withdraw-lobby', 'arena-money-why', 'arena-settings', 'arena-settings-go',
    'arena-wallet-bar', 'arena-wb-sats', 'arena-wb-pending', 'arena-wb-deposit', 'arena-wb-withdraw', 'arena-wb-gear', 'arena-wb-why']) el(id);
  els['arena-settings'].style.display = settingsShown ? '' : 'none';
  //: the withdraw overlay, and Settings' panel with its home to go back to
  const home = { kids: [], insertBefore: (n) => { home.kids.push(n.id); n.parentNode = home; } };
  for (const id of ['arena-withdraw-panel', 'arena-money-why']) { el(id).parentNode = home; els[id].nextSibling = null; }
  const body = { kids: [], append: (...n) => { for (const x of n) { body.kids.push(x.id); x.parentNode = body; } } };
  const close = {}; const shown = new Set();
  els['arena-withdraw'] = { id: 'arena-withdraw', querySelector: (q) => (q === '.wd-body' ? body : close),
    classList: { add: (c) => shown.add(c), remove: (c) => shown.delete(c), contains: (c) => shown.has(c) } };
  els.withdrawBox = { body, close, shown, home };
  const did = [];
  const document = { getElementById: (id) => els[id] || null, body: { classList: { contains: (c) => c === 'arena-own-client' && ownClient } } };
  const window = { ARENA_WALLET_BALANCE: balance, sessionStorage: {}, ARENA_PAINT_SETTINGS: () => did.push('paint settings'),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: 'LC' }) };
  const BLWPCLIENT = { depositDonationMsat: () => 1000n, marketForRound: () => null,
    settingsDepositOffer: async (o) => { if (depositFails) throw new Error(depositFails); did.push(['offer', o.invite, String(o.donationMsat)]); return { offer: 1 }; } };
  const intervals = [];
  const fn = pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'moneyContext', 'openWithdraw', 'showDepositOffer', 'donationBps', 'vault', 'paintHistory', 'setInterval', 'setTimeout', 'clearTimeout'],
    [OPEN, WIRED], 'return { openMoney, paintWalletBar };');
  const api = fn(document, window, BLWPCLIENT, () => ctx, (c) => did.push(['withdraw', c.invite]), (offer, opts) => did.push(['modal', opts.title, !!opts.overSettings]),
    () => 0, () => ({}), () => {}, (f, ms) => intervals.push([f, ms]), () => 0, () => {});
  return { ...api, els, did, window, intervals, click: (id) => clicks[id]() };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('Settings\' Deposit and the wallet bar\'s Deposit open the same offer and the same modal', async () => {
  for (const button of ['arena-deposit-go', 'arena-wb-deposit']) {
    const p = page();
    p.click(button); await settle();
    assert.deepEqual(p.did, [['offer', 'fed1', '1000'], ['modal', 'Deposit into your player wallet', true]], button);
  }
});

test('Withdraw from a game\'s bar opens its own overlay with Settings\' panel in it, back on close; from Settings it stays as it is', () => {
  // (2026-10-17: "make withdrawals an overlay like deposits ... do not touch deposit or withdrawal in the settings overlay")
  const p = page();
  p.click('arena-wb-withdraw');
  const b = p.els.withdrawBox;
  assert.equal(p.els['arena-settings'].style.display, 'none', 'Settings stays closed');
  assert.ok(b.shown.has('show'), 'the overlay is shown');
  assert.deepEqual(b.body.kids, ['arena-withdraw-panel', 'arena-money-why']);
  assert.deepEqual(p.did, [['withdraw', 'fed1']]);
  b.close.onclick();
  assert.ok(!b.shown.has('show'));
  assert.deepEqual(b.home.kids, ['arena-withdraw-panel', 'arena-money-why'], 'the panel is back in Settings');
  assert.equal(p.els['arena-withdraw-panel'].style.display, 'none');
  const q = page({ settingsShown: true });
  q.click('arena-withdraw-lobby');
  assert.deepEqual(q.did, [['withdraw', 'fed1']], 'already open: not painted again');
});

test('a reason not to says itself where it was asked: under Settings\' buttons, or under the bar; and the answer names it', async () => {
  const why = 'No paying round is listed, so there is no stake to count rounds in.';
  const p = page({ ctx: { ok: false, why } });
  p.click('arena-deposit-go');
  assert.equal(p.els['arena-money-why'].textContent, why);
  p.click('arena-wb-deposit');
  assert.equal(p.els['arena-wb-why'].textContent, why, 'the bar says it under itself');
  assert.deepEqual(await p.openMoney('deposit', () => {}), { ok: false, why });
  const q = page({ depositFails: 'the federation did not answer' });
  assert.deepEqual(await q.openMoney('deposit', (t) => { q.said = t; }), { ok: false, why: 'No deposit: the federation did not answer' });
  assert.equal(q.said, 'No deposit: the federation did not answer');
  const said = []; assert.deepEqual(await page().openMoney('deposit', (t) => said.push(t)), { ok: true });
  assert.deepEqual(said, ['Opening your wallet and making the invoice \u2026', ''], 'the wait is said, and cleared once the modal is up');
});

test('the bar shows the balance this wallet read, only while a game\'s client runs, and its gear is Settings\' gear', () => {
  const p = page({ balance: { sats: 1234567, pending: 2500 } });
  p.paintWalletBar();
  assert.equal(p.els['arena-wb-sats'].textContent, '1,234,567 sat');
  assert.equal(p.els['arena-wb-pending'].textContent, ' · 2,500 pending');
  const none = page({ balance: null }); none.paintWalletBar();
  assert.equal(none.els['arena-wb-sats'].textContent, '– sat', 'no balance read yet: nothing invented');
  const lobby = page({ ownClient: false }); lobby.paintWalletBar();
  assert.equal(lobby.els['arena-wb-sats'].textContent, '', 'no game client: the bar is not painted');
  assert.ok(p.intervals.some(([f, ms]) => f === p.paintWalletBar && ms === 1000), 'painted every second');
  let opened = 0; p.els['arena-settings-go'].addEventListener('click', () => { opened++; });
  p.click('arena-wb-gear');
  assert.equal(opened, 1, 'the bar\'s gear clicks the page\'s own gear');
});

test('a game\'s client is handed the page\'s wallet - balance, deposit, withdraw - and the bar sits above its frame, never over it', () => {
  const api = slice('        wallet: {', '\n        },\n');
  assert.match(api, /balance: \(\) => \(window\.ARENA_WALLET_BALANCE \?/);
  assert.match(api, /deposit: \(\) => openMoney\('deposit', window\.ARENA_WALLET_BAR_SAY\)/);
  assert.match(api, /withdraw: \(\) => openMoney\('withdraw', window\.ARENA_WALLET_BAR_SAY, \{ overlay: true \}\)/);
  // the bar over a game's own client and over the games screen share one rule since (UI 88)
  const css = slice('    body.arena-picking #arena-wallet-bar, body.arena-own-client #arena-wallet-bar {', '\n    #arena-wb-why:empty { display: none; }');
  assert.match(css, /body\.arena-own-client #arena-client \{ top: calc\(41px \+ env\(safe-area-inset-top, 0px\)\)/, 'the frame starts under the 40 px bar and its border');
  assert.match(css, /height: 40px/);
  assert.match(HTML, /<div id="arena-wallet-bar" role="toolbar" aria-label="wallet">/);
});

// (2026-10-17: "leave the back link always in the header and move the balance to the other buttons"): the bar's own
// ← right after the logo, the balance pushed right beside Deposit, the client's own "← Arena" hidden in its frame; ← closes an open sheet and goes to the arena
// first, else ARENA_GAME.back
test('the way back is in the bar, the balance on the right, the client\'s own back hidden', () => {
  const HTML = readFileSync(PAGE, 'utf8');
  assert.match(HTML, /<span>Bitcoin Arena<\/span><\/a>\s*<button id="arena-wb-back" type="button"[^>]*><span aria-hidden="true">&larr;<\/span><span class="word">Arena<\/span><\/button>\s*<button class="wb-bal" type="button"/);
  assert.match(HTML, /#arena-wallet-bar \.wb-bal \{ flex: 0 1 auto; min-width: 0; margin-left: auto;/);
  // (2026-10-19: "the button is superfluous and redundant. the bitcoin Arena logo already links back to the homepage"):
  // no "← bitcoin-arena.io" on the games screen any more (/#404 added it);: the balance is a button
  assert.doesNotMatch(HTML, /arena-wb-site/);
  assert.match(HTML, /body\.arena-own-client #arena-wb-back \{ display: inline-flex;/);
  assert.match(HTML, /'#back,button\.back\{display:none!important\}'/);
  const from = HTML.indexOf("      { const wbBack = document.getElementById('arena-wb-back');");
  const src = HTML.slice(from, HTML.indexOf('\n', HTML.indexOf('wbBack.onclick', from)) + 1);
  let sheet = null, closed = 0, backs = 0; const btn = {};
  const document = { getElementById: () => btn, querySelector: () => (sheet ? { click: () => { closed++; } } : null) };
  const window = { ARENA_GAME: { back: () => { backs++; } } };
  pageFunction(PAGE, ['document', 'window'], src)(document, window);
  //: over a sheet ← closes it and goes back to the arena too
  sheet = true; btn.onclick(); sheet = null; btn.onclick();
  assert.deepEqual([closed, backs], [1, 2]);
});
