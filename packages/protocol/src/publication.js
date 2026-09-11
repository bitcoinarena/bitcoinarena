// A ROUND EXISTS ONLY ONCE ITS HASH IS ON BITCOIN, BELOW ITS BEACON BLOCK.
//
// Section 5A.5 (v4.6.2, P1): "a Round Contract exists only once its hash is in
// a Bitcoin block before the beacon block."
//
//     publication_txid   a transaction carrying
//                        OP_RETURN "BLW" ROUND H(RoundContract)   (36 bytes)
//                        confirmed at a height strictly below the beacon block
//
// THE HOLE IT CLOSES. 4.6.1 ordered a contract against its beacon by timestamp
// receipts, which were free: a creator published a thousand candidate rounds,
// waited for the beacon, and promoted the one whose committee was his. On chain
// every candidate costs a transaction, and the ordering is objective - the
// beacon block's hash did not exist when the publication confirmed.
//
// WHY THE TXID IS NOT IN THE CONTRACT although section 6 lists it: the
// transaction carries H(RoundContract), which is the round id, so a contract
// holding that transaction's id has no fixed point. It rides beside the
// contract, as `round_id` and `creator_signature` do.
//
// THE KIND BYTE IS OURS. The spec writes `ROUND` and fixes no value for it; it
// is 0x52, 'R', in keeping with the ASCII "BLW". A vote (27A.7.3) carries no
// kind byte but is 76 bytes, so the exact length keeps the two apart.
import { commitmentsOf, parseTransaction, OP_RETURN } from './tx.js';

export const PUBLICATION_MAGIC = Uint8Array.from([0x42, 0x4c, 0x57]);   // "BLW"
export const PUBLICATION_KIND_ROUND = 0x52;                             // 'R'
export const PUBLICATION_BYTES = 36;

const is32 = (b) => b instanceof Uint8Array && b.length === 32;

/** The 36 bytes a round's publication carries: "BLW", ROUND, round id. */
export function publicationPayload(roundIdBytes) {
  if (!is32(roundIdBytes)) throw new TypeError('a publication commits to a 32-byte round id');
  const out = new Uint8Array(PUBLICATION_BYTES);
  out.set(PUBLICATION_MAGIC, 0);
  out[3] = PUBLICATION_KIND_ROUND;
  out.set(roundIdBytes, 4);
  return out;
}

/** The output a creator adds to publish a round: zero value, one direct push. */
export function publicationOutput(roundIdBytes) {
  const payload = publicationPayload(roundIdBytes);
  const script = new Uint8Array(2 + PUBLICATION_BYTES);
  script[0] = OP_RETURN;
  script[1] = PUBLICATION_BYTES;
  script.set(payload, 2);
  return { value: 0n, script };
}

/** Does this parsed transaction publish that round? */
export function publishesRound(tx, roundIdBytes) {
  const want = publicationPayload(roundIdBytes);
  return commitmentsOf(tx).some((p) => p.length === PUBLICATION_BYTES
    && p.every((b, i) => b === want[i]));
}

/**
 * WHERE A ROUND WAS PUBLISHED, IN A CHAIN VIEW THIS NODE READ ITSELF.
 *
 * The same view the census is derived from - `{ firstHeight, blocks: [{
 * header, transactions }] }` - so the height is the chain's, and nobody has to
 * be believed about a txid. The LOWEST publication counts: a creator who
 * publishes the same round twice gained nothing by the second.
 */
export function findPublication(view, roundIdBytes) {
  if (!view || !Array.isArray(view.blocks) || !Number.isInteger(view.firstHeight)) return null;
  for (let i = 0; i < view.blocks.length; i++) {
    for (const raw of view.blocks[i].transactions || []) {
      let tx;
      try { tx = parseTransaction(raw); } catch { continue; }
      if (publishesRound(tx, roundIdBytes)) return { tx, height: view.firstHeight + i };
    }
  }
  return null;
}

/**
 * IS THIS ROUND PUBLISHED, AND BEFORE ITS BEACON?
 *
 * The heights are the caller's own chain's - where the transaction confirmed
 * and which block the beacon rule named - never a number the creator wrote.
 * Missing either is a refusal: "I do not know when it confirmed" and "it
 * confirmed in time" must never be the same answer. So is an equal height,
 * because a publication in the beacon block itself was made knowing nothing of
 * that block's hash only if the miner says so.
 */
export function publicationIsBeforeBeacon({ roundId, tx, txHeight, beaconHeight } = {}) {
  if (!is32(roundId)) return { ok: false, why: 'that publication names no 32-byte round id' };
  if (!tx || !Array.isArray(tx.outputs)) return { ok: false, why: 'there is no publication transaction to read' };
  if (!publishesRound(tx, roundId))
    return { ok: false, why: 'that transaction does not carry OP_RETURN "BLW" ROUND and this round\'s id' };
  if (!Number.isInteger(txHeight) || txHeight < 0)
    return { ok: false, why: 'that publication names no height, so nothing says it came before the beacon' };
  if (!Number.isInteger(beaconHeight) || beaconHeight < 0)
    return { ok: false, why: 'there is no beacon height to measure the publication against' };
  if (txHeight >= beaconHeight)
    return {
      ok: false,
      why: `that round was published at height ${txHeight}, at or after its beacon block `
        + `${beaconHeight} - its creator could have seen the beacon first`,
    };
  return { ok: true, txHeight, beaconHeight };
}
