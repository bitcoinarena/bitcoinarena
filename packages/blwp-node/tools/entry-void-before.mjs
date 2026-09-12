// ENTRY_VOID (§16), MEASURED BEFORE ANY CODE: what the node records today when
// a seated, locked player's first mark reaches both seats in time, and when it
// reaches only one (the other seat down at the start). Two in-process seats of
// a lock round; the fixture's delivering winner (join tick 0, delivers at 1320).
// The run: inputs 0..59, first mark at 60; inputs 60..1319, mark at 1320.
// 120 ticks is the agreed reference deadline - the contract cannot carry one.
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { resultFinality } from '../src/finality.js';
import { assumeSeated } from '../test/seating.js';
import { lockPort } from '../test/lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from '../test/window-fixture.js';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import * as constants from '../../protocol/src/constants.js';
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
import { toHex, sha256 } from '../../protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const REFERENCE_DEADLINE = 120;
const FIRST = 60;
const END = WINNER.ticks;                         // 1320: the run delivers here
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));

async function seats() {
  const port = lockPort();
  const mk = (db, p = 0) => serve(db, { port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const dbA = openStore(':memory:');
  const dbB = openStore(':memory:');
  const a = await mk(dbA);
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
    federationId: b32(0xfe) };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    if (r.status !== 201) throw new Error(await r.text());
    assumeSeated(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  const claimPk = a.dkg.seatFor(c.nodes).pool.groupPublicKey;
  return {
    a, get b() { return b; }, c, rid, port, claimPk,
    async downB() { await b.close(); },
    async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { await a.close(); try { await b.close(); } catch {} },
  };
}

/** Seated and locked at both seats (both up), and the run's four messages, built. */
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
  const committed = [];
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    committed.push((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status);
  }
  // THE RUN, as the page publishes it: a batch, then the mark over it.
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  const hashAt = (upTo, from) => { for (let t = from; t < upTo; t++) step(st, ...wordsAt(t)); return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))); };
  const batch1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: FIRST }, (_, t) => wordsAt(t)), liquidations: [] };
  const mark1 = { roundId: w.rid, entryId: eid, tick: FIRST, stateHash: hashAt(FIRST, 0), inputChainHash: batchId(batch1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  const batch2 = { roundId: w.rid, entryId: eid, previousHash: batchId(batch1), firstTick: FIRST, ticks: Array.from({ length: END - FIRST }, (_, t) => wordsAt(FIRST + t)), liquidations: [] };
  const mark2 = { roundId: w.rid, entryId: eid, tick: END, stateHash: hashAt(END, FIRST), inputChainHash: batchId(batch2), previousHash: checkpointId(mark1), sessionPubkey: entry.sessionPubkey };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  return { entry, eid, outpoint, committed, mark1Id: checkpointId(mark1),
    messages: [encodeInputBatch(batch1), sign(mark1), encodeInputBatch(batch2), sign(mark2)] };
}

/** What one seat holds of the first mark: when it stored it, who receipted it. */
function firstMarkAt(d, run, t0) {
  const row = d.round.db.prepare('SELECT tick, received_ms FROM checkpoints WHERE checkpoint_id = ?').get(run.mark1Id);
  const signers = d.round.db.prepare('SELECT node_pubkey FROM receipts WHERE checkpoint_id = ?').all(run.mark1Id)
    .map((r) => (toHex(new Uint8Array(r.node_pubkey)) === toHex(d.round.pubkey) ? 'self' : 'peer'));
  const head = d.round.db.prepare('SELECT MAX(tick) t FROM checkpoints WHERE round_id = ? AND entry_id = ?').get(run.entry.roundId, run.eid).t;
  return { held: !!row, seenMsAfterStart: row ? row.received_ms - t0 : null, receiptsHeld: signers, chainHeadTick: head };
}

async function outcomeAt(d, w, run) {
  const results = d.round.results(w.rid, run.eid).map((r) => { const x = decodePlayerResult(splitSignedResult(r.bytes).body); return `${x.outcome} score ${x.score}`; });
  const fin = resultFinality(d.round, w.rid, run.eid);
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  const why = f.ok ? 'granted' : (await f.text()).trim().slice(0, 110);
  const tables = d.round.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%void%'").all().map((r) => r.name);
  const voidWords = d.round.db.prepare("SELECT COUNT(*) n FROM results WHERE round_id = ?").get(w.rid).n
    ? results.filter((r) => /VOID/.test(r)).length : 0;
  let canonical;
  try { const t = d.round.canonicalTranscript(w.rid, run.eid); canonical = `through tick ${t.throughTick}, ${t.marks} marks`; }
  catch (e) { canonical = `none: ${e.message.slice(0, 90)}`; }
  return { results, canonical, finality: fin.state || `null (${String(fin.why).slice(0, 70)})`, forfeit: `${f.status} ${why}`,
    voidTables: tables, voidResults: voidWords, lockHeld: w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
}

async function settle(w, run) {
  await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
  for (let t = Date.now(); Date.now() - t < 20000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    const why = f.ok ? '' : await f.text();
    if (f.ok || !/before the result is final/.test(why)) break;
  }
  await wait(500);
}

const field = { decodedHasIt: 'startDeadlineTicks' in decodeRoundContract(encodeRoundContract(contractFor([b32(1), b32(2)], 3000n, []))),
  constant: Object.keys(constants).filter((k) => /DEADLINE|START_/i.test(k)) };
out({ step: 'the contract today', startDeadlineField: field.decodedHasIt ? 'present' : 'ABSENT', namedConstants: field.constant.length ? field.constant : 'none',
  referenceDeadlineTicks: REFERENCE_DEADLINE, joinTick: 0, firstMarkTick: FIRST, markInTime: FIRST <= 0 + REFERENCE_DEADLINE });

// CASE 1: both seats up; the player sends every message to both.
{
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    const t0 = Date.now();
    const said = { a: [], b: [] };
    for (const m of run.messages) for (const [k, d] of [['a', w.a], ['b', w.b]]) said[k].push(String(await say(d.port, m)).slice(0, 40));
    const atFirst = { a: firstMarkAt(w.a, run, t0), b: firstMarkAt(w.b, run, t0) };
    await settle(w, run);
    out({ case: '1 - first mark in time at both seats', lockCommitted: run.committed, sentTo: 'A and B (the player, directly)',
      answers: { a: said.a.map((s) => s.length > 30 ? 'receipt' : s), b: said.b.map((s) => s.length > 30 ? 'receipt' : s) },
      firstMark: atFirst, forwardedBySeat: 'no code path forwards a mark between seats (B holds it because the player sent it)',
      outcomeA: await outcomeAt(w.a, w, run), outcomeB: await outcomeAt(w.b, w, run) });
  } finally { await w.close(); }
}

// CASE 2: both seats commit the lock; B goes down; the player plays at A only.
for (const variant of ['i - B back, never sent the mark', 'ii - B back, the player catches B up late']) {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downB();
    const t0 = Date.now();
    const saidA = [];
    for (const m of run.messages) saidA.push(String(await say(w.a.port, m)).slice(0, 40));
    const atA = firstMarkAt(w.a, run, t0);
    await w.upB();
    const bAfterRestart = firstMarkAt(w.b, run, t0);
    let saidB = null;
    if (variant.startsWith('ii')) { saidB = []; for (const m of run.messages) saidB.push(String(await say(w.b.port, m)).slice(0, 40)); }
    const atB = firstMarkAt(w.b, run, t0);
    await settle(w, run);
    out({ case: `2${variant}`, lockCommitted: run.committed, sentTo: variant.startsWith('ii') ? 'A in time; B only after its restart, the whole chain' : 'A only',
      answersA: saidA.map((s) => s.length > 30 ? 'receipt' : s), answersB: saidB && saidB.map((s) => s.length > 30 ? 'receipt' : s),
      firstMark: { a: atA, bJustAfterRestart: bAfterRestart, b: atB },
      forwardedBySeat: bAfterRestart.held ? 'B held it after restart' : 'no: B held nothing after its restart',
      lateAtB: variant.startsWith('ii') ? `B took the first mark after the chain at A had reached tick ${END} (> ${REFERENCE_DEADLINE})` : null,
      outcomeA: await outcomeAt(w.a, w, run), outcomeB: await outcomeAt(w.b, w, run) });
  } finally { await w.close(); }
}
process.exit(0);
