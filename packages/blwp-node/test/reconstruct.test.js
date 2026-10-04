// FIVE SIGNER NODES, AND ONLY FIVE SIGNER NODES, OPEN A STAKE.
//
// 23.4: "Settling a loser's HTLC requires reconstructing the preimage from at
// least 5 preimage shares." Seven daemons, seven real identities, one player
// dealing to all of them, and then the three numbers this item closes on:
//
//   one node alone      yields nothing
//   four answers        refuse by name
//   five answers        reconstruct, and it hashes to the entry's own commitment
//
// Everything here goes through the daemons' own doors. Nothing hands a share
// to anybody in this file.
import { signFinalSig } from '../../protocol/src/final-sig.js';
import { resultFinality } from '../src/finality.js';
import { fromHex } from '../../protocol/src/hash.js';
import { lockPort, lockedEntry, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { CLOCK } from './block-clock.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../src/cores.js';
// THE RUN LENGTH IS THE CORE'S (2026-09-20). This fixture said 9000 and the core has ended a run at 10800
// since c01cc655, so `Round.open` refused the contract - "a second clock is not a shorter round" - and every
// test here died with "this node holds no such round" before a single share was dealt. These seven tests are
// the evidence that five-of-seven reconstruction works (§23.4), so a stale number was hiding the proof.
import { BLOCK_TICKS as RUN_TICKS } from '../../core/src/rules/gate.js';
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { FORFEIT, DELIVERED } from '../../protocol/src/payout.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeAssigned, assumeStakeSeen } from './assignment.js';
import { StakeSecrets, decodeShareAnswer, SEALED_ANSWER_BYTES } from '../src/stake-secret.js';
import { dealHandout, encodeHandout } from '../../protocol/src/handout.js';
import { openShare } from '../../protocol/src/seal.js';
import { SHARES_NEEDED } from '../../protocol/src/shares.js';
import {
  encodeRoundContract, roundId, encodeEntryContract, entryId,
} from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import {
  encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS,
} from '../../protocol/src/checkpoint.js';
import {
  encodeCheckpointReceipt, receiptId, joinSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import {
  splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId,
} from '../../protocol/src/result.js';
import { encodeTranscriptPosting, transcriptPostingId, joinSignedPosting } from '../../protocol/src/posting.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));

// THE FIXTURE'S OWN WORLD, RE-MEASURED. Letter 36 gave the round its relief
// from its own seed, so this drive is on hills now and it DELIVERED where it
// used to wreck - and these tests are about a run that came to nothing. The
// world secret is the fixture's to choose and it chooses one where the drive
// still loses: b32(0x16) wrecks player 5 at tick 956 with a score of 420 and
// player 6 at 377 (547 / 128 and 947 before the armour doctrine, 2026-09-16). 1000 ticks is past both, and a run's state latches when it
// leaves LIVE.
const TICKS = 1000;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const coefficients = [1n, 2n, 3n, 4n].map((n) => n * 0x1234567890abcdefn + 7n);
const session = ed25519.utils.randomSecretKey();

// SEVEN SLOTS, SO FIVE OF SEVEN IS THE THRESHOLD EVERYWHERE - the results
// that make a run final, the receipts that make a transcript canonical, and
// the shares that open a stake. `genesis.js` fixes those together and this
// letter is about the third one, so the other two are not going to be two.
// AND NO OBJECTION WINDOW: final at the quorum. The window is
// objection-window.test.js's to pin (M3.3-32), not this letter's.
// P2 (v4.6.2 §13A): the relays each run's transcript is posted to - the
// committee's own doors, set when `committee` stands the daemons up, so every
// contract this file builds for them names the same ones and has the same id.
let committeePort = null;
let committeeRelays = [];
// THE COMMITTEE'S BONDED CHAIN (RULED 2026-09-25): every contract this file builds for the committee names its census,
// and the round's beacon is that chain's - the player seeds from it (playedRound). Only censusRoot changes.
let committeeSlot = null;
const contractFor = (nodes) => {
  const c = drafted(nodes);
  return committeeSlot ? { ...c, censusRoot: bondedChainFor(c.nodes, c, committeeSlot,
    { endpoints: committeeRelays.map((u) => u.replace('http://', 'ws://')) }).censusRoot } : c;
};
const drafted = (nodes) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  // A WINDOW OF 1ms, NOT 0. This fixture named a zero objection window so finality was instant and the suite
  // did not have to wait; a zero window is now refused, because it erases §13A's replay veto (contracts.js).
  // The spec sets NO FLOOR - "reference: 10 minutes, contract-defined" - so the smallest legal window is 1ms,
  // which has passed by the time these tests ask. Nothing asserted here is about the window's length.
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: committeeRelays, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: RUN_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

/** One signer node's signed posting of the transcript a result names (P2). */
const postedBy = (who, rid, result) => {
  const p = { roundId: rid, playerPubkey: result.playerPubkey, transcriptHash: result.transcriptHash, signerNodePubkey: who.round.pubkey,
    blockHash: CLOCK.tipAt(Date.now()) };   // the block it sits in (§13A, RULED 2026-09-24)
  return joinSignedPosting(encodeTranscriptPosting(p), schnorr.sign(transcriptPostingId(p), who.round.identity.secret));
};

/** Until the fixtures' chain has a block after the one of now (a window of 1 ms ends there). */
const untilNextBlock = async () => { const s = Math.floor(Date.now() / 1000); while (Math.floor(Date.now() / 1000) <= s) await new Promise((r) => setTimeout(r, 50)); };

/** Seven daemons, and the round they all hold. */
async function committee(n = 7) {
  const nodes = [];
  // THE COMMITTEE REACHES ONE FEDERATION (RULED 2026-09-25: a paying round opens only on a signer node that reaches one):
  // the lock fixture's port, shared, and an entry's stake and fee are locked in it (playedRound).
  committeeSlot = bondedChainSlot(lockPort());
  committeePort = committeeSlot.port;
  for (let i = 0; i < n; i++)
    nodes.push(await serve(openStore(':memory:'), {
      port: 0, funded: () => true, stakeLocks: committeePort, chainFor: committeeSlot.chainFor,
      randomnessFor: committeeSlot.randomnessFor,
    }));
  // THE CHAIN §13A'S WINDOWS ARE READ FROM (RULED 2026-09-24): the block clock every fixture daemon reads.
  for (const d of nodes) d.round.chainView = CLOCK.chainView();
  committeeRelays = nodes.map((d) => `http://127.0.0.1:${d.port}`);
  return nodes;
}

/**
 * ONE WHOLE ROUND ON ONE DAEMON, ending in a signed result: the player deals a
 * stake to all seven signer nodes, joins, plays, marks, and the round is closed.
 */
async function playedRound(node, c, stake, signerNodes) {
  const rid = roundId(c);
  assumeAssigned(node.round, rid, c.nodes);

  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: stake.stakeCommitment, stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
    donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: stake.ref, stakePoint: stake.stakePoint, feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  // ONE ENTRY ON EVERY NODE: its locks are made once per stake and named the same everywhere, so its id is one id.
  if (!stake.locked) {
    await lockedEntry(committeePort, entry, b32(5));
    stake.locked = { feePreimage: entry.feePreimage, stakeLockOutpoint: entry.stakeLockOutpoint, feeLockOutpoint: entry.feeLockOutpoint };
  } else Object.assign(entry, stake.locked);
  const eid = entryId(entry);
  const joined = await fetch(`http://127.0.0.1:${node.port}/entry`,
    { method: 'POST', body: encodeEntryContract(entry) });
  assert.equal(joined.status, 201, await joined.text());
  assumeStakeSeen(node.round, entry);

  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
  const said = [];
  ws.on('message', (d, bin) => said.push(bin ? new Uint8Array(d) : d.toString()));
  await new Promise((r) => ws.once('open', r));
  const say = (m) => new Promise((resolve, reject) => {
    const at = said.length; let waited = 0;
    ws.send(m);
    const t = setInterval(() => {
      if (said.length > at) { clearInterval(t); return resolve(said[at]); }
      if ((waited += 2) > 20000) { clearInterval(t); reject(new Error('no answer')); }
    }, 2);
  });

  const rows = [];
  for (let t = 0; t < TICKS; t++) rows.push(wordsAt(t));
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: rows, liquidations: [] };
  assert.equal(await say(encodeInputBatch(input)), String(TICKS));

  const st = init(seedWordForEntry(entry, committeeSlot.randomnessFor({ contract: c }).hash));
  for (let t = 0; t < TICKS; t++) step(st, ...wordsAt(t));
  const mark = {
    roundId: rid, entryId: eid, tick: TICKS,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS,
    sessionPubkey: ed25519.getPublicKey(session),
  };
  const mid = checkpointId(mark);
  assert.equal((await say(joinSigned(encodeCheckpoint(mark), ed25519.sign(mid, session)))).length,
    SIGNED_RECEIPT_BYTES);

  // FIVE OF SEVEN RECEIPTS MAKE IT CANONICAL, from the signer nodes themselves.
  for (const signerNode of signerNodes.slice(0, 5)) {
    if (toHex(signerNode.round.pubkey) === toHex(node.round.pubkey)) continue;
    const receipt = { checkpointId: mid, receivedAtMs: 1234n, nodePubkey: signerNode.round.pubkey };
    assert.equal(await say(joinSignedReceipt(encodeCheckpointReceipt(receipt),
      schnorr.sign(receiptId(receipt), signerNode.round.identity.secret))), 'held');
  }

  assert.equal(await say(`close ${toHex(rid)}`), 'closed');
  ws.close();

  for (const p of node.verifier.done) await p;
  await node.verifier.settling;
  await node.stakes();
  return { rid, eid, entry };
}

/**
 * EVERY SIGNER NODE REPLAYS ITS OWN. A node hands out its share only for a run IT
 * signed a result for - a peer's record is a peer's claim - so a committee
 * where six signer nodes never replayed is a committee of one, and this measurement
 * would be measuring nothing.
 */
async function everyoneReplays(nodes, stake) {
  const c = contractFor(nodes.map((n) => n.round.pubkey));
  const rid = roundId(c);
  let out = null;
  for (const node of nodes) {
    await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(c) });
    const posted = await fetch(`http://127.0.0.1:${node.port}/handout`,
      { method: 'POST', body: stake.body });
    assert.equal(posted.status, 201, await posted.text());
    out = await playedRound(node, c, stake, nodes);
  }

  // AND THEY TELL EACH OTHER, which is what `gather` does over `/results`.
  // Five agreeing is what makes the run final, and final is the condition a
  // share is handed out under.
  const every = [];
  for (const node of nodes) every.push(...node.round.results(rid, out.eid));
  for (const node of nodes)
    for (const r of every) node.round.putResult(rid, out.eid, r.nodePubkey, r.resultId, r.bytes);

  // AND EACH POSTS THE TRANSCRIPT THE AGREED RESULT NAMES to the relays, and
  // they tell each other that too (P2): final needs five of these as well.
  for (const node of nodes) await node.verifier.publish(rid, out.eid);
  const posted = [];
  for (const node of nodes) posted.push(...node.round.postings(rid, out.eid));
  for (const node of nodes)
    for (const p of posted) node.round.putPosting(rid, out.eid, p.signerNodePubkey, p.bytes);
  // THE WINDOW ENDS AT A BLOCK (RULED 2026-09-24): even this fixture's 1 ms window closes only at the next block of the
  // chain, a second away on the fixtures' block clock - waited for here, as a node waits for it.
  await untilNextBlock();

  const outcome = decodePlayerResult(splitSignedResult(
    nodes[0].round.results(rid, out.eid)[0].bytes).body).outcome;
  return { ...out, rid, contract: c, outcome };
}

/** The player deals one preimage to every daemon, and every daemon accepts. */
async function dealTo(nodes, rid) {
  let preimage = rand(32);
  const e = rand(32);
  const dealt = await dealHandout({
    preimage, signerNodes: nodes.map((n) => n.round.pubkey), roundId: rid,
    playerPubkey: b32(5), ephemeralSecret: e, ephemeralPubkey: schnorr.getPublicKey(e),
    coefficients, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  return { preimage, stakeCommitment: sha256(preimage), ref: dealt.id, stakePoint: dealt.handout.commitments[0], body: encodeHandout(dealt.handout) };
}

test('one node alone opens nothing, four refuse by name, five reconstruct', async () => {
  const nodes = await committee(7);
  try {
    const c = contractFor(nodes.map((n) => n.round.pubkey));
    const rid = roundId(c);
    const stake = await dealTo(nodes, rid);
    const { eid, outcome } = await everyoneReplays(nodes, stake);
    assert.equal(outcome, 'FAILED', 'the drive did not lose, so no preimage would be released');

    const asker = nodes[0];
    const peersOf = (n) => nodes.slice(1, 1 + n).map((x) => `http://127.0.0.1:${x.port}`);
    const openWith = (n) => new StakeSecrets(asker.round, {
      curve: feldmanGroup, peers: peersOf(n), fetcher: (u) => fetch(u), random: rand,
    }).open({ roundId: rid, entryId: eid });

    // (a) ONE NODE ALONE. It holds its own share and no other, which is the
    // whole of what this letter is for.
    const alone = await openWith(0);
    assert.equal(alone.ok, false);
    assert.equal(alone.held, 1);
    assert.match(alone.why, /1 of 5 shares: a stake nobody can open stays in flight/);

    // (c) FOUR ANSWERS.
    const four = await openWith(3);
    assert.equal(four.ok, false, four.ok ? 'four shares opened a stake' : '');
    assert.equal(four.held, 4, four.why);
    assert.match(four.why, /4 of 5 shares/);

    // (b) FIVE ANSWERS.
    const five = await openWith(4);
    assert.equal(five.ok, true, five.why);
    assert.equal(five.held, 5);
    assert.deepEqual(five.preimage, stake.preimage);
    assert.deepEqual(sha256(five.preimage), stake.stakeCommitment,
      'the reconstruction does not hash to the entry\'s own commitment');

    // AND IT STOPS AT FIVE. Asking a sixth signer node for a secret five already
    // opened is spreading it for nothing.
    const all = await new StakeSecrets(asker.round, {
      curve: feldmanGroup, peers: peersOf(6), fetcher: (u) => fetch(u), random: rand,
    }).open({ roundId: rid, entryId: eid });
    assert.equal(all.held, 5, 'the asker kept asking after it had enough');
  } finally { for (const n of nodes) await n.close(); }
});

test('a stranger asking for a share is refused, and a signer node gets an envelope only it can open', async () => {
  const nodes = await committee(7);
  try {
    const c = contractFor(nodes.map((n) => n.round.pubkey));
    const rid = roundId(c);
    const stake = await dealTo(nodes, rid);
    const { eid } = await everyoneReplays(nodes, stake);
    const answerer = nodes[1];

    const ask = (signerNode) => fetch(`http://127.0.0.1:${answerer.port}/share`
      + `?round=${toHex(rid)}&entry=${toHex(eid)}&signer node=${toHex(signerNode)}`);

    // A KEY THAT IS NOT A SIGNER NODE.
    const stranger = schnorr.getPublicKey(rand(32));
    const refused = await ask(stranger);
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /not a signer node of this round, and a share is not a public thing/);

    // A SIGNER NODE'S KEY, CLAIMED BY SOMEBODY WHO HAS NOT GOT IT. The answer comes -
    // and it is sealed to that signer node, so the claimant holds an envelope it
    // cannot open. That, with the signer node check, is why no signature is needed.
    const got = await ask(answerer.round.pubkey);
    const bytes = new Uint8Array(await got.arrayBuffer());
    assert.equal(got.status, 200, new TextDecoder().decode(bytes));
    assert.equal(bytes.length, SEALED_ANSWER_BYTES);
    const back = decodeShareAnswer(bytes);

    const impostor = await openShare({
      sealed: back.sealed, signerNode: back.signerNode, secret: rand(32),
      ephemeralPubkey: back.ephemeralPubkey, curve: feldmanGroup,
    });
    assert.equal(impostor.ok, false);
    assert.match(impostor.why, /sealed to somebody else/);

    const rightful = await openShare({
      sealed: back.sealed, signerNode: back.signerNode, secret: answerer.round.identity.secret,
      ephemeralPubkey: back.ephemeralPubkey, curve: feldmanGroup,
    });
    assert.equal(rightful.ok, true, rightful.why);
    assert.equal(rightful.share.signerNode, back.signerNode);
  } finally { for (const n of nodes) await n.close(); }
});

test('a delivered run never gives up its preimage, and neither does one that is not final', async () => {
  const nodes = await committee(7);
  try {
    const stake = await dealTo(nodes, roundId(contractFor(nodes.map((n) => n.round.pubkey))));
    const { rid, eid } = await everyoneReplays(nodes, stake);
    const ask = (node, signerNode) => fetch(`http://127.0.0.1:${node.port}/share`
      + `?round=${toHex(rid)}&entry=${toHex(eid)}&signer node=${toHex(signerNode)}`);

    // It answers while the run is the FAILED one every signer node agreed on.
    assert.equal((await ask(nodes[1], nodes[0].round.pubkey)).status, 200);

    // NOW A RUN WHOSE RESULTS SAY DELIVERED. A second entry in the same round,
    // and every signer node's result for it says the player got through. The outcome
    // is not computed here - what is under test is what a signer node DOES with the
    // word - and 23.2 cancels a delivered stake, so its preimage must never
    // leave: releasing it would let anyone claim a lock that has to go
    // back to its player.
    // A ROUND OF ITS OWN, because every signer node's round above is closed and a
    // closed round takes no new entries.
    const holder = nodes[6];
    const other = { ...contractFor(nodes.map((n) => n.round.pubkey)), configHash: TRUCK_V3_CONFIG_HASH, slashMinimumServed: 21 };
    const orid = holder.round.open(other);
    assumeAssigned(holder.round, orid, other.nodes);

    const winner = {
      roundId: orid, playerPubkey: b32(6), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(b32(0x77)), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16),
      vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const wid = entryId(winner);
    holder.round.enter(winner);

    const shape = decodePlayerResult(splitSignedResult(
      nodes[0].round.results(rid, eid)[0].bytes).body);
    for (const who of nodes) {
      const delivered = {
        ...shape, roundId: orid, outcome: 'DELIVERED', playerPubkey: winner.playerPubkey,
        nodePubkey: who.round.pubkey,
      };
      const id = resultId(delivered);
      holder.round.putResult(orid, wid, who.round.pubkey, id,
        joinSignedResult(encodePlayerResult(delivered), schnorr.sign(id, who.round.identity.secret)));
      holder.round.putPosting(orid, wid, who.round.pubkey, postedBy(who, orid, delivered));
    }
    await untilNextBlock();
    // AND EVERY SEAT SIGNS IT FINAL (WINDOW-10-SPEC): the round ended in 1970, so its window closed long ago.
    const agreedRun = fromHex(resultFinality(holder.round, orid, wid).runId);
    for (const who of nodes) {
      const x = { roundId: orid, entryId: wid, runId: agreedRun, signerPubkey: who.round.pubkey, signedAtMs: BigInt(holder.round.now()) };
      const r = await fetch(`http://127.0.0.1:${holder.port}/final-sig?round=${toHex(orid)}&entry=${toHex(wid)}`,
        { method: 'POST', body: signFinalSig(x, (d) => schnorr.sign(d, who.round.identity.secret)) });
      assert.equal(r.status, 201, await r.text());
    }
    assert.equal(resultFinality(holder.round, orid, wid).state, 'FINAL');

    const may = holder.stakeSecrets.mayRelease(orid, wid);
    assert.equal(may.ok, false);
    assert.match(may.why, /that run is DELIVERED/);
    assert.match(may.why, /would let anyone claim a lock that has to go back to its player/);

    // AND A RUN NOBODY AGREED ON. Four of seven signer nodes signed the same FAILED
    // run, which is one short - and one short is not a threshold, so no share
    // moves and the stake goes home on its own timelock.
    const undecided = { ...winner, playerPubkey: b32(7), stakeCommitment: sha256(b32(0x78)) };
    const uid = entryId(undecided);
    holder.round.enter(undecided);
    for (const who of nodes.slice(0, 4)) {
      const failed = {
        ...shape, roundId: orid, outcome: 'FAILED', playerPubkey: undecided.playerPubkey,
        nodePubkey: who.round.pubkey,
      };
      const id = resultId(failed);
      holder.round.putResult(orid, uid, who.round.pubkey, id,
        joinSignedResult(encodePlayerResult(failed), schnorr.sign(id, who.round.identity.secret)));
    }
    const short = holder.stakeSecrets.mayRelease(orid, uid);
    assert.equal(short.ok, false);
    assert.match(short.why, /no share is handed out before the result is final/);
    assert.match(short.why, /4 of 5 agree/);
  } finally { for (const n of nodes) await n.close(); }
});

test('a player who committed to one secret and dealt another opens nothing', async () => {
  // DECISION B, MEASURED. Feldman proves the dealer cut ONE polynomial; it
  // cannot prove that the polynomial's constant term is the preimage of the
  // hash the entry publishes, because the commitment is a group element and
  // the hash is not. So the lie is caught HERE, at reconstruction: five signer nodes
  // open it, sha256 is not the entry's stakeCommitment, nothing settles, the
  // hold expires and the player is refunded. The cheat gains nothing, and it
  // needs no proof system.
  const nodes = await committee(7);
  try {
    const c = contractFor(nodes.map((n) => n.round.pubkey));
    const rid = roundId(c);

    // One honest polynomial over P, and an entry that publishes sha256(Q).
    const stake = await dealTo(nodes, rid);
    const lying = { ...stake, stakeCommitment: sha256(rand(32)) };
    const { eid } = await everyoneReplays(nodes, lying);

    const asker = nodes[0];
    const opened = await new StakeSecrets(asker.round, {
      curve: feldmanGroup,
      peers: nodes.slice(1).map((x) => `http://127.0.0.1:${x.port}`),
      fetcher: (u) => fetch(u), random: rand,
    }).open({ roundId: rid, entryId: eid });

    assert.equal(opened.ok, false, 'a stake opened to something the entry does not name');
    assert.equal(opened.held, 5, 'the signer nodes did answer; the shares are consistent');
    assert.match(opened.why, /those shares do not open that stake/);
    assert.match(opened.why, /not the committed preimage/);
  } finally { for (const n of nodes) await n.close(); }
});

test('a signer node that never replayed the run hands over nothing', async () => {
  // A node releases its share for a run IT signed a result for. A peer's
  // record is a peer's claim, and acting on somebody else's word about what a
  // run came to is how a committee becomes one node with six echoes.
  const nodes = await committee(7);
  try {
    const stake = await dealTo(nodes, roundId(contractFor(nodes.map((n) => n.round.pubkey))));
    const { rid, eid } = await everyoneReplays(nodes, stake);

    const quiet = nodes[6];
    const c = { ...contractFor(nodes.map((n) => n.round.pubkey)), configHash: TRUCK_V3_CONFIG_HASH, slashMinimumServed: 22 };
    const orid = quiet.round.open(c);
    assumeAssigned(quiet.round, orid, c.nodes);
    const entry = {
      roundId: orid, playerPubkey: b32(8), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(b32(0x7a)), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const wid = entryId(entry);
    quiet.round.enter(entry);

    // EVERY OTHER SIGNER NODE SIGNED, and this one did not.
    const shape = decodePlayerResult(splitSignedResult(
      nodes[0].round.results(rid, eid)[0].bytes).body);
    for (const who of nodes.slice(0, 6)) {
      const failed = {
        ...shape, roundId: orid, outcome: 'FAILED', playerPubkey: entry.playerPubkey,
        nodePubkey: who.round.pubkey,
      };
      const id = resultId(failed);
      quiet.round.putResult(orid, wid, who.round.pubkey, id,
        joinSignedResult(encodePlayerResult(failed), schnorr.sign(id, who.round.identity.secret)));
      quiet.round.putPosting(orid, wid, who.round.pubkey, postedBy(who, orid, failed));
    }
    await untilNextBlock();
    // AND THE SIX SIGN IT FINAL (WINDOW-10-SPEC): the round ended in 1970, so its window closed long ago.
    const agreedRun = fromHex(resultFinality(quiet.round, orid, wid).runId);
    for (const who of nodes.slice(0, 6)) {
      const x = { roundId: orid, entryId: wid, runId: agreedRun, signerPubkey: who.round.pubkey, signedAtMs: BigInt(quiet.round.now()) };
      const r = await fetch(`http://127.0.0.1:${quiet.port}/final-sig?round=${toHex(orid)}&entry=${toHex(wid)}`,
        { method: 'POST', body: signFinalSig(x, (d) => schnorr.sign(d, who.round.identity.secret)) });
      assert.equal(r.status, 201, await r.text());
    }
    assert.equal(resultFinality(quiet.round, orid, wid).state, 'FINAL');

    const may = quiet.stakeSecrets.mayRelease(orid, wid);
    assert.equal(may.ok, false);
    assert.match(may.why, /this node signed no result for that run, so it releases nothing/);
  } finally { for (const n of nodes) await n.close(); }
});
