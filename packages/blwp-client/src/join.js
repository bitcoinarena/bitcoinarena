// THE ROUND A PAGE WAS SENT TO, NAMED IN ITS OWN URL.
//
// The page has always refused to invent a round: `BLWP_ROUND` is undefined in
// the shipped template, on the written ground that "a round contract is agreed
// before anyone moves, and inventing one in the page would be inventing a
// lobby". That refusal stays exactly as it is. What was missing is the other
// half - there was NO WAY AT ALL to hand a shipped page a round that already
// exists, so two people could not join one, and the whole multiplayer path was
// unreachable from the daily however correct it was underneath.
//
// So: the same family as `?practice=0`. A URL may NAME things that exist - a
// round id, the daemons holding it, where headers and the bond can be asked
// for - and this resolves those names into the three globals the jslib reads.
// Nothing here mints a round, a contract, a committee or an id.
//
// AND THE NODE IS NOT TAKEN AT ITS WORD. A daemon asked for round X answers
// with bytes; those bytes are hashed here and must BE X, or they are refused.
// Without that the query would be an instruction to play whatever contract the
// first server felt like returning - a different stake, a different committee,
// a different core hash - which is precisely the substitution the round id
// exists to prevent. Same rule as the entry a resuming client re-hashes.
import { decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { httpProvider } from './headers.js';
import { NO_SHARES } from '../../protocol/src/handout.js';

/** How the query names each thing. One key, one meaning, all optional but `round`. */
export const JOIN_KEYS = ['round', 'node', 'headers', 'bond', 'advert'];

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };

/**
 * What the URL names, or null when it names no round.
 *
 * Parsing is separated from fetching so the refusals can be measured without a
 * server: a page that mis-spells a key should be told which key, not left
 * waiting on a request nobody will answer.
 */
export function joinQuery(search) {
  const q = new URLSearchParams(
    typeof search === 'string' ? (search.startsWith('?') ? search.slice(1) : search) : search);

  const round = (q.get('round') || '').trim().toLowerCase();
  if (!round) return null;                     // no round named: the daily, unchanged
  if (!/^[0-9a-f]{64}$/.test(round))
    throw new Error('the URL names a round that is not a 32-byte id: ' + round);

  const nodes = list(q.get('node'));
  if (!nodes.length)
    throw new Error('the URL names a round and no node holding it - add node=<url>');
  for (const n of nodes)
    if (!origin(n)) throw new Error('this is not a node address: ' + n);

  // THE HEADERS DEFAULT TO THE NODES AND THAT IS STILL TWO SOURCES, because
  // two daemons are two parties. `agreedChain` refuses one source by name, so
  // a page told about a single node has to be told where the second chain view
  // is - it is not quietly downgraded to trusting one.
  const headers = list(q.get('headers'));
  const chainFrom = headers.length ? headers : nodes;
  if (new Set(chainFrom.map(origin)).size < 2)
    throw new Error('a chain is read from two independent sources and this URL names '
      + new Set(chainFrom.map(origin)).size + ' - add a second node= or headers=');

  const bond = (q.get('bond') || '').trim();
  if (!bond) throw new Error('the URL names nowhere to ask for the bond - add bond=<url>');
  if (!origin(bond)) throw new Error('this is not a bond address: ' + bond);

  const advert = (q.get('advert') || '').trim();
  if (!advert)
    throw new Error('the URL names no signed advertisement - add advert=<hex or url>');
  if (!/^[0-9a-f]{128}$/i.test(advert) && !origin(advert))
    throw new Error('an advertisement is 64 signed bytes or a place to fetch them from');

  return { round, nodes, chainFrom, bond, advert };
}

/**
 * The contract the id names, from the first node that answers with it.
 *
 * Every node is asked before the join fails, because a daemon being down is
 * ordinary and is not the same fact as a round not existing - and the reason
 * each one gave is carried into the error, so "nobody had it" and "everybody
 * answered with something else" do not look alike.
 */
export async function fetchRound(id, nodes, { fetcher = fetch } = {}) {
  const refused = [];
  for (const node of nodes) {
    const at = node.replace(/\/+$/, '') + '/round?id=' + id;
    try {
      const r = await fetcher(at);
      if (!r.ok) { refused.push(`${node}: answered ${r.status}`); continue; }
      const bytes = new Uint8Array(await r.arrayBuffer());
      const contract = decodeRoundContract(bytes);
      const got = toHex(roundId(contract));
      if (got !== id) {
        refused.push(`${node}: answered with round ${got}`);
        continue;
      }
      return { contract, from: node, refused };
    } catch (e) {
      refused.push(`${node}: ${e.message}`);
    }
  }
  throw new Error('no node holds the round this URL names: ' + refused.join('; '));
}

/**
 * A bond provider over the little JSON an operator publishes beside a round.
 *
 * The shape is the one the browser harness already used - hex transaction, hex
 * merkle branch, position - and it lives here now rather than in a string
 * inside a tool, so it is a thing `node --test` drives. It is an ADAPTER: the
 * protocol speaks Bitcoin's own bytes, and translating whatever an operator
 * serves into them is deliberately outside everything that decides.
 */
export function bondProvider(where, { fetcher = fetch } = {}) {
  const get = async (ask, opts) => {
    const r = await fetcher(where, opts);
    if (!r.ok) throw new Error(`the bond provider answered ${r.status}`);
    const o = await r.json();
    return {
      transaction: fromHex(o.hex),
      branch: (o.merkle || []).map(fromHex),
      position: o.pos | 0,
    };
  };
  get.tag = origin(where);
  return get;
}

/**
 * The three globals the jslib reads, resolved from a URL - or null.
 *
 * Null is the shipping default and it is not an error: a page nobody sent
 * anywhere is the single-player daily, which is what almost every visitor
 * opens. Only a URL that NAMES a round changes that.
 */
export async function joinFromQuery(search, { fetcher = fetch } = {}) {
  const named = joinQuery(search);
  if (!named) return null;

  const { contract, from, refused } = await fetchRound(named.round, named.nodes, { fetcher });
  const advert = /^[0-9a-f]{128}$/i.test(named.advert)
    ? named.advert.toLowerCase()
    : await (async () => {
        const r = await fetcher(named.advert);
        if (!r.ok) throw new Error(`the advertisement answered ${r.status}`);
        const hex = (await r.text()).trim().toLowerCase();
        if (!/^[0-9a-f]{128}$/.test(hex))
          throw new Error('that is not a 64-byte signature over an advertisement');
        return hex;
      })();

  return {
    round: contract,
    roundIdHex: named.round,
    from,
    refused,
    chain: {
      headers: named.chainFrom.map((u) => httpProvider(u.replace(/\/+$/, '') + '/headers')),
      bonds: [bondProvider(named.bond, { fetcher })],
    },
    advert: { signedAdvert: advert },
  };
}

/**
 * WHO THIS TAB IS, kept in the tab and never sent anywhere.
 *
 * Two people looking at one round is two identities, and on one machine that
 * is two tabs - so the key cannot live in `localStorage`, which every tab of a
 * browser shares and which would make two tabs one player whose own ghost is
 * dropped. `sessionStorage` is per tab, which is exactly the lifetime a seat
 * at a round has.
 *
 * The bytes are the browser's own randomness. Nothing derives them from
 * anything the page was given, so no operator can predict or replay a player.
 * PRIORITIES has the long form of this - a key kept in the browser with backup
 * and import, never uploaded - and this is its first half.
 */
export function tabIdentity({ storage, random, key = 'blwp.player' } = {}) {
  const held = storage && storage.getItem(key);
  if (held && /^[0-9a-f]{64}$/i.test(held)) return fromHex(held.toLowerCase());
  const made = random(32);
  if (storage) storage.setItem(key, toHex(made));
  return made;
}

/**
 * The seat this page takes at a round it did not write.
 *
 * The amounts are the ROUND'S, not the page's: a stake it disagrees with is a
 * stake the node would refuse, and copying the number out of the contract is
 * the only way a page can be sure it is asking for the seat that exists.
 *
 * M2 ASKS FOR NO MONEY AND DISTRIBUTES NONE, so `stakeCommitment` commits to
 * nothing: in M3 it is the hash of a hold invoice's preimage, and until that
 * invoice exists there is no preimage to hash. It is random rather than a
 * constant so two players never file the same one, and it is named here rather
 * than quietly zeroed, because a zeroed commitment looks like a computed one.
 *
 * The world secret IS load-bearing already: it is the player's own, it seeds
 * their world, and a node that had it could predict the round they are about
 * to drive.
 */
export function entryFor(round, { playerPubkey, random, joinTick = 0 } = {}) {
  if (!round) throw new Error('there is no round to take a seat at');
  if (!playerPubkey || playerPubkey.length !== 32)
    throw new Error('a player is 32 bytes of key');
  return {
    playerPubkey,
    stakeCommitment: random(32),
    worldSecret: random(32),
    // 23.1's `vss_shares_ref`, and this entry publishes no shares: there is no
    // stake behind the preimage in M2, so there is nothing yet to split. The
    // field is in the signed bytes either way, so an entry that has shares and
    // one that has none can never be the same entry id.
    vssSharesRef: NO_SHARES,
    stakeMsat: round.stakeMsat,
    feeMsat: 0n,
    donationMsat: 0n,
    joinTick,
  };
}
