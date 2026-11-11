// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1 census-1 (state machine, crash-restart): a seat decided a proposal PASSED and wrote it (ballot_proposals); the new config
// is live since its activation. The seat restarts. The tally's `lives` / `spansAll` (what GET /config and the serving rule configServesRound
// read, server.js configRefusal) are filled only at the END of a pass that got through the reorg check - never from the kept records at
// construction. Until then (10 s at best; for as long as bitcoind answers no getblockhash - a node and its bitcoind restarted together,
// RPC -28 "Loading block index" for minutes) the restarted seat answers from the genesis alone: it SERVES a round created after the
// activation that names the old config (every other seat refuses it, 409), and GET /config names the old config. The kept record says
// PASSED; the seat acts as if it had never been decided. Safe behaviour: a decided record is the seat's state from its first answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }];
const NET = H(0x4e);
const NEW = H(0x22);

test('wf1489 sm1 census-1: after a restart the seat serves under the config its own kept outcome replaced', async () => {
  // a proposal as proposals.js keeps it (regtest: review 1, voting 6, cooldown 1), published at 100: voting 101-106, activation 108
  const publishedAt = 100, activationHeight = 108;
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: NEW, config: Uint8Array.of(2), class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  const record = { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(NET),
    parent: toHex(p.parent), configHash: toHex(NEW), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000',
    votingFrom: 101, votingUntil: 107, activationHeight, repeal: false, blockHash: 'b'.repeat(64), state: 'COUNTING' };
  // the seat's store (ballot_proposals): rows by id, INSERT OR REPLACE, as server.js
  const rows = new Map([[record.id, JSON.stringify(record)]]);
  const store = { read: () => [...rows.values()].map((j) => JSON.parse(j)), write: (list) => { for (const x of list) rows.set(x.id, JSON.stringify(x)); } };
  const hashOf = (h) => h.toString(16).padStart(64, '0');
  const ch = { tip: 0, rpcUp: true };
  const chainOpts = () => ({ tipHeight: async () => ch.tip, censusAt: async () => CENSUS, verify,
    votesAt: async (h) => (h === 102 ? [{ payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(idBytes, CHOICE.YES), A.secret) }), height: h, txid: 'v' }] : []),
    blockHashAt: async (h) => { if (!ch.rpcUp) throw new Error('{"code":-28,"message":"Loading block index..."}'); return h <= ch.tip ? (h === publishedAt ? record.blockHash : hashOf(h)) : null; },
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });

  // BEFORE THE RESTART: counted and decided here, the outcome written
  const seat = createBallotTally({ proposals: createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 1n, verify, store }), ...chainOpts() });
  for (const t of [101, 104, 106, 109]) { ch.tip = t; await seat.pass(); }
  assert.equal(JSON.parse(rows.get(record.id)).state, 'PASSED', 'the outcome is kept');
  const net = toHex(NET);
  const before = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 109, history: seat.spans(net) });
  assert.equal(before.ok, false, 'before the restart: a round created at 109 naming the old config is refused');
  assert.equal(seat.live(net).configHash, toHex(NEW));

  // THE RESTART: the same store, a new process; bitcoind (restarted with it) is still loading its block index
  ch.rpcUp = false;
  const again = createBallotTally({ proposals: createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 1n, verify, store }), ...chainOpts() });
  await again.pass();                                                       // skipped: the chain did not answer the reorg check
  assert.equal(again.list()[0].state, 'PASSED', 'the restarted seat holds the PASSED record');
  const after = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 109, history: again.spans(net) });
  console.log('  AFTER RESTART: serve old config at 109 ->', JSON.stringify(after), '| GET /config ->', again.live(net).configHash.slice(0, 16));
  assert.equal(after.ok, false, 'after the restart the same round (old config, created after the activation) must still be refused');
  assert.equal(again.live(net).configHash, toHex(NEW), 'GET /config must name the config the kept outcome made live');
});
