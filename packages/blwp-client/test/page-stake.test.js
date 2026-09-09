// THE PAGE DEALS ITS OWN STAKE, AND THE SEATS IT DEALS TO CAN OPEN IT.
//
// LETTER 15, AND ITS OWN SENTENCE IS RETRACTED. The letter read "the page does
// not vendor a curve, so a shipped page refuses a seat at a paying round".
// Measured on the live Daily: `blwp-curve.js` is 96,493 bytes, `index.html`
// loads it, and driving the SERVED file produces a real x-only key. The guard
// cannot fire and the missing curve was 0% of the hole.
//
// WHAT WAS OPEN IS A SILENT SEAT. `entryFor` was called with NO stake, so every
// seat the shipped page took carried `random(32)` where `sha256(P)` belongs and
// 32 zero bytes where the shares belong - and `stakeFor`, the page as dealer
// for 23.1 steps 1 and 2, had ZERO CALLERS. `round.js` accepts those zeros on
// purpose for M2, so nothing refused and nothing said anything.
//
// This file drives the page's OWN sequence against real daemons: ask who
// settles the round, deal, post the handout, build the entry, join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { stakeFor, entryFor, fetchSettlementSeats, roundPays } from '../src/join.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { handoutId, decodeHandout, openMyShare, NO_SHARES } from '../../protocol/src/handout.js';
import { sha256, toHex } from '../../protocol/src/hash.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { SHARES_TOTAL, SHARES_NEEDED } from '../../protocol/src/shares.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const FUNDED = { funded: () => true };

const contractFor = (nodes, stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  const raw = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes: raw, text: new TextDecoder().decode(raw) };
};

/**
 * SEVEN DAEMONS, and a `/committee?role=settlement` that answers with the ones
 * that actually settle.
 *
 * The real door reads a chain census, which `seated-committee.test.js`
 * exercises; what this file is about is the PAGE, so the answer is served and
 * the page's own behaviour is measured against it. The list it is given is
 * deliberately NOT all seven, because the whole point of `fetchSettlementSeats`
 * is that the contract's flat `nodes` list is the union of the committees.
 */
async function daemons(n = SHARES_TOTAL, { stakeMsat = 100000n } = {}) {
  const nodes = [];
  for (let i = 0; i < n; i++)
    nodes.push(await serve(openStore(':memory:'), { port: 0, ...FUNDED, now: () => NOW }));
  const contract = contractFor(nodes.map((x) => x.round.pubkey), stakeMsat);
  const rid = roundId(contract);
  for (const x of nodes)
    assert.equal((await post(x.port, '/round', encodeRoundContract(contract))).status, 201);
  return { nodes, contract, rid, close: () => Promise.all(nodes.map((x) => x.close())) };
}

/** The page's own sequence, in the order `index.html` runs it. */
async function pageJoins(world, settlementSeats) {
  const player = { secret: rand(32) };
  player.pubkey = schnorr.getPublicKey(player.secret);

  const pays = roundPays(world.contract);
  let stake = null;
  const accepted = [];
  const refused = [];
  if (pays) {
    stake = await stakeFor({ ...world.contract, id: world.rid }, {
      seats: settlementSeats, curve: feldmanGroup, random: rand, playerPubkey: player.pubkey,
    });
    for (const node of world.nodes) {
      const r = await post(node.port, '/handout', stake.body);
      if (r.status === 201) accepted.push(node); else refused.push(`${node.port}: ${r.text}`);
    }
  }
  const entry = {
    roundId: world.rid, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    ...entryFor(world.contract, {
      playerPubkey: player.pubkey, random: rand, ...(stake ? { stake } : {}),
    }),
  };
  return { player, stake, entry, accepted, refused, pays };
}

/**
 * THE NUMBER THAT CLOSES THE LETTER: an entry from the page's own sequence
 * carries a real commitment and shares the settlement seats can open.
 */
test('a paying-round entry from the page carries a real stake, not random bytes', async () => {
  const world = await daemons();
  try {
    // The settlement committee is FIVE of the seven, so this file measures the
    // page dealing to the list it was told rather than to everybody it knows.
    const settlement = world.nodes.slice(0, 5).map((n) => n.round.pubkey);
    const joined = await pageJoins(world, settlement);

    assert.equal(joined.pays, true, 'this fixture is not a paying round');
    assert.deepEqual(joined.entry.stakeCommitment, sha256(joined.stake.preimage),
      'the entry does not commit to a preimage anybody holds');
    assert.notDeepEqual(joined.entry.vssSharesRef, NO_SHARES,
      'the entry still says it publishes no shares');
    assert.deepEqual(joined.entry.vssSharesRef, handoutId(joined.stake.handout));

    // AND THE SEATS IT WAS DEALT TO CAN OPEN THEIRS. A handout no seat can open
    // is a stake that is lost at payout, which is worse than one never dealt.
    assert.equal(joined.accepted.length, settlement.length,
      `${joined.accepted.length} of ${settlement.length} settlement seats took the handout: `
      + joined.refused.join('; '));
    const handout = decodeHandout(joined.stake.body);
    let opened = 0;
    for (const node of world.nodes.slice(0, 5)) {
      const mine = await openMyShare(handout, {
        pubkey: node.round.pubkey, secret: node.round.identity.secret, curve: feldmanGroup,
      });
      if (mine.ok) opened++;
    }
    assert.equal(opened, settlement.length);
    console.log(`  ${settlement.length} settlement seats, ${joined.accepted.length} accepted the `
      + `handout, ${opened} opened their own share; ${SHARES_NEEDED} of them settle`);

    // AND A REAL DAEMON TAKES THE ENTRY, with the handout named rather than zeroed.
    const answer = await post(world.nodes[0].port, '/entry', encodeEntryContract(joined.entry));
    assert.equal(answer.status, 201, answer.text);
    assert.equal(toHex(answer.bytes), toHex(entryId(joined.entry)));
    console.log('  a daemon took the entry, and it names the handout rather than 32 zero bytes');
  } finally { await world.close(); }
});

/**
 * AND DEALING TO THE WRONG LIST IS REFUSED BY THE SEATS THEMSELVES.
 *
 * `contract.nodes` is the UNION of the role committees - `Roster.seatsFor`
 * says so - so a page that dealt to it would seal shares to seats that cannot
 * open one. Measured on nine bonded nodes with 7 + 7 slots: game 7,
 * settlement 7, union 9, five in both and two settlement-only.
 */
test('a stake dealt to the wrong committee is refused by the seats that cannot open it', async () => {
  const world = await daemons();
  try {
    // Two of the seven are strangers to the settlement committee - the shape a
    // game-verify-only seat has.
    const strangers = [schnorr.getPublicKey(rand(32)), schnorr.getPublicKey(rand(32))];
    const wrong = [...world.nodes.slice(0, 5).map((n) => n.round.pubkey), ...strangers];
    const joined = await pageJoins(world, wrong);

    assert.equal(joined.accepted.length, 5,
      'a seat with no share in the handout accepted it anyway');
    assert.equal(joined.refused.length, 2);
    for (const why of joined.refused)
      assert.match(why, /share|seat|open/i, `a seat refused for an unexpected reason: ${why}`);
    console.log(`  dealt to ${wrong.length} keys: ${joined.accepted.length} could open a share, `
      + `${joined.refused.length} could not`);
  } finally { await world.close(); }
});

/**
 * AND A ROUND THAT ASKS NOTHING IS A FREE SEAT, SAID OUT LOUD RATHER THAN
 * DEALT.
 */
test('a round that asks no stake deals none, and says so', async () => {
  const world = await daemons(3, { stakeMsat: 0n });
  try {
    const joined = await pageJoins(world, []);
    assert.equal(joined.pays, false);
    assert.equal(joined.stake, null, 'a free round dealt a stake nobody asked for');
    assert.deepEqual(joined.entry.vssSharesRef, NO_SHARES);
    const answer = await post(world.nodes[0].port, '/entry', encodeEntryContract(joined.entry));
    assert.equal(answer.status, 201, answer.text);
    console.log('  a free round: no stake dealt, 32 zero share bytes, and the daemon takes it');
  } finally { await world.close(); }
});
