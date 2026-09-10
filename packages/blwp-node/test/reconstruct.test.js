// FIVE SEATS, AND ONLY FIVE SEATS, OPEN A STAKE.
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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { Custody, HELD, SETTLED } from '../src/custody.js';
import { FORFEIT, DELIVERED } from '../../protocol/src/payout.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeSeated, assumeStakeSeen } from './seating.js';
import { Preimages, decodeShareAnswer, SEALED_ANSWER_BYTES } from '../src/preimage.js';
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

/** A Lightning node that keeps a call log and no money. */
function fakePort() {
  const calls = [];
  return {
    calls,
    async createHeld({ paymentHash, amountMsat }) {
      calls.push(['createHeld', toHex(paymentHash)]);
      return { paymentHash, amountMsat, request: 'lnbcrt-fake' };
    },
    async look({ paymentHash }) { calls.push(['look', toHex(paymentHash)]); return { state: HELD }; },
    async settle({ paymentHash, preimage }) { calls.push(['settle', toHex(paymentHash), preimage]); },
    async cancel({ paymentHash }) { calls.push(['cancel', toHex(paymentHash)]); },
  };
}
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
// THE FIXTURE'S OWN WORLD, RE-MEASURED. Letter 36 gave the round its relief
// from its own seed, so this drive is on hills now and it DELIVERED where it
// used to wreck - and these tests are about a run that came to nothing. The
// world secret is the fixture's to choose and it chooses one where the drive
// still loses: b32(0x16) wrecks player 5 at tick 547 with a score of 128 and
// player 6 at 947. 1000 ticks is past both, and a run's state latches when it
// leaves LIVE.
const TICKS = 1000;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const coefficients = [1n, 2n, 3n, 4n].map((n) => n * 0x1234567890abcdefn + 7n);
const session = ed25519.utils.randomSecretKey();

// SEVEN SLOTS, SO FIVE OF SEVEN IS THE THRESHOLD EVERYWHERE - the results
// that make a run final, the receipts that make a transcript canonical, and
// the shares that open a stake. `genesis.js` fixes those together and this
// letter is about the third one, so the other two are not going to be two.
const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

/** Seven daemons, and the round they all hold. */
async function committee(n = 7) {
  const nodes = [];
  for (let i = 0; i < n; i++)
    nodes.push(await serve(openStore(':memory:'), {
      port: 0, funded: () => true, randomnessFor: () => BEACON,
    }));
  return nodes;
}

/**
 * ONE WHOLE ROUND ON ONE DAEMON, ending in a signed result: the player deals a
 * stake to all seven seats, joins, plays, marks, and the round is closed.
 */
async function playedRound(node, c, stake, seats) {
  const rid = roundId(c);
  assumeSeated(node.round, rid, c.nodes);

  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: stake.stakeCommitment, stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
    donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: stake.ref,
  };
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

  const st = init(seedWordForEntry(entry, RANDOMNESS));
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

  // FIVE OF SEVEN RECEIPTS MAKE IT CANONICAL, from the seats themselves.
  for (const seat of seats.slice(0, 5)) {
    if (toHex(seat.round.pubkey) === toHex(node.round.pubkey)) continue;
    const receipt = { checkpointId: mid, receivedAtMs: 1234n, nodePubkey: seat.round.pubkey };
    assert.equal(await say(joinSignedReceipt(encodeCheckpointReceipt(receipt),
      schnorr.sign(receiptId(receipt), seat.round.identity.secret))), 'held');
  }

  assert.equal(await say(`close ${toHex(rid)}`), 'closed');
  ws.close();

  for (const p of node.verifier.done) await p;
  await node.verifier.settling;
  await node.stakes();
  return { rid, eid, entry };
}

/**
 * EVERY SEAT REPLAYS ITS OWN. A node hands out its share only for a run IT
 * signed a result for - a peer's record is a peer's claim - so a committee
 * where six seats never replayed is a committee of one, and this measurement
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

  const outcome = decodePlayerResult(splitSignedResult(
    nodes[0].round.results(rid, out.eid)[0].bytes).body).outcome;
  return { ...out, rid, contract: c, outcome };
}

/** The player deals one preimage to every daemon, and every daemon accepts. */
async function dealTo(nodes, rid) {
  let preimage = rand(32);
  const e = rand(32);
  const dealt = await dealHandout({
    preimage, seats: nodes.map((n) => n.round.pubkey), roundId: rid,
    playerPubkey: b32(5), ephemeralSecret: e, ephemeralPubkey: schnorr.getPublicKey(e),
    coefficients, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  return { preimage, stakeCommitment: sha256(preimage), ref: dealt.id, body: encodeHandout(dealt.handout) };
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
    const openWith = (n) => new Preimages(asker.round, {
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

    // AND IT STOPS AT FIVE. Asking a sixth seat for a secret five already
    // opened is spreading it for nothing.
    const all = await new Preimages(asker.round, {
      curve: feldmanGroup, peers: peersOf(6), fetcher: (u) => fetch(u), random: rand,
    }).open({ roundId: rid, entryId: eid });
    assert.equal(all.held, 5, 'the asker kept asking after it had enough');
  } finally { for (const n of nodes) await n.close(); }
});

test('a stranger asking for a share is refused, and a seat gets an envelope only it can open', async () => {
  const nodes = await committee(7);
  try {
    const c = contractFor(nodes.map((n) => n.round.pubkey));
    const rid = roundId(c);
    const stake = await dealTo(nodes, rid);
    const { eid } = await everyoneReplays(nodes, stake);
    const answerer = nodes[1];

    const ask = (seat) => fetch(`http://127.0.0.1:${answerer.port}/share`
      + `?round=${toHex(rid)}&entry=${toHex(eid)}&seat=${toHex(seat)}`);

    // A KEY THAT IS NOT A SEAT.
    const stranger = schnorr.getPublicKey(rand(32));
    const refused = await ask(stranger);
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /not a seat of this round, and a share is not a public thing/);

    // A SEAT'S KEY, CLAIMED BY SOMEBODY WHO HAS NOT GOT IT. The answer comes -
    // and it is sealed to that seat, so the claimant holds an envelope it
    // cannot open. That, with the seat check, is why no signature is needed.
    const got = await ask(answerer.round.pubkey);
    const bytes = new Uint8Array(await got.arrayBuffer());
    assert.equal(got.status, 200, new TextDecoder().decode(bytes));
    assert.equal(bytes.length, SEALED_ANSWER_BYTES);
    const back = decodeShareAnswer(bytes);

    const impostor = await openShare({
      sealed: back.sealed, seat: back.seat, secret: rand(32),
      ephemeralPubkey: back.ephemeralPubkey, curve: feldmanGroup,
    });
    assert.equal(impostor.ok, false);
    assert.match(impostor.why, /sealed to somebody else/);

    const rightful = await openShare({
      sealed: back.sealed, seat: back.seat, secret: answerer.round.identity.secret,
      ephemeralPubkey: back.ephemeralPubkey, curve: feldmanGroup,
    });
    assert.equal(rightful.ok, true, rightful.why);
    assert.equal(rightful.share.seat, back.seat);
  } finally { for (const n of nodes) await n.close(); }
});

test('a delivered run never gives up its preimage, and neither does one that is not final', async () => {
  const nodes = await committee(7);
  try {
    const stake = await dealTo(nodes, roundId(contractFor(nodes.map((n) => n.round.pubkey))));
    const { rid, eid } = await everyoneReplays(nodes, stake);
    const ask = (node, seat) => fetch(`http://127.0.0.1:${node.port}/share`
      + `?round=${toHex(rid)}&entry=${toHex(eid)}&seat=${toHex(seat)}`);

    // It answers while the run is the FAILED one every seat agreed on.
    assert.equal((await ask(nodes[1], nodes[0].round.pubkey)).status, 200);

    // NOW A RUN WHOSE RESULTS SAY DELIVERED. A second entry in the same round,
    // and every seat's result for it says the player got through. The outcome
    // is not computed here - what is under test is what a seat DOES with the
    // word - and 23.2 cancels a delivered stake, so its preimage must never
    // leave: releasing it would let anyone settle an invoice that has to go
    // back to its player.
    // A ROUND OF ITS OWN, because every seat's round above is closed and a
    // closed round takes no new entries.
    const holder = nodes[6];
    const other = { ...contractFor(nodes.map((n) => n.round.pubkey)), configHash: b32(0x44) };
    const orid = holder.round.open(other);
    assumeSeated(holder.round, orid, other.nodes);

    const winner = {
      roundId: orid, playerPubkey: b32(6), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(b32(0x77)), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16),
      vssSharesRef: new Uint8Array(32),
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
    }

    const may = holder.preimages.mayRelease(orid, wid);
    assert.equal(may.ok, false);
    assert.match(may.why, /that run is DELIVERED/);
    assert.match(may.why, /would let anyone settle an invoice that has to go back to its player/);

    // AND A RUN NOBODY AGREED ON. Four of seven seats signed the same FAILED
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
    const short = holder.preimages.mayRelease(orid, uid);
    assert.equal(short.ok, false);
    assert.match(short.why, /no share is handed out before the result is final/);
    assert.match(short.why, /4 of 5 agree/);
  } finally { for (const n of nodes) await n.close(); }
});

test('a hold settles on a preimage five seats opened, and on nothing less', async () => {
  // (d) The hold path is unchanged and still follows the core's outcome word.
  // What changed is where the 32 bytes come from: no file, no injection - five
  // seats, or the stake stays in flight.
  const nodes = await committee(7);
  const port = fakePort();
  try {
    const stake = await dealTo(nodes, roundId(contractFor(nodes.map((n) => n.round.pubkey))));
    const { rid, eid, entry } = await everyoneReplays(nodes, stake);

    const asker = nodes[0];
    const peers = nodes.slice(1).map((x) => `http://127.0.0.1:${x.port}`);
    const preimages = new Preimages(asker.round, {
      curve: feldmanGroup, peers, fetcher: (u) => fetch(u), random: rand,
    });
    const custody = new Custody(asker.round, {
      port,
      preimageFor: async (id, e, roundIdBytes) => {
        const out = await preimages.open({ roundId: roundIdBytes, entryId: id });
        return out.ok ? out.preimage : null;
      },
    });
    const held = await custody.hold(entry);
    assert.equal(held.ok, true, held.why);

    const summary = (outcome, score) => ({
      entryId: eid, pubkey: entry.playerPubkey, outcome, score, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat,
    });

    // A LOSER SETTLES, and the preimage that went to Lightning is the one the
    // player committed to.
    const out = await custody.settleHeldInvoices({
      roundId: rid, minScore: 1, finalFor: () => true,
      entries: [summary(FORFEIT, 0), { ...summary(DELIVERED, 9), entryId: eid }].slice(0, 1)
        .concat([]),
    });
    assert.equal(out.ok, false, 'a round with one loser and nobody to pay should refuse');

    // With a winner beside them the table balances and the loser settles.
    const second = { ...entry, playerPubkey: b32(9), stakeCommitment: sha256(b32(0x79)),
      vssSharesRef: new Uint8Array(32) };
    const sid = entryId(second);
    const paid = await custody.settleHeldInvoices({
      roundId: rid, minScore: 1, finalFor: () => true,
      entries: [summary(FORFEIT, 0), { entryId: sid, pubkey: second.playerPubkey,
        outcome: DELIVERED, score: 9, stakeMsat: second.stakeMsat, feeMsat: second.feeMsat, donationMsat: second.donationMsat }],
    });
    assert.equal(paid.ok, true, paid.why);
    assert.equal(custody.stateOf(eid).state, SETTLED, 'the loser did not settle');
    const settled = port.calls.filter((c) => c[0] === 'settle');
    assert.equal(settled.length, 1);
    assert.deepEqual(settled[0][2], stake.preimage,
      'the bytes that went to Lightning are not the ones five seats opened');
    assert.deepEqual(sha256(settled[0][2]), entry.stakeCommitment);
  } finally { for (const n of nodes) await n.close(); }
});

test('with four seats reachable the loser\'s stake stays in flight', async () => {
  const nodes = await committee(7);
  const port = fakePort();
  try {
    const stake = await dealTo(nodes, roundId(contractFor(nodes.map((n) => n.round.pubkey))));
    const { rid, eid, entry } = await everyoneReplays(nodes, stake);

    const asker = nodes[0];
    const preimages = new Preimages(asker.round, {
      curve: feldmanGroup,
      // THREE PEERS, so four shares with this node's own: one short.
      peers: nodes.slice(1, 4).map((x) => `http://127.0.0.1:${x.port}`),
      fetcher: (u) => fetch(u), random: rand,
    });
    const custody = new Custody(asker.round, {
      port,
      preimageFor: async (id, e, roundIdBytes) => {
        const out = await preimages.open({ roundId: roundIdBytes, entryId: id });
        return out.ok ? out.preimage : null;
      },
    });
    await custody.hold(entry);

    const second = { ...entry, playerPubkey: b32(9) };
    const paid = await custody.settleHeldInvoices({
      roundId: rid, minScore: 1, finalFor: () => true,
      entries: [
        { entryId: eid, pubkey: entry.playerPubkey, outcome: FORFEIT, score: 0, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat },
        { entryId: entryId(second), pubkey: second.playerPubkey, outcome: DELIVERED, score: 9, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat },
      ],
    });
    assert.equal(paid.ok, true, paid.why);
    assert.equal(custody.stateOf(eid).state, HELD, 'four shares settled a stake');
    assert.equal(port.calls.filter((c) => c[0] === 'settle').length, 0);
    assert.match(paid.actions.find((a) => toHex(a.entryId) === toHex(eid)).why,
      /no preimage for that stake/);
  } finally { for (const n of nodes) await n.close(); }
});

test('a player who committed to one secret and dealt another opens nothing', async () => {
  // DECISION B, MEASURED. Feldman proves the dealer cut ONE polynomial; it
  // cannot prove that the polynomial's constant term is the preimage of the
  // hash the entry publishes, because the commitment is a group element and
  // the hash is not. So the lie is caught HERE, at reconstruction: five seats
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
    const opened = await new Preimages(asker.round, {
      curve: feldmanGroup,
      peers: nodes.slice(1).map((x) => `http://127.0.0.1:${x.port}`),
      fetcher: (u) => fetch(u), random: rand,
    }).open({ roundId: rid, entryId: eid });

    assert.equal(opened.ok, false, 'a stake opened to something the entry does not name');
    assert.equal(opened.held, 5, 'the seats did answer; the shares are consistent');
    assert.match(opened.why, /those shares do not open that stake/);
    assert.match(opened.why, /not the committed preimage/);
  } finally { for (const n of nodes) await n.close(); }
});

test('a seat that never replayed the run hands over nothing', async () => {
  // A node releases its share for a run IT signed a result for. A peer's
  // record is a peer's claim, and acting on somebody else's word about what a
  // run came to is how a committee becomes one node with six echoes.
  const nodes = await committee(7);
  try {
    const stake = await dealTo(nodes, roundId(contractFor(nodes.map((n) => n.round.pubkey))));
    const { rid, eid } = await everyoneReplays(nodes, stake);

    const quiet = nodes[6];
    const c = { ...contractFor(nodes.map((n) => n.round.pubkey)), configHash: b32(0x45) };
    const orid = quiet.round.open(c);
    assumeSeated(quiet.round, orid, c.nodes);
    const entry = {
      roundId: orid, playerPubkey: b32(8), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(b32(0x7a)), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32),
    };
    const wid = entryId(entry);
    quiet.round.enter(entry);

    // EVERY OTHER SEAT SIGNED, and this one did not.
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
    }

    const may = quiet.preimages.mayRelease(orid, wid);
    assert.equal(may.ok, false);
    assert.match(may.why, /this node signed no result for that run, so it releases nothing/);
  } finally { for (const n of nodes) await n.close(); }
});
