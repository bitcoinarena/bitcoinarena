// THE WALLET'S BUDGET, BALANCE AND PAYMENT LINES - nwc.js on its own (kanban #147, surface 2 of "The player's money lines",
// plan comment 202, accepted 2026-10-05): what the player reads about the wallet the page is connected to, and the record of
// what left it - pending, returned, kept - by its exact words. The wallet is a fake NIP-47 wallet on a local relay, scripted
// per method; no live wallet is reached.
//
// Read from the source before this file, and measured here first: walletBudget turned the wallet's own numbers into BigInt
// with no catch, so a wallet answering a budget or balance of 1.5 or "abc" made it THROW instead of refusing by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { tabWallet, nwcCall, walletBudget, budgetLine, makeInvoice, spendLog, spentLine, parseConnection, nip04Decrypt, nip04Encrypt, signEvent, NWC_REQUEST, NWC_RESPONSE } from '../src/nwc.js';
import { pageCurve } from '../src/page-curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const hexOf = (b) => Buffer.from(b).toString('hex');

// A NIP-47 WALLET ON A LOCAL RELAY that answers each method with what `answers[method]` says (a result, or { error }).
async function wallet(answers) {
  const walletSecret = rand(32);
  const walletPubkey = pageCurve.pointX(walletSecret);
  const asked = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (sock) => {
    const subs = new Set();
    sock.on('message', async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame[0] === 'REQ') { subs.add(frame[1]); return; }
      if (frame[0] !== 'EVENT') return;
      const event = frame[1];
      sock.send(JSON.stringify(['OK', event.id, true, '']));
      if (event.kind !== NWC_REQUEST) return;
      const opened = await nip04Decrypt(event.content, { secret: walletSecret, theirPubkey: fromHex(event.pubkey), curve: pageCurve });
      if (!opened.ok) return;
      const said = JSON.parse(opened.plaintext);
      asked.push(said);
      const a = answers[said.method];
      const body = a && a.error ? { result_type: said.method, error: a.error } : { result_type: said.method, result: a === undefined ? {} : a };
      const content = await nip04Encrypt(JSON.stringify(body), { secret: walletSecret, theirPubkey: fromHex(event.pubkey), curve: pageCurve, random: rand });
      const reply = await signEvent({ kind: NWC_RESPONSE, tags: [['p', event.pubkey], ['e', event.id]], content, secret: walletSecret, curve: pageCurve });
      for (const sub of subs) sock.send(JSON.stringify(['EVENT', sub, reply]));
    });
  });
  await new Promise((r) => wss.on('listening', r));
  const where = parseConnection(`nostr+walletconnect://${toHex(walletPubkey)}?relay=ws://127.0.0.1:${wss.address().port}&secret=${toHex(rand(32))}`);
  return { where, asked, close: () => new Promise((r) => wss.close(r)) };
}
const opts = { curve: pageCurve, random: rand, timeoutMs: 5000 };
const withWallet = async (answers, f) => { const w = await wallet(answers); try { return await f(w); } finally { await w.close(); } };

// THE FIRST CHECK (plan 202): a wallet's numbers that are not numbers are refused by name, never thrown.
test('walletBudget refuses a budget or balance of 1.5 or "abc" by name; it does not throw', async () => {
  for (const bad of [1.5, 'abc']) {
    const budget = await withWallet({ get_info: { methods: ['get_budget'] }, get_budget: { total_budget: bad, used_budget: 0 } },
      (w) => walletBudget(w.where, opts));
    assert.equal(budget.ok, false, `a budget of ${bad} was taken`);
    assert.match(budget.why, /budget/);
    const balance = await withWallet({ get_info: { methods: ['get_balance'] }, get_balance: { balance: bad } }, (w) => walletBudget(w.where, opts));
    assert.equal(balance.ok, false, `a balance of ${bad} was taken`);
    assert.match(balance.why, /balance/);
  }
});

test('walletBudget: a budget, a balance, no budget set, no budget method; each with its line', async () => {
  const b = await withWallet({ get_info: { methods: ['get_budget', 'get_balance'] }, get_budget: { total_budget: 100000, used_budget: 25000, renews_at: 1790000000, renewal_period: 'monthly' } },
    (w) => walletBudget(w.where, opts));
  assert.deepEqual(b, { ok: true, kind: 'budget', totalMsat: 100000n, usedMsat: 25000n, leftMsat: 75000n, renewsAt: 1790000000, renewalPeriod: 'monthly' });
  assert.equal(budgetLine(b), '75 of 100 sat budget left');
  const over = await withWallet({ get_info: { methods: ['get_budget'] }, get_budget: { total_budget: 1000, used_budget: 5000 } }, (w) => walletBudget(w.where, opts));
  assert.deepEqual({ left: over.leftMsat, line: budgetLine(over) }, { left: 0n, line: '0 of 1 sat budget left' });
  const unset = await withWallet({ get_info: { methods: ['get_budget'] }, get_budget: {} }, (w) => walletBudget(w.where, opts));
  assert.deepEqual(unset, { ok: true, kind: 'none', why: 'this connection has no budget set' });
  assert.equal(budgetLine(unset), 'this connection has no budget set');
  const bal = await withWallet({ get_info: { methods: ['get_balance'] }, get_balance: { balance: 123456 } }, (w) => walletBudget(w.where, opts));
  assert.deepEqual(bal, { ok: true, kind: 'balance', balanceMsat: 123456n });
  assert.equal(budgetLine(bal), 'wallet balance 123 sat');
  const empty = await withWallet({ get_info: { methods: ['get_balance'] }, get_balance: {} }, (w) => walletBudget(w.where, opts));
  assert.deepEqual(empty, { ok: false, why: 'the wallet answered a balance with no balance in it' });
  assert.equal(budgetLine(empty), 'budget unknown: the wallet answered a balance with no balance in it');
  const neither = await withWallet({ get_info: { methods: ['pay_invoice'] } }, (w) => walletBudget(w.where, opts));
  assert.deepEqual(neither, { ok: true, kind: 'none', why: 'this wallet does not report a budget', methods: ['pay_invoice'] });
  assert.equal(budgetLine(neither), 'this wallet does not report a budget');
  assert.equal(budgetLine(null), 'budget not asked for yet');
  assert.equal(budgetLine({ ok: true, kind: 'none' }), 'this wallet does not report a budget');
});

test('walletBudget passes the wallet\'s refusal through, by its code', async () => {
  const info = await withWallet({ get_info: { error: { code: 'UNAUTHORIZED', message: 'no such connection' } } }, (w) => walletBudget(w.where, opts));
  assert.deepEqual(info, { ok: false, why: 'the wallet refused: UNAUTHORIZED no such connection' });
  const bud = await withWallet({ get_info: { methods: ['get_budget'] }, get_budget: { error: { code: 'RESTRICTED', message: '' } } }, (w) => walletBudget(w.where, opts));
  assert.deepEqual(bud, { ok: false, why: 'the wallet refused: RESTRICTED' });
  const bal = await withWallet({ get_info: { methods: ['get_balance'] }, get_balance: { error: { code: 'INTERNAL' } } }, (w) => walletBudget(w.where, opts));
  assert.deepEqual(bal, { ok: false, why: 'the wallet refused: INTERNAL' });
});

test('makeInvoice: nothing to withdraw, no bolt11 in the answer, and the trimmed bolt11 for the amount asked', async () => {
  assert.deepEqual(await makeInvoice({}, 0n, opts), { ok: false, why: 'there is nothing to withdraw' });
  assert.deepEqual(await makeInvoice({}, -5, opts), { ok: false, why: 'there is nothing to withdraw' });
  const got = await withWallet({ make_invoice: { invoice: '  lntbrs1pexample  ' } }, async (w) => ({ said: await makeInvoice(w.where, 5000n, { ...opts, description: 'round 1d5d' }), asked: w.asked }));
  assert.deepEqual(got.said, { ok: true, invoice: 'lntbrs1pexample' });
  assert.deepEqual(got.asked[0], { method: 'make_invoice', params: { amount: 5000, description: 'round 1d5d' } });
  const defaultWords = await withWallet({ make_invoice: { invoice: 'lnbc1x' } }, async (w) => { await makeInvoice(w.where, 1000, opts); return w.asked[0].params.description; });
  assert.equal(defaultWords, 'btc-logistics payout');
  for (const answer of [{ invoice: 'not-a-bolt11' }, {}, { invoice: 7 }])
    assert.deepEqual(await withWallet({ make_invoice: answer }, (w) => makeInvoice(w.where, 1000n, opts)), { ok: false, why: 'the wallet answered make_invoice with no bolt11' });
  assert.deepEqual(await withWallet({ make_invoice: { error: { code: 'QUOTA_EXCEEDED', message: 'over' } } }, (w) => makeInvoice(w.where, 1000n, opts)),
    { ok: false, code: 'QUOTA_EXCEEDED', why: 'the wallet refused: QUOTA_EXCEEDED over' });
});

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const R1 = new Uint8Array(32).fill(1), R2 = new Uint8Array(32).fill(2);
const H = (n) => new Uint8Array(32).fill(n);

test('the payment record: pending, returned and kept totals, no double counting, and its line', () => {
  const log = spendLog();
  assert.equal(spentLine(log), 'nothing paid this session');
  assert.equal(log.record({ amountMsat: 96000n, paymentHash: H(1), roundId: R1, at: 1 }), 1);
  assert.equal(log.record({ amountMsat: 96000n, paymentHash: H(1), roundId: R1, at: 2 }), 1, 'one payment hash counted twice');
  log.record({ amountMsat: 1334n, paymentHash: H(2), roundId: R1, kind: 'donation' });
  log.record({ amountMsat: 50000n, paymentHash: H(3), roundId: R2 });
  assert.deepEqual({ count: log.count, total: log.totalMsat, returned: log.returnedMsat }, { count: 3, total: 147334n, returned: 0n });
  assert.equal(spentLine(log), '147334 msat over 2 stakes and 1 donation share in 2 rounds');
  // a stake that came back is named and left out of the total
  assert.equal(log.markReturned({ paymentHash: H(3), state: 'CANCELLED' }), true);
  assert.deepEqual({ total: log.totalMsat, returned: log.returnedMsat }, { total: 97334n, returned: 50000n });
  assert.equal(spentLine(log), '97334 msat over 1 stake and 1 donation share in 1 round · 50 sat came back (1 stake cancelled)');
  assert.equal(log.markReturned({ paymentHash: H(2), state: 'EXPIRED' }), false, 'a donation share was marked returned');
  assert.equal(log.markReturned({ paymentHash: H(9), state: 'EXPIRED' }), false);
  assert.equal(log.markReturned({ paymentHash: H(1), state: 'SETTLED' }), false, 'a settled stake came back');
  assert.equal(log.markReturned({ paymentHash: 'ab', state: 'EXPIRED' }), false);
  assert.equal(log.markReturned({ paymentHash: H(1), state: 'EXPIRED' }), true);
  assert.equal(spentLine(log), '1334 msat over 1 donation share in 1 round · 146 sat came back (2 stakes expired/cancelled)');
  // stakes only, whole sats
  const stakes = spendLog();
  stakes.record({ amountMsat: 96000n, paymentHash: H(4), roundId: R1 });
  assert.equal(spentLine(stakes), '96 sat over 1 stake in 1 round');
  stakes.markReturned({ paymentHash: H(4), state: 'EXPIRED' });
  assert.equal(spentLine(stakes), 'nothing spent this session · 96 sat came back (1 stake expired)');
});

test('the payment record survives a reload through the tab\'s storage; an unreadable entry is not counted', () => {
  const storage = mem();
  const first = spendLog({ storage });
  first.record({ amountMsat: 96000n, paymentHash: H(1), roundId: R1, at: 10 });
  first.record({ amountMsat: 1334n, paymentHash: H(2), roundId: R1, kind: 'donation', at: 11 });
  first.markReturned({ paymentHash: H(1), state: 'CANCELLED' });
  const again = spendLog({ storage });
  assert.deepEqual({ count: again.count, total: again.totalMsat, returned: again.returnedMsat }, { count: 2, total: 1334n, returned: 96000n });
  assert.deepEqual(again.entries().map((p) => [p.kind, p.returned || null, toHex(p.paymentHash)]), [['stake', 'CANCELLED', toHex(H(1))], ['donation', null, toHex(H(2))]]);
  assert.equal(again.record({ amountMsat: 96000n, paymentHash: H(1), roundId: R1 }), 2, 'a reloaded payment was counted again');
  const raw = JSON.parse(storage.getItem('arena.spend.log'));
  raw.push({ amountMsat: 'x' }, { amountMsat: '5', returned: 'SIDEWAYS' });
  storage.setItem('arena.spend.log', JSON.stringify(raw));
  const third = spendLog({ storage });
  assert.deepEqual({ count: third.count, total: third.totalMsat }, { count: 3, total: 1339n }, 'an unreadable entry was counted');
  storage.setItem('arena.spend.log', 'not json');
  assert.equal(spendLog({ storage }).count, 0);
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const forgetful = spendLog({ storage: full });
  assert.equal(forgetful.record({ amountMsat: 1000n, paymentHash: H(5) }), 1, 'a tab that cannot keep the log still counts in memory');
});

test('the connection the tab holds: connected, kept on a reload, forgotten; a pasted string that is not a connection is refused by name', () => {
  const storage = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const uri = `nostr+walletconnect://${'ab'.repeat(32)}?relay=wss://relay.example&secret=${'cd'.repeat(32)}`;
  const w = tabWallet({ storage });
  assert.deepEqual(w.current(), { ok: false, why: 'this tab has no wallet connected' });
  assert.equal(w.connected, false);
  assert.deepEqual(w.connect('https://wallet.example/'), { ok: false, why: 'that string is https and a wallet connection is nostr+walletconnect' });
  assert.equal(storage.getItem('arena.wallet'), null, 'a refused string was kept');
  const got = w.connect(`  ${uri}  `);
  assert.equal(got.ok, true);
  assert.equal(storage.getItem('arena.wallet'), uri, 'the string was not kept trimmed');
  assert.equal(tabWallet({ storage }).connected, true, 'a reload lost the wallet');
  assert.equal(hexOf(tabWallet({ storage }).current().walletPubkey), 'ab'.repeat(32));
  storage.setItem('arena.wallet', 'nostr+walletconnect://xyz');
  assert.deepEqual(tabWallet({ storage }).current(), { ok: false, why: 'that connection names no 32-byte wallet key' });
  assert.deepEqual(w.forget(), { ok: true });
  assert.equal(w.connected, false);
  const none = tabWallet({});
  assert.equal(none.connected, false);
  assert.equal(none.connect(uri).ok, true, 'a tab with no storage cannot hold a connection for the page');
  assert.deepEqual(none.forget(), { ok: true });
});

test('a request the page cannot build is refused by name, not thrown', async () => {
  const w = await wallet({});
  try {
    const got = await nwcCall(w.where, { method: 'get_info', params: {} }, { curve: { ecdhShared: () => { throw new Error('no curve here'); } }, random: rand, timeoutMs: 5000 });
    assert.deepEqual(got, { ok: false, why: 'this page could not build the request: no curve here' });
  } finally { await w.close(); }
});

test('nwcCall answers every way a wallet can fail to answer, by name', async () => {
  const where = (port) => ({ ...parseConnection(`nostr+walletconnect://${'ab'.repeat(32)}?relay=ws://127.0.0.1:${port}&secret=${'cd'.repeat(32)}`) });
  const call = (w, o = {}) => nwcCall(w, { method: 'get_info', params: {} }, { ...opts, ...o });
  assert.deepEqual(await call(where(9), { WebSocketImpl: null }), { ok: false, why: 'this page has no WebSocket, so it can reach no relay' });
  assert.deepEqual(await call(where(9), { WebSocketImpl: class { constructor() { throw new Error('bad url'); } } }), { ok: false, why: 'that relay would not open: bad url' });
  const closed = await call(where(1), { timeoutMs: 5000 });
  assert.equal(closed.ok, false);
  assert.match(closed.why, /^that relay (would not open|closed before the wallet answered)$/);
  // a relay that refuses the event, one that hangs up, one that says nothing, one that answers garbage
  const relay = async (behave) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (sock) => sock.on('message', (raw) => behave(sock, JSON.parse(raw.toString()))));
    await new Promise((r) => wss.on('listening', r));
    return { port: wss.address().port, close: () => new Promise((r) => wss.close(r)) };
  };
  const refuses = await relay((sock, f) => { sock.send('not json'); sock.send(JSON.stringify({ not: 'a frame' })); if (f[0] === 'EVENT') sock.send(JSON.stringify(['OK', f[1].id, false, 'blocked: rate limit'])); });
  assert.deepEqual(await call(where(refuses.port)), { ok: false, why: 'the relay refused the request: blocked: rate limit' });
  await refuses.close();
  const binary = await relay((sock, f) => { if (f[0] === 'EVENT') { sock.send(Buffer.from('["EVENT"]'), { binary: true }); sock.send(JSON.stringify(['OK', f[1].id, false, 'after a binary frame'])); } });
  assert.deepEqual(await call(where(binary.port)), { ok: false, why: 'the relay refused the request: after a binary frame' });
  await binary.close();
  const silent = await relay(() => {});
  assert.deepEqual(await call(where(silent.port), { timeoutMs: 300 }), { ok: false, why: 'the wallet did not answer in 300 ms' });
  await silent.close();
  const hangs = await relay((sock, f) => { if (f[0] === 'EVENT') sock.close(); });
  assert.deepEqual(await call(where(hangs.port)), { ok: false, why: 'that relay closed before the wallet answered' });
  await hangs.close();
  const noReason = await relay((sock, f) => { if (f[0] === 'EVENT') sock.send(JSON.stringify(['OK', f[1].id, false])); });
  assert.deepEqual(await call(where(noReason.port)), { ok: false, why: 'the relay refused the request: no reason given' });
  await noReason.close();
  const garbage = await relay((sock, f) => { if (f[0] === 'EVENT') sock.send(JSON.stringify(['EVENT', 'sub', { content: 'no iv here' }])); });
  assert.deepEqual(await call(where(garbage.port)), { ok: false, why: 'that answer carries no iv, so it is not NIP-04' });
  await garbage.close();
});
