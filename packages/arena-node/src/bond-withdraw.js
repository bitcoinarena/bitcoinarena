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
import { bondOutputKey, bondInternalKey, recoveryLeaf, tapLeafHash, controlBlockFor, BOND_TEMPLATE_V2 } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { nodeBondOf } from '../../arena-protocol/src/census.js';
import { tweakPoint, combine } from './curve.js';

/** Testnet4 and mainnet both aim at ten-minute blocks: the date is an estimate, the height is the rule. */
export const BLOCK_MS = 600000;

/** The bond output key of a node key at a maturity height, on a network (template 2). */
export function bondKeyOf(nodeKey, maturity, network) {
  const g = genesisFor(network);
  const built = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
  return built;
}

/**
 * This node's bond as a census entry names it: { txid, vout, sats, height, maturity, template } or null. `entries` are a census's
 * eligible entries (roster.censusFor(...).entries); `me` is the node key, hex.
 */
export function ownBondOf(entries, me) {
  // a census entry (census.js): the bond's txid as the chain's bytes, its vout, the height it confirmed at, the amount, the advertisement
  const e = (entries || []).find((x) => x && x.pubkey && toHex(x.pubkey) === me);
  if (!e || !e.advert || !e.txid) return null;
  return outputOfEntry(e);
}

/** One bond output as a census entry (kept or excluded) names it: { txid, vout, sats, height, maturity, template }. */
export function outputOfEntry(e) {
  return { txid: toHex(Uint8Array.from(e.txid).reverse()), vout: Number(e.vout), sats: String(e.bondSats), height: e.height ?? null,
    maturity: e.advert.bondMaturityHeight ?? null, template: e.advert.bondScriptTemplateVersion };
}

/**
 * ALL THIS NODE'S BOND OUTPUTS and their sum (kanban #544: an added output beside the first counts with it): { sats, outputs: [as
 * ownBondOf] } - the outputs of its key and of the operator its first entry names - or null.
 */
export function ownBondsOf(entries, me) {
  const n = nodeBondOf(entries, me);
  if (!n) return null;
  const mine = (entries || []).filter((x) => x && x.pubkey && x.txid && x.advert && toHex(x.pubkey) === me && String(x.advert.operatorId || '') === n.operatorId);
  return { sats: String(n.bondSats), outputs: mine.map(outputOfEntry) };
}

/**
 * EVERY OUTPUT OF THIS NODE'S BOND STILL ON THE CHAIN (kanban #1439, money audit 8 M8-2: the door spent the first output only, and an
 * added output left alone below the floor dropped out of the census - no door spent it after). `outputs` are the candidates - the
 * census's, the ones this seat saw in an earlier census, a census's excluded ones - and `txOut(txid, vout)` the chain's unspent output
 * ({ sats, script } or null, main.js chainTxOut). Kept: an output still unspent whose script is this node's template-2 bond at its
 * maturity (so an output is this node's by the chain, not by any record), with the chain's amount. An older template's output (no
 * recovery leaf) is kept as named while unspent: the withdrawal refuses it by name, as before. Each output once.
 */
export async function ownOutputsOnChain({ outputs, nodeKey, network, txOut }) {
  const seen = new Set(), kept = [];
  for (const o of outputs || []) {
    if (!o || !/^[0-9a-f]{64}$/.test(String(o.txid)) || !Number.isInteger(Number(o.vout))) continue;
    const k = `${o.txid}:${Number(o.vout)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const c = await txOut(String(o.txid), Number(o.vout));   // a chain that cannot be read throws: the caller says so
    if (!c) continue;                                        // spent (or never there)
    if (o.template !== BOND_TEMPLATE_V2) { kept.push({ ...o, vout: Number(o.vout) }); continue; }
    if (!Number.isInteger(o.maturity)) continue;
    const want = '5120' + toHex(bondKeyOf(nodeKey, o.maturity, network).outputKey);
    if (String(c.script).toLowerCase() !== want) continue;   // not this node's bond at that maturity
    kept.push({ ...o, vout: Number(o.vout), sats: String(c.sats) });
  }
  return kept;
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
 *
 * EVERY OUTPUT IN ONE SPEND (kanban #1439): `bonds` - this node's unlocked bond outputs - are spent together, one input each on its
 * own recovery leaf (its own maturity), the locktime the latest of them, so no unlocked output is left behind below the floor. `bond`
 * alone is the one-output spend, byte for byte as before.
 */
export function withdrawSpend({ bond, bonds, nodeSecret, network, script, feeRate = 2 }) {
  const list = Array.isArray(bonds) ? bonds : [bond];
  if (!list.length || list.some((b) => !b)) throw new Error('no bond output to withdraw');
  for (const b of list) {
    if (b.template !== BOND_TEMPLATE_V2) throw new Error(`a template ${b.template} bond is not withdrawn here (template 2 only)`);
    if (!Number.isInteger(b.maturity)) throw new Error('a bond output without its maturity height is not withdrawn here');
  }
  if (new Set(list.map((b) => `${b.txid}:${b.vout}`)).size !== list.length) throw new Error('an output named twice');
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const locktime = Math.max(...list.map((b) => b.maturity));
  const ins = list.map((b) => {
    const built = bondKeyOf(nodeKey, b.maturity, network);
    const leaf = recoveryLeaf(nodeKey, b.maturity);
    return { b, built, leaf, spk: fromHex('5120' + toHex(built.outputKey)), sats: BigInt(b.sats) };
  });
  const sats = ins.reduce((a, i) => a + i.sats, 0n);
  const make = (fee) => {
    const tx = { version: 2, locktime, inputs: ins.map((i) => ({ txid: fromHex(i.b.txid).reverse(), vout: i.b.vout, sequence: 0xfffffffe })),
      outputs: [{ value: sats - fee, script }] };
    const prevouts = ins.map((i) => ({ value: i.sats, script: i.spk }));
    const witnesses = ins.map((i, n) => {
      const sig = schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: n, leafHash: tapLeafHash(i.leaf) }), nodeSecret);
      return scriptPathWitness({ stack: [sig], script: i.leaf, controlBlock: controlBlockFor('recovery', i.built).controlBlock });
    });
    return toHex(serializeSpend({ ...tx, witnesses }));
  };
  // the size from a first build: one input on a script path each, one output
  const first = fromHex(make(1000n));
  const p = parseTransaction(first);
  const wit = 2 + p.witnesses.reduce((a, w) => a + 1 + w.reduce((b, item) => b + (item.length < 0xfd ? 1 : 3) + item.length, 0), 0);
  const vsize = Math.ceil((3 * (first.length - wit) + first.length) / 4);
  const fee = BigInt(vsize * Math.max(1, Math.ceil(feeRate)) + 10);
  if (sats - fee < 330n) throw new Error(`a bond of ${sats} sat leaves nothing after a fee of ${fee} sat`);
  const hex = make(fee);
  return { hex, txid: toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()), fee: String(fee), value: String(sats - fee),
    spent: ins.map((i) => ({ txid: i.b.txid, vout: i.b.vout, sats: String(i.sats), maturity: i.b.maturity })) };
}
