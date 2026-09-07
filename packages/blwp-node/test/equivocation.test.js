// SECTION 13B: THE PLAYER WHO SIGNED TWO WORLDS AT ONE TICK.
//
// "A player who publishes two different checkpoints for the same
// (round_id, player_pubkey, tick), or two chains that diverge at any tick,
// forfeits the entry... The two conflicting signed checkpoints are a complete,
// portable proof; no replay is needed. Nodes MUST publish such a proof when
// they hold one."
//
// The node already REFUSED the second mark and then threw it away, which
// destroyed the only thing that shows what the player did. It is kept now, and
// the proof is checkable by anyone holding the two records - no node asked, no
// transcript replayed, no committee needed. That is why this is the one part of
// the no-quorum rule a single node can hold up on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned,
  splitSigned, provesEquivocation, SIGNED_CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const verify = (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } };

const contract = (nodes) => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
});
const signedBy = (c, key = session) =>
  joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), key));

/** A round with one mark at tick 60, and the pieces to conflict with it. */
function played() {
  const round = new Round(openStore(), () => 1234);
  const c = contract([b32(4)]);
  const rid = round.open(c);
  const eid = round.enter(entryFor(rid));
  const mark = {
    roundId: rid, entryId: eid, tick: 60, stateHash: b32(0x11),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  round.checkpoint(signedBy(mark));
  return { round, rid, eid, mark };
}

test('the second world is refused and KEPT, where it used to be thrown away', () => {
  const { round, rid, eid, mark } = played();
  assert.deepEqual(round.equivocation(rid, eid), []);

  const other = { ...mark, stateHash: b32(0x22) };
  assert.throws(() => round.checkpoint(signedBy(other)), /equivocation at tick 60/);

  const held = round.equivocation(rid, eid);
  assert.equal(held.length, 1);
  assert.equal(held[0].tick, 60);
  assert.equal(held[0].stored.length, SIGNED_CHECKPOINT_BYTES);
  assert.equal(held[0].offered.length, SIGNED_CHECKPOINT_BYTES);
  assert.notEqual(toHex(held[0].stored), toHex(held[0].offered));

  // and the chain the committee carries is untouched: one checkpoint, the first
  const kept = round.checkpoints(rid, eid);
  assert.equal(kept.count, 1);
  assert.deepEqual(
    checkpointId(decodeCheckpoint(splitSigned(kept.bytes).body)),
    checkpointId(mark));
});

/**
 * AND ANYONE CAN CHECK IT. The two records and the session key the entry
 * named, and nothing else: no node is asked and no transcript is replayed.
 */
test('the two records prove it on their own', async () => {
  const { round, rid, eid, mark } = played();
  const other = { ...mark, stateHash: b32(0x22) };
  assert.throws(() => round.checkpoint(signedBy(other)), /equivocation/);
  const [held] = round.equivocation(rid, eid);

  const seen = await provesEquivocation(held.stored, held.offered, sessionPubkey, verify);
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.tick, 60);
  assert.equal(seen.ids.length, 2);
  assert.notEqual(toHex(seen.ids[0]), toHex(seen.ids[1]));
});

/**
 * WHAT IS NOT EQUIVOCATION, and each of these would take a stake if it were.
 */
test('a repeat, another tick, another entry and a forgery are all refused', async () => {
  const { round, rid, eid, mark } = played();
  const mine = signedBy(mark);

  // the same mark twice is the ordinary case - a dropped socket, a re-send
  const same = await provesEquivocation(mine, mine, sessionPubkey, verify);
  assert.equal(same.ok, false);
  assert.match(same.why, /the same mark, sent twice/);

  // two marks at different ticks are a chain, not a contradiction
  const later = signedBy({ ...mark, tick: 120, stateHash: b32(0x33) });
  const ticks = await provesEquivocation(mine, later, sessionPubkey, verify);
  assert.equal(ticks.ok, false);
  assert.match(ticks.why, /at ticks 60 and 120/);

  // and two marks from different entries are two players
  const elsewhere = signedBy({ ...mark, entryId: b32(0x7e), stateHash: b32(0x44) });
  const other = await provesEquivocation(mine, elsewhere, sessionPubkey, verify);
  assert.equal(other.ok, false);
  assert.match(other.why, /not from the same entry/);

  // A FORGERY MUST NOT FORFEIT A STAKE. Anyone can write two conflicting
  // objects; only the session key the entry named can sign them.
  const stranger = ed25519.utils.randomSecretKey();
  const forged = signedBy({ ...mark, stateHash: b32(0x55) }, stranger);
  const fake = await provesEquivocation(mine, forged, sessionPubkey, verify);
  assert.equal(fake.ok, false);
  assert.match(fake.why, /the second mark is not signed by that entry/);

  const both = await provesEquivocation(forged, mine, sessionPubkey, verify);
  assert.equal(both.ok, false);
  assert.match(both.why, /the first mark is not signed by that entry/);

  // and bytes that are not a signed checkpoint at all
  const rubbish = await provesEquivocation(mine.slice(0, 20), mine, sessionPubkey, verify);
  assert.equal(rubbish.ok, false);
  assert.match(rubbish.why, /not a signed checkpoint/);

  assert.equal(round.equivocation(rid, eid).length, 0, 'nothing above should have been stored');
});

test('the node publishes the proof it holds, and says so when it holds none', async () => {
  const clean = played();
  const guilty = played();
  const other = { ...guilty.mark, stateHash: b32(0x22) };
  assert.throws(() => guilty.round.checkpoint(signedBy(other)), /equivocation/);

  const a = await serve(guilty.round.db, { port: 0, funded: () => true });
  const b = await serve(clean.round.db, { port: 0, funded: () => true });
  try {
    const at = (p, r, e) =>
      fetch(`http://127.0.0.1:${p}/equivocation?round=${toHex(r)}&entry=${toHex(e)}`);

    const found = await at(a.port, guilty.rid, guilty.eid);
    assert.equal(found.status, 200);
    assert.equal(found.headers.get('x-equivocations'), '1');
    assert.equal(found.headers.get('x-ticks-at'), '60');
    const body = new Uint8Array(await found.arrayBuffer());
    assert.equal(body.length, 2 * SIGNED_CHECKPOINT_BYTES);

    // and what comes off the wire proves it, without asking that node anything
    const seen = await provesEquivocation(
      body.subarray(0, SIGNED_CHECKPOINT_BYTES),
      body.subarray(SIGNED_CHECKPOINT_BYTES), sessionPubkey, verify);
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.tick, 60);

    const none = await at(b.port, clean.rid, clean.eid);
    assert.equal(none.status, 204);
  } finally { await a.close(); await b.close(); }
});
