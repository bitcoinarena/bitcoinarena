// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 census-11 (P5 + P4): a config proposal carries its FULL config as a u16 vec - up to 65,535 bytes - and a seat keeps
// every proposal that stands, with no bound on its size or on how many it holds, and lists them all, bytes and all, at GET /proposals.
// The peer pull (server.js pullProposals) reads each seat's GET /proposals through jsonUpTo(r, PEER_LISTING_BYTES = 4 MiB) and drops
// the WHOLE answer when it is longer. ONE bonded node (one seat out of 7) posts ~33 proposals of 64 KiB configs, each on a 1-sat deposit,
// to every seat: every seat's listing is then over 4 MiB, and no seat can pull ANY proposal from any other again - an honest proposal
// posted to one seat (or to seats while one was down) never reaches the others, and they never count it (the pull is the only way
// a missed proposal, and the #2432 sightings, travel between seats).
// Safe behaviour: an honest proposal a seat holds is still pulled by its peers after one bonded node filled that seat with big proposals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { jsonUpTo, PEER_LISTING_BYTES } from '../src/peer-read.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
// a deposit transaction; `k` makes its prevout (and so its txid) its own
const tx = (outs, k) => Uint8Array.from([...le(2, 4), 1, ...le(k, 4), ...new Uint8Array(28).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 10000, label: 'a' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const BLOCK = 'bb'.repeat(32);

const attacker = new Uint8Array(32).fill(11);     // one bonded node (the one seat the attacker runs)
const honest = new Uint8Array(32).fill(12);       // another bonded node, proposing in good faith
const census = [{ pubkey: schnorr.getPublicKey(attacker), outpoint: 'a1:0', bondSats: 100000n },
  { pubkey: schnorr.getPublicKey(honest), outpoint: 'a2:0', bondSats: 100000n }];

// every deposit of the test, 1 sat each, as the seat's chain holds them in BLOCK at height 200
const deposits = new Map();
const depositFor = (k) => {
  const raw = tx(depositOutputsExpected(1, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), k);
  const txid = Uint8Array.from(parseTransaction(raw).txid);
  deposits.set(toHex(Uint8Array.from(txid).reverse()), raw);
  return txid;
};
const seat = () => createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && deposits.has(txid) ? { raw: deposits.get(txid), height: 200 } : null),
  recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt: async () => census,
  store: { read: () => [], write: () => {} } });
const proposalHex = (secret, config, k) => {
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config,
    class: CLASS.MONEY, activationHeight: 100000, proposer: schnorr.getPublicKey(secret), depositTxid: depositFor(k) };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
};

test('wf1489 r5 census-11: one bonded node\'s big proposals do not stop the seats pulling an honest proposal from each other', async () => {
  const a = seat(), b = seat();
  // the attacker's proposals: the largest config a proposal carries (a u16 vec), one 1-sat deposit each, posted to every seat
  // kanban #2723: a 64 KiB config (the largest a u16 vec holds) is refused at every seat - a proposal carries at most 4096 config bytes
  const big = await a.add({ proposal: proposalHex(attacker, new Uint8Array(65535).fill(9), 999), blockHash: BLOCK });
  assert.equal(big.status, 422, `a 64 KiB config is refused (${big.why || ''})`);
  for (let i = 0; i < 34; i++) {
    const config = new Uint8Array(4096).fill(i + 1);   // the largest config a seat now keeps
    const hex = proposalHex(attacker, config, 1000 + i);
    const ga = await a.add({ proposal: hex, blockHash: BLOCK });
    const gb = await b.add({ proposal: hex, blockHash: BLOCK });
    assert.ok(ga.ok && gb.ok, `the attacker's proposal ${i} is kept (${ga.why || gb.why || ''})`);
  }
  // an honest proposal, posted to seat A only (B was down at the time)
  const h = await a.add({ proposal: proposalHex(honest, Uint8Array.of(1, 2, 3), 7), blockHash: BLOCK });
  assert.equal(h.status, 201);
  // B's peer pull of A, as server.js pullProposals reads it: GET /proposals through jsonUpTo(r, PEER_LISTING_BYTES)
  const listing = JSON.stringify({ proposals: a.list() });
  console.log(`  A's GET /proposals: ${listing.length} bytes for ${a.list().length} proposals (peer read limit ${PEER_LISTING_BYTES})`);
  let got = null;
  try { got = await jsonUpTo(new Response(listing, { status: 200 }), PEER_LISTING_BYTES); } catch (e) { console.log(`  B's read of A: ${e.message}`); got = null; }
  let took = 0;
  if (got && Array.isArray(got.proposals)) took = await b.pull(got.proposals);
  const bHolds = b.list().some((r) => r.id === h.id);
  console.log(`  B took ${took} proposal(s) from A; B holds the honest proposal: ${bHolds}`);
  assert.ok(bHolds, 'seat B pulls the honest proposal seat A holds');
});
