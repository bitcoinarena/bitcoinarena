// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLAIMS ON A HALTED FEDERATION'S ESCROW (§23A.5 steps 2-4): the arbitration set's book, its doors, the
// offline note check's parsing, and the client that presents its notes - the federation's validation stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createLiquidationClaims, payOutLiquidation } from '../src/liquidation-claims.js';
import { notesOfDecoded, fedimintNoteValidator } from '../src/note-validate.js';
import { serveArbiter } from '../src/arbiter.js';
import { presentNotes, pendingClaimKey } from '../../arena-client/src/liquidation-claim.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';

const FED = 'ab'.repeat(32);
const P1 = '02' + '11'.repeat(32), P2 = '02' + '22'.repeat(32);
const NOTES = { e1: [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 512000n }, { nonce: '02' + 'a2'.repeat(32), amountMsat: 256000n }],
  e2: [{ nonce: '02' + 'b1'.repeat(32), amountMsat: 1024000n }], e3: [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 512000n }],
  e4: [{ nonce: '02' + 'c1'.repeat(32), amountMsat: 128000n }] };
const LIQ = { federation: FED, haltHeight: 1000, liquidatesAt: 1010, claimWindowCloses: 1020, lateClaimsUntil: 1100, spentNonces: ['02' + 'c1'.repeat(32)] };

function book({ escrowMsat = 10_000_000n } = {}) {
  let tip = 1005; const saved = [];
  const claims = createLiquidationClaims({ validate: async (_fid, e) => (NOTES[e] ? { ok: true, notes: NOTES[e], amountMsat: NOTES[e].reduce((a, n) => a + n.amountMsat, 0n) } : { ok: false, why: 'Note 0 has an invalid federation signature' }),
    liquidationOf: async (fid) => (fid === FED ? LIQ : null), height: async () => tip, escrowMsatOf: async () => escrowMsat, clocks: REGTEST_CLOCKS,
    save: (rows) => saved.push(rows) });
  return { claims, at: (h) => { tip = h; }, saved };
}

test('a claim is taken only in the window, only with notes that stand, never twice, never a spent nonce', async () => {
  const b = book();
  assert.match((await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 })).why, /window opens at 1010/);
  b.at(1012);
  const one = await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  assert.deepEqual([one.ok, one.accepted.length, one.inWindow], [true, 2, true]);
  assert.match((await b.claims.offer({ federation: FED, ecash: 'e3', payoutPk: P2 })).refused[0].why, /claimed before/);
  assert.match((await b.claims.offer({ federation: FED, ecash: 'e4', payoutPk: P2 })).refused[0].why, /spent set/);
  assert.match((await b.claims.offer({ federation: FED, ecash: 'forged', payoutPk: P2 })).why, /invalid federation signature/);
  assert.match((await b.claims.offer({ federation: 'cd'.repeat(32), ecash: 'e2', payoutPk: P2 })).why, /not being liquidated/);
  b.at(1050);
  const late = await b.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P2 });
  assert.deepEqual([late.ok, late.inWindow], [true, false], 'a late note is still taken until drain_blocks');
  b.at(1101);
  assert.match((await b.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P1 })).why, /claims close at 1100/);
  assert.equal(b.saved.at(-1).length, 3, 'the book is kept');
});

test('the table: every valid note at face value from a large escrow; pro rata from a short one; the remainder split only after drain_blocks', async () => {
  const big = book(); big.at(1012);
  await big.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 }); await big.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P2 });
  const p = await big.claims.plan(FED);
  assert.deepEqual([p.ok, p.proRata, p.payouts.find((x) => x.payoutPk === P1).msat, p.payouts.find((x) => x.payoutPk === P2).msat, p.split], [true, false, '768000', '1024000', null]);
  big.at(1100); assert.equal((await big.claims.plan(FED)).split.nodes, String((10_000_000n - 1_792_000n) * 75n / 100n));
  const short = book({ escrowMsat: 896_000n }); short.at(1012);
  await short.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 }); await short.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P2 });
  const q = await short.claims.plan(FED);
  assert.deepEqual([q.proRata, q.rate, q.payouts.find((x) => x.payoutPk === P2).msat], [true, 0.5, '512000']);
});

test('the arbitration set\'s doors: POST and GET /liquidation-claims', async () => {
  const b = book(); b.at(1012);
  const doors = await serveArbiter({ set: { network: 'regtest', k: 5, members: [] }, allow: () => ({ ok: false }), claims: b.claims });
  try {
    const at = `http://127.0.0.1:${doors.port}/liquidation-claims`;
    const r = await fetch(at, { method: 'POST', body: JSON.stringify({ federation: FED, ecash: 'e1', payoutPk: P1 }) });
    assert.equal(r.status, 200);
    assert.equal((await fetch(at, { method: 'POST', body: JSON.stringify({ federation: FED, ecash: 'e1', payoutPk: P1 }) })).status, 409);
    const g = await (await fetch(`${at}?federation=${FED}`)).json();
    assert.deepEqual([g.notes, g.payouts[0].msat], [2, '768000']);
  } finally { await doors.close(); }
});

test('decoded notes: each nonce is its spend key\'s compressed public key, in either tier shape; the validator sums them against the mint\'s check', async () => {
  const k1 = '01'.repeat(32), k2 = '02'.repeat(32);
  const pub = (k) => Array.from(secp256k1.getPublicKey(Uint8Array.from(k.match(/../g).map((x) => parseInt(x, 16))), true), (x) => x.toString(16).padStart(2, '0')).join('');
  const a = notesOfDecoded({ federation_id_prefix: 'abcd', notes: { '1024': [{ signature: 'aa', spend_key: k1 }], '2048': [{ signature: 'bb', spend_key: k2 }] } });
  assert.deepEqual(a.map((n) => [n.nonce, n.amountMsat]), [[pub(k1), 1024n], [pub(k2), 2048n]]);
  assert.deepEqual(notesOfDecoded({ notes: [[4096, [{ spend_key: k1 }]]] }).map((n) => n.amountMsat), [4096n]);
  // a federation on the old mint module: mintv2 is not there, the stock check and decode are read
  const runs = [];
  const v = fedimintNoteValidator({ cli: 'fedimint-cli', dataDirFor: () => '/c', run: async (bin, args) => { runs.push(args.slice(2, 5).join(' '));
    if (args.includes('mintv2')) return { ok: false, out: '', err: '{"error":"No module with this kind found"}' };
    return args.includes('validate') ? { ok: true, out: '{"amount_msat":3072}' } : { ok: true, out: JSON.stringify({ notes: { '1024': [{ spend_key: k1 }], '2048': [{ spend_key: k2 }] } }) }; } });
  const got = await v(FED, 'fedimint1xyz');
  assert.deepEqual([got.ok, got.amountMsat, got.notes.length, runs], [true, 3072n, 2, ['module mintv2 validate', 'module mint validate', 'dev decode notes']]);
  const bad = fedimintNoteValidator({ cli: 'x', dataDirFor: () => '/c', run: async () => ({ ok: false, err: 'Error: Note 0 has an invalid federation signature' }) });
  assert.match((await bad(FED, 'e')).why, /invalid federation signature/);
  // MINTV2 (our federations): the fork's validate names every note, its nonce and whether it carries the signature
  const said = (o) => fedimintNoteValidator({ cli: 'x', dataDirFor: () => '/c', run: async () => ({ ok: true, out: JSON.stringify(o) }) });
  const n1 = { nonce: pub(k1), amount_msat: 1024, valid: true }, n2 = { nonce: pub(k2), amount_msat: 2048, valid: true };
  const good = await said({ federation_id: FED, ours: true, amount_msat: 3072, valid: true, notes: [n1, n2] })(FED, 'e');
  assert.deepEqual([good.ok, good.amountMsat, good.notes.map((n) => [n.nonce, n.amountMsat])], [true, 3072n, [[pub(k1), 1024n], [pub(k2), 2048n]]]);
  assert.match((await said({ federation_id: 'ff', ours: false, amount_msat: 3072, valid: false, notes: [n1, n2] })(FED, 'e')).why, /another federation/);
  assert.match((await said({ federation_id: FED, ours: true, amount_msat: 3072, valid: false, notes: [n1, { ...n2, valid: false }] })(FED, 'e')).why, /1 of 2 notes do not carry/);
  assert.match((await said({ federation_id: FED, ours: true, amount_msat: 4096, valid: true, notes: [n1, n2] })(FED, 'e')).why, /come to 3072 msat/);
});

test('the client presents its whole wallet once, keeps the e-cash until it is taken, and presents the same string again after a failure', async () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let sends = 0, up = false; const posted = [];
  const walletFor = async () => ({ sendAllEcash: async () => { sends++; return JSON.stringify({ msat: 768000, ecash: 'e1' }); } });
  const fetcher = async (url, o) => { posted.push([url, JSON.parse(o.body).ecash]); if (!up) throw new Error('fetch failed'); return { ok: true, json: async () => ({ accepted: [1, 2], inWindow: true }) }; };
  const liq = [{ ...LIQ, claims: 'https://arb.example/' }];
  const first = await presentNotes({ liquidations: liq, held: [FED], walletFor, payoutPk: P1, height: 1012, storage, fetcher });
  assert.deepEqual([first[0].ok, first[0].kept, store.get(pendingClaimKey(FED))], [false, true, 'e1'], 'kept when the post failed');
  up = true;
  const again = await presentNotes({ liquidations: liq, held: [FED], walletFor, payoutPk: P1, height: 1012, storage, fetcher });
  assert.deepEqual([again[0].ok, again[0].kept, sends, store.has(pendingClaimKey(FED))], [true, false, 1, false], 'the same string, sent from storage');
  assert.deepEqual(posted.map((p) => p[0]), ['https://arb.example/liquidation-claims', 'https://arb.example/liquidation-claims']);
  assert.equal((await presentNotes({ liquidations: liq, held: ['ef'.repeat(32)], walletFor, payoutPk: P1, height: 1012, storage, fetcher })).length, 0, 'a federation this browser holds nothing in');
  assert.match((await presentNotes({ liquidations: liq, held: [FED], walletFor, payoutPk: P1, height: 1005, storage, fetcher }))[0].why, /claims open at 1010/);
});

test('the table paid: nothing before the window closes; then the escrow into the safe federation, every note once, a late one by a later pass', async () => {
  const b = book(); b.at(1012);
  await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  const runs = []; const v = {}; let spent = 0;
  const run = async (args) => { runs.push(args[1]);
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 9_000_000 };
    if (args[1] === 'pay') return { txid: `pay${runs.length}`, payouts: args[3].split(',').map((x, i) => ({ refund_pk: x.split(':')[0], amount_msat: Number(x.split(':')[1]), out_idx: i })) };
    return {}; };
  const spendEscrow = async (addr) => { spent++; return { txid: 'escrow-into-safe', addr }; };
  const pass = () => payOutLiquidation({ fid: FED, v, claims: b.claims, height: async () => tip(), run, spendEscrow });
  let h = 1015; const tip = () => h;
  assert.match((await pass()).why, /claim window closes at 1020/);
  h = 1021;
  const first = await pass();
  assert.deepEqual([first.paid, spent, v.escrowTxid, v.claimedMsat, v.payouts.map((x) => [x.payoutPk, x.msat])], [2, 1, 'escrow-into-safe', '9000000', [[P1, '768000']]]);
  assert.deepEqual((await pass()), { paid: 0, notes: 2 }, 'nothing paid twice');
  b.at(1050); await b.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P2 });
  const late = await pass();
  assert.deepEqual([late.paid, spent, v.payouts.at(-1).payoutPk, v.payouts.at(-1).msat], [1, 1, P2, '1024000'], 'the late note from what is left, the escrow spent once');
});

test('after drain_blocks the remainder is paid once to its payees, never before every note is', async () => {
  const b = book(); b.at(1012);
  await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  const pays = []; const v = {};
  const run = async (args) => {
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 2_000_000 };
    if (args[1] === 'pay') { pays.push(args[3]); return { txid: `t${pays.length}`, payouts: [] }; }
    if (args[1] === 'balance') return { msat: 1_300_000 };
    return {}; };
  let h = 1021;
  const remainderPayees = async (_fid, msat) => [{ key: 'aa'.repeat(32), msat: (msat * 75n) / 100n }, { key: 'dd'.repeat(32), msat: msat - (msat * 75n) / 100n }];
  const pass = () => payOutLiquidation({ fid: FED, v, claims: b.claims, height: async () => h, run, spendEscrow: async () => ({ txid: 'x' }), remainderPayees });
  await pass();
  assert.equal(pays.length, 1, 'the notes first');
  assert.deepEqual(await pass(), { paid: 0, notes: 2 }, 'no remainder before drain_blocks');
  b.at(1100); h = 1100;
  const r = await pass();
  assert.deepEqual([r.remainder, pays.length, pays[1]], ['1232000', 2, `${'aa'.repeat(32)}:924000,${'dd'.repeat(32)}:308000`]);
  await pass(); assert.equal(pays.length, 2, 'once');
});

test('the remainder is paid from what the paying client holds, less a margin for the fees, when the fees ate into it', async () => {
  const b = book(); b.at(1012);
  await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  const pays = []; const v = {}; let held = 1_000_000;
  const run = async (args) => {
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 2_000_000 };
    if (args[1] === 'pay') { pays.push(args[3]); return { txid: `t${pays.length}`, payouts: [] }; }
    if (args[1] === 'balance') return { msat: held };
    return {}; };
  let h = 1021;
  const remainderPayees = async (_fid, msat) => [{ key: 'aa'.repeat(32), msat }];
  const pass = () => payOutLiquidation({ fid: FED, v, claims: b.claims, height: async () => h, run, spendEscrow: async () => ({ txid: 'x' }), remainderPayees });
  await pass();
  b.at(1100); h = 1100;
  const r = await pass();
  assert.deepEqual([r.remainder, pays[1]], ['990000', `${'aa'.repeat(32)}:990000`], 'the table says 1232000; the client holds 1000000');
  held = 5_000; delete v.remainderTxid; pays.length = 1;
  assert.match((await pass()).why, /holds 5000 msat, nothing left/);
  assert.equal(pays.length, 1, 'no pay it cannot make');
});

test('the claim key comes from the seed per federation; the payouts naming it are collected by Refund once; the arbiter lists them', async () => {
  const { liquidationKeyFor, collectLiquidationPayouts } = await import('../../arena-client/src/liquidation-claim.js');
  const { pageCurve } = await import('../../arena-client/src/page-curve.js');
  const seed = new Uint8Array(32).fill(5);
  const a = liquidationKeyFor(seed, FED, pageCurve), again = liquidationKeyFor(seed, FED, pageCurve), other = liquidationKeyFor(seed, 'cd'.repeat(32), pageCurve);
  assert.equal(a.payoutPk, again.payoutPk, 'the same seed, the same key');
  assert.notEqual(a.payoutPk, other.payoutPk, 'another federation, another key');
  assert.match(a.payoutPk, /^02[0-9a-f]{64}$/);
  const SAFE = 'ef'.repeat(32);
  const listed = { payouts: [{ federation: FED, into: SAFE, payoutPk: a.payoutPk, msat: '768000', txid: 'aa'.repeat(32), outIdx: 1 },
    { federation: FED, into: SAFE, payoutPk: '02' + '33'.repeat(32), msat: '5000', txid: 'aa'.repeat(32), outIdx: 2 }] };
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const refunds = [];
  const clientFor = async (fid) => ({ refund: async (txid, outIdx, fields, secret) => { refunds.push([fid, outIdx, JSON.parse(fields).refundPk, secret.length]); return JSON.stringify({ accepted: true }); } });
  const got = await collectLiquidationPayouts({ listed, seed, curve: pageCurve, clientFor, storage });
  assert.deepEqual([got.length, got[0].ok, refunds], [1, true, [[SAFE, 1, a.payoutPk, 64]]], 'only its own, in the federation it was paid in');
  await collectLiquidationPayouts({ listed, seed, curve: pageCurve, clientFor, storage });
  assert.equal(refunds.length, 1, 'once');
  const doors = await serveArbiter({ set: { network: 'regtest', k: 5, members: [] }, allow: () => ({ ok: false }), liquidationPayouts: () => listed.payouts });
  try { const j = await (await fetch(`http://127.0.0.1:${doors.port}/liquidation-payouts?federation=${FED}`)).json(); assert.equal(j.payouts.length, 2); }
  finally { await doors.close(); }
});

test('the client presents its outputs still in issuance too: once, kept until taken, and "claimed before" counts as taken', async () => {
  const { presentNotes, pendingRequestsKey } = await import('../../arena-client/src/liquidation-claim.js');
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let asked = 0; const posts = [];
  const walletFor = async () => ({ sendAllEcash: async () => JSON.stringify({ msat: 0, ecash: null }),
    pendingOutputs: async () => { asked++; return JSON.stringify([{ nonce: '02aa', amount_msat: 8192, request: 'r1' }, { nonce: '03bb', amount_msat: 4096, request: 'r2' }]); } });
  let mode = 'down';
  const fetcher = async (url, o) => { const b = JSON.parse(o.body); posts.push(b); if (mode === 'down') throw new Error('fetch failed');
    return mode === 'ok' ? { ok: true, json: async () => ({ accepted: b.pending.map((r) => ({ request: r })) }) }
      : { ok: false, json: async () => ({ refused: b.pending.map(() => ({ why: 'that output was claimed before' })) }) }; };
  const liq = [{ ...LIQ, claims: 'https://arb.example/' }];
  const run = () => presentNotes({ liquidations: liq, held: [FED], walletFor, payoutPk: '02' + '11'.repeat(32), height: LIQ.liquidatesAt, storage, fetcher });
  const first = (await run()).find((x) => x.pending);
  assert.equal(first.ok, false); assert.deepEqual(JSON.parse(store.get(pendingRequestsKey(FED))), ['r1', 'r2'], 'kept before it left the page');
  mode = 'ok';
  const second = (await run()).find((x) => x.pending);
  assert.equal(second.ok, true); assert.equal(store.has(pendingRequestsKey(FED)), false, 'taken: forgotten');
  assert.equal(asked, 1, 'the kept requests were presented again, not read again');
  assert.deepEqual(posts.filter((p) => p.pending).map((p) => p.pending), [['r1', 'r2'], ['r1', 'r2']]);
  mode = 'refused';
  const third = (await run()).find((x) => x.pending);
  assert.equal(third.kept, false, 'claimed before: nothing left to keep');
});

test('a peg-in claimed outside a pass is read from the balance the client held before the escrow came (kanban #326)', async () => {
  const b = book(); b.at(1012);
  await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  let balance = 500_000; const v = {};
  const run = async (args) => {
    if (args[1] === 'balance') return { msat: balance };
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    // the claim went through by hand before this pass: the tool waits for a rise it never sees
    if (args[1] === 'pegin-claim') return { error: 'no claim within 840s' };
    if (args[1] === 'pay') return { txid: 'p', payouts: [] };
    return {}; };
  const pass = () => payOutLiquidation({ fid: FED, v, claims: b.claims, height: async () => 1021, run, spendEscrow: async () => ({ txid: 'x', sats: 9000 }) });
  assert.match((await pass()).why, /not claimed yet/, 'nothing yet');
  assert.equal(v.balanceBeforeClaimMsat, '500000', 'marked before the escrow was spent');
  balance = 500_000 + 8_990_000;
  await pass();
  assert.equal(v.claimedMsat, '8990000', 'the rise over the mark');
  const w = { escrowTxid: 'x', pegInAddress: 'a', escrowSats: '9000', balanceBeforeClaimMsat: '0' };
  balance = 50_000_000;
  const r = await payOutLiquidation({ fid: FED, v: w, claims: b.claims, height: async () => 1021, run, spendEscrow: async () => ({ txid: 'x' }) });
  assert.match(r.why, /not claimed yet/, 'never more than the escrow carried');
});
