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
import { playerSecretFor, refundFingerprint } from '../../protocol/src/player-key.js';
import { coreIsKnownGood } from '../../protocol/src/known-core.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { readWithOneRetry } from './reread.js';
import { decodeClaimKeyAttestation, claimKeyIsAttested } from '../../protocol/src/claim-key.js';

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

  // THE FEDERATION A LOCK ROUND'S STAKE GOES INTO, as its invite code. The
  // round names only the federation's id; the invite says where its guardians
  // answer, and the lock client refuses one whose federation is not the round's.
  // Optional here: only a round whose stake is a lock needs it, and that is
  // refused later, by name, when it is missing.
  const federation = (q.get('federation') || '').trim().toLowerCase();
  // bech32m: the prefix `fed1`, the separator `1`, then the data (no `1` in it).
  if (federation && !/^fed11[02-9ac-hj-np-z]+$/.test(federation))
    throw new Error('that is not a federation invite code (fed1...): ' + federation.slice(0, 24));

  return { round, nodes, chainFrom, bond, advert, federation: federation || null };
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
      const r = await readWithOneRetry(fetcher, at);
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
      const r = await readWithOneRetry(fetcher, at);
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
 * DOES THIS ROUND'S STAKE GO INTO A FEDERATION LOCK? A paying round that names
 * its federation (§6 federation_id, §23.6). A hold-invoice round names none.
 */
export const roundLocks = (round) => roundPays(round) && round.custody === 'FEDERATION'
  && round.federationId instanceof Uint8Array && round.federationId.some((b) => b !== 0);

/** 1 type + 2 version + 32 round + 33 claim key + 32 seat, then a 64-byte signature. */
const ATTESTATION_BYTES = 100;

/**
 * THE CLAIM KEY A LOCK MAY NAME (v4.6.2 §23.1 step 0, F3): "The key is valid
 * only with signatures from >=5 seats; a client MUST refuse to lock to a key
 * without them. Otherwise one seat could serve its own key and, after the
 * shares are released, claim a loser's stake for itself."
 *
 * Every node the page holds is asked for its seat's signed (round_id,
 * claim_pk); the answers are grouped by key and counted by protocol
 * `claimKeyIsAttested` over the round's SETTLEMENT seats - the same list the
 * stake is dealt to - at the round's own threshold. A key short of it is
 * refused by name; the one that stands comes back with the attested set's id,
 * which the entry names as claim_key_attestation_ref.
 */
export async function attestedClaimKey({ round, seats, nodes, curve, fetcher = fetch } = {}) {
  if (!round || !(round.id instanceof Uint8Array)) throw new Error('there is no round id to ask a claim key for');
  if (!curve || typeof curve.verify !== 'function') throw new Error('checking a claim key needs the page\'s curve');
  const id = toHex(round.id);
  const byKey = new Map();
  const refused = [];
  for (const node of nodes || []) {
    try {
      const r = await readWithOneRetry(fetcher, node.replace(/\/+$/, '') + '/claim-key?round=' + id);
      if (!r.ok) { refused.push(`${node}: answered ${r.status} ${(await r.text()).trim()}`); continue; }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length !== ATTESTATION_BYTES + 64) { refused.push(`${node}: answered ${bytes.length} bytes, not one signed claim key`); continue; }
      const a = decodeClaimKeyAttestation(bytes.subarray(0, ATTESTATION_BYTES));
      if (toHex(a.roundId) !== id) { refused.push(`${node}: attested a claim key for another round`); continue; }
      const k = toHex(a.claimPk);
      if (!byKey.has(k)) byKey.set(k, { claimPk: a.claimPk, signatures: [] });
      byKey.get(k).signatures.push({ seatPubkey: a.seatPubkey, signature: bytes.subarray(ATTESTATION_BYTES) });
    } catch (e) { refused.push(`${node}: ${e.message}`); }
  }
  let best = null;
  for (const { claimPk, signatures } of byKey.values()) {
    const said = claimKeyIsAttested({ roundId: round.id, claimPk, signatures, seats,
      settlementSlots: round.settlementSlots, verify: (s, m, k) => curve.verify(s, m, k) });
    if (said.ok) return { ok: true, claimPk, ref: said.ref, attested: said.attested, needed: said.needed, refused };
    if (!best || (said.attested || 0) > (best.attested || 0)) best = said;
  }
  return {
    ok: false, refused, attested: best ? best.attested || 0 : 0,
    why: best ? `no claim key has this round's attestation: ${best.why}` : `no seat served a claim key for this round${refused.length ? ': ' + refused.join('; ') : ''}`,
  };
}

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
      const r = await readWithOneRetry(fetcher, base + '/identity');
      if (!r.ok) { per.push({ node, why: `identity answered ${r.status}` }); continue; }
      key = toHex(new Uint8Array(await r.arrayBuffer()));
    } catch (e) { per.push({ node, why: e.message }); continue; }
    if (!want.has(key) || answered.has(key)) continue;
    try {
      const r = await readWithOneRetry(fetcher, `${base}/stake?entry=${eid}`);
      answered.add(key);
      if (r.ok) { seen++; per.push({ node, key, seen: true }); }
      else per.push({ node, key, seen: false, why: (await r.text()).trim() });
    } catch (e) { per.push({ node, key, why: e.message }); }
  }
  const of = want.size;
  const needed = stakeSeenNeeded(contract);
  return { seen, of, needed, unanswered: of - answered.size, committed: seen >= needed, per };
}

/** The hold states a stake does not leave. */
export const SETTLEMENT_OVER = ['SETTLED', 'CANCELLED', 'EXPIRED', 'FREE', 'none'];

/**
 * WHERE THIS STAKE STANDS, asked of every settlement seat (MF item 14).
 *
 * Each seat answers `GET /settlement` for itself - its hold now, where the
 * run's result stands, when its objection window closes, the height its hold
 * refunds at - and the seats are found at the page's addresses the way
 * `stakeSeenBy` finds them, one answer per seat key. The answer is one word
 * per field:
 *
 *   hold          the seats' own word when they agree, HELD while any differs
 *   finality      SUSPENDED if any seat says so, FINAL when all do,
 *                 PROVISIONALLY_FINAL when any has a result, else null
 *   windowClosesAtMs  the LATEST seat's window end - nothing moves before it
 *   refundHeight  the lowest height any seat names
 *
 *   { of, answered, hold, finality, windowClosesAtMs, refundHeight, per }
 */
export async function settlementBy({ entryId, seats, nodes, fetcher = fetch } = {}) {
  const want = new Set((seats || []).map((k) => toHex(k)));
  const eid = typeof entryId === 'string' ? entryId : toHex(entryId);
  const answered = new Map();
  const per = [];
  for (const node of nodes || []) {
    const base = String(node).replace(/\/+$/, '');
    let key;
    try {
      const r = await readWithOneRetry(fetcher, base + '/identity');
      if (!r.ok) { per.push({ node, why: `identity answered ${r.status}` }); continue; }
      key = toHex(new Uint8Array(await r.arrayBuffer()));
    } catch (e) { per.push({ node, why: e.message }); continue; }
    if (!want.has(key) || answered.has(key)) continue;
    try {
      const r = await readWithOneRetry(fetcher, `${base}/settlement?entry=${eid}`);
      const body = await r.text();
      if (!r.ok) { per.push({ node, key, why: body.trim() }); continue; }
      const said = JSON.parse(body);
      answered.set(key, said);
      per.push({ node, key, ...said });
    } catch (e) { per.push({ node, key, why: e.message }); }
  }
  const all = [...answered.values()];
  const holds = new Set(all.map((a) => a.hold));
  const states = all.map((a) => a.finality);
  const ends = all.map((a) => a.windowClosesAtMs).filter((v) => v !== null && v !== undefined).map(Number);
  const refunds = all.map((a) => a.refundHeight).filter((v) => Number.isInteger(v));
  return {
    of: want.size,
    answered: answered.size,
    hold: !all.length ? null : (holds.size === 1 ? all[0].hold : 'HELD'),
    finality: states.includes('SUSPENDED') ? 'SUSPENDED'
      : (all.length && states.every((f) => f === 'FINAL')) ? 'FINAL'
        : states.some((f) => f === 'PROVISIONALLY_FINAL' || f === 'FINAL') ? 'PROVISIONALLY_FINAL' : null,
    windowClosesAtMs: ends.length ? Math.max(...ends) : null,
    refundHeight: refunds.length ? Math.min(...refunds) : null,
    per,
  };
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
      const r = await readWithOneRetry(fetcher, at);
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
    const r = await readWithOneRetry(fetcher, where, opts);
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
        const r = await readWithOneRetry(fetcher, named.advert);
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
    federation: named.federation,
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
//
// WHAT IS KEPT NOW IS THE SEED, NOT A KEY (§24, v4.6.2, F2). The tab used to
// keep one secret and hand its point out as `player_pubkey` for every round -
// a key the player never backed up and could not check, the same in every
// round, so every lock it made was linkable. A payout and a refund go to that
// key. The spec's rule: the key comes from a PLAYER SEED the player holds and
// backs up, fresh per round, with a fingerprint the player compares outside
// the page. So the tab keeps 32 bytes of seed, and `playerFor` makes each
// round's key from it by `protocol/src/player-key.js`.
//
// AND A SEED THE PLAYER ALREADY HOLDS COMES BACK IN. A seed this page minted is
// a seed this page knows: a lying page could mint one, show it as the backup,
// and seat the player under it, and the fingerprint would agree with itself.
// The check means something only for a seed that existed BEFORE this page -
// the player's backup, pasted in (`importSeed`). So: the tab's seed - imported
// or minted - if it has one; else a fresh one for this tab alone. Nothing goes
// in storage every tab shares, so two tabs that never imported stay two
// players; a returning session pastes the backup again.
const SEED_FROM = 'blwp.player.seed.from';
const HEX_SEED = /^[0-9a-f]{64}$/i;

export function tabSeed({ storage, random, key = 'blwp.player.seed' } = {}) {
  const held = storage && storage.getItem(key);
  if (held && HEX_SEED.test(held)) return fromHex(held.toLowerCase());
  const seed = random(32);
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('a player seed is 32 random bytes');
  if (storage) { storage.setItem(key, toHex(seed)); storage.setItem(SEED_FROM, 'minted'); }
  return seed;
}

/**
 * THE PLAYER'S OWN SEED, PASTED IN: from now on it is this tab's seed. 64 hex
 * digits, the form the page's backup and `refund-key.mjs` use.
 */
export function importSeed(text, { storage, key = 'blwp.player.seed' } = {}) {
  const hex = String(text == null ? '' : text).trim().toLowerCase();
  if (!HEX_SEED.test(hex))
    throw new Error('a player seed is 64 hex digits - the backup this page showed you, or your own');
  if (storage) { storage.setItem(key, hex); storage.setItem(SEED_FROM, 'imported'); }
  return fromHex(hex);
}

/** Whether this tab's seed is one the player brought ('imported') or the page made ('minted'). */
export const seedOrigin = ({ storage } = {}) =>
  (storage && storage.getItem(SEED_FROM) === 'imported' ? 'imported' : 'minted');

/** The 32-byte id of a round: its own when it carries one, else its contract's hash. */
const roundIdOf = (round) => (round.id instanceof Uint8Array && round.id.length === 32 ? round.id : roundId(round));

/**
 * THIS ROUND'S PLAYER, from the seed: the secret, the x-only key a payout and a
 * refund go to, and the fingerprint the page shows for the player to compare
 * outside it (`blwp-node/tools/refund-key.mjs <seed> <round id>`).
 */
export function playerFor(round, { seed, curve } = {}) {
  if (!round) throw new Error('there is no round to take a seat at');
  if (!curve || typeof curve.pointX !== 'function')
    throw new Error('a player identity is a key on a curve, and none was injected');
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new Error('a player key comes from the player\'s 32-byte seed, and none was given');
  const rid = roundIdOf(round);
  const secret = playerSecretFor(seed, rid);
  const pubkey = curve.pointX(secret);
  return { seed, roundId: rid, secret, pubkey, fingerprint: refundFingerprint(pubkey) };
}

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
export function entryFor(round, { seed, curve, playerPubkey, random, joinTick = 0, stake, claimKey, stakeLock } = {}) {
  if (!round) throw new Error('there is no round to take a seat at');
  // A PAYING ROUND ON AN UNKNOWN CORE IS REFUSED (§5): no override, no flag. A
  // free round risks nothing and is seated as before.
  if (roundPays(round)) { const core = coreIsKnownGood(round.simCoreHash); if (!core.ok) throw new Error(core.why); }
  // THE SEAT'S KEY IS THE SEED'S KEY FOR THIS ROUND, and nothing else (§24,
  // v4.6.2, F2). A payout and a refund go to it, so a page that seated a player
  // under any other key - a bug, or a host that lies - would send the money
  // where the player's own check (`refund-key.mjs`) cannot find it. So the key
  // is derived here, and a key or a dealt stake naming another is refused.
  const player = playerFor(round, { seed, curve });
  if (playerPubkey !== undefined && toHex(playerPubkey) !== toHex(player.pubkey))
    throw new Error('that player key is not the one this seed makes for this round: a payout or '
      + 'refund to it reaches a key the player cannot check');
  if (stake && stake.handout && toHex(stake.handout.playerPubkey) !== toHex(player.pubkey))
    throw new Error('that stake was dealt under another player key than this seed\'s for this round');
  if (stake && (!stake.stakeCommitment || !stake.vssSharesRef))
    throw new Error('that is not a dealt stake: it names no commitment or no shares');
  if (stake && stake.vssSharesRef.some((b) => b !== 0) && !stake.stakePoint)
    throw new Error('that stake publishes shares and names no stake point, so no seat could check them');
  // A LOCKING ROUND'S ENTRY NAMES THE ATTESTED CLAIM KEY (§23.1 step 0): with
  // no attestation the page refuses the seat - "a client MUST refuse to lock
  // to a key without them" - rather than name a key nobody vouched for.
  if (roundLocks(round) && !(claimKey && claimKey.ref instanceof Uint8Array && claimKey.ref.some((b) => b !== 0)))
    throw new Error('this round\'s stake goes into a federation lock, and no claim key has its seats\' '
      + 'attestation: a client must refuse to lock to a key without it (23.1 step 0)');
  // AND IT NAMES THE LOCK ITSELF (§7 stake_lock_outpoint, W1b). The page used to
  // write zeros here for every round, so a lock round's seat named no lock and
  // the seat could only refuse it. A lock round's entry is not built without a
  // real outpoint, and a round that locks nothing is not handed one.
  if (roundLocks(round) && !(stakeLock && stakeLock.outpoint && stakeLock.outpoint.txid instanceof Uint8Array
    && stakeLock.outpoint.txid.length === 32 && stakeLock.outpoint.txid.some((b) => b !== 0)))
    throw new Error('this round\'s stake goes into a federation lock, and no lock was made: an entry naming '
      + 'no stake lock outpoint is one no seat can commit (23.1 step 5)');
  if (!roundLocks(round) && stakeLock)
    throw new Error('this round names no federation, so there is no lock for its entry to name');
  if (stakeLock && stake && stake.stakePoint && !(stakeLock.fields && stakeLock.fields.paymentImage
    && toHex(stakeLock.fields.paymentImage.bytes) === toHex(stake.stakePoint)))
    throw new Error('that lock is not to this stake\'s point, so it is not this entry\'s lock');
  return {
    playerPubkey: player.pubkey,
    stakeCommitment: stake ? stake.stakeCommitment : random(32),
    worldSecret: random(32),
    // 23.1's `vss_shares_ref`. With a dealt stake it names the handout the
    // committee accepted; without one it is 32 zero bytes, and the field is in
    // the signed bytes either way - so an entry that has shares and one that
    // has none can never be the same entry id.
    vssSharesRef: stake ? stake.vssSharesRef : NO_SHARES,
    // §7's stake-lock fields (v4.6.2). A dealt stake names its point - the
    // handout's A0, which every seat checks the shares against (F1). A lock
    // round's entry names its lock's outpoint (W1b); the fee lock is not made
    // yet (parked), so it and a non-locking round's outpoint are zeros, said
    // here rather than defaulted.
    stakePoint: stake && stake.stakePoint ? stake.stakePoint : new Uint8Array(33),
    feePreimage: new Uint8Array(32),
    stakeLockOutpoint: stakeLock ? { txid: stakeLock.outpoint.txid, outIdx: BigInt(stakeLock.outpoint.outIdx) }
      : { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: roundLocks(round) ? claimKey.ref : new Uint8Array(32),
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
  // NO STAKE ON A CORE THIS CLIENT DOES NOT KNOW (§5). Refused before anything
  // is dealt, so a backdoored round gets no handout, no hold and no seat.
  { const core = coreIsKnownGood(round.simCoreHash); if (!core.ok) throw new Error(core.why); }
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
    // §23.1 step 1 (v4.6.2): P.G, which IS the handout's constant commitment
    // A0 - so every seat can check the shares open to this stake (F1).
    stakePoint: dealt.handout.commitments[0],
    handout: dealt.handout,
    // Ready to POST to every seat, because a handout no seat accepted is a
    // reference the entry cannot name.
    body: encodeHandout(dealt.handout),
  };
}
