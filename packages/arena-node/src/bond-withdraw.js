// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER TAKES THE BOND BACK AFTER ITS LOCK (2026-10-18: "withdrawing the bond after the lock
// (communicating the lock time clearly)"). A template-2 bond (§5A.3B) has a recovery leaf: the node's own key, valid from its
// maturity height (OP_CHECKLOCKTIMEVERIFY). This file finds the node's own bond in the newest census this seat holds, says its lock
// plainly - the height, the blocks to it, an estimated date - and, from that height on, builds the spend of the whole bond to the
// address the owner names, signed by the node's key on the recovery leaf, at a named fee rate.
//
// A withdrawn bond takes the node out of the census from the next census height on: the owner page says so before it is sent.
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bond3OutputKey, bondInternalKey, recoveryLeaf, tapLeafHash, controlBlockFor, BOND_TEMPLATE_V2, BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { nodeBondOf } from '../../arena-protocol/src/census.js';
import { tweakPoint, combine } from './curve.js';

/** Testnet4 and mainnet both aim at ten-minute blocks: the date is an estimate, the height is the rule. */
export const BLOCK_MS = 600000;

/** The bond output key of a node key at a maturity height, on a network: template 2, or template 3 when `censusKey` names the key its path B holds. */
export function bondKeyOf(nodeKey, maturity, network, censusKey = null) {
  const g = genesisFor(network);
  if (censusKey) return bond3OutputKey({ nodeKey, censusKey, arbitrationKeys: g.arbitrationKeys, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
  const built = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
  return built;
}

/** One census entry in the owner's terms. A started bond (5A.3B) says so: `hold` { txid (hex as a block explorer shows it), vout, height }, the output that stands for it now. */
const ownOutput = (e) => ({ txid: toHex(Uint8Array.from(e.txid).reverse()), vout: Number(e.vout), sats: String(e.bondSats), height: e.height ?? null,
  maturity: e.advert.bondMaturityHeight ?? null, template: e.advert.bondScriptTemplateVersion, ...(e.advert.censusKey ? { censusKey: toHex(Uint8Array.from(e.advert.censusKey)) } : {}),
  ...(e.hold ? { hold: { txid: toHex(fromHex(e.hold.txid).reverse()), vout: e.hold.vout, height: e.hold.height } } : {}) });

/**
 * This node's bond as a census entry names it: { txid, vout, sats, height, maturity, template, censusKey?, hold? } or null. `entries` are a census's
 * eligible entries (roster.censusFor(...).entries); `me` is the node key, hex.
 */
export function ownBondOf(entries, me) {
  // a census entry (census.js): the bond's txid as the chain's bytes, its vout, the height it confirmed at, the amount, the advertisement
  const e = (entries || []).find((x) => x && x.pubkey && toHex(x.pubkey) === me);
  if (!e || !e.advert || !e.txid) return null;
  return ownOutput(e);
}

/**
 * ALL THIS NODE'S BOND OUTPUTS and their sum (kanban #544: an added output beside the first counts with it): { sats, outputs: [as
 * ownBondOf] } - the outputs of its key and of the operator its first entry names - or null.
 */
export function ownBondsOf(entries, me) {
  const n = nodeBondOf(entries, me);
  if (!n) return null;
  const mine = (entries || []).filter((x) => x && x.pubkey && x.txid && x.advert && toHex(x.pubkey) === me && String(x.advert.operatorId || '') === n.operatorId);
  return { sats: String(n.bondSats), outputs: mine.map(ownOutput) };
}

/** The lock, said plainly, at a tip: { maturity, blocksLeft, estimatedMs, withdrawable }. */
export function lockAt(bond, tip, nowMs = Date.now()) {
  if (!bond || !Number.isInteger(bond.maturity)) return null;
  const blocksLeft = Math.max(0, bond.maturity - tip);
  return { maturity: bond.maturity, tip, blocksLeft, estimatedMs: nowMs + blocksLeft * BLOCK_MS, withdrawable: tip >= bond.maturity };
}

/**
 * The spend of the whole bond to `script` (the owner's address as an output script) on the recovery leaf: locktime = maturity,
 * signed by the node's key. `feeRate` sat/vB. Answers { hex, txid, fee, value } or throws why not.
 */
export function withdrawSpend({ bond, nodeSecret, network, script, feeRate = 2 }) {
  if (bond.template !== BOND_TEMPLATE_V2 && bond.template !== BOND_TEMPLATE_V3) throw new Error(`a template ${bond.template} bond is not withdrawn here (templates 2 and 3 only)`);
  if (bond.hold) throw new Error(`a slash was started on this bond at block ${bond.hold.height}: the money sits in its hold output now, which leaves by the return, not by this path`);
  if (bond.template === BOND_TEMPLATE_V3 && !bond.censusKey) throw new Error('a template-3 bond is spent with the census key it names, and this record names none');
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const built = bondKeyOf(nodeKey, bond.maturity, network, bond.template === BOND_TEMPLATE_V3 ? fromHex(bond.censusKey) : null);
  const spk = fromHex('5120' + toHex(built.outputKey));
  const leaf = recoveryLeaf(nodeKey, bond.maturity);
  const sats = BigInt(bond.sats);
  const make = (fee) => {
    const tx = { version: 2, locktime: bond.maturity, inputs: [{ txid: fromHex(bond.txid).reverse(), vout: bond.vout, sequence: 0xfffffffe }],
      outputs: [{ value: sats - fee, script }] };
    const sig = schnorr.sign(tapSighash({ ...tx, prevouts: [{ value: sats, script: spk }], inputIndex: 0, leafHash: tapLeafHash(leaf) }), nodeSecret);
    return toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: [sig], script: leaf, controlBlock: controlBlockFor('recovery', built).controlBlock })] }));
  };
  // the size from a first build: one input on a script path, one output
  const first = fromHex(make(1000n));
  const p = parseTransaction(first);
  const wit = 2 + p.witnesses.reduce((a, w) => a + 1 + w.reduce((b, item) => b + (item.length < 0xfd ? 1 : 3) + item.length, 0), 0);
  const vsize = Math.ceil((3 * (first.length - wit) + first.length) / 4);
  const fee = BigInt(vsize * Math.max(1, Math.ceil(feeRate)) + 10);
  if (sats - fee < 330n) throw new Error(`a bond of ${sats} sat leaves nothing after a fee of ${fee} sat`);
  const hex = make(fee);
  return { hex, txid: toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()), fee: String(fee), value: String(sats - fee) };
}
