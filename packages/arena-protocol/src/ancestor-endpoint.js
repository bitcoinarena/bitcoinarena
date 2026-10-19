// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ENDPOINT OF A CARRIED BOND (kanban #209, measured 2026-10-10 05:35Z: a paid join on testnet4 was refused at the
// session - "no proven endpoint: the bond output commits to a different advertisement").
//
// §0A.9: bonds cross from the BLWP ancestor without a spend. The bond output stays where it is and keeps committing to its
// ANCESTOR advertisement; its operator re-affirms it for the new network (an "ARNF" payload signed by the bond's key) and
// then names its Bitcoin Arena terms - endpoint, hosted games - in an advertisement update ("ARNA", signed by the same key).
// The census reads it that way (reaffirm.js, advert-update.js). The door a PLAYER walks through read only the first half:
// a bond that commits to an Arena advertisement. So no seat with a carried bond could be reached.
//
// This is the second half, from raw bytes only, as `acceptAdvert` is: the bond, its re-affirmation and its update, each
// proved into a header of the chain the client agreed, read out of their own outputs and witnesses. Nothing here checks a
// signature (this package carries no crypto): the answer names the update's signature over its id, as `acceptAdvert`
// names an advertisement's, and lists the two more a client must verify - the ancestor body's and the re-affirmation's -
// all three by the bond's node key. `arena-client` refuses the session unless every one verifies.
import { parseTransaction, commitmentsOf, witnessRunsOf } from './tx.js';
import { splitSignedAdvert } from './advert.js';
import { ancestorMarker, ancestorAdvertId, decodeAncestorAdvert } from './ancestor.js';
import { provesTransaction, recognizeBond, paysMarkerProgram, paysBondMarker } from './chain.js';
import { readAdvertUpdate } from './advert-update.js';
import { readReaffirmationPayload, reaffirmationMessage } from './reaffirm.js';
import { NETWORK_ID_TESTNET4, NETWORK_ID_REGTEST } from './genesis-ids.js';

// the networks with an ancestor, by the marker names the protocol uses, and the id a re-affirmation names for each
const ANCESTOR_NETWORK_IDS = Object.freeze({ testnet: NETWORK_ID_TESTNET4, regtest: NETWORK_ID_REGTEST });
const sameBytesAE = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function parsedAE(proof, what) {
  if (!proof || !(proof.transaction instanceof Uint8Array)) return { why: `no ${what} was given` };
  try { return { tx: parseTransaction(proof.transaction) }; } catch (e) { return { why: `the ${what} is not a transaction: ${e.message}` }; }
}
const headerOfAE = (chain, txid, proof) => chain.find((h) => provesTransaction(h, txid, proof.branch || [], proof.position | 0)) || null;

/**
 * `chain`: the agreed headers; the bond as `{ transaction, branch, position }`, and `update` and `reaffirm` in the same
 * shape. Answers { ok, endpoint, nodePubkey, signature, advertId, advert, txid, bondVout, header, checks: [{ what,
 * signature, message, key }] } or { ok: false, why }.
 */
export function acceptAncestorEndpoint({ chain, transaction, branch, position, update, reaffirm }) {
  if (!Array.isArray(chain) || !chain.length) return { ok: false, why: 'no chain to prove the bond into' };
  const b = parsedAE({ transaction }, 'bond');
  if (!b.tx) return { ok: false, why: b.why };
  const header = headerOfAE(chain, b.tx.txid, { branch, position });
  if (!header) return { ok: false, why: 'the bond is not in any block of that chain' };
  const network = Object.keys(ANCESTOR_NETWORK_IDS).find((n) => paysMarkerProgram(b.tx, ancestorMarker(n)));
  if (!network) return { ok: false, why: 'the bond output commits to a different advertisement, and it is no carried ancestor bond either' };

  // 1. THE ANCESTOR BODY THE BOND COMMITS TO: who the node is, and which output is its bond
  const commitments = commitmentsOf(b.tx).filter((c) => c.length === 32);
  let body = null;
  for (const item of witnessRunsOf(b.tx)) {
    try {
      const s = splitSignedAdvert(item);
      if (commitments.some((c) => sameBytesAE(c, ancestorAdvertId(s.body)))) { body = { ...s, advert: decodeAncestorAdvert(s.body) }; break; }
    } catch { /* not a signed body */ }
  }
  if (!body) return { ok: false, why: 'the ancestor bond carries no advertisement its output commits to' };
  const seen = recognizeBond(b.tx, body.advert.bondVout, body.advert, { network, ancestor: true });
  if (!seen.ok) return { ok: false, why: seen.why };
  const nodePubkey = body.advert.nodePubkey;
  const bondVout = body.advert.bondVout;

  // 2. ITS RE-AFFIRMATION FOR THIS NETWORK: without one an ancestor bond does not count here
  const r = parsedAE(reaffirm, 're-affirmation');
  if (!r.tx) return { ok: false, why: `an ancestor bond counts only re-affirmed: ${r.why}` };
  if (!headerOfAE(chain, r.tx.txid, reaffirm)) return { ok: false, why: 'the re-affirmation is not in any block of that chain' };
  if (!paysBondMarker(r.tx, network)) return { ok: false, why: 'a re-affirmation pays the bond marker, and that transaction does not' };
  const prefix = ANCESTOR_NETWORK_IDS[network].subarray(0, 8);
  const payload = commitmentsOf(r.tx).map(readReaffirmationPayload).find((p) => p && sameBytesAE(p.networkPrefix, prefix));
  if (!payload) return { ok: false, why: 'that transaction re-affirms nothing for this network' };

  // 3. ITS ADVERTISEMENT UPDATE: the endpoint and the hosted games, for this bond, by this bond's key
  const u = parsedAE(update, 'advertisement update');
  if (!u.tx) return { ok: false, why: `an ancestor bond names its endpoint in an update: ${u.why}` };
  if (!headerOfAE(chain, u.tx.txid, update)) return { ok: false, why: 'the advertisement update is not in any block of that chain' };
  const read = readAdvertUpdate(u.tx, { network });
  if (!read.ok) return { ok: false, why: read.why };
  if (!sameBytesAE(read.bondTxid, b.tx.txid) || read.bondVout !== bondVout) return { ok: false, why: 'the update names another bond' };
  if (!sameBytesAE(read.nodePubkey, nodePubkey)) return { ok: false, why: 'the update is by another key than the bond\'s' };

  return {
    ok: true, endpoint: read.advert.endpoint, nodePubkey, signature: read.signature, advertId: read.advertId, advert: read.advert,
    txid: b.tx.txid, bondVout, bondSats: seen.valueSats, header,
    checks: [
      { what: 'the ancestor advertisement the bond commits to', signature: body.signature, message: ancestorAdvertId(body.body), key: nodePubkey },
      { what: 'the re-affirmation', signature: payload.signature,
        message: reaffirmationMessage({ networkId: ANCESTOR_NETWORK_IDS[network], bondTxid: b.tx.txid, bondVout }), key: nodePubkey },
    ],
  };
}
