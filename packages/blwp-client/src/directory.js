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
import {
  acceptAdvert, mostWork, chainWork, blockHashOf, BITCOIN_MAINNET_GENESIS,
} from '../../protocol/src/chain.js';
import { agreedChain } from './headers.js';
import { askForBond } from './bond.js';
import { advertId } from '../../protocol/src/advert.js';
import { toHex } from '../../protocol/src/hash.js';

/**
 * Is this a socket address at all?
 *
 * Section 25.1: "Then connect `wss://` to the `endpoint` from the verified
 * advertisement." The endpoint is a string a bonded operator committed to on
 * chain, which makes it THEIRS - it does not make it a URL. Without this the
 * client would take whatever was committed and hand it to `WebSocket` after a
 * blind `replace(/^ws/, 'http')`, so a body carrying `http://...`, a bare
 * host, or something that is not an address at all would become the base a
 * round is played on.
 *
 * `ws://` is allowed for loopback only, because a test node on this machine
 * has no certificate and refusing it would mean the tests could not drive the
 * real door. Nothing else: a plaintext socket to another host is exactly the
 * one thing a committed endpoint must not be able to ask a player for.
 */
const LOOPBACK = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
export function isSocketAddress(endpoint) {
  if (typeof endpoint !== 'string') return false;
  if (LOOPBACK.test(endpoint)) return true;
  return /^wss:\/\/[^/?#\s]+(\/|$)/.test(endpoint);
}

/**
 * The endpoint, or the reason there is not one.
 *
 * The proof is tried against every header of the best chain rather than
 * against a header named by the caller: being handed a header is not being
 * handed a block, and a header that is not in the chain the client accepted is
 * one somebody made up. The transaction has to be in a block that is in the
 * chain, not merely in something 80 bytes long.
 *
 * AND THE NODE HAS TO BE ONE OF THIS ROUND'S. Section 25.1 is four steps, and
 * step 3 - "which are on the committee?" - is computed rather than fetched, so
 * the answer is already in the round's own contract. Step 4 is "where do I
 * reach THEM". Proving an advertisement without reading step 3's answer proves
 * only that somebody, somewhere, posted a bond: a page could hand over a real,
 * bonded, header-proven node with no standing in this round and the client
 * would open the round there and publish its whole section 11 transcript to a
 * stranger before the first receipt refused. A committee is therefore
 * REQUIRED, not optional - an absent one is a refusal, because the version of
 * this that takes an empty list and shrugs is the version that ships.
 */
export function reach({
  chain, chains, transaction, signedAdvert, branch, position, committee, bond, network,
}) {
  if (!committee || !committee.length)
    return { ok: false, why: 'no committee to check the node against' };

  // A CHAIN THAT WAS ALREADY AGREED, or a list to weigh here. `chain` is what
  // `agreedChain` hands back after two independent providers were compared,
  // and it is the one a live client should be passing: weighing a single list
  // handed over by one party is arithmetic, not evidence. Both are re-checked
  // - every header must link and must have met the target it claims - so a
  // fabricated block cannot be the one a bond is proven into whichever door it
  // came through.
  let headers; let work; let from = null;
  if (chain) {
    const linked = chainWork(chain);
    if (!linked.ok) return { ok: false, why: `that is not a mined chain: ${linked.why}` };
    headers = chain; work = linked.work;
  } else {
    const best = mostWork(chains || []);
    if (!best) return { ok: false, why: 'no chain of headers to check against' };
    headers = best.headers; work = best.work; from = best.at;
  }

  let refusal = 'the transaction is not in any block of that chain';
  for (const header of headers) {
    // The bond option travels with it: a page holding the network's
    // arbitration set and a curve can have the output key rebuilt, and one
    // that holds neither gets exactly what it got before.
    const seen = acceptAdvert({ transaction, signedAdvert, header, branch, position, bond, network });
    if (!seen.ok) {
      // A header that proves the transaction and then fails on the commitment
      // is a more specific answer than "not in this one", and it is the answer
      // that matters: the block is real and the endpoint was swapped anyway.
      if (seen.why !== 'the transaction is not in that block') refusal = seen.why;
      continue;
    }

    if (!committee.some((n) => toHex(n) === toHex(seen.nodePubkey))) {
      return {
        ok: false,
        why: `the advertisement is for ${toHex(seen.nodePubkey)}, `
          + "which is not on this round's committee",
      };
    }
    if (!isSocketAddress(seen.endpoint)) {
      return {
        ok: false,
        why: `the advertisement's endpoint ${JSON.stringify(seen.endpoint)} `
          + 'is not a secure socket address',
      };
    }

    return {
      ok: true,
      endpoint: seen.endpoint,
      nodePubkey: seen.nodePubkey,
      signature: seen.signature,
      advertId: advertId(seen.advert),
      txid: seen.txid,
      blockHash: blockHashOf(header),
      work,
      from,
    };
  }
  return { ok: false, why: refusal };
}

/**
 * The base URL a client talks to, from a proven advertisement only.
 *
 * Throws rather than answering, because there is no degraded mode here: a
 * client that could not prove where to go has nothing to fall back to that
 * would not be the page's word again.
 *
 * THIS DOES NOT CHECK THE SIGNATURE - it cannot, because verifying is
 * asynchronous in a browser and this answer is wanted synchronously, and
 * because a curve does not belong in this package. It is a gate, not the door:
 * `Client.at` is the door, it is asynchronous, and nothing is sent to the node
 * until the signature has verified there.
 */
export function endpointFor(discovery) {
  const seen = reach(discovery);
  if (!seen.ok) throw new Error(`no proven endpoint: ${seen.why}`);
  // 25.1 connects `wss://` to the endpoint; the client's own base is the HTTP
  // origin of the same node, and `connect()` turns it back into a socket.
  return seen.endpoint.replace(/^ws/, 'http');
}

/**
 * THE WHOLE OF STEP 4, FROM PROVIDERS RATHER THAN FROM A PAGE.
 *
 * Everything above this was a library nothing used. `reach` verified whatever
 * chain it was handed, which proves that a chain and a proof agree with each
 * other and NOTHING about Bitcoin: a page that wrote both wrote a consistent
 * pair. Section 25.1 is normative about what a CLIENT does, so until the door
 * asks providers itself, the chain source is not the client's chain source.
 *
 * A PROVIDER IS A FUNCTION AND THE CLIENT SPEAKS BITCOIN'S OWN SHAPES:
 * 80-byte headers back to back, and a merkle proof as 32-byte hashes with an
 * index. No explorer's JSON is parsed in here and no host or path is written
 * here. Translating a real chain API into these functions is an adapter, it
 * belongs to whoever runs the page or the node, and it is deliberately not
 * part of this package - a client that spoke one explorer's schema would have
 * adopted a second protocol without saying so.
 *
 * `anchor` is an argument for the same reason: which block a deployment
 * anchors on is a constant somebody must choose, and choosing it here would
 * settle it by accident.
 */
/** Two, and it is the whole property rather than a setting. */
export const PROVIDERS_NEEDED = 2;

/** How long the client waits on a provider before giving up on it. */
export const PROVIDER_WAIT_MS = 10000;

export async function discover({
  headers, bonds, anchor, committee, signedAdvert, ask, least, timeoutMs,
}) {
  // THE RULES ARE THE CLIENT'S. THE PAGE SAYS WHERE TO ASK, AND NOTHING ELSE.
  //
  // Each of these was a caller's argument, which meant a page's argument, and
  // each one alone undoes the whole chain source:
  //
  //   least       set it to 1 and "several independent sources, most work
  //               wins" becomes one source, whose short chain and whose
  //               hidden block are the same bytes. Measured before this was
  //               refused: a page passing `least: 1` opened a round on a
  //               single provider it also supplied.
  //   timeoutMs   how long a client waits is the client's patience, not the
  //               page's. Zero refuses every honest provider; enormous hangs
  //               the run on one the page controls.
  //
  // `ask` is deliberately NOT here. It names the range of chain to fetch, and
  // a lie about it can only omit - which is what a second provider answers.
  // AND EVERY PROVIDER HAS TO SAY WHO IT IS.
  //
  // "Several independent SOURCES" is the rule, and a source is a server, not a
  // call. Two functions closing over one address are one source however they
  // are listed, and on this path the page writes the functions - so without a
  // declared tag the two-provider floor counted calls, which is weaker than
  // the words and is the same shape of hole as `least`: a rule that held in
  // the library and never fired at the door.
  //
  // A tag is a DECLARATION and not a proof. A page that puts two different
  // tags on one machine is believed, and cannot be caught from in here: two
  // honest providers on the same chain return the same bytes, so there is no
  // signal to read. What the tag buys is that the obvious case - one address
  // listed twice - is refused, and that a lie has to be written down as a lie
  // rather than being the default.
  for (const [what, list] of [['header', headers], ['bond', bonds]]) {
    const said = new Map();
    for (let i = 0; i < (list || []).length; i++) {
      const tag = list[i] && list[i].tag;
      if (typeof tag !== 'string' || !tag.length)
        return {
          ok: false,
          why: `${what} provider ${i} does not say which source it is: a `
            + 'provider must carry a tag, or two calls to one server count as two sources',
        };
      if (said.has(tag))
        return {
          ok: false,
          why: `${what} providers ${said.get(tag)} and ${i} are the same source, `
            + `${tag}: one server listed twice is not two`,
        };
      said.set(tag, i);
    }
  }

  for (const [name, value] of [['least', least], ['timeoutMs', timeoutMs]]) {
    if (value !== undefined)
      return {
        ok: false,
        why: `${name} is the client's own and may not be supplied: how many `
          + 'providers must agree, and how long to wait for them, are not '
          + 'settings for whoever handed over the providers',
      };
  }

  // THE ANCHOR IS THE CLIENT'S, AND A PAGE THAT OFFERS ONE IS REFUSED.
  //
  // This was the last hop where the whole chain source came apart. Weighing,
  // mining and the bond proof were all honest, and then the block everything
  // was anchored TO arrived from the page - so an attacker who supplied the
  // providers supplied the block he wanted to sit on, and his own little mined
  // world contained it by construction. An anchor somebody else chooses is not
  // an anchor; it is the same trust, one level down, wearing the word.
  //
  // Genesis is the one block that needs no decision from anybody: it is
  // mainnet's identity, it cannot go stale, and anyone can check it. Whether a
  // deployment later anchors on a nearer block to avoid carrying history is a
  // constant somebody must choose, and choosing it here would settle it by
  // accident.
  if (anchor !== undefined)
    return {
      ok: false,
      why: 'the anchor is the client\'s own and may not be supplied: a block '
        + 'chosen by whoever handed over the chain is not a block the client knows',
    };

  const chain = await agreedChain(headers, {
    anchor: BITCOIN_MAINNET_GENESIS, ask,
    least: PROVIDERS_NEEDED, timeoutMs: PROVIDER_WAIT_MS,
  });
  if (!chain.ok) return { ok: false, why: `no chain: ${chain.why}`, refused: chain.refused };

  const bond = await askForBond(bonds, {
    chain: chain.headers, ask, timeoutMs: PROVIDER_WAIT_MS,
  });
  if (!bond.ok) return { ok: false, why: `no bond: ${bond.why}`, refused: bond.refused };

  const seen = reach({
    chain: chain.headers,
    transaction: bond.transaction,
    branch: bond.branch,
    position: bond.position,
    signedAdvert,
    committee,
  });
  if (!seen.ok) return seen;
  return {
    ...seen,
    work: chain.work,
    agreed: chain.agreed,
    fromChain: chain.from,
    fromBond: bond.from,
  };
}
