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
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { httpProvider } from './headers.js';
import { NO_SHARES, dealHandout, encodeHandout } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';

/**
 * HOW MANY SHARES OPEN THIS ROUND'S STAKES - the round's number, not the
 * player's: 2 of 2, 5 of 7 (`receiptsNeeded` over the settlement slots). The
 * page deals at it, the node's door refuses any other, and the settle opens at
 * it (M3.3-26). The page used to deal `needed: settlementSlots` - 7 of 7 on
 * seven seats, which the door now refuses - and to post at 5 on a 2-of-2.
 */
export const sharesNeededFor = (round) => receiptsNeeded(round.settlementSlots);

/** How the query names each thing. One key, one meaning, all optional but `round`. */
export const JOIN_KEYS = ['round', 'node', 'headers', 'bond', 'advert'];

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };
// Two daemons behind one HTTPS reverse proxy differ by first path segment
// (/blwp-a vs /blwp-b). Origin alone would count them as one source and an
// https page could not fetch http:// Tailscale nodes (Safari mixed content).
const sourceKey = (u) => {
  try {
    const x = new URL(u);
    const head = x.pathname.split('/').filter(Boolean)[0] || '';
    return head ? `${x.origin}/${head}` : x.origin;
  } catch { return null; }
};

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
  if (new Set(chainFrom.map(sourceKey)).size < 2)
    throw new Error('a chain is read from two independent sources and this URL names '
      + new Set(chainFrom.map(sourceKey)).size + ' - add a second node= or headers=');

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
 * THE ROUND'S RANDOMNESS, AGREED BY EVERY NODE THE URL NAMED.
 *
 * The player's own world is seeded H(randomness || pubkey || world secret ||
 * join tick), so a page that does not know the randomness cannot put its core
 * in the world the committee will replay it in. It did not know it: the page
 * seeded its core with a CONSTANT, and on a real 2-of-2 round the truck the
 * player drove stood at z 10.20 m while the committee's copy of the same truck
 * stood at 57.80 m - a different bay, in a different world, before either of
 * them moved. Every other player saw that second truck.
 *
 * ASKED OF ALL OF THEM, NOT THE FIRST. A beacon is a published block hash and
 * a node that named a different one would put this player alone in a world
 * nobody replays - which is the fault this function exists to end, arriving by
 * another road. So this is the chain rule again, in the small: every node the
 * URL named is asked, and a disagreement is a refusal by name rather than a
 * majority or a first answer.
 *
 * WHAT THIS IS NOT is proof that the hash is the block 5A.5 names. Deriving
 * the height from the chain is letter 32's work and the page does not do it;
 * what the page can do is refuse to be told two different things, and say so.
 */
export async function fetchRandomness(id, nodes, { fetcher = fetch } = {}) {
  if (!Array.isArray(nodes) || !nodes.length)
    throw new Error('no node to ask for this round\'s randomness');
  const said = [];
  const refused = [];
  for (const node of nodes) {
    const at = node.replace(/\/+$/, '') + '/randomness?round=' + id;
    try {
      const r = await fetcher(at);
      if (!r.ok) { refused.push(`${node}: answered ${r.status} ${(await r.text()).trim()}`); continue; }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length !== 32) { refused.push(`${node}: answered ${bytes.length} bytes`); continue; }
      said.push({ node, hash: bytes, height: Number(r.headers.get('x-height') || 0) });
    } catch (e) {
      refused.push(`${node}: ${e.message}`);
    }
  }
  if (!said.length)
    throw new Error('no node named this round\'s randomness: ' + refused.join('; '));
  const first = toHex(said[0].hash);
  for (const s of said.slice(1)) {
    if (toHex(s.hash) !== first)
      throw new Error(`${said[0].node} says this round's randomness is ${first} and `
        + `${s.node} says ${toHex(s.hash)}: a round whose nodes name two worlds is not one round`);
  }
  return { randomness: said[0].hash, height: said[0].height, agreed: said.length, refused };
}

/**
 * PUBLISH THE HANDOUT, AND COUNT WHAT IT IS WORTH.
 *
 * A HANDOUT FEWER THAN `needed` SEATS HOLD IS A STAKE NOBODY CAN OPEN.
 * Reconstruction takes five of seven; a page that dealt to seven, reached
 * three and seated anyway would put a player at a paying round whose stake can
 * never be settled - and every seat that did not store it REFUSES the entry,
 * so most of the committee has no record of that player at all.
 *
 * Measured before this existed, with three of seven reachable:
 *
 *   settlement seats holding the handout   3 of 7
 *   the threshold to open it               5
 *   reconstructable                        false
 *   the node the page joined               201, seated
 *   every other node                       400, "that entry names shares this
 *                                          node has not accepted"
 *
 * and the page counted the three and acted on none of it. So the count is a
 * DECISION now, and it is made here rather than in the page for the reason
 * `roundPays` is: `index.html` is the one file `node --test` cannot load.
 *
 * Posted to every node the round named, because the page holds URLs and the
 * committee is keys - there is no map between them. A node with no share in
 * the handout refuses, which is the right answer and is counted as one.
 */
export async function postHandout(stake, nodes, { fetcher = fetch, needed: asked } = {}) {
  if (!stake || !stake.body) throw new Error('there is no dealt stake to publish');
  // THE SEATS THAT MUST HOLD IT are the threshold it was dealt at - which
  // `stakeFor` makes the round's. The default was a flat 5 (M3.3-26).
  const needed = asked ?? stake.handout?.needed;
  if (!Number.isInteger(needed) || needed < 1)
    throw new Error('this stake does not say how many seats open it');
  if (!Array.isArray(nodes) || !nodes.length)
    throw new Error('no node to publish this handout to');
  const accepted = [];
  const refused = [];
  for (const node of nodes) {
    const at = node.replace(/\/+$/, '') + '/handout';
    try {
      const r = await fetcher(at, { method: 'POST', body: stake.body });
      if (r.ok) accepted.push(node);
      else refused.push(`${node}: ${(await r.text()).trim()}`);
    } catch (e) {
      refused.push(`${node}: ${e.message}`);
    }
  }
  if (accepted.length < needed)
    return {
      ok: false, accepted: accepted.length, needed, refused,
      why: `${accepted.length} of the ${needed} seats needed to open this stake took the `
        + 'handout, so it could never be settled',
    };
  return { ok: true, accepted: accepted.length, needed, refused };
}

/**
 * DOES THIS ROUND ASK FOR MONEY?
 *
 * One line, and it lives HERE rather than in the page for the reason the hold
 * and the drain moved: `index.html` is the one file `node --test` cannot load,
 * and a rule written there is a rule with no test. It is also the reason the
 * page is forbidden to name a contract field at all - a page that carried its
 * own `stakeMsat` could carry its own committee next - so the page asks this
 * and reads nothing off the round itself.
 */
export const roundPays = (round) => !!round && BigInt(round.stakeMsat || 0n) > 0n;

/**
 * HOW MANY SETTLEMENT NODES MUST HAVE SEEN A STAKE HELD (23.1 step 5): the
 * round's threshold, the one rule the door, the settle and the dealing read
 * (2 of 2, 5 of 7). It was its own copy - "2 on two slots, 5 otherwise" - and
 * counted a stake committed on committees the node has no threshold for.
 */
export function stakeSeenNeeded(contract) {
  return receiptsNeeded(contract?.settlementSlots ?? contract?.nodes?.length);
}

/**
 * HOW MANY OF THE ROUND'S SETTLEMENT SEATS HAVE SEEN THIS STAKE HELD.
 *
 * 23.1 step 5: "STAKE_COMMITTED is recorded once >=5 settlement nodes have seen
 * the held HTLC." Each node answers for itself (`GET /stake`, its own
 * Lightning). The seats are KEYS (`fetchSettlementSeats`) and the page holds
 * URLS, so each URL is asked who it is (`GET /identity`) and only a settlement
 * seat's answer is counted, once per key. A seat no URL answers for - down, or
 * never listed - is counted as NOT seen and named in `unanswered`.
 *
 *   { seen, of, needed, unanswered, committed, per }
 *
 * `committed` is a label for the page: it gates nothing. Each node still
 * refuses its own receipt until it has seen the stake.
 */
export async function stakeSeenBy({ entryId, seats, nodes, contract, fetcher = fetch } = {}) {
  const want = new Set((seats || []).map((k) => toHex(k)));
  const eid = typeof entryId === 'string' ? entryId : toHex(entryId);
  const answered = new Set();
  const per = [];
  let seen = 0;
  for (const node of nodes || []) {
    const base = String(node).replace(/\/+$/, '');
    let key;
    try {
      const r = await fetcher(base + '/identity');
      if (!r.ok) { per.push({ node, why: `identity answered ${r.status}` }); continue; }
      key = toHex(new Uint8Array(await r.arrayBuffer()));
    } catch (e) { per.push({ node, why: e.message }); continue; }
    if (!want.has(key) || answered.has(key)) continue;
    try {
      const r = await fetcher(`${base}/stake?entry=${eid}`);
      answered.add(key);
      if (r.ok) { seen++; per.push({ node, key, seen: true }); }
      else per.push({ node, key, seen: false, why: (await r.text()).trim() });
    } catch (e) { per.push({ node, key, why: e.message }); }
  }
  const of = want.size;
  const needed = stakeSeenNeeded(contract);
  return { seen, of, needed, unanswered: of - answered.size, committed: seen >= needed, per };
}

/**
 * WHO THE SETTLEMENT COMMITTEE IS, ASKED OF EVERY NODE THE ROUND NAMED.
 *
 * A STAKE IS DEALT TO THE SETTLEMENT SEATS AND TO NOBODY ELSE, and the list
 * the page already holds is the wrong one. Measured on nine bonded nodes with
 * seven game/verify slots and seven settlement slots:
 *
 *   /committee?role=game          7 seats
 *   /committee?role=settlement    7 seats
 *   contract.nodes (the union)    9      <- what `joinFromQuery` hands over
 *   in both committees            5
 *   settlement-only               2
 *
 * `Roster.seatsFor` says so in its own words - "a contract carries one flat
 * `nodes` list, so the seated set is the union of the role committees" - so
 * dealing to it would seal nine shares for a seven-of-which-five scheme, two
 * of them to seats that can never open one. A stake nobody can open at payout
 * is a stake that is lost, which is worse than one never dealt.
 *
 * ASKED OF EVERY NODE AND REFUSED ON DISAGREEMENT, exactly as the randomness
 * is: one node's answer about who may open a player's stake is one node
 * choosing who may open it.
 */
export async function fetchSettlementSeats(id, nodes, { fetcher = fetch } = {}) {
  if (!Array.isArray(nodes) || !nodes.length)
    throw new Error('no node to ask which seats settle this round');
  const said = [];
  const refused = [];
  for (const node of nodes) {
    const at = node.replace(/\/+$/, '') + '/committee?role=settlement&round=' + id;
    try {
      const r = await fetcher(at);
      if (!r.ok) { refused.push(`${node}: answered ${r.status} ${(await r.text()).trim()}`); continue; }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (!bytes.length || bytes.length % 32 !== 0) {
        refused.push(`${node}: answered ${bytes.length} bytes, which is not whole keys`);
        continue;
      }
      const seats = [];
      for (let at2 = 0; at2 < bytes.length; at2 += 32) seats.push(bytes.subarray(at2, at2 + 32));
      said.push({ node, seats });
    } catch (e) {
      refused.push(`${node}: ${e.message}`);
    }
  }
  if (!said.length)
    throw new Error('no node named this round\'s settlement committee: ' + refused.join('; '));

  // SORTED BEFORE THEY ARE COMPARED, because two nodes may list one committee
  // in two orders and that is the same committee. What must not differ is the
  // SET.
  const key = (list) => list.map(toHex).sort().join(',');
  const first = key(said[0].seats);
  for (const s of said.slice(1)) {
    if (key(s.seats) !== first)
      throw new Error(`${said[0].node} and ${s.node} name two different settlement `
        + 'committees, so a stake dealt here could be opened by neither');
  }
  return { seats: said[0].seats, agreed: said.length, refused };
}

/**
 * THE ONE NUMBER A PAGE NEEDS BEFORE IT MAY STEP ITS CORE.
 *
 * `init(seedWord)` decides which of the 24 loading bays this player parks at
 * and the whole of the world after it, and the committee derives that word
 * from the entry and the round's randomness. A page that stepped its core with
 * any other word drove a different world from the one its own transcript is
 * replayed in - and published the inputs of one truck as the inputs of
 * another.
 *
 * So this is fetched and derived in one place, and the page has no second way
 * to get a seed.
 */
export async function worldSeedFor({ entry, round, nodes, fetcher = fetch } = {}) {
  if (!entry) throw new Error('there is no entry to seed a world for');
  const id = typeof round === 'string' ? round : toHex(round);
  const beacon = await fetchRandomness(id, nodes, { fetcher });
  return {
    seedWord: seedWordForEntry(entry, beacon.randomness),
    randomness: beacon.randomness,
    height: beacon.height,
    agreed: beacon.agreed,
  };
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
    // THE NODES THE URL NAMED, handed on rather than re-parsed. The page has to
    // ask all of them for the round's randomness - one answer is one party
    // naming the world this player drives - and a second parse of the query is
    // a second place for the list to be wrong.
    nodes: named.nodes,
    chain: {
      headers: named.chainFrom.map((u) => httpProvider(u.replace(/\/+$/, '') + '/headers', { tag: sourceKey(u) })),
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
 * IT IS A REAL KEY NOW, AND IT WAS NOT. This function used to store 32 random
 * bytes and hand the SAME bytes back as `player_pubkey` - an identifier that
 * looked like a key and was on no curve at all. Nothing signed under it, so
 * nothing caught it; what caught it was asking where a winner gets paid. A
 * payout is an output, an output pays to a key, and random bytes are not one.
 *
 * SO WHAT IS STORED IS THE SECRET and what is returned is its x-only point.
 * The player keeps the secret in their own tab and it is never sent anywhere -
 * which is the whole reason the field can be a payout destination.
 *
 * THE CURVE IS INJECTED, like `sign` and like the dealer's. This bundle
 * carries no crypto on purpose, and a page that cannot bring a curve gets a
 * REFUSAL rather than random bytes: seating a player at a money round under a
 * key nobody can spend from is worse than not seating them.
 */
export function tabIdentity({ storage, random, curve, key = 'blwp.player' } = {}) {
  if (!curve || typeof curve.pointX !== 'function')
    throw new Error('a player identity is a key on a curve, and none was injected');

  const held = storage && storage.getItem(key);
  let secret = held && /^[0-9a-f]{64}$/i.test(held) ? fromHex(held.toLowerCase()) : null;
  // A STORED VALUE THAT IS NOT A SCALAR IS NOT A KEY. Anything written by the
  // version that stored random bytes is read the same way - as a secret - and
  // replaced if it does not name a point.
  if (secret !== null && !isScalar(secret)) secret = null;

  if (secret === null) {
    for (let tries = 0; ; tries++) {
      secret = random(32);
      if (isScalar(secret)) break;
      if (tries > 8) throw new Error('this randomness never produced a scalar of the group');
    }
    if (storage) storage.setItem(key, toHex(secret));
  }
  return { secret, pubkey: curve.pointX(secret) };
}

/** Non-zero and below the group order, which is what a secret key has to be. */
const isScalar = (bytes) => {
  const v = scalarFrom32(bytes);
  return v > 0n && v < FIELD;
};

/**
 * The seat this page takes at a round it did not write.
 *
 * The amounts are the ROUND'S, not the page's: a stake it disagrees with is a
 * stake the node would refuse, and copying the number out of the contract is
 * the only way a page can be sure it is asking for the seat that exists.
 *
 * THE STAKE IS DEALT BY `stakeFor` NOW, and handed in. Without one this still
 * commits to nothing - `random(32)` and `NO_SHARES` - which is the M2 seat and
 * is still the honest thing for a round with no money behind it. What it must
 * never do is look computed when it is not, which is why it is named here.
 *
 * The world secret IS load-bearing already: it is the player's own, it seeds
 * their world, and a node that had it could predict the round they are about
 * to drive.
 */
export function entryFor(round, { playerPubkey, random, joinTick = 0, stake } = {}) {
  if (!round) throw new Error('there is no round to take a seat at');
  if (!playerPubkey || playerPubkey.length !== 32)
    throw new Error('a player is 32 bytes of key');
  if (stake && (!stake.stakeCommitment || !stake.vssSharesRef))
    throw new Error('that is not a dealt stake: it names no commitment or no shares');
  return {
    playerPubkey,
    stakeCommitment: stake ? stake.stakeCommitment : random(32),
    worldSecret: random(32),
    // 23.1's `vss_shares_ref`. With a dealt stake it names the handout the
    // committee accepted; without one it is 32 zero bytes, and the field is in
    // the signed bytes either way - so an entry that has shares and one that
    // has none can never be the same entry id.
    vssSharesRef: stake ? stake.vssSharesRef : NO_SHARES,
    stakeMsat: BigInt(round.stakeMsat || 0n),
    // THE NODE FEE, AND IT IS 2% OF THIS ENTRY'S OWN STAKE - taken OUT of it,
    // never on top (22A). The stake is the one number the wallet commits; the
    // hold is for what is left once the fee and the donation are out.
    //
    // This was `0n` on every entry the page ever built, and `feeMatchesEntry`
    // - the rule that says an entry's fee must be exactly `entryFeeMsat` of
    // its stake - had ZERO CALLERS outside its own tests, so nothing refused
    // one. Measured on the fixture stake: 2% of 100000 msat is 2000, and the
    // page wrote 0, so every paying entry it made DID NOT STAND. Too little
    // and the round collected less than the fee table will owe its nodes.
    //
    // A free round is 2% of nothing, which is nothing, so the same line is
    // right for both and there is no branch to get wrong.
    feeMsat: entryFeeMsat(BigInt(round.stakeMsat || 0n)),
    donationMsat: 0n,
    joinTick,
  };
}

/**
 * THE PAGE AS DEALER. 23.1 step 1 and 2, and the half letter 29 left named.
 *
 * The player chooses P, publishes `sha256(P)` as the stake commitment their
 * hold invoice is issued against, splits P 5-of-7 over the settlement
 * committee and seals one share to each seat. Nobody else ever sees P: the
 * page is where it is generated and the page is where it is forgotten.
 *
 * WHY THIS IS AN INPUT DEVICE AND NOT A SIMULATOR. Nothing here computes an
 * outcome, reads a truck, or decides what a run came to. It generates key
 * material and encodes it. The core stays where it is.
 *
 * THE CURVE IS INJECTED, exactly like `sign` and `verify`: this bundle carries
 * no crypto on purpose, because a vendored curve sitting in the page is an
 * implementation of the thing that pins money that nobody audits. The caller
 * hands in `pointFromScalar`, `combinePoints` and `ecdhShared`.
 *
 * P IS NOT REDUCED. About one preimage in 2^128 is not below the group order,
 * and the answer is another preimage rather than this one taken modulo n -
 * reducing would change the number the payment hash already commits to, and
 * the shares would then open something the Entry Contract does not name.
 */
export async function stakeFor(round, { seats, curve, random, playerPubkey, needed: asked } = {}) {
  if (!round || !round.id) throw new Error('a stake is dealt for a round, and that is not one');
  // AT THE ROUND'S THRESHOLD, the one the node's door takes and its settle
  // opens at (M3.3-26). The default was a flat 5 whatever the round, and any
  // other number is a stake the door refuses - so it is refused here first.
  if (round.settlementSlots === undefined)
    throw new Error('this round names no settlement slots, so no threshold to deal its stake at');
  const needed = sharesNeededFor(round);
  if (asked !== undefined && asked !== needed)
    throw new Error(`a stake dealt ${asked} of ${seats ? seats.length : 0} is refused: `
      + `this round's stakes open at ${needed} of ${round.settlementSlots}`);
  if (!Array.isArray(seats) || seats.length < needed)
    throw new Error(`a threshold of ${needed} cannot be dealt to ${seats ? seats.length : 0} seats`);
  if (!curve || typeof curve.ecdhShared !== 'function' || typeof curve.pointX !== 'function')
    throw new Error('dealing a stake needs a curve, and none was injected');
  if (!playerPubkey || playerPubkey.length !== 32)
    throw new Error('a stake is dealt by a player, and that is 32 bytes of key');

  let preimage = random(32);
  for (let tries = 0; scalarFrom32(preimage) >= FIELD; tries++) {
    if (tries > 8) throw new Error('this randomness never produced a scalar of the group');
    preimage = random(32);
  }

  const ephemeralSecret = random(32);
  const dealt = await dealHandout({
    preimage, seats, roundId: round.id, playerPubkey,
    ephemeralSecret, ephemeralPubkey: curve.pointX(ephemeralSecret),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(random(32)) % FIELD),
    needed, curve,
  });
  if (!dealt.ok) throw new Error(dealt.why);

  return {
    // WHAT THE PLAYER KEEPS. It never leaves this object, and the caller is
    // the page: a node that had it could settle alone, which is the whole
    // reason the shares exist.
    preimage,
    stakeCommitment: sha256(preimage),
    vssSharesRef: dealt.id,
    handout: dealt.handout,
    // Ready to POST to every seat, because a handout no seat accepted is a
    // reference the entry cannot name.
    body: encodeHandout(dealt.handout),
  };
}
