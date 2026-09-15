// THE PAGE COUNTS THE FEDERATION'S BONDED GUARDIANS ITSELF (§23.6, P3; the owner
// 2026-09-15 07:33: "every guardian / node must have its own bond or it may not
// take part. federationIsBonded stays on").
//
// A signer node counts them before it signer nodes a paying round (server.js guardiansBonded),
// and the page used to take that on the signer nodes' word: the signer nodes are the ones a
// creator could have chosen. Here the page counts on its own evidence, every
// piece of it checked rather than handed over:
//
//   the guardians   off the config the page's own lock client downloaded from
//                   the federation it joined (lock client `guardians()`: the
//                   broadcast keys and fedimint's threshold) - not a signer node's list;
//   the chain       headers the page agreed from independent providers
//                   (`agreedChain`), each linked and mined;
//   each bond       a transaction proven into a block of that chain, committing
//                   to an advertisement signed by the node it names, at least the
//                   round's census_confirmations deep, worth at least its bond_min.
//
// WHERE THE BONDS COME FROM IS A HINT. A signer node, a provider, a list on the page -
// whoever names candidate guardian nodes can only omit, never forge: an offer
// that does not prove is set aside with its reason, and the count is only over
// what proved. Omitting enough to fall under the threshold is a refusal, which
// is where a lie about the list can take a player: to no round, not to a bad one.
//
// NOT CHECKED HERE: whether a proven bond is still unspent. Headers carry no
// spends, and the signer node's census reads them from the chain it indexed. A spent
// bond counted here is one a signer node's own count refuses.
import { acceptAdvert, chainWork } from '../../protocol/src/chain.js';
import { advertId } from '../../protocol/src/advert.js';
import { federationIsBonded } from '../../protocol/src/federation.js';
import { fromHex, toHex } from '../../protocol/src/hash.js';

/** The lock client's `guardians()` answer, as bytes. */
export function guardiansOf(answer) {
  const g = typeof answer === 'string' ? JSON.parse(answer) : answer;
  if (!g || !Array.isArray(g.keys)) throw new Error('the lock client named no guardians');
  return {
    federationId: fromHex(g.federation_id),
    total: g.guardians,
    threshold: g.threshold,
    keys: g.keys.map((k) => fromHex(k.key)),
  };
}

/**
 * A signer node's /guardian-bonds answer as offers: hex to bytes, nothing believed.
 * The signer node names candidates; `bondedGuardians` is what decides.
 */
export function offersFrom(answer) {
  const a = typeof answer === 'string' ? JSON.parse(answer) : answer;
  if (!a || !Array.isArray(a.bonds)) throw new Error('that answer names no guardian bonds');
  return a.bonds.map((b) => ({
    transaction: fromHex(b.transaction), branch: b.branch.map(fromHex), position: b.position,
  }));
}

/**
 * The count: { ok, bonded, threshold, why?, counted, refused }. `offers` are
 * `{ transaction, branch, position, signedAdvert? }` from whoever named the
 * candidates; `verify(signature, message, pubkey)` is the page's schnorr check.
 */
export async function bondedGuardians({ guardians, round, chain, offers, verify, bond, network } = {}) {
  if (!guardians || !Array.isArray(guardians.keys))
    return { ok: false, why: 'the page read no guardians off its federation\'s config', counted: [], refused: [] };
  if (toHex(guardians.federationId) !== toHex(round.federationId))
    return {
      ok: false, counted: [], refused: [],
      why: `the page's lock client joined federation ${toHex(guardians.federationId).slice(0, 16)} and this round `
        + `names ${toHex(round.federationId).slice(0, 16)}, so it cannot count this round's guardians`,
    };
  const linked = chainWork(chain || []);
  if (!linked.ok) return { ok: false, why: `that is not a mined chain: ${linked.why}`, counted: [], refused: [] };
  if (typeof verify !== 'function')
    return { ok: false, why: 'the page has no signature check to read an advertisement with', counted: [], refused: [] };

  const census = [];
  const refused = [];
  for (let i = 0; i < (offers || []).length; i++) {
    const { transaction, branch, position, signedAdvert } = offers[i] || {};
    let seen = null; let at = -1;
    let why = 'the transaction is not in any block of that chain';
    for (let h = 0; h < chain.length; h++) {
      const s = acceptAdvert({ transaction, signedAdvert, header: chain[h], branch, position, bond, network });
      if (s.ok) { seen = s; at = h; break; }
      if (s.why !== 'the transaction is not in that block') why = s.why;
    }
    if (!seen) { refused.push(`bond ${i}: ${why}`); continue; }
    const deep = chain.length - at;
    if (deep < round.censusConfirmations) {
      refused.push(`bond ${i}: it is ${deep} block(s) deep and this round asks for ${round.censusConfirmations}`);
      continue;
    }
    if (!await verify(seen.signature, advertId(seen.advert), seen.nodePubkey)) {
      refused.push(`bond ${i}: the advertisement for ${toHex(seen.nodePubkey).slice(0, 16)} is not signed by the node it names`);
      continue;
    }
    census.push({ pubkey: seen.nodePubkey, bondSats: BigInt(seen.bondSats), advert: seen.advert });
  }

  const count = federationIsBonded({
    federationId: round.federationId, guardianKeys: guardians.keys, threshold: guardians.threshold,
    census, bondMinSats: round.bondMinSats,
  });
  return { ...count, counted: census.map((e) => toHex(e.pubkey)), refused };
}
