// THE DONATION SET A ROUND NAMES, SERVED BY ITS SEATS (M3.2 6e; §22A, §27A.4;
// the owner 2026-09-13: the donation authority signs with Ed25519).
//
// Measured before this: every seat answered /donation-set 404, and every
// launcher named the placeholder donationSetId b32(0xd0) - no set's id - so no
// round named a set anybody could pay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import {
  NETWORK_ID_REGTEST, AUTHORITY_PUBKEY_REGTEST, AUTHORITY_PUBKEY_TESTNET4,
} from '../../protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_SET_TESTNET4, TEST_DONATION_ENDPOINTS } from '../../protocol/src/test-donation-sets.js';
import { donationSetId, donationSetMatchesRound, splitDonation } from '../../protocol/src/donation.js';
import { donationSetBodyId, decodeDonationSetBody, DONATION_SIGNATURE_BYTES, authorityRotationId, decodeAuthorityRotation } from '../../protocol/src/authority.js';
import { urlOfLnurl } from '../../protocol/src/bech32.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const NOW = 1788700000000;
const SET = TEST_DONATION_SET_REGTEST;
const SET_ID = donationSetId(SET.recipients);

const contractFor = (nodes, donationSetIdOfRound) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS, entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20, slashRemainder: 'BURN',
  federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: donationSetIdOfRound,
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

async function seatsWith(setsPerSeat, rotationsPerSeat = []) {
  const seats = [];
  for (const [i, donationSets] of setsPerSeat.entries())
    seats.push(await serve(openStore(':memory:'), { port: 0, funded: () => true, now: () => NOW, donationSets, donationRotations: rotationsPerSeat[i] || [] }));
  const nodes = seats.map((s) => s.round.pubkey);
  const post = async (contract) => {
    for (const s of seats) {
      const r = await fetch(`http://127.0.0.1:${s.port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
      assert.equal(r.status, 201, `a seat refused the round: ${await r.text()}`);
    }
    return roundId(contract);
  };
  const ask = async (s, rid) => {
    const r = await fetch(`http://127.0.0.1:${s.port}/donation-set?round=${hex(rid)}`);
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  return { seats, nodes, post, ask, close: () => Promise.all(seats.map((s) => s.close())) };
}

test('each test set is signed by its network\'s Ed25519 donation authority and splits 2000 msat between two local recipients', () => {
  assert.equal(ed25519.verify(SET.signature, donationSetBodyId(SET), AUTHORITY_PUBKEY_REGTEST), true, 'regtest');
  assert.equal(ed25519.verify(TEST_DONATION_SET_TESTNET4.signature, donationSetBodyId(TEST_DONATION_SET_TESTNET4), AUTHORITY_PUBKEY_TESTNET4), true, 'testnet4');
  assert.equal(ed25519.verify(SET.signature, donationSetBodyId(SET), AUTHORITY_PUBKEY_TESTNET4), false, 'one network\'s key does not sign the other\'s set');
  assert.deepEqual(SET.recipients.map((r) => urlOfLnurl(r.lnurl)), TEST_DONATION_ENDPOINTS);
  const split = splitDonation({ donationMsat: 2000n, recipients: SET.recipients });
  assert.deepEqual(split.shares.map((s) => [urlOfLnurl(s.lnurl), s.amountMsat]),
    [[TEST_DONATION_ENDPOINTS[0], 1334n], [TEST_DONATION_ENDPOINTS[1], 666n]]);
  console.log(`  2000 msat: ${split.shares.map((s) => `${s.amountMsat} to ${urlOfLnurl(s.lnurl)}`).join(', ')}`);
});

test('every seat of a round serves the set the round names, byte for byte', async () => {
  const w = await seatsWith([[SET], [SET]]);
  try {
    const contract = contractFor(w.nodes, SET_ID);
    const rid = await w.post(contract);
    const said = await Promise.all(w.seats.map((s) => w.ask(s, rid)));
    assert.deepEqual(said.map((x) => x.status), [200, 200]);
    assert.equal(hex(said[0].bytes), hex(said[1].bytes), 'the seats serve different bytes');
    const body = said[0].bytes.slice(0, -DONATION_SIGNATURE_BYTES);
    const signature = said[0].bytes.slice(-DONATION_SIGNATURE_BYTES);
    const served = { ...decodeDonationSetBody(body), signature };
    assert.equal(ed25519.verify(signature, donationSetBodyId(served), AUTHORITY_PUBKEY_REGTEST), true);
    assert.equal(donationSetMatchesRound(contract, served.recipients).ok, true);
    console.log(`  both seats: 200, ${said[0].bytes.length} bytes, set ${hex(SET_ID).slice(0, 16)}..., signed by ${hex(AUTHORITY_PUBKEY_REGTEST).slice(0, 16)}`);
  } finally { await w.close(); }
});

test('a seat serves no set it cannot stand behind: the placeholder, none held, or a set another key signed', async () => {
  const forger = ed25519.utils.randomSecretKey();
  const forged = { ...SET, signature: ed25519.sign(donationSetBodyId(SET), forger) };
  const w = await seatsWith([[SET], [], [forged]]);
  try {
    const placeholder = await w.post(contractFor(w.nodes, b32(0xd0)));
    const named = await w.post(contractFor(w.nodes, SET_ID));
    const onPlaceholder = await Promise.all(w.seats.map((s) => w.ask(s, placeholder)));
    const onNamed = await Promise.all(w.seats.map((s) => w.ask(s, named)));
    assert.deepEqual(onPlaceholder.map((x) => x.status), [404, 404, 404], 'a set served for a round naming the placeholder');
    assert.deepEqual(onNamed.map((x) => x.status), [200, 404, 404], 'the seat with no set or a forged one served it');
    const bad = await fetch(`http://127.0.0.1:${w.seats[0].port}/donation-set?round=zz`);
    assert.equal(bad.status, 400);
    const unknown = await w.ask(w.seats[0], b32(0x77));
    assert.equal(unknown.status, 404);
    console.log(`  placeholder ${onPlaceholder.map((x) => x.status)}; named: held ${onNamed[0].status}, none ${onNamed[1].status}, forged ${onNamed[2].status}`);
  } finally { await w.close(); }
});

test('a seat serves the authority rotations it holds for the round\'s network, and an empty list when it holds none', async () => {
  const recovery = ed25519.utils.randomSecretKey();
  const body = { networkId: NETWORK_ID_REGTEST, serial: 1n, newAuthority: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), validFrom: 5 };
  const rotation = { ...body, signature: ed25519.sign(authorityRotationId(body), recovery) };
  const w = await seatsWith([[SET], [SET]], [[rotation], []]);
  try {
    const rid = await w.post(contractFor(w.nodes, SET_ID));
    const said = await Promise.all(w.seats.map(async (s) => (await fetch(`http://127.0.0.1:${s.port}/donation-rotations?round=${hex(rid)}`)).json()));
    assert.equal(said[0].rotations.length, 1);
    const back = decodeAuthorityRotation(Uint8Array.from(Buffer.from(said[0].rotations[0].body, 'hex')));
    assert.equal(hex(back.newAuthority), hex(body.newAuthority));
    assert.equal(said[0].rotations[0].signature, hex(rotation.signature));
    assert.deepEqual(said[1].rotations, []);
  } finally { await w.close(); }
});
