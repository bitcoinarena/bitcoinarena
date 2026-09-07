// WHERE TO TALK, AND WHY.
//
// Section 25.1: "A client finds nodes by reading Bitcoin. There is no
// directory, no relay network and no seed list belonging to this protocol."
// This file is the client's half of step 4 - "where do I reach them? the
// NodeAdvertisement, carried by the bond funding transaction".
//
// WHAT IT REPLACES. The endpoint used to be `BLWP_NODE`, a page global. Every
// stranger who loaded the page reached whatever address whoever shipped the
// page had written into it, and there was nothing in the client that could
// tell a real node from any other server. Section 25.1 is normative about
// exactly that: a client "MUST NOT take a census, a committee or an endpoint on
// the word of any API, including one operated by the same party that ships the
// client", because "there is no symptom to notice and nothing for the player to
// check".
//
// A PAGE MAY STILL CARRY THE BYTES. That is not the same thing and it is the
// whole design: the page hands over a transaction, a branch and headers, and
// none of those are things it can choose. The txid is computed from the
// transaction, the branch has to rebuild a header's own merkle root, and the
// endpoint is only read out of a body an output of that transaction commits
// to. A page that swaps the endpoint is refused by name.
//
// WHAT IS STILL MISSING, AND IT IS NOT THIS SLICE. Where the headers come from.
// One source cannot be weighed: "block headers from several independent
// sources, most work wins", and then "a list provider can omit but not forge,
// and omission is answered by asking a second one". `mostWork` is here and takes
// as many chains as it is given - nothing fetches yet, and until something does,
// a client is only as sure as the chain it was handed.
import { acceptAdvert, mostWork, blockHashOf } from '../../protocol/src/chain.js';

/**
 * The endpoint, or the reason there is not one.
 *
 * The proof is tried against every header of the best chain rather than
 * against a header named by the caller: being handed a header is not being
 * handed a block, and a header that is not in the chain the client accepted is
 * one somebody made up. The transaction has to be in a block that is in the
 * chain, not merely in something 80 bytes long.
 */
export function reach({ chains, transaction, advert, branch, position }) {
  const best = mostWork(chains || []);
  if (!best) return { ok: false, why: 'no chain of headers to check against' };

  let refusal = 'the transaction is not in any block of that chain';
  for (const header of best.headers) {
    const seen = acceptAdvert({ transaction, advert, header, branch, position });
    if (seen.ok) {
      return {
        ok: true,
        endpoint: seen.endpoint,
        nodePubkey: seen.nodePubkey,
        txid: seen.txid,
        blockHash: blockHashOf(header),
        work: best.work,
        chain: best.at,
      };
    }
    // A header that proves the transaction and then fails on the commitment is
    // a more specific answer than "not in this one", and it is the answer that
    // matters: the block is real and the endpoint was swapped anyway.
    if (seen.why !== 'the transaction is not in that block') refusal = seen.why;
  }
  return { ok: false, why: refusal };
}

/**
 * The base URL a client talks to, from a proven advertisement only.
 *
 * Throws rather than answering, because there is no degraded mode here: a
 * client that could not prove where to go has nothing to fall back to that
 * would not be the page's word again.
 */
export function endpointFor(discovery) {
  const seen = reach(discovery);
  if (!seen.ok) throw new Error(`no proven endpoint: ${seen.why}`);
  // 25.1 connects `wss://` to the endpoint; the client's own base is the HTTP
  // origin of the same node, and `connect()` turns it back into a socket.
  return seen.endpoint.replace(/^ws/, 'http');
}
