// THE BOND, IN A BLOCK THAT WAS ACTUALLY MINED.
//
// Section 25.1 gives a browser three lines of work: headers from several
// independent sources with most work winning, "bond transaction plus a merkle
// proof, from any chain API", and then "verify: proof against header,
// H(advertisement) against the bond output's commitment".
//
// The first line is `headers.js` and it needs AGREEMENT, because the weight of
// a chain means nothing except in comparison. This line does not, and the
// difference is worth saying out loud rather than copying the pattern: a bond
// proof carries its own proof. It rebuilds a merkle root that a mined header
// already commits to, so a provider cannot forge one at any price - the only
// lie available is to withhold it, and withholding is answered by asking the
// next provider, not by taking a vote.
//
// SO ONE PROVIDER IS ENOUGH HERE, and two are needed there, and neither is a
// preference.
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { provesTransaction, blockHashOf, chainWork } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

/**
 * Does this proof land in a block of this chain?
 *
 * The chain is re-checked here rather than taken on the caller's word - it is
 * one pass over headers that are already in hand, and it is the difference
 * between "a block" and "80 bytes somebody handed me". Every header in a chain
 * that passes has met the target it claims, so a fabricated header carrying a
 * merkle root of the attacker's choosing cannot be the block a bond is proven
 * into: the chain holding it is not a chain.
 *
 * The txid is computed from the transaction, never accepted beside it, for the
 * same reason it is computed in `acceptAdvert`.
 */
export function provenBond({ chain, transaction, branch, position }) {
  const linked = chainWork(chain || []);
  if (!linked.ok)
    return { ok: false, why: `that is not a mined chain: ${linked.why}` };

  let tx;
  try { tx = parseTransaction(transaction); }
  catch (e) { return { ok: false, why: `that is not a transaction: ${e.message}` }; }

  for (const header of chain) {
    if (!provesTransaction(header, tx.txid, branch, position)) continue;
    return {
      ok: true,
      txid: tx.txid,
      transaction,
      branch,
      position,
      header,
      blockHash: blockHashOf(header),
    };
  }
  return {
    ok: false,
    why: `the transaction ${toHex(tx.txid.slice().reverse())} is not proven `
      + 'into any block of that chain',
  };
}

/**
 * Ask providers for a bond until one of them proves it.
 *
 * IN ORDER, AND THE FIRST PROOF WINS, which is not laziness: a proof is not an
 * opinion, so there is nothing for a second provider to add except the same
 * bytes. What a second provider is for is the case where the first says
 * nothing - "omission is answered by asking a second one" - and that is why
 * every refusal is kept and handed back rather than swallowed.
 *
 * A provider is a function, like a header provider is, and for the same
 * reason: the shape a chain API puts a merkle proof in is nobody's standard,
 * and writing one API's field names into the client would be adopting a second
 * protocol without saying so.
 */
export async function askForBond(providers, { chain, ask, timeoutMs = 10000 } = {}) {
  const refused = [];
  for (let at = 0; at < (providers || []).length; at++) {
    let timer;
    try {
      const stop = new AbortController();
      const offer = await Promise.race([
        Promise.resolve().then(() => providers[at](ask, { signal: stop.signal })),
        new Promise((_, no) => {
          timer = setTimeout(() => {
            stop.abort();
            no(new Error(`no answer in ${timeoutMs} ms`));
          }, timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
      const seen = provenBond({ chain, ...offer });
      if (seen.ok) return { ...seen, from: at, refused };
      refused.push(`provider ${at}: ${seen.why}`);
    } catch (e) {
      refused.push(`provider ${at}: ${e.message}`);
    } finally { clearTimeout(timer); }
  }
  return {
    ok: false,
    why: refused.length
      ? 'no provider proved that bond into the chain'
      : 'no providers to ask for the bond',
    refused,
  };
}
