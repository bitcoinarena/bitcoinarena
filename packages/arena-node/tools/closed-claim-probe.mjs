// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLOSED-CLAIM TRUST BOUNDARY (§16, §13C), MEASURED: can one signer node's word void an
// entry at the other signer node? Two in-process signer nodes of a lock round (deadline 900).
//   (1a) A's closed claim + A's own receipt, no mark        (1b) an invented first mark,
//        A's receipt over it, closed; A's side planted     (2) the honest closed-line case
//   (2') a live run: B up and open, the forward reaches it
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from '../test/assignment.js';
import { lockPort } from '../test/lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from '../test/window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const END = WINNER.ticks;
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const until = async (fn, ms = 8000) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) if (fn()) return true; return false; };

async function signerNodes() {
  const port = lockPort();
  const mk = (db, p = 0) => serve(db, { plugins: [NEXTBLOCK], port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const dbB = openStore(':memory:');
  const a = await mk(openStore(':memory:'));
  let b = await mk(dbB);
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  const rid = roundId(c);
  for (const d of [a, b]) {
    await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return { a, get b() { return b; }, c, rid, port, claimPk: a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey,
    async downB() { await b.close(); }, async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { await a.close(); try { await b.close(); } catch { /* down */ } } };
}

async function joinAndBuild(w) {
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
    await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
  }
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  const hashAt = (upTo, from) => { for (let t = from; t < upTo; t++) step(st, ...wordsAt(t)); return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))); };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const batchOf = (from, to, previousHash) => ({ roundId: w.rid, entryId: eid, previousHash, firstTick: from,
    ticks: Array.from({ length: to - from }, (_, t) => wordsAt(from + t)), liquidations: [] });
  const markOf = (tick, h, input, previousHash) => ({ roundId: w.rid, entryId: eid, tick, stateHash: h, inputChainHash: batchId(input), previousHash, sessionPubkey: entry.sessionPubkey });
  const b1 = batchOf(0, 60, GENESIS_HASH);
  const m1 = markOf(60, hashAt(60, 0), b1, NO_PREVIOUS);
  const b2 = batchOf(60, END, batchId(b1));
  const m2 = markOf(END, hashAt(END, 60), b2, checkpointId(m1));
  return { eid, outpoint, fields, firstId: checkpointId(m1),
    start: [encodeInputBatch(b1), sign(m1)], rest: [encodeInputBatch(b2), sign(m2)] };
}

const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.replace(/^(error [A-Z_]+).*/, '$1').slice(0, 70)) : 'receipt');
const signerNodeView = (d, w, run) => {
  const v = d.round.entryVoid(run.eid);
  return { stored: v ? `ENTRY_VOID (${v.evidenceKind})` : null, holdsFirstMark: d.round.holdsMark(run.firstId),
    receiptsOfFirstMark: d.round.receiptCount(run.firstId),
    results: [...new Set(d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome))],
    roundClosed: d.round.get(w.rid).state === 1 };
};
async function askForfeit(w, run) {
  const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  if (!f.ok) return { status: f.status, why: (await f.text()).trim().slice(0, 140) };
  const j = await f.json();
  return { status: 200, verifies: schnorr.verify(fromHex(j.signature), fromHex(j.contractId), w.claimPk.subarray(1)),
    overTheLocksId: j.contractId === String(await w.port.contractId(run.fields)),
    lockExpiryAhead: run.fields.expiration > w.port.height, keptBy: [w.a, w.b].map((d) => !!d.round.forfeit(run.eid)) };
}
const closeAt = (d, w) => say(d.port, `close ${toHex(w.rid)}`);

import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

// ---- THE CLOSED-CLAIM TRUST BOUNDARY (§16, §13C): can one signer node's word void an
// entry at the other signer node? B is up and open throughout (1a, 1b, 2'); in (2) it
// was down at the start, as the honest closed-line case measured before.

async function variant(name, body) {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    out({ case: name, ...(await body(w, run)) });
  } catch (e) { out({ case: name, error: e.message }); } finally { await w.close(); }
}
// A SIGNER NODE'S OWN SIGNED RECEIPT OVER ANY CHECKPOINT ID - what a lying signer node can always make.
const receiptBy = (d, id) => {
  const r = { checkpointId: id, receivedAtMs: BigInt(Date.now()), nodePubkey: d.round.pubkey };
  return joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), d.round.identity.secret));
};
const postFirstMark = async (d, body) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/first-mark`, { method: 'POST', body: JSON.stringify(body) });
  let j;
  try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, entryVoid: !!j.entryVoid, receipt: !!j.receipt, why: j.why ? String(j.why).slice(0, 110) : undefined };
};

await variant('(1a) A sends B only its closed claim and its own receipt - no mark at all', async (w, run) => {
  const said = await postFirstMark(w.b, { receipt: toHex(receiptBy(w.a, run.firstId)), entryVoid: { kind: 'closed', evidence: null } });
  return { bAnswer: said, b: signerNodeView(w.b, w, run) };
});

await variant("(1b) A invents a first mark - not the player's - signs its own receipt over it and claims closed; the player sent nothing", async (w, run) => {
  const fakeKey = ed25519.utils.randomSecretKey();
  const fake = { roundId: w.rid, entryId: run.eid, tick: 60, stateHash: rand(32), inputChainHash: GENESIS_HASH,
    previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(fakeKey) };
  const fakeBytes = joinSigned(encodeCheckpoint(fake), ed25519.sign(checkpointId(fake), fakeKey));
  const said = await postFirstMark(w.b, { mark: toHex(fakeBytes), batches: [], receipt: toHex(receiptBy(w.a, checkpointId(fake))),
    entryVoid: { kind: 'closed', evidence: null } });
  const b = signerNodeView(w.b, w, run);
  // A LYING SIGNER NODE CONTROLS ITS OWN STORE: its side of the Void, planted.
  w.a.round.putEntryVoid({ entryId: run.eid, roundId: w.rid, firstMark: fakeBytes, evidenceKind: 'closed', evidence: null, why: 'planted by a lying signer node' });
  const forfeit = await askForfeit(w, run);
  return { bAnswer: said, b, forfeit, lockExpiryHeight: run.fields.expiration, federationHeight: w.port.height };
});

await variant("(2) honest: the player's real on-time first mark reached A only (B down), A closed; B back and open is sent it by the player", async (w, run) => {
  await w.downB();
  for (const m of run.start) await say(w.a.port, m);
  await wait(500);
  await closeAt(w.a, w);
  await until(() => w.a.round.entryVoid(run.eid));
  await w.upB();
  const saidB = [];
  for (const m of run.start) saidB.push(answer(await say(w.b.port, m)));
  const forfeit = await askForfeit(w, run);
  return { saidB, a: signerNodeView(w.a, w, run), b: signerNodeView(w.b, w, run), forfeit };
});

await variant("(2') live run: both signer nodes up and open; the player's first mark reaches only A, then the run goes to both", async (w, run) => {
  for (const m of run.start) await say(w.a.port, m);
  await until(() => w.b.round.holdsMark(run.firstId));
  for (const m of run.rest) for (const d of [w.a, w.b]) await say(d.port, m);
  await Promise.all([closeAt(w.a, w), closeAt(w.b, w)]);
  for (let t = Date.now(); Date.now() - t < 15000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
  return { a: signerNodeView(w.a, w, run), b: signerNodeView(w.b, w, run), forfeit: await askForfeit(w, run) };
});
process.exit(0);
