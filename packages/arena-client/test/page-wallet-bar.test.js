// ONE DEPOSIT AND ONE WITHDRAW FOR EVERY GAME (kanban #294, the owner 2026-10-10: "Align the deposit process of nextblock, Rock
// Paper Scissors, and the prediction UI. It must be the same everywhere. A game must not implement deposit itself. It imports
// it from the protocol"). The page's own code (page-script.js) on a small fake page. Measured: Settings' buttons, the wallet
// bar over a game's own client and ARENA_GAME.wallet all reach the one openMoney - a deposit builds the same offer and opens
// the same modal, a withdraw opens Settings' own panel over whatever asked; a reason not to says itself where it was asked;
// the bar shows the balance the wallet read, only while a game's client runs; a client is handed the wallet, not a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const OPEN = slice('    function openMoney(which, say = ', '\n      })();\n    }\n');
const WIRED = slice("    for (const [id, which] of [['blwp-deposit-go', 'deposit'], ['blwp-move-go', 'move'],", '\n      setInterval(paintWalletBar, 1000);\n    }\n');

function page({ ctx = { ok: true, round: { stakeMsat: 100000n }, roundIdHex: 'ab'.repeat(32), roundStake: 100000n, invite: 'fed1', seed: 'seed', gateways: [] },
  ownClient = true, balance = { sats: 12345, pending: 0 }, settingsShown = false, depositFails = null } = {}) {
  const els = {}; const clicks = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {}, addEventListener: (k, f) => { clicks[id] = f; }, click: () => clicks[id] && clicks[id]() });
  for (const id of ['blwp-deposit-go', 'blwp-move-go', 'blwp-withdraw-lobby', 'blwp-money-why', 'blwp-settings', 'blwp-settings-go',
    'arena-wallet-bar', 'arena-wb-sats', 'arena-wb-pending', 'arena-wb-deposit', 'arena-wb-withdraw', 'arena-wb-gear', 'arena-wb-why']) el(id);
  els['blwp-settings'].style.display = settingsShown ? '' : 'none';
  const did = [];
  const document = { getElementById: (id) => els[id] || null, body: { classList: { contains: (c) => c === 'arena-own-client' && ownClient } } };
  const window = { BLWP_WALLET_BALANCE: balance, sessionStorage: {}, BLWP_PAINT_SETTINGS: () => did.push('paint settings'),
    BLWP_LOCK_WASM: async () => ({ default: async () => {}, LockClient: 'LC' }) };
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
  for (const button of ['blwp-deposit-go', 'arena-wb-deposit']) {
    const p = page();
    p.click(button); await settle();
    assert.deepEqual(p.did, [['offer', 'fed1', '1000'], ['modal', 'Deposit into your player wallet', true]], button);
  }
});

test('Withdraw from a game\'s bar opens Settings\' own panel over the client, painted once; from Settings it stays as it is', () => {
  const p = page();
  p.click('arena-wb-withdraw');
  assert.equal(p.els['blwp-settings'].style.display, '', 'Settings is shown');
  assert.deepEqual(p.did, ['paint settings', ['withdraw', 'fed1']]);
  const q = page({ settingsShown: true });
  q.click('blwp-withdraw-lobby');
  assert.deepEqual(q.did, [['withdraw', 'fed1']], 'already open: not painted again');
});

test('a reason not to says itself where it was asked: under Settings\' buttons, or under the bar; and the answer names it', async () => {
  const why = 'No paying round is listed, so there is no stake to count rounds in.';
  const p = page({ ctx: { ok: false, why } });
  p.click('blwp-deposit-go');
  assert.equal(p.els['blwp-money-why'].textContent, why);
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
  let opened = 0; p.els['blwp-settings-go'].addEventListener('click', () => { opened++; });
  p.click('arena-wb-gear');
  assert.equal(opened, 1, 'the bar\'s gear clicks the page\'s own gear');
});

test('a game\'s client is handed the page\'s wallet - balance, deposit, withdraw - and the bar sits above its frame, never over it', () => {
  const api = slice('        wallet: {', '\n        },\n');
  assert.match(api, /balance: \(\) => \(window\.BLWP_WALLET_BALANCE \?/);
  assert.match(api, /deposit: \(\) => openMoney\('deposit', window\.ARENA_WALLET_BAR_SAY\)/);
  assert.match(api, /withdraw: \(\) => openMoney\('withdraw', window\.ARENA_WALLET_BAR_SAY\)/);
  const css = slice('    body.arena-own-client #arena-wallet-bar {', '\n    #arena-wb-why:empty { display: none; }');
  assert.match(css, /body\.arena-own-client #arena-client \{ top: calc\(41px \+ env\(safe-area-inset-top, 0px\)\)/, 'the frame starts under the 40 px bar and its border');
  assert.match(css, /height: 40px/);
  assert.match(HTML, /<div id="arena-wallet-bar" role="toolbar" aria-label="wallet">/);
});
