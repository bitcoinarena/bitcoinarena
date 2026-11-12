// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 2 (census area), finding 6: the config history a seat serves rounds by (ballot-tally.js
// `spans`, server.js configRefusal at POST /round and offerRefusal; `live` for GET /config, which round-2of2.mjs configForNewRound
// asks) lives in memory only and is rebuilt only at the END of a completed tally pass (refreshLive). After a restart the store holds
// a PASSED, activated proposal, but until the first pass completes - 10 s at best (the timer's first tick), and for as long as
// bitcoind does not answer (warming up after a reboot: tipHeight throws, the pass throws, refreshLive never runs) - the seat serves
// the GENESIS history: a round created after the activation under the config it replaced is taken here and refused by every other
// seat, and GET /config tells an opener to name the old config. Fixtures copied from wf1489-sm2-census-2.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, SCHEDULES } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31);
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });

/** A proposal as proposals.js keeps it (regtest: review 1, voting 6, cooldown 1). */
function kept({ net = H(0x4e), parent = BALLOT_GENESIS.configHash, configHash = H(0x22), config = Uint8Array.of(2), cls = CLASS.DESIGN, publishedAt = 100,
  review = 1, voting = 6, cooldown = 1, repeal = false } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: net, parent, configHash, config, class: cls, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(net),
    parent: toHex(parent), configHash: toHex(configHash), class: Object.keys(CLASS).find((k) => CLASS[k] === cls), proposer: toHex(A.pubkey), publishedAt,
    depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting, activationHeight, repeal } };
}

test('wf1489 sm2 census-6: a restarted seat serves rounds under the config the ballot replaced until its first tally pass completes', async () => {
  // THE STORE AS THE SEAT LEFT IT: proposal 2170f250 -> 2222.. PASSED (published 100, live from 108), the tip was 130
  const { record } = kept();
  const rows = [{ ...record, blockHash: 'bb'.repeat(32), state: 'PASSED',
    decided: { passed: true, approved: true, quorum: true, turnoutPct: 100, approvalPct: 100, yesSats: '100', noSats: '0', abstainSats: '0', totalSats: '100',
      bondsVoted: 1, decidedAt: 107, census: 1, anchor: { height: 106, hash: 'cc'.repeat(32) } } }];
  const proposals = createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 1n, verify, schedule: SCHEDULES.regtest,
    store: { read: () => rows.map((r) => ({ ...r })), write: () => {} } });
  // THE RESTART: bitcoind is still loading its block index (RPC -28) - every chain read throws for now
  const warming = async () => { throw new Error('{"code":-28,"message":"Loading block index..."}'); };
  const t = createBallotTally({ proposals, tipHeight: warming, votesAt: warming, censusAt: warming, blockHashAt: warming, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  await t.pass().catch(() => {});
  const net = toHex(H(0x4e));
  // a round created at census height 140 - long after the activation at 108 - naming the config the ballot replaced (2170f250)
  const served = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 140, history: t.spans(net) });
  assert.deepEqual(t.spans(net).map((h) => toHex(h.configHash).slice(0, 8)), [toHex(BALLOT_GENESIS.configHash).slice(0, 8), '22222222'],
    'the history this seat serves by holds the activated proposal it keeps in its store');
  assert.equal(served.ok, false, 'a round created after the activation under the replaced config is refused, as every other seat refuses it');
  // kanban #1751: with no tip read yet GET /config says nothing (503) rather than genesis
  assert.equal(t.live(net), null, 'no tip yet: the live config is not answered as genesis');
});
