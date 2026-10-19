// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION ROUND'S STAKE FROM THE PAGE: THE INVOICE FIRST (2026-09-11).
//
// The page asks a node for the round's federation invoice and builds its
// entry on that invoice's hash - no preimage chosen, no shares dealt - and it
// checks the amount is the round's net stake before committing to anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { federationStakeFor } from '../src/client.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { entryFor } from '../src/join.js';
import { NO_SHARES } from '../../arena-protocol/src/handout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { coreHashHex } from '../../nextblock/tools/hash-core.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

// A PAYING ROUND NAMES ITS FEDERATION, AND ITS ENTRY ITS LOCK (RULED 2026-09-24, the enum slice's fifth cut, as
// join.test's fixtures): this paying fixture used to be hold-shaped - a stake and no federation - and entryFor now refuses
// that shape. It keeps measuring what it measured, on a real FEDERATION entry: an attested claim key and a stake lock with
// a non-zero outpoint, paying to the dealt stake's point where one is dealt.
const lockedFor = (stakePoint = Uint8Array.of(2, ...new Uint8Array(32).fill(0x6c))) => ({
  claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
  stakeLock: { outpoint: { txid: new Uint8Array(32).fill(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: stakePoint } } },
});
const round = { id: new Uint8Array(32).fill(7), stakeMsat: 1000000n, gameId: NEXTBLOCK_GAME_ID, simCoreHash: fromHex(coreHashHex()), federationId: TEST_FEDERATION_ID };
const NET = round.stakeMsat - entryFeeMsat(round.stakeMsat);
const HASH = 'aa'.repeat(32);

/** Nodes that answer `/federation-invoice` as each test says. */
function nodesAnswering(answers) {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const node = Object.keys(answers).find((n) => url.startsWith(n));
    const a = answers[node];
    return { ok: a.status === 200, status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  return { fetcher, asked };
}

test('the stake commits to the node\'s federation invoice hash, deals no shares, and the entry carries both', async () => {
  const { fetcher, asked } = nodesAnswering({
    'http://a': { status: 200, body: { paymentHash: HASH, amountMsat: String(NET), request: 'lnbcrt-fed' } },
  });
  const stake = await federationStakeFor(round, { nodes: ['http://a'], fetcher });
  assert.equal(asked[0], `http://a/federation-invoice?round=${toHex(round.id)}`);
  assert.equal(stake.federation, true);
  assert.equal(toHex(stake.stakeCommitment), HASH);
  assert.equal(toHex(stake.vssSharesRef), toHex(NO_SHARES), 'a federation stake dealt shares');
  assert.equal(stake.request, 'lnbcrt-fed');
  const entry = entryFor(round, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), stake, ...lockedFor() });
  assert.equal(toHex(entry.stakeCommitment), HASH);
  assert.equal(toHex(entry.vssSharesRef), toHex(NO_SHARES));
});

test('an invoice for another amount is refused, and the next node is asked', async () => {
  const { fetcher } = nodesAnswering({
    'http://a': { status: 200, body: { paymentHash: HASH, amountMsat: String(NET + 1n), request: 'lnbcrt-wrong' } },
    'http://b': { status: 200, body: { paymentHash: 'bb'.repeat(32), amountMsat: String(NET), request: 'lnbcrt-right' } },
  });
  const stake = await federationStakeFor(round, { nodes: ['http://a', 'http://b'], fetcher });
  assert.equal(stake.request, 'lnbcrt-right');
  await assert.rejects(
    federationStakeFor(round, { nodes: ['http://a'], fetcher }),
    /net stake is/);
});

// ONE ARITHMETIC (M3.2 6e): a donor's stake is the stake less the fee AND the
// donation, and the entry it goes into names that donation - so the node is
// asked for that amount and anything else is refused, the fee-only net included.
test('a 2% donor asks for the stake less the fee and the donation, refuses the fee-only net, and its entry is that invoice', async () => {
  const DONATION = round.stakeMsat * 2n / 100n;
  const { fetcher, asked } = nodesAnswering({
    'http://a': { status: 200, body: { paymentHash: HASH, amountMsat: String(NET), request: 'lnbcrt-fee-only' } },
    'http://b': { status: 200, body: { paymentHash: 'bb'.repeat(32), amountMsat: String(NET - DONATION), request: 'lnbcrt-donor' } },
  });
  const stake = await federationStakeFor(round, { nodes: ['http://a', 'http://b'], fetcher, donationMsat: DONATION });
  assert.equal(asked[0], `http://a/federation-invoice?round=${toHex(round.id)}&donation=${DONATION}`);
  assert.equal(stake.request, 'lnbcrt-donor', 'the fee-only net was taken for a donor');
  assert.equal(stake.amountMsat, NET - DONATION);
  const entry = entryFor(round, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), stake, donationMsat: DONATION, ...lockedFor() });
  assert.equal(toHex(entry.stakeCommitment), 'bb'.repeat(32));
  assert.equal(entry.donationMsat, DONATION);
  await assert.rejects(federationStakeFor(round, { nodes: ['http://a'], fetcher, donationMsat: DONATION }), /net stake is/);
  await assert.rejects(federationStakeFor(round, { nodes: ['http://a'], fetcher, donationMsat: round.stakeMsat }), /cannot come to more than it/);
});

test('a free round, and nodes that make no federation invoice, give no stake', async () => {
  await assert.rejects(federationStakeFor({ ...round, stakeMsat: 0n }, { nodes: ['http://a'] }), /asks no stake/);
  const { fetcher } = nodesAnswering({ 'http://a': { status: 409, body: 'this node makes no federation invoices' } });
  await assert.rejects(federationStakeFor(round, { nodes: ['http://a'], fetcher }), /makes no federation invoices/);
});
