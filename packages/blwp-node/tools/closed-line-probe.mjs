// ENTRY_VOID (§16) WHEN THE PLAYER'S CHAIN NEVER PASSES THE START LINE: the
// seat holding the on-time first mark can only decide at its round's close
// ("closed" evidence). Measured beside the come-back case, where the chain
// passes the line and the evidence is the player's own mark.
//
//   (b)   reference: B down, first mark 60 and a mark 1320 at A (past 900)
//   (i)   B down, first mark 60 only at A; A closes; B back, B closes; forfeit asked
//   (ii)  as (i), but the forfeit asked while B is back and still open; then B
//         closes and it is asked again
//   (iii) as (ii), and while B is back and still open the player sends B the
//         first mark directly; then B closes and the forfeit is asked
//
// Two in-process seats of a lock round, deadline omitted (900). Columns: what
// each seat stores, receipts of the first mark, the forfeit door, whether its
// signature verifies over the lock's id, and the lock's expiry still ahead.
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from '../test/seating.js';
import { lockPort } from '../test/lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from '../test/window-fixture.js';
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
const END = WINNER.ticks;
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const until = async (fn, ms = 8000) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) if (fn()) return true; return false; };

async function seats() {
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
  const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  const rid = roundId(c);
  for (const d of [a, b]) {
    await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeSeated(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return { a, get b() { return b; }, c, rid, port, claimPk: a.dkg.seatFor(c.nodes).pool.groupPublicKey,
    async downB() { await b.close(); }, async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { await a.close(); try { await b.close(); } catch { /* down */ } } };
}

async function seatAndBuild(w) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, seats: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
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
const seatView = (d, w, run) => {
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

async function variant(name, body) {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downB();
    out({ case: name, ...(await body(w, run)) });
  } catch (e) { out({ case: name, error: e.message }); } finally { await w.close(); }
}

await variant('(b) reference: chain passes the line at A (mark 1320)', async (w, run) => {
  for (const m of [...run.start, ...run.rest]) await say(w.a.port, m);
  await until(() => w.a.round.entryVoid(run.eid));
  const a = seatView(w.a, w, run);
  await w.upB();
  const forfeit = await askForfeit(w, run);
  return { a, bAfter: seatView(w.b, w, run), forfeit };
});

await variant('(i) chain stops at 60; A closes; B back and closed; forfeit asked', async (w, run) => {
  for (const m of run.start) await say(w.a.port, m);
  await wait(500);
  const aBeforeClose = seatView(w.a, w, run);
  await closeAt(w.a, w);
  await until(() => w.a.round.entryVoid(run.eid));
  const aAfterClose = seatView(w.a, w, run);
  await w.upB();
  await closeAt(w.b, w);
  await wait(500);
  const forfeit = await askForfeit(w, run);
  return { aBeforeClose, aAfterClose, bAfter: seatView(w.b, w, run), forfeit };
});

await variant('(ii) chain stops at 60; A closes; forfeit asked while B is back and open; then B closes', async (w, run) => {
  for (const m of run.start) await say(w.a.port, m);
  await wait(500);
  await closeAt(w.a, w);
  await until(() => w.a.round.entryVoid(run.eid));
  await w.upB();
  const whileBOpen = await askForfeit(w, run);
  const bWhileOpen = seatView(w.b, w, run);
  await closeAt(w.b, w);
  await wait(500);
  const afterBCloses = await askForfeit(w, run);
  return { a: seatView(w.a, w, run), whileBOpen, bWhileOpen, afterBCloses, bAfter: seatView(w.b, w, run) };
});

await variant('(iii) chain stops at 60; A closes; B back and open; the player sends B the first mark; B closes', async (w, run) => {
  for (const m of run.start) await say(w.a.port, m);
  await wait(500);
  await closeAt(w.a, w);
  await until(() => w.a.round.entryVoid(run.eid));
  await w.upB();
  const saidB = [];
  for (const m of run.start) saidB.push(answer(await say(w.b.port, m)));
  await wait(500);
  const bOpen = seatView(w.b, w, run);
  await closeAt(w.b, w);
  await wait(1500);
  const forfeit = await askForfeit(w, run);
  return { saidB, a: seatView(w.a, w, run), bOpen, bAfterClose: seatView(w.b, w, run), forfeit };
});
process.exit(0);
