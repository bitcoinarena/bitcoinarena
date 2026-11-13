// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 fix-refute (audit44, item t1751, skeptic 2): the resume path after a restart. #1751 builds `lives` at construction
// with height 0 (no tip yet) and makes live() answer null only while `tip === null`. A first pass that READS the tip and then throws
// later (a getblock for another proposal's voting block times out / the work queue is full - votesAt throws) sets `tip` but never
// reaches refreshLive: live() then answers the construction-time liveConfig at height 0 - GENESIS - with the real tip beside it,
// although the seat's own store holds an activated PASSED proposal. GET /config hands an opener the replaced config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, SCHEDULES } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31);

function kept({ net = H(0x4e), parent = BALLOT_GENESIS.configHash, configHash = H(0x22), config = Uint8Array.of(2), cls = CLASS.DESIGN, publishedAt = 100,
  review = 1, voting = 6, cooldown = 1, deposit = 0x77 } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: net, parent, configHash, config, class: cls, activationHeight, proposer: A.pubkey, depositTxid: H(deposit) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(net),
    parent: toHex(parent), configHash: toHex(configHash), class: Object.keys(CLASS).find((k) => CLASS[k] === cls), proposer: toHex(A.pubkey), publishedAt,
    depositTxid: toHex(H(deposit)), depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting, activationHeight, repeal: false } };
}

test('wf1489 a44-refute-65-s2-1: a first pass that read the tip and then threw leaves GET /config answering genesis after an activation', async () => {
  // THE STORE: proposal genesis -> 2222.. PASSED (published 100, anchor 106, live from 108); a second proposal 2222.. -> 3333.. voting 126-131
  const a = kept();
  const b = kept({ parent: H(0x22), configHash: H(0x33), config: Uint8Array.of(3), publishedAt: 125, deposit: 0x78 });
  const rows = [
    { ...a.record, blockHash: 'bb'.repeat(32), state: 'PASSED',
      decided: { passed: true, approved: true, quorum: true, turnoutPct: 100, approvalPct: 100, yesSats: '100', noSats: '0', abstainSats: '0', totalSats: '100',
        bondsVoted: 1, decidedAt: 107, census: 1, anchor: { height: 106, hash: 'cc'.repeat(32) } } },
    { ...b.record, blockHash: 'dd'.repeat(32), state: 'COUNTING' },
  ];
  const proposals = createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 1n, verify, schedule: SCHEDULES.regtest,
    store: { read: () => rows.map((r) => ({ ...r })), write: () => {} } });
  // THE RESTARTED SEAT'S CHAIN: tip 130 answers, every block hash answers (the anchor and the publication still on it), but a
  // getblock for the second proposal's voting block times out
  const hashAt = async (h) => (h === 106 ? 'cc'.repeat(32) : h === 125 ? 'dd'.repeat(32) : h.toString(16).padStart(64, 'e'));
  const t = createBallotTally({ proposals, tipHeight: async () => 130, blockHashAt: hashAt,
    votesAt: async () => { throw new Error('getblock: Request timeout (work queue depth exceeded)'); },
    censusAt: async () => [{ pubkey: A.pubkey, outpoint: 'x', bondSats: 100n }], verify, decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  await t.pass().catch(() => {});
  const net = toHex(H(0x4e));
  assert.equal(t.tip, 130, 'the pass read the tip');
  const l = t.live(net);
  // what must hold: either nothing is said (503, as before the tip) or the config the seat's own store made live at 108
  assert.ok(l === null || l.configHash === '22'.repeat(32),
    `GET /config at tip 130 must not hand out the replaced config: answered ${l && l.configHash.slice(0, 8)} (since ${l && l.since})`);
});
