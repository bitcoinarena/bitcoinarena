// §15 THE WALK-AWAY, MEASURED (read-only probe, M3.3-34's ENTRY_VOID piece): a
// player is joined at both signer nodes of a 2-of-2 - entry, handout and stake lock
// committed (or a free round) - and then:
//   (A) sends nothing at all                       paid (federation lock)
//   (B) sends the first mark at tick 60, then nothing   paid - the mid-run stop, for contrast
//   (C) sends nothing at all                       free round
// Both signer nodes close the round. Printed: what each signer node's replay stored or why not,
// the results each signer node holds, ENTRY_VOID / start-FORFEIT records, and the forfeit
// answer against the lock's expiry. Harness: closed-claim-probe.mjs's.
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from '../test/assignment.js';
import { lockPort } from '../test/lock-fixture.js';
import { b32, rand, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait, RANDOMNESS } from '../test/window-fixture.js';
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
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));

async function signerNodes({ free = false } = {}) {
  const port = lockPort();
  const mk = (db) => serve(db, { port: 0, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const a = await mk(openStore(':memory:'));
  const b = await mk(openStore(':memory:'));
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
  }
  let c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  if (free) c = { ...c, stakeMsat: 0n, federationId: new Uint8Array(32) };
  const rid = roundId(c);
  for (const d of [a, b]) {
    await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeAssigned(d.round, rid, c.nodes);
  }
  if (!free) for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return { a, b, c, rid, port, free, claimPk: free ? null : a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey,
    async close() { await a.close(); await b.close(); } };
}

async function joinAndBuild(w) {
  const session = ed25519.utils.randomSecretKey();
  const outpoint = { txid: rand(32), outIdx: 0n };
  let entry;
  let fields = null;
  let dealt = null;
  if (w.free) {
    entry = { roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
      vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
      stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: new Uint8Array(32) };
  } else {
    const preimage = secretScalar();
    const e = rand(32);
    dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
    entry = { roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
      joinTick: 0, worldSecret: WINNER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
      feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: b32(0x9a) };
    fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
      refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
  }
  const eid = entryId(entry);
  const joined = [];
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    if (dealt) await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    joined.push((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
    if (fields) joined.push((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status);
  }
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < 60; t++) step(st, ...wordsAt(t));
  const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [] };
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  return { eid, fields, joined, firstId: checkpointId(m1), start: [encodeInputBatch(b1), joinSigned(encodeCheckpoint(m1), ed25519.sign(checkpointId(m1), session))] };
}

async function closeAndLook(w, run) {
  await Promise.all([w.a, w.b].map((d) => say(d.port, `close ${toHex(w.rid)}`)));
  const replayed = await Promise.all([w.a, w.b].map(async (d) => {
    try {
      const s = await d.verifier.settling;
      return (s && s.replayed || []).map((r) => (r ? { stored: r.stored, outcome: r.outcome, score: r.score, why: r.why ? String(r.why).slice(0, 150) : undefined } : r));
    } catch (e) { return [{ error: e.message }]; }
  }));
  // WAIT FOR FINALITY: until the forfeit door stops saying "before the result is final", up to 20 s.
  const waited = Date.now();
  for (; Date.now() - waited < 20000; await wait(250)) {
    if (!run.fields) { if ([w.a, w.b].every((d) => resultFinality(d.round, w.rid, run.eid).state === 'FINAL')) break; continue; }
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
  await wait(500);
  const signerNode = (d) => ({
    results: d.round.results(w.rid, run.eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }),
    finality: resultFinality(d.round, w.rid, run.eid).state,
    entryVoid: !!d.round.entryVoid(run.eid), startForfeit: !!d.round.startForfeit(run.eid),
    holdsFirstMark: d.round.holdsMark(run.firstId), roundClosed: d.round.get(w.rid).state === 1 });
  let forfeit = 'free round: no lock';
  if (run.fields) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    forfeit = f.ok ? { status: 200 } : { status: f.status, why: (await f.text()).trim().slice(0, 150) };
  }
  return { joined: run.joined, replayed: { a: replayed[0], b: replayed[1] }, a: signerNode(w.a), b: signerNode(w.b), forfeit,
    lock: run.fields ? { expiration: run.fields.expiration, height: w.port.height, heldUntilExpiry: run.fields.expiration > w.port.height } : null };
}

for (const [name, free, sendFirst] of [['(A) paid, joined, sends nothing', false, false],
  ['(B) paid, first mark at 60, then nothing', false, true], ['(C) free, joined, sends nothing', true, false]]) {
  const w = await signerNodes({ free });
  try {
    const run = await joinAndBuild(w);
    if (sendFirst) for (const d of [w.a, w.b]) for (const m of run.start) await say(d.port, m);
    await wait(500);
    out({ case: name, ...(await closeAndLook(w, run)) });
  } catch (e) { out({ case: name, error: e.message, stack: String(e.stack).split('\n')[1] }); } finally { await w.close(); }
}
process.exit(0);
