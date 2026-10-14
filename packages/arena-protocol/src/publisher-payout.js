// THE SERIES PUBLISHER IS PAID BACK ITS PUBLICATION FEE (§5A.5 "Who pays the fee", kanban #304; 2026.0.3): "The publisher pays it
// from its own wallet and is reimbursed from the node fee (§22A) of the series' round 0 - or, if round 0 has no entries, the first
// round of the series that settles with any. The reimbursement is one line in that round's settlement: publisher_payout =
// min(publication fee, fee_cap) to the publisher's bond key, where the fee is the confirmed publication's own fee, read from the
// chain (reference fee_cap: 10,000 sat). Only the first confirmed publication is reimbursed."
//
// THE FEE IS PROVEN, NOT SAID: a block holds the publication but not the values it spends, so the publisher hands over the raw
// transactions its inputs spend. Each proves itself - its txid is the hash of its bytes, and it must be the very txid an input
// names - and the fee is what they hold at the spent outputs less what the publication pays out. Nothing is asked of a node's RPC.
// The publisher is the round's creator (contracts.js creator_pubkey, #313), whose key is the contract's and whose signature opened it.
import { parseTransaction } from './tx.js';
import { toHex } from './hash.js';

/** The reference fee cap, sat (§5A.5). */
export const PUBLICATION_FEE_CAP_SATS = 10000n;

/**
 * A PUBLICATION'S FEE, FROM ITS PARENTS. `tx` the publication's raw bytes; `parents` the raw transactions its inputs spend (any
 * order). Answers { ok, feeSats } or { ok: false, why } - a parent missing, one that is not the transaction an input names, an
 * output index it does not have, or outputs worth more than the inputs.
 */
export function publicationFee(txRaw, parents = []) {
  let tx;
  try { tx = parseTransaction(txRaw); } catch (e) { return { ok: false, why: `the publication does not parse: ${e.message}` }; }
  const byId = new Map();
  for (const p of parents) {
    let t;
    try { t = parseTransaction(p); } catch (e) { return { ok: false, why: `a parent does not parse: ${e.message}` }; }
    byId.set(toHex(t.txid), t);
  }
  let inSats = 0n;
  for (const i of tx.inputs) {
    const parent = byId.get(toHex(i.previousTxid));
    if (!parent) return { ok: false, why: `the parent ${toHex(i.previousTxid).slice(0, 16)}… (output ${i.previousVout}, which the publication spends) was not handed over, so the fee is not proven` };
    const out = parent.outputs[i.previousVout];
    if (!out) return { ok: false, why: `${toHex(i.previousTxid).slice(0, 16)}… has no output ${i.previousVout}` };
    inSats += BigInt(out.value);
  }
  const outSats = tx.outputs.reduce((s, o) => s + BigInt(o.value), 0n);
  if (outSats > inSats) return { ok: false, why: 'the publication pays out more than its inputs hold' };
  return { ok: true, feeSats: inSats - outSats };
}

/** publisher_payout = min(publication fee, fee_cap), in msat. */
export function publisherPayoutMsat(feeSats, capSats = PUBLICATION_FEE_CAP_SATS) {
  const f = BigInt(feeSats), c = BigInt(capSats);
  if (f < 0n || c < 0n) throw new Error('a fee and a cap are 0 or more');
  return (f < c ? f : c) * 1000n;
}

/**
 * WHICH ROUND OF THE SERIES PAYS IT: round 0, or - when round 0 has no entries - the first round of the series that has any.
 * `entriesByIndex` Map(index -> counted entries) over the series' rounds this seat holds up to the one asked about. Answers the
 * index, or null while no round has entries. Every seat holds the series' rounds and their entries, so they name one round.
 */
export function publisherRoundIndex(entriesByIndex) {
  const idx = [...entriesByIndex.entries()].filter(([, n]) => n > 0).map(([i]) => i).sort((a, b) => a - b);
  return idx.length ? idx[0] : null;
}
