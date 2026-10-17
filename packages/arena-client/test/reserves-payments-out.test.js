// THE PAYMENTS OUT OF THE RESERVES ON THE ARENA PAGE (§27A.9.3, kanban #397, the owner 2026-10-17: "Build the Payments out list and its
// 5 tests as named in comment 2647"): a payout is shown only once five nodes list it and hold its proposal's vote as passed; a passed
// vote without a payout is pending; a drained federation's move needs no vote; the page lists them under the payments in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reservesPaymentsOut, fetchReservesPaymentsOut, paymentOutLine } from '../src/reserves-page.js';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const P = 'aa'.repeat(32), MOVE = 'bb'.repeat(32), FA = '33'.repeat(32), FB = '44'.repeat(32);
const proposal = (state, count = { turnoutPct: 41.5, approvalPct: 72.25, passed: state === 'passed' }) => ({ id: P, purpose: 'Relay hosting', lnurl: 'dev@example.org',
  amountSats: '50000', vote: state === null ? null : { state, count } });
const paid = { proposal: P, planId: 'p1', federation: FA, state: 'PAID', plan: { kind: 'payout', amountSats: '50000', lnurl: 'dev@example.org' }, txid: 'cc'.repeat(32), preimage: 'dd'.repeat(32) };
const moved = { proposal: MOVE, planId: 'm1', federation: FA, state: 'CLAIMED', plan: { kind: 'move', to: FB, amountSats: '120000' }, txid: 'ee'.repeat(32), claimTxid: 'ff'.repeat(32) };
const nodes = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));

test('1. a payout before its vote passed is not shown, and is reported as an inconsistency', () => {
  for (const vote of ['voting', 'failed', null]) {
    const r = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [paid], proposals: [proposal(vote)] })) });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.out.length, 0, `vote ${vote}: no payment out`);
    assert.equal(r.inconsistent.length, 1); assert.match(r.inconsistent[0].why, /its vote has not passed on 5 of them/);
  }
  const none = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [paid], proposals: [] })) });
  assert.deepEqual([none.out.length, none.inconsistent.length], [0, 1], 'a payout for a proposal the nodes do not hold');
});

test('2. a passed vote is never missing: pending with no payout, exactly one payment out with its paid record', () => {
  const pend = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [], proposals: [proposal('passed')] })) });
  assert.deepEqual([pend.out.length, pend.pending.length, pend.pending[0].lnurl, pend.pending[0].amountSats], [0, 1, 'dev@example.org', '50000']);
  const planned = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [{ ...paid, state: 'PLANNED', txid: null, preimage: null }], proposals: [proposal('passed')] })) });
  assert.deepEqual([planned.out.length, planned.pending.length], [0, 1], 'a planned payout is still pending');
  const r = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [paid], proposals: [proposal('passed')] })) });
  assert.equal(r.out.length, 1); assert.equal(r.pending.length, 0); assert.equal(r.inconsistent.length, 0);
  const o = r.out[0];
  assert.deepEqual([o.kind, o.lnurl, o.amountSats, o.status, o.vote.turnoutPct, o.vote.yesPct, o.agreeing], ['payout', 'dev@example.org', '50000', 'paid', 41.5, 72.25, 7]);
  assert.equal(paymentOutLine(o), `Relay hosting · dev@example.org · 50,000 sat · paid · vote 41.5 % turnout, 72.25 % YES · preimage ${'dd'.repeat(8)}… · tx ${'cc'.repeat(8)}…`);
});

test('3. fewer than five agreeing nodes: nothing is shown', () => {
  const four = reservesPaymentsOut({ answers: nodes(7, (i) => ({ payouts: i < 4 ? [paid] : [{ ...paid, preimage: '11'.repeat(32) }].slice(0, i % 2), proposals: [proposal('passed')] })) });
  assert.equal(four.out.length, 0, 'four list one record, the rest another or none');
  const votes4 = reservesPaymentsOut({ answers: nodes(7, (i) => ({ payouts: [paid], proposals: [proposal(i < 4 ? 'passed' : 'voting')] })) });
  assert.equal(votes4.out.length, 0, 'the vote passed on four only'); assert.equal(votes4.inconsistent.length, 1);
  const few = reservesPaymentsOut({ answers: nodes(4, () => ({ payouts: [paid], proposals: [proposal('passed')] })), asked: 7 });
  assert.equal(few.ok, false); assert.match(few.why, /only 4 of 7 nodes answered the payments out, and 5 must/);
});

test('4. a drained federation\'s move shows as moved to federation Y, with no vote', () => {
  const r = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [moved], proposals: [] })) });
  assert.deepEqual([r.out.length, r.inconsistent.length, r.pending.length], [1, 0, 0]);
  const o = r.out[0];
  assert.deepEqual([o.kind, o.to, o.status, o.vote, o.amountSats, o.txid], ['move', FB, 'moved', null, '120000', 'ff'.repeat(32)]);
  assert.equal(paymentOutLine(o), `moved from federation 33333333 to federation 44444444 · 120,000 sat · moved · tx ${'ff'.repeat(8)}…`);
});

test('5. the page lists the payments out under the payments in; the reserves line itself is unchanged', async () => {
  const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
  const HTML = readFileSync(PAGE, 'utf8'), a = HTML.indexOf('    async function showReserves(el, nodes) {');
  const SHOW = HTML.slice(a, HTML.indexOf('\n    }\n', a) + 7);
  const make = (tag) => { const e = { tag, children: [], textContent: '', title: '', className: '', hidden: true,
    append(...k) { for (const c of k) this.children.push(typeof c === 'string' ? { tag: '#text', textContent: c, children: [] } : c); } }; return e; };
  const text = (e) => e.tag === '#text' ? e.textContent : (e.textContent || '') + e.children.map(text).join('');
  const run = async (answers) => {
    const box = make('div'); const el = { querySelector: (q) => (q === '.reserves' ? box : null) };
    const document = { createElement: make }; const window = {};
    const fetcher = async (url) => { const i = Number(new URL(url).port) - 9000; const a = answers(i), path = new URL(url).pathname;
      return { ok: true, async json() { return path === '/reserves' ? { totalMsat: '102000', entries: 2, paidIn: [{ at: '2026-10-17T01:00:00Z', game: 'Tick Tock', amountMsat: '2000' }] }
        : path === '/reserve-payouts' ? { payouts: a.payouts } : { proposals: a.proposals }; } }; };
    const { fetchReservesTotal } = await import('../src/reserves-page.js');
    const BLWPCLIENT = { fetchReservesTotal: (o) => fetchReservesTotal({ ...o, fetcher }), fetchReservesPaymentsOut: (o) => fetchReservesPaymentsOut({ ...o, fetcher }), paymentOutLine };
    const console = { log() {}, warn() {} };
    const showReserves = pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'console'], SHOW, 'return showReserves;')(document, window, BLWPCLIENT, console);
    await showReserves(el, Array.from({ length: 14 }, (_, i) => `http://127.0.0.1:${9000 + i}`));
    const d = box.children[0];
    return { box, d, window, summary: text(d.children[0]), rest: d.children.slice(1).map(text) };
  };
  const empty = await run(() => ({ payouts: [], proposals: [] }));
  assert.equal(empty.summary, 'Protocol reserves: 102 sat · 2 payments in', 'the reserves line as before');
  assert.equal(empty.d.children[0].title, '14 of 14 nodes name this total');
  assert.equal(empty.rest[1], 'Payments out: none yet · 14 of 14 nodes agree');
  assert.deepEqual(empty.window.ARENA_PAYMENTS_OUT, { out: 0, pending: 0, inconsistent: [], agreeing: 14, asked: 14 });
  const full = await run(() => ({ payouts: [paid, moved], proposals: [proposal('passed')] }));
  assert.equal(full.rest[1], 'Payments out · 14 of 14 nodes agree');
  assert.match(full.rest[2], /Relay hosting · dev@example\.org · 50,000 sat · paid · vote 41\.5 % turnout, 72\.25 % YES/);
  assert.match(full.rest[2], /moved from federation 33333333 to federation 44444444 · 120,000 sat · moved/);
  const pend = await run(() => ({ payouts: [], proposals: [proposal('passed')] }));
  assert.equal(pend.rest[2], 'Relay hosting · dev@example.org · 50,000 sat · vote passed – payout pending');
});

