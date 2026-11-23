// kanban #3373: the card's test (audit census a6-3-1)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT census a6-3-1 (P5): THE PEER PULL OF GET /proposals VOUCHES ONCE PER LISTED RECORD, NOT ONCE PER PROPOSAL.
// proposals.pull takes up to 256 records of one peer's listing and, for every record whose id names a proposal this seat keeps late
// (every bound proposal is late until a census majority's sightings are held, #2700), calls vouch(id, record). vouch's #3040 rule
// "at most one signature per census key is checked" holds inside ONE call only: its `tried` set is new for each record. One census
// seat whose /proposals the honest seats pull lists the same late record 256 times, each copy carrying a junk sighting (well formed,
// `at` inside the window, random signature) by every census key that has not signed yet: every honest seat runs 256 x K BIP-340
// checks on its thread in that one pull (K = the census keys), every ARENA_PROPOSALS_PULL_MS.
// SAFE: one pull checks at most one sighting per census key and proposal (a repeated record is no new evidence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
let verifies = 0;
const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
const keyOf = (n) => { const secret = new Uint8Array(32); secret[30] = (n >> 8) & 0xff; secret[31] = n & 0xff; secret[0] = 2; return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const K = 40;
const KEYS = Array.from({ length: K + 2 }, (_, i) => keyOf(i + 1));
const [PROPOSER, SELF, ...OTHERS] = KEYS;
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const NET = new Uint8Array(32).fill(0x4e);
const CENSUS = [{ pubkey: PROPOSER.pubkey, outpoint: 'p:0', bondSats: 1000000n }, { pubkey: SELF.pubkey, outpoint: 's:0', bondSats: 1000000n },
  ...OTHERS.map((k, i) => ({ pubkey: k.pubkey, outpoint: `o${i}:0`, bondSats: 1000000n }))];
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

test('one peer listing a late record 256 times does not cost 256 x census BIP-340 checks in one pull', async () => {
  const c = chain();
  const tip = { tip: 205 };
  const seat = createProposals({ bindHeightFor: () => 0, confirmedTx: async (t, b) => (t === c.txid && b === BLOCK ? { raw: c.raw, height: DEP_HEIGHT } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    censusAt: async () => CENSUS, store: { read: () => [], write: () => {} },
    tipHeight: async () => tip.tip, seenSigner: { pubkey: SELF.pubkey, sign: (m) => schnorr.sign(m, SELF.secret) } });
  const got = await seat.add({ proposal: c.hex, blockHash: BLOCK });
  assert.equal(got.status, 201);
  const id = toHex(c.idBytes);
  const rec = seat.list().find((r) => r.id === id);
  assert.ok(rec && rec.late, 'held in time, it waits for the census majority (#2700)');
  // the lying peer's listing: the same record 256 times, each with a well-formed junk sighting by every other census key
  const junkSig = () => toHex(Uint8Array.from({ length: 64 }, () => Math.floor(Math.random() * 256)));
  const listing = Array.from({ length: 256 }, () => ({ ...rec, sightings: OTHERS.map((k) => ({ by: toHex(k.pubkey), at: 204, sig: junkSig() })) }));
  verifies = 0;
  const t0 = Date.now();
  await seat.pull(listing);
  const ms = Date.now() - t0;
  console.log(`  one pull of one peer's listing: ${verifies} BIP-340 checks, ${ms} ms on the seat's thread (census of ${CENSUS.length} keys)`);
  assert.equal(seat.counts(id), false, 'junk counts for nothing');
  assert.ok(verifies <= 2 * K, `one pull checked ${verifies} sightings - more than one per census key (${K}): each repeat of the record is checked again`);
});
