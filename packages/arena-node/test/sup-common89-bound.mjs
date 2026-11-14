// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// shared fixture for sup-2185 / sup-2478 (kanban #2536: the #1840 re-checks of a44-refute-89 on 1.9's BOUND reading). The card's
// _common89.mjs read every deposit unbound (no bindHeightFor: the old reading); 1.9 reads a deposit at or above BALLOT_BIND_HEIGHT as
// bound - regtest and mainnet from block 0, testnet4 from 161 400 - so its deposit carries ONE "ARN" 'D' commitment to its proposer key
// and body (ballot-chain.js depositCommitmentScript). One deposit at height 200 for proposer A's body P, regtest schedule (1 / 6 / 1:
// voting 201..206, activation 208), two proposers in the census (A and a bonded stranger C).
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
export const secretA = new Uint8Array(32).fill(1); export const proposerA = schnorr.getPublicKey(secretA);
export const secretC = new Uint8Array(32).fill(9); export const proposerC = schnorr.getPublicKey(secretC);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
export const BLOCK = 'bb'.repeat(32);
const PARENT = new Uint8Array(32).fill(0x10);
const bodyOf = (activationHeight, config, secret) => ({ networkId: NET, parent: PARENT, configHash: configHashOf(config), config,
  class: CLASS.DESIGN, activationHeight, proposer: schnorr.getPublicKey(secret) });
// THE ONE DEPOSIT: committed to A's body P (activation 208, config 1 2 3)
export const P_CONFIG = Uint8Array.of(1, 2, 3);
const want = depositOutputsExpected(1000, SET);
const raw = tx([...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(bodyOf(208, P_CONFIG, secretA)) }]);
const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
const txidDisplay = toHex(Uint8Array.from(depositTxid).reverse());
/** a proposal over THE deposit: any body, signed by `secret` (`aux` the signature's randomness: a twin re-signs the same body) */
export const proposal = (activationHeight, config, secret = secretA, aux = 0) => {
  const p = { ...bodyOf(activationHeight, config, secret), depositTxid };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret, new Uint8Array(32).fill(aux))]));
};
/** a seat, bound from block 0 as regtest and mainnet are; `tip` an object { h } read as this seat's tip */
export const seat = (tip = null) => createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && txid === txidDisplay ? { raw, height: 200 } : null),
  recipientsFor: (net, height) => (net === toHex(NET) && height === 200 ? SET : null), lowestBondMinSatsFor: () => 100000n, verify,
  scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest, bindHeightFor: () => 0,
  censusAt: async () => [{ pubkey: proposerA }, { pubkey: proposerC }], store: { read: () => [], write: () => {} },
  ...(tip ? { tipHeight: async () => tip.h } : {}) });
export const ids = (s) => s.list().map((p) => p.id.slice(0, 16)).sort();
export const countedIds = (s) => s.list().filter((p) => s.counts(p.id)).map((p) => p.id.slice(0, 16)).sort();
