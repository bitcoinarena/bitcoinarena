// THE PENDING LINE (WINDOW-10-SPEC, RULED the owner 2026-10-01, §24): the page's own lookThePending, run on fake signer
// node answers - pending the moment a result is signed, the window's close in UTC, "provisional" while results still
// arrive, gone when the result becomes invalid, gone when the money is collected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
const at = html.indexOf('    async function lookThePending() {');
const src = html.slice(at, html.indexOf('\n    }\n', at) + 6);

function page({ answers, done = [] }) {
  const kept = new Map([['blwp.pending.r1', JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e1', nodes: ['http://a', 'http://b', 'http://c'] })]]);
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i], getItem: (k) => kept.get(k) ?? null, removeItem: (k) => kept.delete(k) };
  const els = { 'blwp-bal-pending-when': { textContent: '' }, 'blwp-lobby-pending': { parentNode: { title: '' } } };
  const window = { BLWP_WALLET_BALANCE: { sats: 10, pending: 0 } };
  const fetch = async (u) => { const a = answers[new URL(u).host]; return a ? { ok: true, json: async () => a } : { ok: false }; };
  const BLWPCLIENT = { savedCollects: () => done.map((r) => ({ roundIdHex: r, done: { payout: 'x' } })) };
  const run = new Function('vault', 'BLWPCLIENT', 'fetch', 'document', 'window', 'paintMoney', `${src}; return lookThePending();`);
  return { go: () => run(() => store, BLWPCLIENT, fetch, { getElementById: (id) => els[id] || null }, window, () => {}), window, els, kept };
}
const signed = (msat, more = {}) => ({ kind: 'payout', pendingMsat: msat, windowCloseMs: String(Date.UTC(2026, 9, 1, 12, 11, 22)), provisional: false, ...more });

test('signed: the majority figure is pending at once, with the window close in UTC', async () => {
  const p = page({ answers: { a: signed('196000'), b: signed('196000'), c: signed('98000') } });
  await p.go();
  assert.equal(p.window.BLWP_PENDING_SATS, 196, 'the pending is not the majority figure');
  assert.equal(p.window.BLWP_WALLET_BALANCE.pending, 196);
  assert.equal(p.els['blwp-bal-pending-when'].textContent, 'window closes 12:11:22 UTC');
});

test('while other results still arrive the figure is marked provisional', async () => {
  const p = page({ answers: { a: signed('98000', { provisional: true }), b: signed('98000', { provisional: true }) } });
  await p.go();
  assert.equal(p.window.BLWP_PENDING_SATS, 98);
  assert.match(p.els['blwp-bal-pending-when'].textContent, /provisional/);
});

test('a result that becomes invalid takes the line away: no figure, or 0, is no pending', async () => {
  for (const answers of [{ a: { pendingMsat: null, state: 'SUSPENDED' }, b: { pendingMsat: null } }, { a: signed('0'), b: signed('0') }, {}]) {
    const p = page({ answers });
    await p.go();
    assert.equal(p.window.BLWP_PENDING_SATS, 0, `a pending stayed: ${JSON.stringify(answers)}`);
    assert.equal(p.els['blwp-bal-pending-when'].textContent, '');
  }
});

test('collected into the wallet: the round\'s note goes and nothing is pending', async () => {
  const p = page({ answers: { a: signed('196000'), b: signed('196000') }, done: ['r1'] });
  await p.go();
  assert.equal(p.window.BLWP_PENDING_SATS, 0);
  assert.equal(p.kept.size, 0, 'the collected round is still asked about');
});

// SETTLED WITHOUT FINAL (the owner 2026-10-01): the signer nodes answer a round settled and accepted, with no FINAL signature,
// with state PROVISIONALLY_FINAL, no pending amount, and the accepted settlement as the reason - the page shows no line,
// as for an invalid payment; and the same note on a live round with its amount shows it again.
test('a round the nodes report settled - PROVISIONALLY_FINAL, no pending amount - gives no line; the live amount does', async () => {
  const settled = { state: 'PROVISIONALLY_FINAL', pendingMsat: null, kind: null, settled: 'ab'.repeat(32),
    windowCloseMs: String(Date.UTC(2026, 8, 30, 22, 13, 30)), why: `the round's settlement ${'ab'.repeat(32)} is ACCEPTED by the federation and pays this entry's share: nothing is pending` };
  const p = page({ answers: { a: settled, b: settled, c: settled } });
  await p.go();
  assert.equal(p.window.BLWP_PENDING_SATS, 0, 'a settled round left a pending amount');
  assert.equal(p.window.BLWP_WALLET_BALANCE.pending, 0);
  assert.equal(p.els['blwp-bal-pending-when'].textContent, '', 'a settled round left its window line');
  const live = page({ answers: { a: signed('196000', { state: 'PROVISIONALLY_FINAL' }), b: signed('196000', { state: 'PROVISIONALLY_FINAL' }), c: settled } });
  await live.go();
  assert.equal(live.window.BLWP_PENDING_SATS, 196);
});

// TWO PLAYERS IN ONE BROWSER (ORDER-2116, measured 2026-10-02 01:56Z): the notes share one store; keyed by round alone the
// loser's overwrote the winner's and the winner's tab showed nothing while every node said 192000 msat. One note per
// entry, and a tab asks only about the notes it wrote; a tab that wrote none (a reopened browser) asks about all.
test('two entries of one round in one browser: each tab asks only about its own entry', async () => {
  const kept = new Map([
    ['blwp.pending.r1.e1', JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e1', nodes: ['http://a'] })],
    ['blwp.pending.r1.e2', JSON.stringify({ roundIdHex: 'r1', entryIdHex: 'e2', nodes: ['http://a'] })],
  ]);
  const store = { get length() { return kept.size; }, key: (i) => [...kept.keys()][i], getItem: (k) => kept.get(k) ?? null, removeItem: (k) => kept.delete(k) };
  const asked = [];
  const fetch = async (u) => { const e = new URL(u).searchParams.get('entry'); asked.push(e); return { ok: true, json: async () => signed(e === 'e1' ? '192000' : '0') }; };
  const tab = (mine) => {
    const session = new Map(mine ? [['blwp.pending.mine', JSON.stringify(mine)]] : []);
    const window = { BLWP_WALLET_BALANCE: { sats: 0, pending: 0 }, sessionStorage: { getItem: (k) => session.get(k) ?? null } };
    const run = new Function('vault', 'BLWPCLIENT', 'fetch', 'document', 'window', 'paintMoney', `${src}; return lookThePending();`);
    return run(() => store, { savedCollects: () => [] }, fetch, { getElementById: () => null }, window, () => {}).then(() => window.BLWP_PENDING_SATS);
  };
  const winner = await tab(['blwp.pending.r1.e1']);
  const winnerAsked = asked.splice(0);
  const loser = await tab(['blwp.pending.r1.e2']);
  const loserAsked = asked.splice(0);
  const reopened = await tab(null);
  console.log('  FACTS (two tabs):', JSON.stringify({ winner, winnerAsked, loser, loserAsked, reopened, reopenedAsked: asked }));
  assert.equal(winner, 192, 'the winner\'s tab does not show its own pending');
  assert.deepEqual(winnerAsked, ['e1']);
  assert.equal(loser, 0);
  assert.deepEqual(loserAsked, ['e2']);
  assert.deepEqual([...asked].sort(), ['e1', 'e2'], 'a tab with no notes of its own does not ask about every note');
});

// WINDOW-LIVE-1155 (the owner 2026-10-02: "If the payment becomes invalid, the pending line disappears"): measured on testnet4,
// four seats voided the run (each offering the 96 sat stake back as a refund) while three still said PROVISIONALLY_FINAL
// 192 sat - and the line showed 96, then would have shown 192. A refund is not winnings, and a figure fewer than half the
// answering seats say is not shown.
test('four seats VOID with a refund, three still PROVISIONALLY_FINAL with winnings: no line', async () => {
  const voided = { state: 'VOID', kind: 'refund', pendingMsat: '96000', windowCloseMs: String(Date.UTC(2026, 9, 1, 12, 11, 22)) };
  const answers = { a: voided, b: voided, c: voided, d: voided, e: signed('192000'), f: signed('192000'), g: signed('192000') };
  const p = page({ answers });
  const note = JSON.parse(p.kept.get('blwp.pending.r1')); note.nodes = Object.keys(answers).map((h) => 'http://' + h);
  p.kept.set('blwp.pending.r1', JSON.stringify(note));
  await p.go();
  assert.equal(p.window.BLWP_PENDING_SATS, 0, 'a refund or a minority figure was shown as pending winnings');
  assert.equal(p.els['blwp-bal-pending-when'].textContent, '');
});
