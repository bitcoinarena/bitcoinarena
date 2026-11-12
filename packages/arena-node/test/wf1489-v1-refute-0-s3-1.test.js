// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 skeptic 3 of fix:faucet:1 (70c049ea0 + dbff0a135 + 7e75289d0): the census the check trusts is testnet4's (FAUCET_SEASON_SEATS),
// where a bond costs only faucet coins (50,000 tn4 sat), while the bounty is paid on MAINNET (FAUCET_BOUNTY_NETWORK). Nothing checks that a
// round was ever drawn or held by anyone outside its own committee: three bonded nodes of one operator, each answering at its own advertised
// endpoint, invent a round whose committee is the three of them, and each signs its own FINAL. The claimed node is also counted as one of its own
// NODE_BOUNTY_AGREE witnesses. Result: all three keys pass the checklist - three mainnet bounties for three free bonds and no round played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const TRUSTED = 'https://trusted.example';
const KEYS = [0x61, 0x62, 0x63].map((b) => { const sk = new Uint8Array(32).fill(b); return { sk, pk: toHex(schnorr.getPublicKey(sk)) }; });
const RID = toHex(new Uint8Array(32).fill(0x5a));   // a round no trusted seat, and nobody outside the three, ever held
const END = Object.fromEntries(KEYS.map((k, i) => [k.pk, `wss://evil${i + 1}.example`]));
const fins = KEYS.map((k) => toHex(signFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(k.pk), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, k.sk))));
// the trusted census: many honest nodes plus the operator's three, each with the cheapest testnet4 bond
const HONEST = Array.from({ length: 10 }, (_, i) => ({ node: (i + 16).toString(16).repeat(32).slice(0, 64), endpoint: `wss://honest${i}.example`, bondSats: '5000000' }));
const roles = [...HONEST, ...KEYS.map((k) => ({ node: k.pk, endpoint: END[k.pk], bondSats: '50000' }))];

const fetchJson = async (url) => {
  if (url.endsWith('/owner')) return { node: 'dd'.repeat(32), claimed: false };
  if (url.endsWith('/roles')) return url.startsWith(TRUSTED) ? { nodes: roles } : { nodes: [] };
  const who = KEYS.find((k) => url.startsWith(`${END[k.pk].replace(/^wss:/, 'https:')}/`));
  if (who) return { node: who.pk, held: [{ roundId: RID, committee: KEYS.map((k) => k.pk), finals: fins }] };
  return { node: null, held: [] };   // every honest seat: never saw that round
};

test('#1489 refute-0-s3-1: three cheaply bonded colluding nodes witness each other\'s made-up round and all three pass', async () => {
  let passed = 0;
  for (const k of KEYS) {
    const r = await nodeBountyCheck({ node: k.pk, seats: [], nowMs: NOW, censusSeats: [TRUSTED], fetchJson });
    if (r.passes) passed++;
    console.log('  MEASURED s3-1:', k.pk.slice(0, 8), JSON.stringify(r.checks.map((c) => [c.key, c.ok, c.says])));
  }
  console.log(`  MEASURED s3-1: ${passed} of 3 colluding testnet4-bonded keys pass on a round no seat outside them ever held`);
  assert.equal(passed, 0, 'a round only its own claimants hold (no trusted seat, no drawn committee) must not earn a mainnet bounty');
});

test('#1489 refute-0-s3-1: the claimed node is not one of its own witnesses', async () => {
  // only two OTHER census nodes hold the round; the claimant's own door is the third "witness"
  const r = await nodeBountyCheck({ node: KEYS[0].pk, seats: [], nowMs: NOW, censusSeats: [TRUSTED], fetchJson });
  assert.equal(r.checks.find((c) => c.key === 'committees').ok, false, `NODE_BOUNTY_AGREE witnesses must be other nodes than the claimant: ${r.checks.find((c) => c.key === 'committees').says}`);
});
