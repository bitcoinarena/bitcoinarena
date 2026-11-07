// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLAIMS ON A HALTED FEDERATION'S ESCROW (§23A.5 steps 2-4): the arbitration set's book, its doors, the
// offline note check's parsing, and the client that presents its notes - the federation's validation stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { createLiquidationClaims, payOutLiquidation, escrowCoverageMsat } from '../src/liquidation-claims.js';
import { notesOfDecoded, fedimintNoteValidator } from '../src/note-validate.js';
import { serveArbiter } from '../src/arbiter.js';
import { presentNotes, pendingClaimKey } from '../../arena-client/src/liquidation-claim.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';

const FED = 'ab'.repeat(32);
const P1 = '02' + '11'.repeat(32), P2 = '02' + '22'.repeat(32);
const NOTES = { e1: [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 512000n }, { nonce: '02' + 'a2'.repeat(32), amountMsat: 256000n }],
  e2: [{ nonce: '02' + 'b1'.repeat(32), amountMsat: 1024000n }], e3: [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 512000n }],
  e4: [{ nonce: '02' + 'c1'.repeat(32), amountMsat: 128000n }] };
// THE ARBITRATION SET a client checks the liquidation against (kanban #1148): three keys, two signatures
const SET = (() => {
  const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
  return { terms: { keys, k: 2 }, verify: (sig, msg, key) => schnorr.verify(sig, msg, key),
    sign: (event) => ({ event, signatures: secrets.slice(0, 2).map((x, i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(event), x)) })) }) };
})();
const LIQ = { federation: FED, haltHeight: 1000, liquidatesAt: 1010, claimWindowCloses: 1100, lateClaimsUntil: 1100, spentNonces: ['02' + 'c1'.repeat(32)] };

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
  assert.deepEqual([late.ok, late.inWindow], [true, true], 'the window runs 3 months from the halt (regtest 100 blocks): 1050 is in it');
  b.at(1101);
  assert.match((await b.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P1 })).why, /claims closed at 1100/);
  assert.equal(b.saved.at(-1).length, 3, 'the book is kept');
});

test('the table: every valid note at face value; a short escrow pays in the order claimed, never pro rata; the remainder split only after the window', async () => {
  const big = book(); big.at(1012);
  await big.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 }); await big.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P2 });
  const p = await big.claims.plan(FED);
  assert.deepEqual([p.ok, p.proRata, p.payouts.find((x) => x.payoutPk === P1).msat, p.payouts.find((x) => x.payoutPk === P2).msat, p.split], [true, false, '768000', '1024000', null]);
  big.at(1100); assert.equal((await big.claims.plan(FED)).split, null, 'not while a player may still claim');
  big.at(1101); assert.equal((await big.claims.plan(FED)).split.reserves, String(10_000_000n - 1_792_000n));
  const short = book({ escrowMsat: 896_000n }); short.at(1012);
  await short.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 }); await short.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P2 });
  const q = await short.claims.plan(FED);
  assert.deepEqual([q.proRata, q.short, q.payouts.find((x) => x.payoutPk === P1).msat, q.payouts.find((x) => x.payoutPk === P2).msat], [false, true, '768000', '128000'], 'the first claim at face, the second gets what is left');
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

test('the client presents its whole wallet once at the signed door, keeps the e-cash until the set lists it, and presents the same string again after a failure (kanban #1148)', async () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let sends = 0, up = false; const posted = [];
  const walletFor = async () => ({ sendAllEcash: async () => { sends++; return JSON.stringify({ msat: 768000, ecash: 'e1' }); } });
  const fetcher = async (url, o) => { posted.push([url, JSON.parse(o.body).ecash]); if (!up) throw new Error('fetch failed'); return { ok: true, json: async () => ({ accepted: [1, 2], inWindow: true }) }; };
  const signed = (extra = {}) => [SET.sign({ kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null }, door: 'http://arb.example', firstMs: 1, atMs: 1, ...extra })];
  const o = { network: 'regtest', arbitration: SET.terms, verify: SET.verify, held: [FED], walletFor, payoutPk: P1, height: 1012, storage, fetcher };
  const first = await presentNotes({ ...o, events: signed() });
  assert.deepEqual([first[0].ok, first[0].kept, JSON.parse(store.get(pendingClaimKey(FED))).state, JSON.parse(store.get(pendingClaimKey(FED))).ecash], [false, true, 'kept', 'e1'], 'kept when the post failed');
  up = true;
  const again = await presentNotes({ ...o, events: signed() });
  assert.deepEqual([again[0].ok, again[0].kept, sends, JSON.parse(store.get(pendingClaimKey(FED))).state], [true, true, 1, 'posted'], 'the same string, sent from storage, and kept: an answer is no receipt');
  assert.deepEqual(posted.map((p) => p[0]), ['http://arb.example/liquidation-claims', 'http://arb.example/liquidation-claims']);
  // TAKEN only when the set's signed event lists this payout key as accepted
  const listed = await presentNotes({ ...o, events: signed({ atMs: 2, claims: { accepted: [{ nonce: 'n1', amountMsat: '768000', height: 1012, payoutPk: P1 }], refused: [], msat: '768000' } }) });
  assert.deepEqual([listed[0].taken, store.has(pendingClaimKey(FED))], [true, false]);
  assert.equal((await presentNotes({ ...o, events: signed(), held: ['ef'.repeat(32)] })).length, 0, 'a federation this browser holds nothing in');
  assert.match((await presentNotes({ ...o, events: signed(), height: 1005 }))[0].why, /claims open at 1010/);
});

test('the table paid when claimed (kanban #1093 part 8): nothing before the window opens; then the escrow into the safe federation, every note once, a late one by a later pass', async () => {
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
  let h = 1005; const tip = () => h;
  assert.match((await pass()).why, /claim window opens at 1010/);
  h = 1012;
  const first = await pass();
  assert.deepEqual([first.paid, spent, v.escrowTxid, v.claimedMsat, v.payouts.map((x) => [x.payoutPk, x.msat])], [2, 1, 'escrow-into-safe', '9000000', [[P1, '768000']]]);
  assert.deepEqual((await pass()), { paid: 0, notes: 2 }, 'nothing paid twice');
  b.at(1050); await b.claims.offer({ federation: FED, ecash: 'e2', payoutPk: P2 });
  const late = await pass();
  assert.deepEqual([late.paid, spent, v.payouts.at(-1).payoutPk, v.payouts.at(-1).msat], [1, 1, P2, '1024000'], 'a later claim paid at its own pass, the escrow spent once');
});

test('after the claim window the remainder is paid once to its payees, never before every note is', async () => {
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
  const remainderPayees = async (_fid, msat) => [{ key: 'aa'.repeat(32), msat, part: 'reserves' }];
  const pass = () => payOutLiquidation({ fid: FED, v, claims: b.claims, height: async () => h, run, spendEscrow: async () => ({ txid: 'x' }), remainderPayees });
  await pass();
  assert.equal(pays.length, 1, 'the notes first');
  assert.deepEqual(await pass(), { paid: 0, notes: 2 }, 'no remainder while the window runs');
  b.at(1100); h = 1100;
  assert.deepEqual(await pass(), { paid: 0, notes: 2 }, 'nor at its last block');
  b.at(1101); h = 1101;
  const r = await pass();
  assert.deepEqual([r.remainder, pays.length, pays[1]], ['1232000', 2, `${'aa'.repeat(32)}:1232000`]);
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
  b.at(1101); h = 1101;
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

test('the client presents its outputs still in issuance too: once, at the signed door, kept until the set lists the claim (kanban #1148)', async () => {
  const { presentNotes, pendingRequestsKey } = await import('../../arena-client/src/liquidation-claim.js');
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let asked = 0; const posts = [];
  const walletFor = async () => ({ sendAllEcash: async () => JSON.stringify({ msat: 0, ecash: null }),
    pendingOutputs: async () => { asked++; return JSON.stringify([{ nonce: '02aa', amount_msat: 8192, request: 'r1' }, { nonce: '03bb', amount_msat: 4096, request: 'r2' }]); } });
  let mode = 'down';
  const fetcher = async (url, o) => { const b = JSON.parse(o.body); posts.push([url, b]); if (mode === 'down') throw new Error('fetch failed');
    return mode === 'ok' ? { ok: true, json: async () => ({ accepted: b.pending.map((r) => ({ request: r })) }) }
      : { ok: false, json: async () => ({ refused: b.pending.map(() => ({ why: 'that output was claimed before' })) }) }; };
  const PK = '02' + '11'.repeat(32);
  const ev = (extra = {}) => [SET.sign({ kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null }, door: 'http://arb.example', firstMs: 1, atMs: 1, ...extra })];
  const run = (events = ev()) => presentNotes({ events, network: 'regtest', arbitration: SET.terms, verify: SET.verify, held: [FED], walletFor, payoutPk: PK, height: LIQ.liquidatesAt, storage, fetcher });
  const first = (await run()).find((x) => x.pending);
  assert.equal(first.ok, false); assert.deepEqual(JSON.parse(store.get(pendingRequestsKey(FED))).reqs, ['r1', 'r2'], 'kept before it left the page');
  mode = 'ok';
  const second = (await run()).find((x) => x.pending);
  assert.equal(second.ok, true); assert.equal(JSON.parse(store.get(pendingRequestsKey(FED))).state, 'posted', 'an answer is no receipt: kept until the set lists it');
  assert.equal(asked, 1, 'the kept requests were presented again, not read again');
  assert.deepEqual(posts.filter((p) => p[1].pending).map((p) => [p[0], p[1].pending]), [['http://arb.example/liquidation-claims', ['r1', 'r2']], ['http://arb.example/liquidation-claims', ['r1', 'r2']]]);
  await run(ev({ atMs: 2, claims: { accepted: [{ nonce: '02aa', amountMsat: '8192', height: 1010, payoutPk: PK }], refused: [], msat: '8192' } }));
  assert.equal(store.has(pendingRequestsKey(FED)), false, 'taken: the set listed this key');
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

// ---- kanban #1174: THE TABLE'S PAYOUTS, ONCE, WHATEVER STOPS ----
// THE TOOL AS IT IS NOW: a keyed pay submits once per key and answers it again; pay-sent reads it back. `lose` answers are lost after the tool
// paid (a crash, a timeout); `old` a tool from before #1174 (no key, no pay-sent). The state `v` is reloaded from what keep() wrote, as a restart does
function liqTool({ lose = 0, old = false, heldMsat = 9_000_000 } = {}) {
  const pays = [], byKey = new Map();
  let lost = lose;
  const rows = (arg) => arg.split(',').map((x, i) => ({ refund_pk: x.split(':')[0], amount_msat: Number(x.split(':')[1]), out_idx: i }));
  const run = async (args) => {
    const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 9_000_000 };
    if (args[1] === 'balance') return { msat: heldMsat - pays.reduce((a, p) => a + p.msat, 0) };
    if (args[1] === 'pay-sent') {
      if (old) return { error: 'no mode pay-sent' };
      const k = at('--key');
      return byKey.has(k) ? { mode: 'pay-sent', found: true, txid: byKey.get(k), payouts: rows(at('--payouts')) } : { mode: 'pay-sent', found: false };
    }
    if (args[1] === 'pay') {
      const key = old ? null : at('--key');
      if (key && byKey.has(key)) return { txid: byKey.get(key), payouts: rows(at('--payouts')), again: true };
      const txid = `pay${pays.length + 1}`;
      pays.push({ payouts: at('--payouts'), msat: rows(at('--payouts')).reduce((a, x) => a + x.amount_msat, 0) });
      if (key) byKey.set(key, txid);
      if (lost > 0) { lost--; return { error: 'the tool did not answer in 300 s (killed)' }; }
      return { txid, payouts: rows(at('--payouts')) };
    }
    return {};
  };
  return { run, pays };
}

test('kanban #1174: a note batch and the remainder whose tool paid and whose answer was lost are paid once - ASKED on disk first, read back by its key', async () => {
  const facts = {};
  // `restart`: every pass starts from what keep() last wrote
  const passes = ({ b, tool, h, remainderPayees = null, n, start = '{}' }) => {
    let disk = start, v = {};
    const keep = () => { disk = JSON.stringify(v); };
    const said = [];
    const go = async () => { for (let i = 0; i < n; i++) { v = JSON.parse(disk); const r = await payOutLiquidation({ fid: FED, v, claims: b.claims, height: async () => h(), run: tool.run,
      spendEscrow: async () => ({ txid: 'escrow-into-safe' }), remainderPayees, keep }); if (r.why) said.push(r.why.replace(/liq-[a-z]+:[0-9a-f]+(:\d+)?/g, '<key>').slice(0, 240)); } return { v: JSON.parse(disk), said: [...new Set(said)], disk }; };
    return go();
  };
  for (const [name, o] of [['notesLost', { lose: 1 }], ['notesOldTool', { lose: 1, old: true }]]) {
    const b = book(); b.at(1012);
    await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
    const tool = liqTool(o);
    const r = await passes({ b, tool, h: () => 1012, n: 3 });
    facts[name] = { pays: tool.pays.length, paidNonces: (r.v.paidNonces || []).length, payoutsKept: (r.v.payouts || []).length, said: r.said };
  }
  // THE REMAINDER: every note paid, the window over, its pay's answer lost
  {
    const b = book(); b.at(1012);
    await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
    const remainderPayees = async (_fid, msat) => [{ key: 'aa'.repeat(32), msat, part: 'reserves' }];
    let h = 1021;
    const first = await passes({ b, tool: liqTool(), h: () => h, remainderPayees, n: 1 });
    b.at(1101); h = 1101;
    const tool = liqTool({ lose: 1, heldMsat: 9_000_000 - 768_000 });
    const r = await passes({ b, tool, h: () => h, remainderPayees, n: 3, start: first.disk });
    facts.remainderLost = { remainderPays: tool.pays.length, remainderTxid: r.v.remainderTxid || null, said: r.said };
  }
  console.log('  MEASURED #1174 liquidation:', JSON.stringify(facts));
  assert.deepEqual([facts.notesLost.pays, facts.notesLost.paidNonces, facts.notesLost.payoutsKept], [1, 2, 1], 'a lost answer paid the notes again');
  assert.equal(facts.notesOldTool.pays, 1, 'a tool that cannot read a key back paid the notes again');
  assert.ok(facts.notesOldTool.said.some((x) => /held, never paid twice/.test(x)), JSON.stringify(facts.notesOldTool.said));
  assert.deepEqual([facts.remainderLost.remainderPays, !!facts.remainderLost.remainderTxid], [1, true], 'a lost answer paid the remainder again');
});

test('kanban #1232: an escrow spend whose answer was lost is recorded first and taken by the next pass - the escrow spent once, the peg-in still claimed', async () => {
  const b = book(); b.at(1012);
  await b.claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  const runs = []; let v = {}; let spent = 0; let disk = '{}';
  const run = async (args) => { runs.push(args[1]);
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 9_000_000 };
    if (args[1] === 'pay') return { txid: `pay${runs.length}`, payouts: args[3].split(',').map((x, i) => ({ refund_pk: x.split(':')[0], amount_msat: Number(x.split(':')[1]), out_idx: i })) };
    return {}; };
  // the broadcast went out and its answer was lost (bitcoind restarted, the unit stopped): only what was kept before it is on disk
  const lost = async (addr, record) => { spent++; record({ txid: 'escrow-into-safe', hex: '02ab', input: { txid: 'cd'.repeat(32), vout: 1 }, sats: '10000' }); throw new Error('socket hang up'); };
  const again = async () => { spent++; return { why: 'the escrow output is spent or unknown' }; };
  const resumed = [];
  const keep = () => { disk = JSON.stringify(v); };
  const pass = (spendEscrow) => { v = JSON.parse(disk); return payOutLiquidation({ fid: FED, v, claims: b.claims, height: async () => 1012, run, spendEscrow, keep,
    resume: async (i) => { resumed.push(i.txid); return { ok: true, inferred: true }; } }); };
  await assert.rejects(pass(lost), /socket hang up/);
  assert.equal(JSON.parse(disk).escrowIntent.txid, 'escrow-into-safe', 'kept before the broadcast');
  const second = await pass(again);
  console.log('  MEASURED #1232 liquidation:', JSON.stringify({ spent, resumed, escrowTxid: v.escrowTxid, intentLeft: !!v.escrowIntent, paid: second.paid, claimedMsat: v.claimedMsat }));
  assert.deepEqual([spent, resumed, v.escrowTxid, v.pegInAddress, v.escrowIntent, v.claimedMsat], [1, ['escrow-into-safe'], 'escrow-into-safe', 'tb1qsafe', undefined, '9000000']);
});

test('kanban #1237 (ruled 2026-11-07, RES-4 part 2): no verified spent set - claims taken and told they wait, nothing paid inside the window; at its close paid against the empty set; a set that arrives pays at once', async () => {
  let tip = 1012, liq = { ...LIQ, spentNonces: null };
  const claims = createLiquidationClaims({ validate: async (_fid, e) => ({ ok: true, notes: NOTES[e], amountMsat: NOTES[e].reduce((a, n) => a + n.amountMsat, 0n) }),
    liquidationOf: async (fid) => (fid === FED ? liq : null), height: async () => tip, escrowMsatOf: async () => 10_000_000n, clocks: REGTEST_CLOCKS, save: () => {} });
  const offered = await claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  const runs = [];
  const run = async (args) => { runs.push(args[1]);
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 9_000_000 };
    if (args[1] === 'pay') return { txid: `pay${runs.length}`, payouts: args[3].split(',').map((x, i) => ({ refund_pk: x.split(':')[0], amount_msat: Number(x.split(':')[1]), out_idx: i })) };
    return {}; };
  const v = {};
  const pass = () => payOutLiquidation({ fid: FED, v, claims, height: async () => tip, run, spendEscrow: async () => ({ txid: 'escrow-into-safe', sats: '10000' }) });
  const inWindow = await pass();
  const paysInWindow = runs.filter((r) => r === 'pay').length;
  // the window closes with no set at all: paid against the empty set
  tip = 1101;
  const atClose = await pass();
  // a second federation-like case: the set arrives inside the window - paid at once, a nonce in it refused
  let tip2 = 1012; const liq2 = { ...LIQ, spentNonces: null };
  const claims2 = createLiquidationClaims({ validate: async (_fid, e) => ({ ok: true, notes: NOTES[e], amountMsat: NOTES[e].reduce((a, n) => a + n.amountMsat, 0n) }),
    liquidationOf: async (fid) => (fid === FED ? liq2 : null), height: async () => tip2, escrowMsatOf: async () => 10_000_000n, clocks: REGTEST_CLOCKS, save: () => {} });
  await claims2.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  const v2 = {}; const pass2 = () => payOutLiquidation({ fid: FED, v: v2, claims: claims2, height: async () => tip2, run, spendEscrow: async () => ({ txid: 'escrow-2', sats: '10000' }) });
  const waits2 = await pass2();
  liq2.spentNonces = ['02' + 'a2'.repeat(32)];
  const arrived = await pass2();
  console.log('  MEASURED #1237:', JSON.stringify({ offered: { ok: offered.ok, spentSetPublished: offered.spentSetPublished }, inWindow: inWindow.why, paysInWindow,
    atClose: { paid: atClose.paid, payouts: (v.payouts || []).map((x) => x.msat) }, withSet: { waited: !!waits2.why, paid: arrived.paid, payouts: (v2.payouts || []).map((x) => x.msat) } }));
  assert.equal(offered.ok, true); assert.equal(offered.spentSetPublished, false, 'the holder is told the claim waits for the spent set');
  assert.match(inWindow.why, /no verified spent set/); assert.equal(paysInWindow, 0, 'a note was paid with no verified spent set inside the window');
  assert.equal(atClose.paid, 2, 'at the close with no set, both notes are paid against the empty set');
  assert.match(waits2.why, /no verified spent set/);
  assert.equal(arrived.paid, 1, 'the set arrived: paid at once, the note spent in it refused');
  assert.deepEqual(v2.payouts.map((x) => x.msat), ['512000']);
});

test('kanban #1237: the client is told a taken claim waits for the federation\'s spent set', async () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const walletFor = async () => ({ sendAllEcash: async () => JSON.stringify({ msat: 768000, ecash: 'e1' }) });
  const answer = (spentSetPublished) => async () => ({ ok: true, json: async () => ({ accepted: [1, 2], inWindow: true, spentSetPublished }) });
  const events = [SET.sign({ kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null }, door: 'http://arb.example', firstMs: 1, atMs: 1 })];
  const o = { network: 'regtest', arbitration: SET.terms, verify: SET.verify, held: [FED], walletFor, payoutPk: P1, height: 1012, storage, events };
  const waits = await presentNotes({ ...o, fetcher: answer(false) });
  store.clear();
  const stands = await presentNotes({ ...o, fetcher: answer(true) });
  console.log('  MEASURED #1237 client:', JSON.stringify({ noSet: waits[0].waitsForSpentSet || false, withSet: stands[0].waitsForSpentSet || false }));
  assert.equal(waits[0].ok, true); assert.equal(waits[0].waitsForSpentSet, true);
  assert.equal(stands[0].waitsForSpentSet, undefined);
});

test('kanban #1247 (audit 3 MONEY-2): once the arbitration set\'s escrow is spent, the door still says what it pays - a census-key escrow carries no claim twice', async () => {
  let tip = 1012; const v = {};
  const liq = { ...LIQ };
  const escrowOnChain = { msat: 10_000_000n };
  const claims = createLiquidationClaims({ validate: async (_fid, e) => ({ ok: true, notes: NOTES[e], amountMsat: NOTES[e].reduce((a, n) => a + n.amountMsat, 0n) }),
    liquidationOf: async (fid) => (fid === FED ? liq : null), height: async () => tip,
    escrowMsatOf: async () => escrowCoverageMsat(v, escrowOnChain.msat), clocks: REGTEST_CLOCKS, save: () => {} });
  await claims.offer({ federation: FED, ecash: 'e1', payoutPk: P1 });
  const before = await claims.plan(FED);
  // the arbiter spends its escrow into the safe federation and claims 9,000,000 msat there: the output is gone from the chain
  Object.assign(v, { escrowTxid: 'escrow-into-safe', claimedMsat: '9000000' }); escrowOnChain.msat = 0n;
  const after = await claims.plan(FED);
  const oldWay = await (createLiquidationClaims({ validate: async (_fid, e) => ({ ok: true, notes: NOTES[e], amountMsat: NOTES[e].reduce((a, n) => a + n.amountMsat, 0n) }),
    liquidationOf: async (fid) => (fid === FED ? liq : null), height: async () => tip, escrowMsatOf: async () => 0n, clocks: REGTEST_CLOCKS, save: () => {} })).plan(FED);
  const sum = (p) => p.paidNotes.reduce((a, n) => a + BigInt(n.msat), 0n);
  console.log('  MEASURED #1247:', JSON.stringify({ before: String(sum(before)), afterSpend: String(sum(after)), spentOutputRead: String(sum(oldWay)), escrowMsat: after.escrowMsat }));
  assert.equal(sum(before), 768000n);
  assert.equal(sum(after), 768000n, 'after the spend the door said the claims were paid nothing');
  assert.equal(after.escrowMsat, '9000000');
  assert.equal(escrowCoverageMsat({ escrowTxid: 't', escrowSats: '9500' }, 0n), 9500000n, 'not claimed yet: the escrow\'s own amount');
  assert.equal(escrowCoverageMsat({}, 1234n), 1234n);
});
