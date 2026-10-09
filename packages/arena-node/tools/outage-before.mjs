// ENTRY_VOID (§16, THE OUTAGE REFUND), MEASURED BEFORE ANY CODE.
//
// "After commitment, before the first financial tick: if fewer than 5
// game/verify nodes are available, the entry becomes ENTRY_VOID and the stake
// is refunded by forfeit or by the stake lock's expiry (§23.2)." What does a
// 2-of-2 record today when an ON-TIME first mark reaches too few signer nodes because
// a signer node is down - and, beside it, the cases that must not move?
//
//   (a)  on-time first mark (60), both signer nodes up
//   (b)  on-time first mark, signer node B down; the player plays on at A; B comes back
//        and is never sent the mark
//   (b') the same, and the player catches B up afterwards (the §13C question)
//   (c)  late first mark (1320 > 900): FORFEIT, never Void
//   (d)  no mark: neither
//
// Two in-process signer nodes of a lock round; the fixture's delivering winner (join
// tick 0); the round names no start deadline (900).
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { resultFinality } from '../src/finality.js';
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
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const curve = { ...feldmanGroup, tweakPoint };
const END = WINNER.ticks;
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));

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
  return { entry, eid, outpoint, messages, firstId };
}

async function outcomeAt(d, w, run) {
  const results = [...new Set(d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome))];
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  const voidTable = d.round.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'entry_voids'").get();
  const lateStart = d.round.startForfeit(run.eid);
  return {
    holdsFirstMark: d.round.holdsMark(run.firstId), receiptsOfFirstMark: d.round.receiptCount(run.firstId),
    recorded: lateStart ? `FORFEIT at ${lateStart.markTick}` : (voidTable ? 'entry_voids table exists' : 'nothing (no ENTRY_VOID record exists anywhere)'),
    results, finality: resultFinality(d.round, w.rid, run.eid).state,
    forfeitDoor: f.status, why: f.ok ? 'granted' : (await f.text()).trim().slice(0, 90),
    lockHeld: w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`),
  };
}
async function settle(w, run) {
  await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
  for (let t = Date.now(); Date.now() - t < 15000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
  await wait(500);
}
const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.slice(0, 60)) : 'receipt');

const cases = [
  ['a  on-time first mark, both signer nodes up', { firstAt: 60, down: false }],
  ['b  on-time first mark, B down at the start, never sent it after', { firstAt: 60, down: true }],
  ["b' on-time first mark, B down at the start, the player catches B up after", { firstAt: 60, down: true, catchUp: true }],
  ['c  late first mark (1320 > 900)', { firstAt: END, down: false }],
  ['d  no mark', { firstAt: 60, down: false, noMark: true }],
];
for (const [name, k] of cases) {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { firstAt: k.firstAt });
    if (k.down) await w.downB();
    const saidA = [];
    const saidB = [];
    if (!k.noMark) {
      for (const m of run.messages) {
        saidA.push(answer(await say(w.a.port, m)));
        if (!k.down) saidB.push(answer(await say(w.b.port, m)));
      }
    }
    if (k.down) await w.upB();
    await wait(300);
    const bAfterRestart = k.down ? { holdsFirstMark: w.b.round.holdsMark(run.firstId) } : null;
    if (k.catchUp) for (const m of run.messages) saidB.push(answer(await say(w.b.port, m)));
    await settle(w, run);
    out({ case: name, saidA, saidB, bAfterRestart, a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run) });
  } finally { await w.close(); }
}
process.exit(0);
