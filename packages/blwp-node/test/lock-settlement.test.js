// W4: THE LOSER'S STAKE LOCK IS CLAIMED INTO THE ROUND'S ONE SETTLEMENT, AND THE
// WINNER IS PAID FROM IT (the owner 2026-09-14 07:22: "a loser loses the stake. The
// lock is claimed into the pool. Winners are paid from that."; FEDERATION.md
// money flow step 5).
//
// Two seats of a lock round with a claim key made between them; a winner who
// delivers and a loser who wrecks, each staked by a lock both seats verified. The
// federation port is the fixture's, checking a settlement as the guardians do
// (every claimed lock stored, P opening its point, the signature under claim_pk
// over the txid, the payouts inside what the locks pay) with the guardians' real
// fee rule, measured on stock fedimintd 0.12.0 by stake-lock-step3.sh: 1000 msat
// per input and per output, 0 ppm.
//
// MEASURED BEFORE (W5b, TASKBOOK): nothing claimed a loser's lock - its forfeit
// was 409, the lock stayed held and went back to the loser at its expiry.
// HARNESS: lockRound and lockAndPlay as forfeit.test.js has them (file-local there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { lockPort } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, LOSER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const REAL_FEES = { ppm: 0n, baseMsat: 1000n };

async function lockRound({ minScore = 1, stakeMsat = STAKE } = {}) {
  const port = lockPort();
  port.feeRule = REAL_FEES;
  const mk = () => serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const a = await mk();
  const b = await mk();
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there;
    d.payouts.peers = there;
    d.preimages.peers = there;
    d.dkg.peers = there;
  }
  const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    federationId: b32(0xfe), minScore, stakeMsat };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeSeated(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  const held = a.dkg.seatFor(c.nodes);
  assert.equal(held.ok, true, held.why);
  return { a, b, c, rid, port, claimPk: held.pool.groupPublicKey, close: async () => { await a.close(); await b.close(); } };
}

async function lockAndPlay(w, who, { feeLock = false, feeFirst = false } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  // PICK A: the fee locked to H(F), F handed over openly in the entry (F5).
  const feeSecret = feeLock ? rand(32) : new Uint8Array(32);
  const feeOutpoint = feeLock ? { txid: rand(32), outIdx: 1n } : { txid: new Uint8Array(32), outIdx: 0n };
  const dealt = await dealHandout({ preimage, seats: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = feeLock ? { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat, claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 } : null;
  if (feeLock) await w.port.put(feeOutpoint, feeFields);
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: w.rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const seated = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
    // PICK (a): THE STAKE COUNTS WHICHEVER LOCK COMES LAST - the fee lock may be handed first.
    const handFee = async () => {
      const fee = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      assert.equal(fee.status, 201, await fee.text());
    };
    if (feeLock && feeFirst) {
      await handFee();
      assert.equal(d.round.stakeSeen(eid), null, 'a stake counted on its fee lock alone, before its stake lock');
    }
    const locked = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    assert.equal(locked.status, 201, await locked.text());
    if (feeLock && !feeFirst) await handFee();
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry, fields, outpoint, feeOutpoint };
}

// PICK (a) (the owner 2026-09-14): REFUSE AT THE DOOR. An entry that brings no fee lock - naming
// none, or naming one it never hands over - seated as far as the seats let it, and its
// first batch offered.
async function seatWithout(w, who, { namesFeeLock }) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, seats: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: namesFeeLock ? rand(32) : new Uint8Array(32),
    stakeLockOutpoint: outpoint, feeLockOutpoint: namesFeeLock ? { txid: rand(32), outIdx: 1n } : { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const at = [];
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const seated = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const why = seated.status === 201 ? 'seated' : await seated.text();
    const locked = seated.status === 201 ? await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) }) : null;
    at.push({ entry: seated.status, why, lock: locked ? locked.status : null, lockSaid: locked ? await locked.text() : null,
      stored: !!d.round.entry(eid), seen: !!d.round.stakeSeen(eid) });
  }
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [] };
  const played = String(await say(w.a.port, encodeInputBatch(input)));
  return { eid, outpoint, at, played };
}

const standing = async (d, w) => (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
const closeRound = (w) => Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
async function untilSettled(w, ms = 30000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED') return got;
  }
  return got;
}
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;

test('after the window the loser\'s lock is claimed by one committee signature, and the winner is paid 96000 msat from it - the real guardians\' 1000 msat per input and output taken out', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    assert.equal((await standing(w.a, w)).state, 'NONE', 'a settlement before the round closed');
    await closeRound(w);
    const got = await untilSettled(w);
    const paid = [...w.port.payouts.values()];
    console.log(`  settled: ${got.state} - ${got.why}; the loser's lock ${w.port.locks.has(key(lost.outpoint)) ? 'STILL HELD' : 'claimed'}, `
      + `the winner's ${w.port.locks.has(key(won.outpoint)) ? 'still held for its forfeit' : 'GONE'}; payouts ${paid.map((p) => `${p.msat} msat to ${toHex(p.payoutPk).slice(0, 12)}`).join(', ')}; `
      + `submissions ${w.port.settlements.length}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.equal(w.port.locks.has(key(lost.outpoint)), false, 'the loser\'s lock was not claimed');
    assert.equal(w.port.locks.has(key(won.outpoint)), true, 'the settlement spent the winner\'s own lock - that comes back by its forfeit');
    assert.equal(paid.length, 1, 'one payout contract, to the one qualifier');
    assert.equal(toHex(paid[0].payoutPk), toHex(refundKeyOf(WINNER.key)), 'the payout is not keyed to the winner\'s own lock key');
    assert.equal(netStakeMsat(lost.entry), 98000n);
    assert.equal(paid[0].msat, 96000n, '98000 in, 1000 on the input, 1000 on the output');
    const sent = w.port.settlements[0];
    assert.equal(schnorr.verify(sent.signature, fromHex(got.message), w.claimPk.subarray(1)), true, 'the signature is not the claim key\'s over the txid');
    assert.deepEqual(sent.claims.map((c) => key(c.outpoint)), [key(lost.outpoint)]);
    const atB = await standing(w.b, w);
    assert.equal(atB.txid, got.txid, 'the other seat does not hold the same settlement');
    // AND THE WINNER'S OWN STAKE STILL COMES BACK BY ITS FORFEIT (W5b).
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(won.eid)}`);
    assert.equal(f.status, 200, await f.text());
  } finally { await w.close(); }
});

// A WITHDRAWAL CLAIMED ON ANOTHER DEVICE (spec §24, the owner 2026-09-14): alice plays on her desktop,
// forgets to withdraw, and two hours later plays on her iPhone holding only her seed. The seats list
// the rounds they settled since a time, each with the keys its settlement pays and its locks' refund
// keys; the device derives its own key per round and matches it there, asking nothing per round.
// Before: /rounds lists only rounds still open for entry.
test('the seats list the rounds they settled since a time with the keys each pays and its locks\' refund keys, so a device holding only the seed finds what it is owed', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    const settled = (since) => fetch(`http://127.0.0.1:${w.a.port}/settled?since=${since}`);
    const before = await (await settled(0)).json();
    assert.equal(before.rounds.some((r) => r.id === toHex(w.rid)), false, 'a round was listed as settled before it closed');
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const listed = await (await settled(0)).json();
    const mine = listed.rounds.find((r) => r.id === toHex(w.rid));
    assert.ok(mine, 'the settled round is not listed');
    assert.equal(mine.state, 'ACCEPTED');
    assert.deepEqual(mine.payouts, [toHex(refundKeyOf(WINNER.key))], 'the listed payout keys are not the qualifier\'s');
    assert.deepEqual([...mine.refunds].sort(), [toHex(refundKeyOf(WINNER.key)), toHex(refundKeyOf(LOSER.key))].sort(), 'the listed refund keys are not the two locks\'');
    assert.equal('contract' in mine, false, 'every listed round carries its contract');
    // AND THE CONTRACT OF A ROUND A DEVICE MATCHED, FROM /round: its id.
    const c = new Uint8Array(await (await fetch(`http://127.0.0.1:${w.a.port}/round?id=${mine.id}`)).arrayBuffer());
    assert.equal(toHex(roundId(decodeRoundContract(c))), toHex(w.rid), 'the round\'s contract is not its id');
    assert.ok(won.outpoint && lost.outpoint);
    const later = await (await settled(Number(mine.madeMs) + 1)).json();
    assert.equal(later.rounds.some((r) => r.id === toHex(w.rid)), false, 'a round settled before since= was listed');
    assert.equal((await settled('x')).status, 400);
    const atB = await (await fetch(`http://127.0.0.1:${w.b.port}/settled?since=0`)).json();
    assert.ok(atB.rounds.some((r) => r.id === toHex(w.rid)), 'the other seat does not list the round it settled');
    console.log(`  /settled: ${listed.rounds.length} round(s) at seat A, this one ${mine.state} at ${mine.madeMs}, paying ${mine.payouts.length} key, ${mine.refunds.length} refund keys; since ${Number(mine.madeMs) + 1}: ${later.rounds.length}; seat B lists it too`);
  } finally { await w.close(); }
});

// PICK (a) (the owner 2026-09-14): REFUSE AT THE DOOR - where the round's gate mints.
test('where the round mints fee locks (1000 sat, the federation\'s own rule) a seat refuses at the door an entry that brings none - not seated, no stake counted - and the round of those who brought theirs settles as before', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const bare = await seatWithout(w, { key: b32(0x07), worldSecret: b32(0x17) }, { namesFeeLock: false });
    console.log(`  no fee lock named: ${bare.at.map((s) => `${s.entry} "${s.why.slice(0, 120)}"`).join(' / ')}; stored ${bare.at.map((s) => s.stored).join('/')}`);
    for (const s of bare.at) {
      assert.equal(s.entry, 409, 'an entry with no fee lock was seated in a round that mints them');
      assert.match(s.why, /this round mints fee locks .*an entry that brings no fee lock is not seated/);
      assert.equal(s.stored, false);
      assert.equal(s.seen, false);
    }
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const paid = [...w.port.payouts.values()];
    const winner = paid.find((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)));
    console.log(`  the round of those who brought theirs: ${got.why}; payouts ${paid.map((p) => String(p.msat)).join(', ')}`);
    assert.equal(winner.msat, 978000n);
    assert.deepEqual(paid.filter((p) => p !== winner).map((p) => p.msat), [18000n, 18000n]);
    assert.equal(w.port.locks.has(key(lost.outpoint)), false, 'the loser\'s lock was not claimed');
    assert.equal(w.port.locks.has(key(won.outpoint)), true);
    assert.equal(w.port.locks.has(key(bare.outpoint)), true, 'a lock the round never took was claimed');
  } finally { await w.close(); }
});

test('where the round mints, an entry that names a fee lock and never hands it over is never committed: its stake lock kept and not counted, its play refused, and the settlement runs without it', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const half = await seatWithout(w, { key: b32(0x07), worldSecret: b32(0x17) }, { namesFeeLock: true });
    console.log(`  a fee lock named, never handed: ${half.at.map((s) => `entry ${s.entry}, lock ${s.lock} "${String(s.lockSaid).slice(-70)}", seen ${s.seen}`).join(' / ')}; its batch: "${half.played.slice(0, 80)}"`);
    for (const s of half.at) {
      assert.equal(s.entry, 201);
      assert.equal(s.lock, 201);
      assert.match(s.lockSaid, /counted once its fee lock is verified/);
      assert.equal(s.seen, false, 'a stake counted without its fee lock');
    }
    assert.match(half.played, /stake not seen/);
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const claimed = w.port.settlements[0].claims.map((c) => key(c.outpoint));
    assert.equal(claimed.includes(key(half.outpoint)), false, 'a stake never committed was claimed');
    assert.equal(claimed.includes(key(lost.outpoint)), true);
    assert.equal(w.port.locks.has(key(half.outpoint)), true, 'the uncommitted player\'s lock did not stay theirs');
    assert.equal(w.port.locks.has(key(won.outpoint)), true);
  } finally { await w.close(); }
});

test('where the round mints, a fee lock handed before its stake lock counts the stake once the stake lock comes: either order commits it, and the round settles as before', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true, feeFirst: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    for (const d of [w.a, w.b]) {
      assert.ok(d.round.stakeSeen(won.eid), 'the fee-lock-first stake was never counted');
      assert.ok(d.round.stakeSeen(lost.eid));
    }
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const winner = [...w.port.payouts.values()].find((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)));
    console.log(`  fee lock first: ${got.why}; the winner ${winner && winner.msat}`);
    assert.equal(winner.msat, 978000n);
  } finally { await w.close(); }
});

// PICK A (the owner 2026-09-14): THE FEE LOCKS INTO THE SAME SETTLEMENT, FOR THE SITTING SEATS.
test('each player\'s fee lock is verified by both seats and claimed in the round\'s one settlement: the winner paid 98000, each sitting seat 2000 to its own key', async () => {
  const w = await lockRound();
  w.port.feeRule = { ppm: 0n, baseMsat: 0n };
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    await closeRound(w);
    const got = await untilSettled(w);
    const paid = [...w.port.payouts.values()];
    const sent = w.port.settlements[0];
    console.log(`  fee locks: ${got.state} - ${got.why}; inputs ${sent ? sent.claims.length : 0}; payouts ${paid.map((p) => `${p.msat} to ${toHex(p.payoutPk).slice(0, 10)}`).join(', ')}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.deepEqual(sent.claims.map((c) => key(c.outpoint)).sort(), [key(lost.outpoint), key(won.feeOutpoint), key(lost.feeOutpoint)].sort(),
      'the inputs are not the loser\'s stake and both fee locks');
    const seatKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k))).sort();
    assert.deepEqual(paid.filter((p) => seatKeys.includes(toHex(p.payoutPk))).map((p) => [toHex(p.payoutPk), p.msat]).sort(),
      seatKeys.map((k) => [k, 2000n]), 'each sitting seat is not paid its 2000 msat (1% + 1% of 200000, both pools)');
    assert.deepEqual(paid.filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key))).map((p) => p.msat), [98000n]);
    assert.equal([won.feeOutpoint, lost.feeOutpoint, lost.outpoint].some((o) => w.port.locks.has(key(o))), false, 'a claimed lock is still held');
    assert.equal(w.port.locks.has(key(won.outpoint)), true, 'the winner\'s own stake lock was spent - it comes back by its forfeit');
  } finally { await w.close(); }
});

test('under the real guardians\' 1000 msat per input and output the 2000 msat fee locks cannot reach a seat: none is claimed, both stay held, the winner is still paid 96000', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    await closeRound(w);
    const got = await untilSettled(w);
    const paid = [...w.port.payouts.values()];
    console.log(`  real fee rule with fee locks: ${got.state} - ${got.why}; payouts ${paid.map((p) => p.msat).join(', ')}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.match(got.why, /no fee lock claimed: the fee locks hold 4000 msat and their inputs alone cost 2000/);
    assert.deepEqual(paid.map((p) => p.msat), [96000n]);
    assert.equal(w.port.locks.has(key(won.feeOutpoint)) && w.port.locks.has(key(lost.feeOutpoint)), true, 'a fee lock was claimed that pays no seat');
  } finally { await w.close(); }
});

// PICK (b): AT THE SMALLEST BRACKET THE GATE MINTS FOR - 1000 sat - THE CLAIMED FEE LOCKS
// PAY EVERY SITTING SEAT SOMETHING UNDER THE REAL GUARDIANS' 1000 msat PER INPUT AND OUTPUT.
test('a 1000 sat round\'s 20000 msat fee locks are claimed under the real guardians\' fees and every sitting seat nets more than nothing', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    await closeRound(w);
    const got = await untilSettled(w);
    const sent = w.port.settlements[0];
    const seatKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    const paid = [...w.port.payouts.values()];
    const seatNets = paid.filter((p) => seatKeys.includes(toHex(p.payoutPk))).map((p) => p.msat);
    const feeIn = sent ? sent.claims.filter((c) => [key(won.feeOutpoint), key(lost.feeOutpoint)].includes(key(c.outpoint))) : [];
    console.log(`  1000 sat: ${got.state} - ${got.why}`);
    console.log(`  stake 1000000 msat, fee lock ${won.entry.feeMsat} msat x ${feeIn.length}, input fees ${feeIn.length * 1000} msat, `
      + `output fees ${seatNets.length * 1000} msat, per-seat net [${seatNets.join(', ')}] msat; winner paid ${paid.filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key))).map((p) => p.msat).join(', ')}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.equal(won.entry.feeMsat, 20000n);
    assert.equal(feeIn.length, 2, 'both fee locks are claimed');
    assert.equal(seatNets.length, 2, 'every sitting seat is paid');
    for (const n of seatNets) assert.ok(n > 0n, `a seat nets ${n}`);
    assert.equal([won.feeOutpoint, lost.feeOutpoint, lost.outpoint].some((o) => w.port.locks.has(key(o))), false);
  } finally { await w.close(); }
});

test('a round with a loser and no qualifier claims nothing: the hold path\'s verdict, and the lock expires back to its player', async () => {
  const w = await lockRound({ minScore: 1000000 });
  try {
    const one = await lockAndPlay(w, WINNER);
    const two = await lockAndPlay(w, LOSER);
    await closeRound(w);
    await wait(WINDOW_MS + 3000);
    const got = await standing(w.a, w);
    console.log(`  no qualifier: ${got.state}; locks held ${[one, two].filter((x) => w.port.locks.has(key(x.outpoint))).length} of 2; submissions ${w.port.settlements.length}`);
    assert.equal(got.state, 'NONE');
    assert.equal(w.port.settlements.length, 0, 'a settlement with nobody to pay was submitted');
    assert.equal(w.port.locks.has(key(two.outpoint)), true);
  } finally { await w.close(); }
});
