// ENTRY_VOID (§16), THE OUTAGE REFUND, AT THE SIGNER NODES - AND THE LOCK BACK AT ONCE.
//
// "After commitment, before the first financial tick: if fewer than 5
// game/verify nodes are available, the entry becomes ENTRY_VOID and the stake
// is refunded by forfeit or by the stake lock's expiry (§23.2)." §23.2:
// "VOID / ENTRY_VOID: forfeit at once; if nobody acts, the lock expires."
//
// An ON-TIME first mark forwarded at once, and a signer node that did not answer: when
// the start deadline passes at the signer node holding it (the player's own mark past
// join + deadline), the first mark still short of 2 of 2 receipts, the entry is
// ENTRY_VOID there; a signer node that was down and comes back is shown the evidence
// and records the same Void, and the lock is forfeited to the player's refund
// key at once - both signer nodes sign, each on its own record. A signer node that comes back
// and is caught up by the player directly refuses the first mark too (§13C).
// Unchanged: a late first mark is FORFEIT. No mark at all is FORFEIT at the
// close (§15's walk-away, ruled 2026-09-12) - never ENTRY_VOID.
//
// MEASURED BEFORE (tools/outage-before.mjs, 3300558): (b) nothing recorded, no
// result, forfeit 409, a silent refund at expiry; (b') DELIVERED at both.
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { resultFinality } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { lockPort } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const END = WINNER.ticks;                      // 1320: past the 900 line; the run delivers here

async function signerNodes() {
  const port = lockPort();
  const mk = (db, p = 0) => serve(db, { port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const dbB = openStore(':memory:');
  const a = await mk(openStore(':memory:'));
  let b = await mk(dbB);
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  // THIS ROUND NAMES NO START DEADLINE: the page's own window, 900.
  const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return {
    a, get b() { return b; }, c, rid, port, claimPk: a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey,
    async downB() { await b.close(); },
    async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { await a.close(); try { await b.close(); } catch { /* down */ } },
  };
}

async function joinAndBuild(w, { firstAt = 60 } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: WINNER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    assert.equal((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
  }
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  const hashAt = (upTo, from) => { for (let t = from; t < upTo; t++) step(st, ...wordsAt(t)); return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))); };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const batchOf = (from, to, previousHash) => ({ roundId: w.rid, entryId: eid, previousHash, firstTick: from,
    ticks: Array.from({ length: to - from }, (_, t) => wordsAt(from + t)), liquidations: [] });
  const markOf = (tick, h, input, previousHash) => ({ roundId: w.rid, entryId: eid, tick, stateHash: h, inputChainHash: batchId(input), previousHash, sessionPubkey: entry.sessionPubkey });
  let messages;
  let firstId;
  if (firstAt < END) {
    const b1 = batchOf(0, firstAt, GENESIS_HASH);
    const m1 = markOf(firstAt, hashAt(firstAt, 0), b1, NO_PREVIOUS);
    const b2 = batchOf(firstAt, END, batchId(b1));
    const m2 = markOf(END, hashAt(END, firstAt), b2, checkpointId(m1));
    messages = [encodeInputBatch(b1), sign(m1), encodeInputBatch(b2), sign(m2)];
    firstId = checkpointId(m1);
  } else {
    const b1 = batchOf(0, END, GENESIS_HASH);
    const m1 = markOf(END, hashAt(END, 0), b1, NO_PREVIOUS);
    messages = [encodeInputBatch(b1), sign(m1)];
    firstId = checkpointId(m1);
  }
  return { entry, eid, outpoint, messages, firstId, fields };
}

const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.replace(/^(error [A-Z_]+).*/, '$1').slice(0, 60)) : 'receipt');
async function forfeitAt(d, w, run) {
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  if (!f.ok) return { status: f.status, verifies: false };
  const j = await f.json();
  return { status: 200, verifies: schnorr.verify(fromHex(j.signature), fromHex(j.contractId), w.claimPk.subarray(1)),
    isTheLocksId: j.contractId === String(await w.port.contractId(run.fields)) };
}
function recordAt(d, w, run) {
  const v = d.round.entryVoid(run.eid);
  const late = d.round.startForfeit(run.eid);
  return { recorded: v ? `ENTRY_VOID (${v.evidenceKind})` : (late ? 'FORFEIT' : null),
    results: [...new Set(d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome))],
    finality: resultFinality(d.round, w.rid, run.eid).state };
}
async function closeAndSettle(w, run) {
  await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
  for (let t = Date.now(); Date.now() - t < 15000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
}
const until = async (fn, ms = 8000) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) if (fn()) return true; return false; };

test('(a) an on-time first mark with both signer nodes up: nothing recorded, DELIVERED, the qualifier forfeit as before', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    for (const m of run.messages) for (const d of [w.a, w.b]) await say(d.port, m);
    await closeAndSettle(w, run);
    const facts = { a: recordAt(w.a, w, run), b: recordAt(w.b, w, run), forfeit: await forfeitAt(w.a, w, run) };
    console.log('  FACTS (a):', JSON.stringify(facts));
    assert.deepEqual(facts, { a: { recorded: null, results: ['DELIVERED'], finality: 'FINAL' },
      b: { recorded: null, results: ['DELIVERED'], finality: 'FINAL' }, forfeit: { status: 200, verifies: true, isTheLocksId: true } });
  } finally { await w.close(); }
});

test('(b) an on-time first mark that missed a down signer node is ENTRY_VOID at both signer nodes, and the lock is forfeited to the player at once', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    const saidA = [];
    for (const m of run.messages) saidA.push(answer(await say(w.a.port, m)));
    await until(() => w.a.round.entryVoid(run.eid));
    const atA = recordAt(w.a, w, run);
    const offersAtA = Object.values(w.a.round.firstMarkOffers(run.eid));
    await w.upB();
    const bBefore = recordAt(w.b, w, run);
    // THE REFUND AT ONCE: asked of A, with no result and no finality anywhere.
    const forfeit = await forfeitAt(w.a, w, run);
    const facts = { saidA, receiptsOfTheFirstMarkAtA: w.a.round.receiptCount(run.firstId), offersAtA, atA, bBefore,
      bAfter: recordAt(w.b, w, run), forfeit, bKeepsIt: !!w.b.round.forfeit(run.eid) };
    console.log('  FACTS (b):', JSON.stringify(facts));
    assert.deepEqual(facts, { saidA: ['60', 'receipt', '1260', 'receipt'], receiptsOfTheFirstMarkAtA: 1, offersAtA: ['unanswered'],
      atA: { recorded: 'ENTRY_VOID (mark)', results: [], finality: null },
      bBefore: { recorded: null, results: [], finality: null },
      bAfter: { recorded: 'ENTRY_VOID (mark)', results: [], finality: null },
      forfeit: { status: 200, verifies: true, isTheLocksId: true }, bKeepsIt: true });
  } finally { await w.close(); }
});

test("(b') the player catches the down signer node up after seeing the run: it refuses the first mark as ENTRY_VOID - nothing is DELIVERED", async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    for (const m of run.messages) await say(w.a.port, m);
    await until(() => w.a.round.entryVoid(run.eid));
    await w.upB();
    const saidB = [];
    for (const m of run.messages) saidB.push(answer(await say(w.b.port, m)));
    await closeAndSettle(w, run);
    const facts = { saidB, a: recordAt(w.a, w, run), b: recordAt(w.b, w, run), bHoldsTheFirstMark: w.b.round.holdsMark(run.firstId),
      forfeit: await forfeitAt(w.b, w, run) };
    console.log("  FACTS (b'):", JSON.stringify(facts));
    assert.equal(facts.saidB[1], 'error ENTRY_VOID');
    assert.deepEqual({ ...facts, saidB: undefined }, { saidB: undefined,
      a: { recorded: 'ENTRY_VOID (mark)', results: [], finality: null },
      b: { recorded: 'ENTRY_VOID (mark)', results: [], finality: null },
      bHoldsTheFirstMark: false, forfeit: { status: 200, verifies: true, isTheLocksId: true } });
  } finally { await w.close(); }
});

test('(c) a late first mark is still FORFEIT at both signer nodes - never Void, never a refund; (d) no mark is FORFEIT at the close, never Void', async () => {
  const w = await signerNodes();
  try {
    const late = await joinAndBuild(w, { firstAt: END });
    for (const m of late.messages) await say(w.a.port, m);
    await until(() => w.b.round.startForfeit(late.eid));
    const none = await joinAndBuild(w);
    await closeAndSettle(w, late);
    // WAITED ON, NOT RACED: the late start is now signed and final at once, so
    // the wait above ends before the no-mark entry need be FINAL at both signer nodes
    // (measured in the full suite: A PROVISIONALLY_FINAL, B FINAL). Both are read
    // once both are FINAL - the values asserted are unchanged.
    await until(() => [w.a, w.b].every((d) => resultFinality(d.round, w.rid, none.eid).state === 'FINAL'), 15000);
    const facts = { late: { a: recordAt(w.a, w, late), b: recordAt(w.b, w, late), forfeit: (await forfeitAt(w.a, w, late)).status },
      noMark: { a: recordAt(w.a, w, none), b: recordAt(w.b, w, none), forfeit: (await forfeitAt(w.a, w, none)).status,
        lockHeld: w.port.locks.has(`${toHex(none.outpoint.txid)}:${none.outpoint.outIdx}`) } };
    console.log('  FACTS (c, d):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      // (c) ruled 2026-09-12 (M3.3-34, late start at close): measured before,
      // no result at either signer node, finality null.
      late: { a: { recorded: 'FORFEIT', results: ['FORFEIT'], finality: 'FINAL' }, b: { recorded: 'FORFEIT', results: ['FORFEIT'], finality: 'FINAL' }, forfeit: 409 },
      // (d) ruled 2026-09-12 (§15): measured before, no result at either signer node.
      noMark: { a: { recorded: null, results: ['FORFEIT'], finality: 'FINAL' }, b: { recorded: null, results: ['FORFEIT'], finality: 'FINAL' }, forfeit: 409, lockHeld: true } });
  } finally { await w.close(); }
});

test('(e) a player who sends the first mark to one signer node while the other is up gets no Void: the forward reaches it', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await say(w.a.port, run.messages[0]);
    await say(w.a.port, run.messages[1]);
    await until(() => w.b.round.holdsMark(run.firstId));
    await say(w.a.port, run.messages[2]);
    await say(w.a.port, run.messages[3]);
    await wait(500);
    const facts = { bHoldsTheFirstMark: w.b.round.holdsMark(run.firstId), receiptsAtA: w.a.round.receiptCount(run.firstId),
      a: w.a.round.entryVoid(run.eid) ? 'ENTRY_VOID' : null, b: w.b.round.entryVoid(run.eid) ? 'ENTRY_VOID' : null };
    console.log('  FACTS (e):', JSON.stringify(facts));
    assert.deepEqual(facts, { bHoldsTheFirstMark: true, receiptsAtA: 2, a: null, b: null });
  } finally { await w.close(); }
});

// WHEN THE PLAYER'S CHAIN NEVER PASSES THE START LINE: the signer node holding the
// on-time first mark decides at its close ("closed"), and a signer node that does not
// hold the first mark takes a round signer node's closed Void - proven by that signer node's
// own signed receipt of this first mark - and refuses the mark itself (pick (1)).
// MEASURED BEFORE (tools/closed-line-probe.mjs): (ii) forfeit 409 while B was
// open; (iii) B took the player's first mark, recorded nothing, forfeit 409 -
// the lock only at expiry.
const closeAt = (d, w) => say(d.port, `close ${toHex(w.rid)}`);
const firstOnly = (run) => run.messages.slice(0, 2);

test('(i) the chain stops at 60 and A closes while B is down: ENTRY_VOID (closed) at both signer nodes, the lock back at once', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    for (const m of firstOnly(run)) await say(w.a.port, m);
    await wait(500);
    const aBeforeClose = recordAt(w.a, w, run);
    await closeAt(w.a, w);
    await until(() => w.a.round.entryVoid(run.eid));
    await w.upB();
    await closeAt(w.b, w);
    await wait(500);
    const forfeit = await forfeitAt(w.a, w, run);
    const facts = { aBeforeClose, a: recordAt(w.a, w, run), b: recordAt(w.b, w, run), forfeit };
    console.log('  FACTS (i):', JSON.stringify(facts));
    assert.deepEqual(facts, { aBeforeClose: { recorded: null, results: [], finality: null },
      a: { recorded: 'ENTRY_VOID (closed)', results: [], finality: null },
      b: { recorded: 'ENTRY_VOID (closed)', results: [], finality: null },
      forfeit: { status: 200, verifies: true, isTheLocksId: true } });
  } finally { await w.close(); }
});

test('(ii) the forfeit asked while the down signer node is back and still open: it takes the closed Void at once, the lock back at once', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    for (const m of firstOnly(run)) await say(w.a.port, m);
    await wait(500);
    await closeAt(w.a, w);
    await until(() => w.a.round.entryVoid(run.eid));
    await w.upB();
    const bOpen = w.b.round.get(w.rid).state === 0;
    const forfeit = await forfeitAt(w.a, w, run);
    const facts = { bOpen, a: recordAt(w.a, w, run), b: recordAt(w.b, w, run), forfeit, bKeepsIt: !!w.b.round.forfeit(run.eid) };
    console.log('  FACTS (ii):', JSON.stringify(facts));
    assert.deepEqual(facts, { bOpen: true, a: { recorded: 'ENTRY_VOID (closed)', results: [], finality: null },
      b: { recorded: 'ENTRY_VOID (closed)', results: [], finality: null },
      forfeit: { status: 200, verifies: true, isTheLocksId: true }, bKeepsIt: true });
  } finally { await w.close(); }
});

test('(iii) the player sends the first mark to the down signer node once it is back and still open: refused as ENTRY_VOID, both signer nodes Void, the lock back at once', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    for (const m of firstOnly(run)) await say(w.a.port, m);
    await wait(500);
    await closeAt(w.a, w);
    await until(() => w.a.round.entryVoid(run.eid));
    await w.upB();
    const saidB = [];
    for (const m of firstOnly(run)) saidB.push(answer(await say(w.b.port, m)));
    const forfeit = await forfeitAt(w.a, w, run);
    const facts = { saidB, bHoldsTheFirstMark: w.b.round.holdsMark(run.firstId), a: recordAt(w.a, w, run), b: recordAt(w.b, w, run), forfeit };
    console.log('  FACTS (iii):', JSON.stringify(facts));
    assert.deepEqual(facts, { saidB: ['60', 'error ENTRY_VOID'], bHoldsTheFirstMark: false,
      a: { recorded: 'ENTRY_VOID (closed)', results: [], finality: null },
      b: { recorded: 'ENTRY_VOID (closed)', results: [], finality: null },
      forfeit: { status: 200, verifies: true, isTheLocksId: true } });
  } finally { await w.close(); }
});

// ONE SIGNER NODE'S WORD IS NOT A VOID AT THE OTHER (§16, §13C). A signer node that does not
// hold the first mark records a round signer node's closed ENTRY_VOID only with the
// PLAYER'S OWN signed first mark in hand - never with a mark a signer node made up.
// MEASURED BEFORE (tools/closed-claim-probe.mjs): an invented first mark with
// A's own receipt over it and "closed" -> B recorded ENTRY_VOID (closed), and
// with A's side planted the lock was forfeited at once (200), though the
// player never sent a mark.
test('(f) a signer node cannot void the other signer node\'s entry with an invented first mark and its own receipt: no Void, no forfeit, the lock held', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    const { encodeCheckpointReceipt, receiptId, joinSignedReceipt } = await import('../../protocol/src/receipt.js');
    const receiptBy = (d, id) => {
      const r = { checkpointId: id, receivedAtMs: BigInt(Date.now()), nodePubkey: d.round.pubkey };
      return joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), d.round.identity.secret));
    };
    const post = async (body) => {
      const r = await fetch(`http://127.0.0.1:${w.b.port}/first-mark`, { method: 'POST', body: JSON.stringify(body) });
      let j;
      try { j = await r.json(); } catch { j = {}; }
      return { status: r.status, entryVoid: !!j.entryVoid };
    };
    // A CLAIM AND A RECEIPT, NO MARK.
    const noMark = await post({ receipt: toHex(receiptBy(w.a, run.firstId)), entryVoid: { kind: 'closed', evidence: null } });
    // A MARK A SIGNER NODE MADE UP: the right entry, tick 60, signed by a key that is not the player's.
    const fakeKey = ed25519.utils.randomSecretKey();
    const fake = { roundId: w.rid, entryId: run.eid, tick: 60, stateHash: rand(32), inputChainHash: GENESIS_HASH,
      previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(fakeKey) };
    const fakeBytes = joinSigned(encodeCheckpoint(fake), ed25519.sign(checkpointId(fake), fakeKey));
    const invented = await post({ mark: toHex(fakeBytes), batches: [], receipt: toHex(receiptBy(w.a, checkpointId(fake))),
      entryVoid: { kind: 'closed', evidence: null } });
    const b = recordAt(w.b, w, run);
    // A LYING SIGNER NODE CONTROLS ITS OWN STORE: its side of the Void, planted - the other signer node must still not sign.
    w.a.round.putEntryVoid({ entryId: run.eid, roundId: w.rid, firstMark: fakeBytes, evidenceKind: 'closed', evidence: null, why: 'planted by a lying signer node' });
    const forfeit = await forfeitAt(w.a, w, run);
    const facts = { noMark, invented, b, forfeit: forfeit.status,
      lockHeld: w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
    console.log('  FACTS (f):', JSON.stringify(facts));
    assert.deepEqual(facts, { noMark: { status: 400, entryVoid: false }, invented: { status: 409, entryVoid: false },
      b: { recorded: null, results: [], finality: null }, forfeit: 409, lockHeld: true });
  } finally { await w.close(); }
});
