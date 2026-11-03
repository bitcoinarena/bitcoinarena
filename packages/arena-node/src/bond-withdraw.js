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

/**
 * The bond output key of a node key at a maturity height, on a network: template 2, or template 3 when `censusKey` names the key its path B holds -
 * then `ownerKey` is the key its path A holds (kanban #1093 part 1: no hot key on a template-3 bond).
 */
export function bondKeyOf(nodeKey, maturity, network, censusKey = null, ownerKey = null) {
  const g = genesisFor(network);
  if (censusKey) return bond3OutputKey({ nodeKey, ownerKey, censusKey, bondMaturity: maturity }, { tweakPoint });
  const built = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
  return built;
}

/** One census entry in the owner's terms. A started bond (5A.3B) says so: `hold` { txid (hex as a block explorer shows it), vout, height }, the output that stands for it now. */
const ownOutput = (e) => ({ txid: toHex(Uint8Array.from(e.txid).reverse()), vout: Number(e.vout), sats: String(e.bondSats), height: e.height ?? null,
  maturity: e.advert.bondMaturityHeight ?? null, template: e.advert.bondScriptTemplateVersion, ...(e.advert.censusKey ? { censusKey: toHex(Uint8Array.from(e.advert.censusKey)) } : {}),
  ...(e.advert.ownerPubkey ? { ownerKey: toHex(Uint8Array.from(e.advert.ownerPubkey)) } : {}),
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
 * signed by the node's key - a template-2 bond. A template-3 bond's path A is the owner key's (kanban #1093 part 1): withdrawToSign.
 * `feeRate` sat/vB. Answers { hex, txid, fee, value } or throws why not.
 */
export function withdrawSpend({ bond, nodeSecret, network, script, feeRate = 2 }) {
  if (bond.template === BOND_TEMPLATE_V3) throw new Error('a template-3 bond is taken back with the owner key from the 24 words, not by the node: withdrawToSign');
  if (bond.template !== BOND_TEMPLATE_V2) throw new Error(`a template ${bond.template} bond is not withdrawn here (templates 2 and 3 only)`);
  if (bond.hold) throw new Error(`a slash was started on this bond at block ${bond.hold.height}: the money sits in its hold output now, which leaves by the return, not by this path`);
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const built = bondKeyOf(nodeKey, bond.maturity, network);
  const leaf = recoveryLeaf(nodeKey, bond.maturity);
  const sign = (digest) => schnorr.sign(digest, nodeSecret);
  const { make, fee, value } = sized({ bond, built, leaf, script, feeRate });
  const hex = make(fee, sign);
  return { hex, txid: toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()), fee: String(fee), value };
}

/** The path-A spend of a bond, with the signature `sign(digest)` gives, and its fee from a first build at `feeRate`. */
function sized({ bond, built, leaf, script, feeRate }) {
  const spk = fromHex('5120' + toHex(built.outputKey));
  const sats = BigInt(bond.sats);
  const unsigned = (fee) => ({ version: 2, locktime: bond.maturity, inputs: [{ txid: fromHex(bond.txid).reverse(), vout: bond.vout, sequence: 0xfffffffe }],
    outputs: [{ value: sats - fee, script }] });
  const digestOf = (fee) => tapSighash({ ...unsigned(fee), prevouts: [{ value: sats, script: spk }], inputIndex: 0, leafHash: tapLeafHash(leaf) });
  const controlBlock = controlBlockFor('recovery', built).controlBlock;
  const make = (fee, sign) => toHex(serializeSpend({ ...unsigned(fee), witnesses: [scriptPathWitness({ stack: [sign(digestOf(fee))], script: leaf, controlBlock })] }));
  // the size from a first build with a signature's 64 bytes: one input on a script path, one output
  const first = fromHex(make(1000n, () => new Uint8Array(64)));
  const p = parseTransaction(first);
  const wit = 2 + p.witnesses.reduce((a, w) => a + 1 + w.reduce((b, item) => b + (item.length < 0xfd ? 1 : 3) + item.length, 0), 0);
  const vsize = Math.ceil((3 * (first.length - wit) + first.length) / 4);
  const fee = BigInt(vsize * Math.max(1, Math.ceil(feeRate)) + 10);
  if (sats - fee < 330n) throw new Error(`a bond of ${sats} sat leaves nothing after a fee of ${fee} sat`);
  return { make, fee, value: String(sats - fee), digest: digestOf(fee), unsigned: unsigned(fee), controlBlock };
}

/**
 * A TEMPLATE-3 BOND TAKEN BACK BY ITS OWNER (kanban #1093 part 1, ruling #1103: "Path A: owner key alone"): the whole bond to `script` on path A,
 * prepared for the owner to sign - the node holds no key that can move it. Answers { digest (hex), fee, value, ... } for withdrawWithOwnerSignature.
 */
export function withdrawToSign({ bond, nodeKey, network, script, feeRate = 2 }) {
  if (bond.template !== BOND_TEMPLATE_V3) throw new Error('only a template-3 bond is taken back with the owner key');
  if (bond.hold) throw new Error(`a slash was started on this bond at block ${bond.hold.height}: the money sits in its hold output now, which leaves by the return, not by this path`);
  if (!bond.censusKey || !bond.ownerKey) throw new Error('a template-3 bond is rebuilt from the census key and the owner key it names, and this record lacks one');
  const ownerKey = fromHex(bond.ownerKey);
  const built = bondKeyOf(nodeKey, bond.maturity, network, fromHex(bond.censusKey), ownerKey);
  if (!built.ok) throw new Error(built.why);
  const leaf = recoveryLeaf(ownerKey, bond.maturity);
  const { fee, value, digest, unsigned, controlBlock } = sized({ bond, built, leaf, script, feeRate });
  return { digest: toHex(digest), fee: String(fee), value, tx: unsigned, leaf: toHex(leaf), controlBlock: toHex(controlBlock), ownerKey: bond.ownerKey };
}

/** The prepared withdrawal with the owner's signature, as { hex, txid }: refused unless it verifies under the bond's owner key. */
export function withdrawWithOwnerSignature(prepared, signatureHex) {
  const sig = fromHex(String(signatureHex || ''));
  if (sig.length !== 64) throw new Error('an owner\'s signature is 64 bytes (BIP-340)');
  if (!schnorr.verify(sig, fromHex(prepared.digest), fromHex(prepared.ownerKey))) throw new Error('that signature is not the owner key\'s over this withdrawal');
  const tx = { ...prepared.tx, inputs: prepared.tx.inputs.map((x) => ({ ...x, txid: x.txid instanceof Uint8Array ? x.txid : fromHex(x.txid) })),
    outputs: prepared.tx.outputs.map((o) => ({ ...o, value: BigInt(o.value), script: o.script instanceof Uint8Array ? o.script : fromHex(o.script) })) };
  const hex = toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: [sig], script: fromHex(prepared.leaf), controlBlock: fromHex(prepared.controlBlock) })] }));
  return { hex, txid: toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()) };
}
