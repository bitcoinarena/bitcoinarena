// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 census-3: ANOTHER BONDED NODE TAKES A PROPOSER'S DEPOSIT, AND THE SEATS SPLIT ON WHICH PROPOSAL IT BACKS. The #1491 fix keeps
// "one deposit, one proposal: the first kept stays" (proposals.js backedBy), but the deposit transaction commits to nothing of its proposal or its
// proposer - it is only outputs to the donation set. So as soon as an honest proposer's deposit is on chain (or in a mempool), any bonded node signs
// its OWN proposal naming that deposit_txid and posts it first: the honest proposal is refused 409 at that seat for good, its deposit paid for the
// attacker's proposal. Posted to some seats before the honest one reaches them, each seat keeps whichever came first, and the 10-minute peer pull
// refuses the other (409) at every seat: the seats keep, count and activate different proposals - two configs live on one network.
// SAFE: a proposal is backed only by a deposit that is ITS OWN (committed to by the deposit or by its proposer), so the honest proposal is kept at
// every seat and the attacker's proposal naming someone else's deposit is refused.
// Adapted to 1.9 by #2536 (kanban #1606): every deposit is BOUND on 1.9's live networks (#2125 / #2012, regtest and mainnet from block
// 0): it commits to its proposer key and H(proposal). The same theft on the honest proposer's committed deposit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const HONEST = key(0x61), ATTACKER = key(0x62);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const BLOCK = 'bb'.repeat(32);

// THE HONEST PROPOSER'S DEPOSIT, on chain at 200
const BODY = (who, config) => ({ networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight: 208, proposer: who.pubkey });
const raw = tx([...depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(BODY(HONEST, Uint8Array.of(1, 1, 1))) }]);
const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
const txidDisplay = toHex(Uint8Array.from(depositTxid).reverse());
const proposalBy = (who, config) => {
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config, class: CLASS.DESIGN,
    activationHeight: 208, proposer: who.pubkey, depositTxid };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), who.secret)]));
};
const seat = () => createProposals({ bindHeightFor: () => 0, confirmedTx: async (t, b) => (t === txidDisplay && b === BLOCK ? { raw, height: 200 } : null),
  recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
  censusAt: async () => [{ pubkey: HONEST.pubkey }, { pubkey: ATTACKER.pubkey }], store: { read: () => [], write: () => {} } });

test('#1606 (1.9, bound) a bonded node cannot take another proposer\'s deposit for its own proposal, and the seats do not split on it', async () => {
  const honest = proposalBy(HONEST, Uint8Array.of(1, 1, 1));
  const stolen = proposalBy(ATTACKER, Uint8Array.of(6, 6, 6));
  const X = seat(), Y = seat();
  const atX = { attacker: await X.add({ proposal: stolen, blockHash: BLOCK }), honest: await X.add({ proposal: honest, blockHash: BLOCK }) };
  const atY = { honest: await Y.add({ proposal: honest, blockHash: BLOCK }) };
  // the peer pull, both ways (server.js pullProposals)
  await X.pull(Y.list()); await Y.pull(X.list());
  const keptX = X.list().map((p) => p.proposer.slice(0, 8)), keptY = Y.list().map((p) => p.proposer.slice(0, 8));
  console.log('  DEPOSIT TAKEN:', JSON.stringify({ X: { attacker: atX.attacker.status, honest: atX.honest.status, honestWhy: atX.honest.why }, Y: { honest: atY.honest.status },
    keptX, keptY, honestKey: toHex(HONEST.pubkey).slice(0, 8), attackerKey: toHex(ATTACKER.pubkey).slice(0, 8) }));
  assert.equal(atX.honest.status, 201, 'the honest proposer\'s proposal, backed by its own deposit, is refused because another node named that deposit first');
  assert.deepEqual(keptX, keptY, 'two seats keep different proposals for one deposit');
});
