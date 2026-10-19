// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DONATION SET A ROUND NAMES, SERVED BY ITS SIGNER NODES (M3.2 6e; §22A, §27A.4;
// 2026-09-13: the donation authority signs with Ed25519).
//
// Measured before this: every signer node answered /donation-set 404, and every
// launcher named the placeholder donationSetId b32(0xd0) - no set's id - so no
// round named a set anybody could pay.
// A FREE ROUND (RULED 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import {
  NETWORK_ID_REGTEST, AUTHORITY_PUBKEY_REGTEST, AUTHORITY_PUBKEY_TESTNET4,
} from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_SET_TESTNET4, TEST_DONATION_ENDPOINTS } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId, donationSetMatchesRound, splitDonation } from '../../arena-protocol/src/donation.js';
import { donationSetBodyId, decodeDonationSetBody, DONATION_SIGNATURE_BYTES, authorityRotationId, decodeAuthorityRotation } from '../../arena-protocol/src/authority.js';
import { urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const NOW = 1788700000000;
const SET = TEST_DONATION_SET_REGTEST;
const SET_ID = donationSetId(SET.recipients);

const contractFor = (nodes, donationSetIdOfRound) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS, entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetIdOfRound,
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

async function signerNodesWith(setsPerSignerNode, rotationsPerSignerNode = []) {
  const signerNodes = [];
  for (const [i, donationSets] of setsPerSignerNode.entries())
    signerNodes.push(await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, now: () => NOW, donationSets, donationRotations: rotationsPerSignerNode[i] || [] }));
  const nodes = signerNodes.map((s) => s.round.pubkey);
  const post = async (contract) => {
    for (const s of signerNodes) {
      const r = await fetch(`http://127.0.0.1:${s.port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
      assert.equal(r.status, 201, `a signer node refused the round: ${await r.text()}`);
    }
    return roundId(contract);
  };
  const ask = async (s, rid) => {
    const r = await fetch(`http://127.0.0.1:${s.port}/donation-set?round=${hex(rid)}`);
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  return { signerNodes, nodes, post, ask, close: () => Promise.all(signerNodes.map((s) => s.close())) };
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

test('every signer node of a round serves the set the round names, byte for byte', async () => {
  const w = await signerNodesWith([[SET], [SET]]);
  try {
    const contract = contractFor(w.nodes, SET_ID);
    const rid = await w.post(contract);
    const said = await Promise.all(w.signerNodes.map((s) => w.ask(s, rid)));
    assert.deepEqual(said.map((x) => x.status), [200, 200]);
    assert.equal(hex(said[0].bytes), hex(said[1].bytes), 'the signer nodes serve different bytes');
    const body = said[0].bytes.slice(0, -DONATION_SIGNATURE_BYTES);
    const signature = said[0].bytes.slice(-DONATION_SIGNATURE_BYTES);
    const served = { ...decodeDonationSetBody(body), signature };
    assert.equal(ed25519.verify(signature, donationSetBodyId(served), AUTHORITY_PUBKEY_REGTEST), true);
    assert.equal(donationSetMatchesRound(contract, served.recipients).ok, true);
    console.log(`  both signer nodes: 200, ${said[0].bytes.length} bytes, set ${hex(SET_ID).slice(0, 16)}..., signed by ${hex(AUTHORITY_PUBKEY_REGTEST).slice(0, 16)}`);
  } finally { await w.close(); }
});

test('a signer node serves no set it cannot stand behind: the placeholder, none held, or a set another key signed', async () => {
  const forger = ed25519.utils.randomSecretKey();
  const forged = { ...SET, signature: ed25519.sign(donationSetBodyId(SET), forger) };
  const w = await signerNodesWith([[SET], [], [forged]]);
  try {
    const placeholder = await w.post(contractFor(w.nodes, b32(0xd0)));
    const named = await w.post(contractFor(w.nodes, SET_ID));
    const onPlaceholder = await Promise.all(w.signerNodes.map((s) => w.ask(s, placeholder)));
    const onNamed = await Promise.all(w.signerNodes.map((s) => w.ask(s, named)));
    assert.deepEqual(onPlaceholder.map((x) => x.status), [404, 404, 404], 'a set served for a round naming the placeholder');
    assert.deepEqual(onNamed.map((x) => x.status), [200, 404, 404], 'the signer node with no set or a forged one served it');
    const bad = await fetch(`http://127.0.0.1:${w.signerNodes[0].port}/donation-set?round=zz`);
    assert.equal(bad.status, 400);
    const unknown = await w.ask(w.signerNodes[0], b32(0x77));
    assert.equal(unknown.status, 404);
    console.log(`  placeholder ${onPlaceholder.map((x) => x.status)}; named: held ${onNamed[0].status}, none ${onNamed[1].status}, forged ${onNamed[2].status}`);
  } finally { await w.close(); }
});

test('a signer node serves the authority rotations it holds for the round\'s network, and an empty list when it holds none', async () => {
  const recovery = ed25519.utils.randomSecretKey();
  const body = { networkId: NETWORK_ID_REGTEST, serial: 1n, newAuthority: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), validFrom: 5 };
  const rotation = { ...body, signature: ed25519.sign(authorityRotationId(body), recovery) };
  const w = await signerNodesWith([[SET], [SET]], [[rotation], []]);
  try {
    const rid = await w.post(contractFor(w.nodes, SET_ID));
    const said = await Promise.all(w.signerNodes.map(async (s) => (await fetch(`http://127.0.0.1:${s.port}/donation-rotations?round=${hex(rid)}`)).json()));
    assert.equal(said[0].rotations.length, 1);
    const back = decodeAuthorityRotation(Uint8Array.from(Buffer.from(said[0].rotations[0].body, 'hex')));
    assert.equal(hex(back.newAuthority), hex(body.newAuthority));
    assert.equal(said[0].rotations[0].signature, hex(rotation.signature));
    assert.deepEqual(said[1].rotations, []);
  } finally { await w.close(); }
});

// THE SET IN FORCE, A SOFT FORK (27A.4; LNURL-0822, 2026-10-02): a newer serial signed by the network's authority,
// valid from a height, is the set every round with its census at or past that height must name; a round below it keeps the
// set it named (22A). A regtest serial-2 set valid from 900100, public bytes signed by the regtest authority.
const SET2 = { ...decodeDonationSetBody(Uint8Array.from(Buffer.from('1400019855e6790b51f0a6ec3ee1a4d83f4de9ad4be7bffb169f0525ad00a59ced5b380000000000000002000dbc040099100001000200466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a68736170647679306e387265381a0b00466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a687361706476673764706667710d05', 'hex'))),
  signature: Uint8Array.from(Buffer.from('f007229c5185a12eeed3310cd5722b576d39121927ef6cdf9624fb868ac61e200cdf60274fbb68cd6f46425d05ba611c989d06e4f606e9ef3b34f33244332e0b', 'hex')) };
test('a newer set in force from a height: a round below it keeps its set, a round at it must name the newer one', async () => {
  assert.equal(ed25519.verify(SET2.signature, donationSetBodyId(SET2), AUTHORITY_PUBKEY_REGTEST), true, 'the serial-2 set is not the regtest authority\'s');
  const w = await signerNodesWith([[SET, SET2], [SET, SET2]]);
  try {
    const below = await w.ask(w.signerNodes[0], await w.post({ ...contractFor(w.nodes, SET_ID), censusHeight: 900099 }));
    const oldAt = await w.ask(w.signerNodes[0], await w.post({ ...contractFor(w.nodes, SET_ID), censusHeight: 900100 }));
    const newAt = await w.ask(w.signerNodes[0], await w.post({ ...contractFor(w.nodes, donationSetId(SET2.recipients)), censusHeight: 900100 }));
    const why = oldAt.status === 200 ? '' : Buffer.from(oldAt.bytes).toString();
    console.log('  FACTS (in force):', JSON.stringify({ below: below.status, oldAtHeight: oldAt.status, why: why.slice(0, 140), newAtHeight: newAt.status }));
    assert.equal(below.status, 200, 'a round below the newer set lost the set it named');
    assert.notEqual(oldAt.status, 200, 'a round at the newer set\'s height was served the superseded set');
    assert.match(why, /in force is serial 2/);
    assert.equal(newAt.status, 200, 'a round naming the set in force was refused');
  } finally { await w.close(); }
});
