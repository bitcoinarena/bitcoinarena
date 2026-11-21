// kanban #3040: the card's test (audit census r3-1 of 2026-11-19)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT census-r3-1: THE #2432 / #2700 SIGHTING QUORUM TAKES ONLY THE FIRST 64 SIGHTINGS OF A PEER'S RECORD, IN KEY ORDER.
// proposals.js vouch() reads `record.sightings.slice(0, 64)`, and every seat serves its sightings sorted by signer key. An attacker
// with 64 small bonds under keys that sort low signs 64 valid sightings of an honest bound proposal (any `at` before voting ended) and
// lists them from his seat; each honest seat merges them, and from then on the first 64 sightings of EVERY honest listing are the
// attacker's - an honest seat's own sighting is cut off. No honest sighting reaches another seat, the census-weight majority is never
// reached, and no bound proposal ever counts at any seat (governance frozen), for 64 x bond_min locked (not spent).
// SAFE: a peer's valid sightings by census keys this seat does not yet hold are taken, whatever key order the peer lists them in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals, seenMessage } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const keyOf = (n) => { const secret = new Uint8Array(32); secret[30] = (n >> 8) & 0xff; secret[31] = n & 0xff; secret[0] = 1; return { secret, pubkey: schnorr.getPublicKey(secret) }; };
// 300 keys sorted by their x-only hex: the attacker takes the 64 lowest, the honest seats and the proposer the highest
const KEYS = Array.from({ length: 300 }, (_, i) => keyOf(i + 1)).sort((a, b) => (toHex(a.pubkey) < toHex(b.pubkey) ? -1 : 1));
const ATTACK = KEYS.slice(0, 64);
const [PROPOSER, A, B, C, D] = KEYS.slice(-5);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const NET = new Uint8Array(32).fill(0x4e);
// four honest seats of 25 M each (100 M of the non-proposer weight); the attacker's 64 bonds of 1,000 sat each
const CENSUS = [{ pubkey: PROPOSER.pubkey, outpoint: 'p:0', bondSats: 35000000n },
  ...[A, B, C, D].map((k, i) => ({ pubkey: k.pubkey, outpoint: `h${i}:0`, bondSats: 25000000n })),
  ...ATTACK.map((k, i) => ({ pubkey: k.pubkey, outpoint: `x${i}:0`, bondSats: 1000n }))];
const DEP_HEIGHT = 200;
const BLOCK = 'dd'.repeat(32);

function chain() {
  const want = depositOutputsExpected(1000, SET);
  const config = Uint8Array.of(9, 9, 9);
  const body0 = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight: DEP_HEIGHT + 8, proposer: PROPOSER.pubkey };
  const raw = tx([...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body0) }]);
  const p = { ...body0, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), PROPOSER.secret);
  const idBytes = proposalId({ ...p, signature });
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature]));
  const txid = toHex(Uint8Array.from(p.depositTxid).reverse());
  return { raw, txid, hex, idBytes };
}

function seat(c, signer, tipRef) {
  return createProposals({ bindHeightFor: () => 0, confirmedTx: async (t, b) => (t === c.txid && b === BLOCK ? { raw: c.raw, height: DEP_HEIGHT } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    censusAt: async () => CENSUS, store: { read: () => [], write: () => {} },
    tipHeight: async () => tipRef.tip, seenSigner: { pubkey: signer.pubkey, sign: (m) => schnorr.sign(m, signer.secret) } });
}

const sightingBy = (k, id, at) => ({ by: toHex(k.pubkey), at, sig: toHex(schnorr.sign(seenMessage(id, at), k.secret)) });

test('64 low-key sightings in front of an honest seat\'s own do not hide the honest sightings: the census majority is reached', async () => {
  const c = chain();
  const tip = { tip: 205 };
  const seatA = seat(c, A, tip);
  const got = await seatA.add({ proposal: c.hex, blockHash: BLOCK });
  assert.equal(got.status, 201);
  const id = toHex(c.idBytes);
  const rec = seatA.list().find((r) => r.id === id);
  assert.ok(rec && rec.late, 'held in time, it waits for the census majority (#2700)');
  assert.equal(seatA.counts(id), false);
  // the attacker's 64 sightings (valid: census keys, `at` inside the window), listed first by key as every seat lists them
  const junk = ATTACK.map((k) => sightingBy(k, id, 204));
  // each honest peer (B, C, D) held it in time too; its listing is what it holds after merging the attacker's: sorted by key
  for (const peer of [B, C, D]) {
    const sightings = [...junk, sightingBy(peer, id, 205)].sort((x, y) => (x.by < y.by ? -1 : 1));
    await seatA.pull([{ ...rec, sightings }]);
  }
  const after = seatA.list().find((r) => r.id === id);
  const fromHonest = (after.sightings || []).filter((s) => [B, C, D].some((k) => toHex(k.pubkey) === s.by)).length;
  console.log('  seat A holds', (after.sightings || []).length, 'sightings,', fromHonest, 'of them from the honest peers B, C, D; counts:', seatA.counts(id));
  // kanban #3040: the record stops merging once it counts (it is no longer late), so the first honest peer whose sighting makes the majority is enough
  assert.ok(fromHonest >= 1, 'the honest peers\' signed sightings must be taken from their listings');
  assert.equal(seatA.counts(id), true, 'A + B + C + D hold 100 M of 100.064 M: the proposal counts');
});
