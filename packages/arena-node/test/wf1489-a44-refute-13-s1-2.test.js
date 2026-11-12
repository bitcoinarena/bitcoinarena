// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute-13 (#1608), the honest path: a proposal posted IN TIME (before its voting) whose deposit block is
// reorged out and the deposit re-mined in another block is orphaned (ballot-tally.js) and can come back only by "posted again
// from a new block" (proposals.add). The #1608 tip check refuses that re-post once the voting has begun - so a short reorg
// inside the voting phase kills an honest proposal for good, its votes already on chain counted for nothing.
// SAFE: the orphaned proposal, first seen before its voting, is taken again from the block its deposit now sits in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const ATTACKER = key(0x51), H1 = key(0x52), H2 = key(0x53);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const NET = new Uint8Array(32).fill(0x4e), NETHEX = toHex(NET);
// the attacker's bond is 35 % of the census: alone above DESIGN's 30 % turnout; the two honest bonds hold 65 % and would vote NO
const CENSUS = [{ pubkey: ATTACKER.pubkey, outpoint: 'aa:0', bondSats: 35000000n }, { pubkey: H1.pubkey, outpoint: 'bb:0', bondSats: 35000000n },
  { pubkey: H2.pubkey, outpoint: 'cc:0', bondSats: 30000000n }];


test('a proposal seen before its voting, orphaned by a reorg and re-posted from its new deposit block, is taken again', async () => {
  const DEP_HEIGHT = 200;
  const want = depositOutputsExpected(1000, SET);
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const config = Uint8Array.of(9, 9, 9);
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
    activationHeight: DEP_HEIGHT + 8, proposer: H1.pubkey, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), H1.secret);
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature]));
  const txid = toHex(Uint8Array.from(p.depositTxid).reverse());
  const OLD = 'dd'.repeat(32), NEW = 'ee'.repeat(32);
  let inBlock = OLD;
  let tip = DEP_HEIGHT;
  const proposals = createProposals({ confirmedTx: async (t, b) => (t === txid && b === inBlock ? { raw, height: DEP_HEIGHT } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    censusAt: async () => CENSUS, tipHeight: async () => tip, store: { read: () => [], write: () => {} } });
  const first = await proposals.add({ proposal: hex, blockHash: OLD });
  // a 3-block reorg at tip 202 (inside voting 201..206): block 200 replaced, the deposit re-mined in the new block 200
  tip = DEP_HEIGHT + 2; inBlock = NEW;
  proposals.orphan(first.id, { at: tip });
  const again = await proposals.add({ proposal: hex, blockHash: NEW });
  console.log('  REORG:', JSON.stringify({ first: first.status, orphaned: proposals.list()[0].state, repost: again.status, why: again.why }));
  assert.equal(first.status, 201);
  assert.equal(again.ok, true, 'a proposal first seen before its voting is taken again from the block its deposit now sits in');
});
