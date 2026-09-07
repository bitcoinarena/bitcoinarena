// SECTION 13C'S NO-QUORUM RULE, ON ONE NODE.
//
// "If, after the result window, no result has 5-of-7 signatures: if the
// disagreement is explained by proven player equivocation (13B) -> FORFEIT.
// Otherwise the fault is on the operator side -> the entry becomes VOID, the
// stake is refunded by letting the HTLC expire, and the entry is excluded from
// the pool and from the payout table."
//
// "This is deliberately asymmetric: a player cannot manufacture a refund by
// causing disagreement, because the only way a player can cause it is
// equivocation, and equivocation forfeits."
//
// NO DAEMONS ARE INVENTED HERE. Both inputs are already in the tree: the fork
// proof a node publishes, and a count of how many committee members signed. The
// output is the word `computePayoutTable` already consumes, so the money end of
// the rule is the one that has been measured since before this file existed.
//
// WHAT IS NOT HERE: the result window, the HTLC that hands the stake back, and
// the slashing of nodes that contradict a replay. Those need the other six
// daemons or Lightning, and none of them is pretended at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import {
  noQuorumOutcome, computePayoutTable, DELIVERED, FORFEIT, VOID,
} from '../../protocol/src/payout.js';
import {
  encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned, provesEquivocation,
  SIGNED_CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import { decodeEntryContract } from '../../protocol/src/contracts.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } };
const NEEDED = 5;

const contract = () => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});

/** One entry on a real node, optionally made to sign two chains. */
function player(round, rid, seed, { forks = false } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const eid = round.enter({
    roundId: rid, playerPubkey: b32(seed), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
  });
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const first = {
    roundId: rid, entryId: eid, tick: 60, stateHash: b32(seed),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  round.checkpoint(sign(first));
  if (forks) {
    const parent = checkpointId(first);
    round.checkpoint(sign({ ...first, tick: 120, stateHash: b32(0xa1), previousHash: parent }));
    assert.throws(
      () => round.checkpoint(sign({ ...first, tick: 180, stateHash: b32(0xb2), previousHash: parent })),
      /does not follow the chain head/);
  }
  return { eid, session };
}

/** Exactly what a third party does: fetch the proof, fetch the key, check it. */
async function forkProven(base, rid, eid) {
  const r = await fetch(`${base}/equivocation?round=${toHex(rid)}&entry=${toHex(eid)}`);
  if (r.status !== 200) return false;
  const body = new Uint8Array(await r.arrayBuffer());
  const got = await fetch(`${base}/entry?id=${toHex(eid)}`);
  const entry = decodeEntryContract(new Uint8Array(await got.arrayBuffer()));
  const seen = await provesEquivocation(
    body.subarray(0, SIGNED_CHECKPOINT_BYTES),
    body.subarray(SIGNED_CHECKPOINT_BYTES), entry.sessionPubkey, verify);
  return seen.ok;
}

test('equivocation forfeits, and disagreement without a fork proof is VOID', async () => {
  const round = new Round(openStore(), () => 1234);
  const rid = round.open(contract());
  const a = player(round, rid, 0x0a, { forks: true });    // signed two chains
  const b = player(round, rid, 0x0b);                     // played straight

  const node = await serve(round.db, { port: 0, funded: () => true });
  try {
    const base = `http://127.0.0.1:${node.port}`;

    // the evidence, from the doors, exactly as a stranger would take it
    const aForked = await forkProven(base, rid, a.eid);
    const bForked = await forkProven(base, rid, b.eid);
    assert.equal(aForked, true, 'the fork proof did not come off the door');
    assert.equal(bForked, false, 'a player who played straight was proven a forker');

    // 1. a published fork and no quorum
    const one = noQuorumOutcome({ signatures: 3, needed: NEEDED, equivocationProven: aForked });
    assert.equal(one.outcome, FORFEIT);
    assert.match(one.why, /no quorum at 3 of 5, and the player signed two chains/);

    // 2. no proof and no quorum
    const two = noQuorumOutcome({ signatures: 3, needed: NEEDED, equivocationProven: bForked });
    assert.equal(two.outcome, VOID);
    assert.match(two.why, /nothing shows the player caused it/);

    // and a committee that DID agree is not this rule's business
    const agreed = noQuorumOutcome({ signatures: 5, needed: NEEDED, equivocationProven: false });
    assert.equal(agreed.outcome, null);
    assert.match(agreed.why, /the committee agreed: 5 of 5/);
  } finally { await node.close(); }
});

/**
 * THE ASYMMETRY, IN MONEY. The forfeited stake joins the pool the winner is
 * paid from; the void stake does not, and the void entry is not in the table
 * at all. A player who could VOID by causing disagreement would have a free
 * refund on every losing round.
 */
test('the forfeited stake pays the winner and the void stake stays out', () => {
  const winner = { entryId: b32(1), pubkey: b32(1), outcome: DELIVERED, score: 100, stakeMsat: 100000n };
  const forker = { entryId: b32(2), pubkey: b32(2), outcome: FORFEIT, score: 0, stakeMsat: 100000n };
  const voided = { entryId: b32(3), pubkey: b32(3), outcome: VOID, score: 0, stakeMsat: 100000n };

  const t = computePayoutTable({ roundId: b32(9), minScore: 1, entries: [winner, forker, voided] });

  assert.equal(t.pool, 100000n, 'the pool is the forfeited stake and nothing else');
  assert.equal(t.qualifiers, 1);
  assert.equal(t.table.length, 2, 'the void entry is in the payout table');
  assert.equal(t.table[0].amountMsat, 200000n, 'the winner gets their stake and the forfeited one');
  assert.equal(t.table[1].amountMsat, 0n);

  // the same round with the forker VOIDed instead: nothing to win
  const noPool = computePayoutTable({
    roundId: b32(9), minScore: 1,
    entries: [winner, { ...forker, outcome: VOID }, voided],
  });
  assert.equal(noPool.pool, 0n);
  assert.equal(noPool.table[0].amountMsat, 100000n, 'only the stake back');
});

test('a count that is not a count is refused rather than guessed', () => {
  assert.throws(() => noQuorumOutcome({ signatures: -1, needed: 5 }), /cannot be negative/);
  assert.throws(() => noQuorumOutcome({ signatures: 1.5, needed: 5 }), /count of committee members/);
  assert.throws(() => noQuorumOutcome({ signatures: 3, needed: 0 }), /positive count/);

  // AND ONLY `true` FORFEITS. An object, a string or a truthy answer somebody
  // forgot to await must not take a stake.
  for (const said of [undefined, null, 'yes', 1, {}, Promise.resolve(true)]) {
    assert.equal(noQuorumOutcome({ signatures: 3, needed: 5, equivocationProven: said }).outcome,
      VOID, String(said));
  }
});
