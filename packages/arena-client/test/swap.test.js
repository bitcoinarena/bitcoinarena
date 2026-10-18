// A ROUND IN ANOTHER FEDERATION IS ENTERED BY A SWAP (§23A.3, kanban #324 step 3): the shortfall quoted with the fee of both
// gateway legs, moved on the player's confirmation - an invoice of the round federation's wallet paid from the other -, the
// fee measured off the paying balance and both sides in the history; declined, nothing moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapQuote, swapForRound, swapGatewayPairs, SWAP_PAIRS_MAX } from '../src/page-lock.js';

// a wallet: balance in msat, a gateway fee rule, receive/awaitReceive/withdraw as the lock client answers them
function wallet(balanceMsat, rule) {
  const w = { balance: BigInt(balanceMsat), received: [], paid: [],
    feeRule: async () => JSON.stringify({ fee_base_msat: rule.base, fee_ppm: rule.ppm }),
    balanceMsat: async () => String(w.balance),
    withdrawableMsat: async () => String(w.balance - 5000n),
    receive: async (msat) => { w.pending = BigInt(msat); return JSON.stringify({ invoice: `lnbcrt-swap-${msat}`, operation: 'op1' }); },
    awaitReceive: async () => { w.balance += w.pending; w.received.push(w.pending); return 'Claimed'; },
    withdraw: async (invoice) => { const msat = BigInt(invoice.split('-').pop()); const fee = BigInt(rule.base) + (msat * BigInt(rule.ppm)) / 1000000n;
      w.balance -= msat + fee; w.paid.push({ invoice, msat, fee }); w.target.payIn(invoice); return JSON.stringify({ state: 'Success', invoice_msat: String(msat) }); } };
  return w;
}
const ledger = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size; } }; };

test('the quote names the amount and both legs\' fee; the swap moves exactly the amount and measures its fee', async () => {
  const from = wallet(500000n, { base: 1000, ppm: 5000 }), to = wallet(20000n, { base: 0, ppm: 1000 });
  from.target = { payIn: () => {} };
  const q = await swapQuote({ from, to, amountMsat: 100000n });
  // from's leg: 1000 + 100000 * 5000 / 1e6 = 1500; to's leg: 0 + 100000 * 1000 / 1e6 = 100
  assert.deepEqual([q.amountMsat, q.feeMsat, q.totalMsat, q.enough, q.ruleKnown], [100000n, 1600n, 101600n, true, true]);
  const storage = ledger(), A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const states = [];
  const done = await swapForRound({ from, to, amountMsat: q.amountMsat, storage, fromFederationId: A, toFederationId: B, onState: (s) => states.push(s.state) });
  assert.deepEqual([done.ok, done.state, done.movedMsat, done.feeMsat], [true, 'swapped', 100000n, 1500n], 'the paying leg\'s fee, measured');
  assert.equal(to.balance, 120000n, 'the round federation\'s wallet holds the amount');
  assert.equal(from.balance, 500000n - 100000n - 1500n);
  assert.deepEqual(states, ['swapping', 'swapped']);
  const rows = [...storage.m.values()].join(' ');
  assert.match(rows, /swapped-out/); assert.match(rows, /swapped-in/);
  assert.equal(from.paid[0].invoice, 'lnbcrt-swap-100000', 'paid the round federation wallet\'s own invoice');
});

test('a paying wallet short of the amount is quoted not enough; a refused payment moves nothing', async () => {
  const from = wallet(50000n, { base: 0, ppm: 0 }), to = wallet(0n, { base: 0, ppm: 0 });
  assert.equal((await swapQuote({ from, to, amountMsat: 100000n })).enough, false);
  const refused = wallet(500000n, { base: 0, ppm: 0 });
  refused.withdraw = async () => JSON.stringify({ state: 'Refunded' });
  const r = await swapForRound({ from: refused, to, amountMsat: 100000n });
  assert.deepEqual([r.ok, r.state], [false, 'stopped']);
  assert.match(r.why, /ended Refunded - the money is back there/);
  assert.equal(to.balance, 0n);
});

import { swapPlayerWalletForRound } from '../src/page-lock.js';
test('the join\'s swap: enough already - nothing asked; the shortfall quoted with its fee and asked; declined - nothing moves', async () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const round = { federationId: Uint8Array.from(Buffer.from(B, 'hex')) };
  const mk = (inB, inA) => { const to = wallet(inB, { base: 0, ppm: 1000 }), from = wallet(inA, { base: 1000, ppm: 5000 }); from.target = { payIn: () => {} };
    return { to, from, openWallet: async ({ invite }) => (invite === 'inv-B' ? to : from) }; };
  const asked = [];
  const base = { round, toInvite: 'inv-B', fromInvite: 'inv-A', fromFederationId: A, needMsat: 100000n, storage: ledger() };
  const full = mk(150000n, 500000n);
  assert.equal((await swapPlayerWalletForRound({ ...base, openWallet: full.openWallet, confirm: async (q) => { asked.push(q); return true; } })).state, 'enough');
  assert.equal(asked.length, 0, 'nothing asked when the round federation\'s wallet already holds the stake');
  const no = mk(20000n, 500000n);
  const d = await swapPlayerWalletForRound({ ...base, openWallet: no.openWallet, confirm: async (q) => { asked.push(q); return false; } });
  assert.deepEqual([d.state, asked[0].amountMsat, asked[0].feeMsat], ['declined', 80000n, 1480n], 'the shortfall 80,000 msat and its fee 1,400 + 80 shown');
  assert.equal(no.to.balance, 20000n, 'declined: nothing moved');
  const yes = mk(20000n, 500000n);
  const s = await swapPlayerWalletForRound({ ...base, openWallet: yes.openWallet, confirm: async () => true });
  assert.deepEqual([s.ok, s.state, s.movedMsat], [true, 'swapped', 80000n]);
  assert.equal(yes.to.balance, 100000n, 'the round federation\'s wallet now holds the stake');
});

// THE PAGE'S PRESS: its own ARENA_SWAP_CONFIRM (index.html) shows the amount, the fee and the total, and answers the button
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
test('the page\'s swap dialog shows the amount, the fee and the total; Cancel answers no, Swap and enter yes', async () => {
  const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
  const HTML = readFileSync(PAGE, 'utf8');
  const a = HTML.indexOf('    window.ARENA_SWAP_CONFIRM = async');
  const slice = HTML.slice(a, HTML.indexOf('\n    };\n', a) + 7);
  const mk = () => {
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {}, children: [], appendChild(c) { this.children.push(c); } });
    for (const id of ['awc-title', 'awc-list', 'awc-go', 'awc-cancel', 'arena-warn-confirm']) el(id);
    const sub = { textContent: 'This round\'s rules are fixed in its contract.' };
    const document = { getElementById: (id) => els[id] || null, querySelector: () => sub, createElement: () => ({ textContent: '' }) };
    const window = {};
    pageFunction(PAGE, ['document', 'window'], [slice], '')(document, window);
    return { window, els, sub };
  };
  const q = { amountMsat: 80000n, feeMsat: 1480n, totalMsat: 81480n, ruleKnown: true };
  const p1 = mk(); const r1 = p1.window.ARENA_SWAP_CONFIRM(q, 'aa'.repeat(32), 'bb'.repeat(32));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p1.els['arena-warn-confirm'].style.display, 'flex');
  assert.equal(p1.els['awc-title'].textContent, 'Enter by swap');
  assert.deepEqual(p1.els['awc-list'].children.map((c) => c.textContent), ['Move 80 sat through a gateway that serves both.', 'Fee: 2 sat.', 'Total from federation aaaaaaaa: 82 sat.']);
  assert.deepEqual(p1.window.ARENA_SWAP_SHOWN, { amountMsat: '80000', feeMsat: '1480', from: 'aa'.repeat(32), to: 'bb'.repeat(32) });
  p1.els['awc-cancel'].onclick();
  assert.equal(await r1, false);
  assert.equal(p1.els['awc-title'].textContent, '', 'the dialog\'s own words back after');
  const p2 = mk(); const r2 = p2.window.ARENA_SWAP_CONFIRM(q, 'aa'.repeat(32), 'bb'.repeat(32));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p2.els['awc-go'].textContent, 'Swap and enter');
  p2.els['awc-go'].onclick();
  assert.equal(await r2, true);
});

// TWO GATEWAYS, PAIR BY PAIR (kanban #466, testnet4 2026-10-18): gateway C's node had no outbound ("InsufficientBalance"), and gw-b
// found no route to C's invoice ("NoRoute"); left to the lock client's pick every swap ended Refunded. The legs now go through two
// different listed gateways, and a Refunded payment - the money back - tries the next pair; another end stops.
test('the pairs: named first, then each federation\'s list, never one gateway on both legs, at most SWAP_PAIRS_MAX; none listed - the lock client\'s pick', () => {
  const pairs = swapGatewayPairs(['https://gw-c/'], ['https://gw-c', 'https://gw-b', 'https://gw-a'], ['https://gw-b', 'https://gw-a', 'https://gw-c']);
  assert.deepEqual(pairs.slice(0, 3), [['https://gw-c/', 'https://gw-b'], ['https://gw-c/', 'https://gw-a'], ['https://gw-b', 'https://gw-c/']]);
  assert.ok(pairs.every(([r, p]) => r.replace(/\/+$/, '') !== p.replace(/\/+$/, '')), 'never the same gateway on both legs');
  assert.equal(pairs.length, SWAP_PAIRS_MAX);
  assert.deepEqual(swapGatewayPairs([], [], []), [['', '']]);
  assert.deepEqual(swapGatewayPairs([], ['https://only'], ['https://only']), [['https://only', '']], 'one gateway on both sides: the lock client pays');
});

test('a Refunded payment tries the next pair and the swap lands; a payment in another state is not retried', async () => {
  const listed = JSON.stringify(['https://gw-c', 'https://gw-b', 'https://gw-a']);
  const to = wallet(0n, { base: 0, ppm: 0 }), from = wallet(500000n, { base: 0, ppm: 0 });
  to.gateways = async () => listed; from.gateways = async () => listed;
  const recvOf = new Map(); let n = 0;
  to.receive = async (msat, gw) => { to.pending = BigInt(msat); const inv = `lnbcrt-${++n}-${msat}`; recvOf.set(inv, gw); return JSON.stringify({ invoice: inv, operation: 'op' + n }); };
  const legs = [];
  from.withdraw = async (invoice, pay) => {
    const recv = recvOf.get(invoice); legs.push([recv, pay]);
    if (pay === 'https://gw-c') return JSON.stringify({ state: 'Refunded' });                          // C: no outbound
    if (recv === 'https://gw-c' && pay === 'https://gw-b') return JSON.stringify({ state: 'Refunded' }); // B -> C: no route
    const msat = BigInt(invoice.split('-').pop()); from.balance -= msat; return JSON.stringify({ state: 'Success', invoice_msat: String(msat) });
  };
  const states = [];
  const done = await swapForRound({ from, to, amountMsat: 52000n, onState: (s) => states.push(s.state) });
  assert.deepEqual([done.ok, done.state, done.movedMsat], [true, 'swapped', 52000n]);
  assert.deepEqual(legs, [['https://gw-c', 'https://gw-b'], ['https://gw-c', 'https://gw-a']], 'the second pair paid');
  assert.equal(to.balance, 52000n);
  assert.deepEqual(states, ['swapping', 'swapped']);

  // a payment that ends neither Success nor Refunded is not retried: money may be on its way
  const to2 = wallet(0n, { base: 0, ppm: 0 }), from2 = wallet(500000n, { base: 0, ppm: 0 });
  to2.gateways = async () => listed; from2.gateways = async () => listed;
  let asked = 0; from2.withdraw = async () => { asked += 1; return JSON.stringify({ state: 'Pending' }); };
  const r = await swapForRound({ from: from2, to: to2, amountMsat: 52000n });
  assert.deepEqual([r.ok, asked], [false, 1]);
  assert.match(r.why, /ended Pending/);

  // every pair Refunded: stopped, the money back, the pairs named
  const to3 = wallet(0n, { base: 0, ppm: 0 }), from3 = wallet(500000n, { base: 0, ppm: 0 });
  to3.gateways = async () => listed; from3.gateways = async () => listed;
  from3.withdraw = async () => JSON.stringify({ state: 'Refunded' });
  const r3 = await swapForRound({ from: from3, to: to3, amountMsat: 52000n });
  assert.deepEqual([r3.ok, r3.tried.length, from3.balance], [false, SWAP_PAIRS_MAX, 500000n]);
  assert.match(r3.why, /the money is back there \(6 gateway pairs tried\)/);
});
