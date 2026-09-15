// A STAKE OPENS AT THE ROUND'S THRESHOLD, NEVER THE ONE A PLAYER DEALT (M3.3-26).
//
// Measured on the regtest rehearsal: both daemons reached the loser's settle,
// each held the 2 shares of a stake dealt 2-of-2, and stopped at "2 of 5
// shares" - the settle's `open` asked for SHARES_NEEDED = 5. And the door took
// whatever threshold a handout named: `acceptHandout` checks a handout only
// against ITSELF. A player who expected to lose could send a stake no committee
// can open - a refund on the timelock every time, which 13C says a player
// cannot arrange - or one a single seat opens alone. So the threshold is the
// ROUND'S (`receiptsNeeded(settlementSlots)`: 2 of 2, 5 of 7) and the door
// refuses any other by name. An honest dealer cannot even make the bad ones
// (`dealHandout` refuses), so the bad ones here are crafted, the way a
// cheating player would send them.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout } from '../../protocol/src/handout.js';
import { sealShare } from '../../protocol/src/seal.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };

const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: nodes.length, settlementSlots: nodes.length, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

/** A real dealing of `needed` over `seats`, the way `stakeFor` deals one. */
async function real(seats, rid, needed, preimage = secretScalar(), ephemeralSecret = rand(32)) {
  const d = await dealHandout({
    preimage, seats, roundId: rid, playerPubkey: b32(5),
    ephemeralSecret, ephemeralPubkey: feldmanGroup.pointX(ephemeralSecret),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed, curve: feldmanGroup,
  });
  assert.equal(d.ok, true, d.why);
  return { handout: d.handout, preimage, ephemeralSecret };
}

/** THREE-OF-TWO, crafted: a 3-of-3 dealing with the third seat's share dropped. */
async function threeOfTwo(seats, rid) {
  const { handout } = await real([...seats, schnorr.getPublicKey(rand(32))], rid, 3);
  return { ...handout, shares: handout.shares.slice(0, 2) };
}

/**
 * ONE-OF-TWO, crafted: a degree-0 polynomial. The one commitment is G*a0 off a
 * real dealing, and every seat is sealed the constant a0 - which is exactly
 * what such a polynomial gives, so each seat's own Feldman check passes and
 * any one seat alone holds the preimage.
 */
async function oneOfTwo(seats, rid) {
  const { handout, preimage, ephemeralSecret } = await real(seats, rid, 2);
  const a0 = scalarFrom32(preimage);
  const shares = [];
  for (const s of handout.shares)
    shares.push({ seat: s.seat, seatPubkey: s.seatPubkey,
      sealed: await sealShare({ value: a0, seat: s.seat, seatPubkey: s.seatPubkey, ephemeralSecret, curve: feldmanGroup }) });
  return { ...handout, needed: 1, commitments: [handout.commitments[0]], shares };
}

async function door(node, seats) {
  const c = contractFor(seats);
  const rid = roundId(c);
  await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
  assumeSeated(node.round, rid, seats);
  const post = async (h) => {
    const r = await fetch(`http://127.0.0.1:${node.port}/handout`, { method: 'POST', body: encodeHandout(h) });
    return { status: r.status, text: (await r.text()).trim() };
  };
  return { rid, post };
}

test('two seats: the door takes 2-of-2 and refuses a crafted 3-of-2 and a crafted 1-of-2 by name', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const seats = [a.round.pubkey, schnorr.getPublicKey(rand(32))];
    const { rid, post } = await door(a, seats);
    const two = await post((await real(seats, rid, 2)).handout);
    const three = await post(await threeOfTwo(seats, rid));
    const one = await post(await oneOfTwo(seats, rid));
    console.log(`  2-of-2 -> ${two.status}; 3-of-2 -> ${three.status} ${three.text.slice(0, 80)}; 1-of-2 -> ${one.status} ${one.text.slice(0, 80)}`);
    assert.equal(two.status, 201, `a stake dealt at the round's own threshold was refused: ${two.text}`);
    assert.notEqual(three.status, 201, 'a stake no committee can open was taken');
    assert.equal(one.status, 409, `a stake one seat opens alone was taken: ${one.status} ${one.text}`);
    assert.match(one.text, /this round's stakes open at 2 of 2/);
  } finally { await a.close(); }
});

test('seven seats: the door takes 5-of-7 and refuses 7-of-7 - what the page used to deal - by name', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const seats = [a.round.pubkey, ...Array.from({ length: 6 }, () => schnorr.getPublicKey(rand(32)))];
    const { rid, post } = await door(a, seats);
    const five = await post((await real(seats, rid, 5)).handout);
    const seven = await post((await real(seats, rid, 7)).handout);
    console.log(`  5-of-7 -> ${five.status}; 7-of-7 -> ${seven.status} ${seven.text.slice(0, 80)}`);
    assert.equal(five.status, 201, `a stake dealt at the round's own threshold was refused: ${five.text}`);
    assert.equal(seven.status, 409, `a stake every seat must open was taken: ${seven.status}`);
    assert.match(seven.text, /this round's stakes open at 5 of 7/);
  } finally { await a.close(); }
});
