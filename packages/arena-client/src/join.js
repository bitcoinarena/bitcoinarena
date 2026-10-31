// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND A PAGE WAS SENT TO, NAMED IN ITS OWN URL.
//
// The page has always refused to invent a round: `ARENA_ROUND` is undefined in
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
import { decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { takesAnyFederation, FRONTEND_FEE_VERSION, ITEMS_VERSION } from '../../arena-protocol/src/constants.js';
import { OBJECTION_WINDOW_MS } from '../../arena-protocol/src/window.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { httpProvider, headerSources, HEADER_SOURCES_ASKED } from './headers.js';
export { headerSources, HEADER_SOURCES_ASKED };
import { seedHexFromInput } from './bip39.js';
import { NO_SHARES, dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { worldSeedWord, worldIsShared, worldSlot, slotOfEntryId, WORLD_SLOTS } from '../../arena-protocol/src/seed.js';
import { playerSecretFor, refundFingerprint } from '../../arena-protocol/src/player-key.js';
import { gameIsKnownGood, sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { entryFeeMsat, feeMatchesEntry, NODE_FEE_BPS } from '../../arena-protocol/src/fee.js';
import { feeOfKnownGame } from '../../arena-protocol/src/known-game.js';
import { paysReserves, RESERVES_NODE_FEE_BPS } from '../../arena-protocol/src/reserves.js';
import { roundSplitBps } from '../../arena-protocol/src/fee-proposal.js';

/**
 * THE ENTRY FEE A ROUND CHARGES, as this page knows it: the rate the page set on the round (an unpinned market the
 * player confirmed - its manifest's), else the pinned game's, else the network's 5 %. A MARKET'S IS ITS NODE FEE AND ITS
 * DONATION TOGETHER (1 % by default): both sit in its fee lock and are due only when it resolves (2026-10-09).
 */
const knownEntryBps = (gameId) => { const k = feeOfKnownGame(gameId); return k ? k.nodeBps + (k.donationBps ?? 0) : NODE_FEE_BPS; };
// A VERSION-11 GAME ROUND'S NODES TAKE 4 % (§27A.9.1); a market keeps its own (its fee lock holds its donation too)
const knownIsMarket = (gameId) => { const k = feeOfKnownGame(gameId); return !!(k && k.donationBps !== undefined && k.donationBps !== null); };
export const roundPaysReserves = (round) => !!round && paysReserves(round) && !knownIsMarket(round.gameId);
// `round.feeSet`: the fees in force at the round's census height, as the page read them from the nodes (GET /fees?height=)
export const feeBpsForRound = (round) => (round && Number.isInteger(round.feeBps) ? round.feeBps
  : roundPaysReserves(round) ? (round.feeSet ? roundSplitBps(round.feeSet).nodes : RESERVES_NODE_FEE_BPS) : knownEntryBps(round && round.gameId));
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { readWithOneRetry } from './reread.js';
import { decodeClaimKeyAttestation, claimKeyIsAttested } from '../../arena-protocol/src/claim-key.js';

/**
 * HOW MANY SHARES OPEN THIS ROUND'S STAKES - the round's number, not the
 * player's: 2 of 2, 5 of 7 (`receiptsNeeded` over the settlement slots). The
 * page deals at it, the node's door refuses any other, and the settle opens at
 * it (M3.3-26). The page used to deal `needed: settlementSlots` - 7 of 7 on
 * seven signer nodes, which the door now refuses - and to post at 5 on a 2-of-2.
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
/**
 * THE CORE A ROUND NAMES, as hex (path A, 2026-10-04: the page carries two cores and plays each round on its own). Read
 * here, not in the page, so the page still names no contract field: it asks which core, and joins.
 */
export const roundCoreHex = (round) => (round && round.simCoreHash instanceof Uint8Array && round.simCoreHash.length === 32
  ? toHex(round.simCoreHash) : '');

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
/**
 * A ROUND'S CONTRACT IS READ ONCE (2026-10-16: "Lower the amount of concurrent connections and network load";
 * measured on live UI 158, one run, 60 s window: GET /round 208). The id is the contract's own hash, so a contract that matched its
 * id and passed the checks below is the round for good; kept per id, at most ROUNDS_KEPT_MAX, the oldest dropped first.
 */
export const ROUNDS_KEPT_MAX = 2000;
const ROUNDS_KEPT = new Map();
export const forgetRounds = () => ROUNDS_KEPT.clear();
export async function fetchRound(id, nodes, { fetcher = fetch } = {}) {
  const kept = ROUNDS_KEPT.get(id);
  if (kept) return { contract: kept.contract, from: kept.from, refused: [], kept: true };
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
      // §13A, WINDOW-10-SPEC (RULED 2026-10-01): a round whose objection window is not exactly 600 000 ms is
      // invalid - the page lists it nowhere and joins it never, whatever a node answers.
      if (contract.objectionWindowMs !== OBJECTION_WINDOW_MS)
        throw new Error(`round ${id} names an objection window of ${contract.objectionWindowMs} ms, not ${OBJECTION_WINDOW_MS}: that contract is invalid and the page does not join it`);
      ROUNDS_KEPT.set(id, { contract, from: node });
      if (ROUNDS_KEPT.size > ROUNDS_KEPT_MAX) ROUNDS_KEPT.delete(ROUNDS_KEPT.keys().next().value);
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
// A ROUND'S RANDOMNESS, ONCE AGREED, IS KEPT FOR THE PAGE (2026-10-02, the join's 2-3 s): the beacon of a round never
// changes, and the session asked all its nodes again after the page had - kept per round and node list, the promise
// itself, so a second asker shares the first's reads; a refusal is not kept.
const RANDOMNESS = new Map();
export async function fetchRandomness(id, nodes, { fetcher = fetch } = {}) {
  if (!Array.isArray(nodes) || !nodes.length)
    throw new Error('no node to ask for this round\'s randomness');
  const key = id + '|' + nodes.join(',');
  if (fetcher === fetch && RANDOMNESS.has(key)) return RANDOMNESS.get(key);
  const asked = readRandomness(id, nodes, fetcher);
  if (fetcher === fetch) { RANDOMNESS.set(key, asked); asked.catch(() => RANDOMNESS.delete(key)); }
  return asked;
}

async function readRandomness(id, nodes, fetcher) {
  // EVERY NODE AT ONCE (measured 2026-10-03 00:03Z: asked one after another, 'session opening' to 'world seed from 7
  // nodes' took 1.5 s of a paid join); the answers are still read in the nodes' order, and all must agree as before.
  const reads = await Promise.all(nodes.map(async (node) => {
    const at = node.replace(/\/+$/, '') + '/randomness?round=' + id;
    try {
      const r = await readWithOneRetry(fetcher, at);
      if (!r.ok) return { node, refused: `${node}: answered ${r.status} ${(await r.text()).trim()}` };
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length !== 32) return { node, refused: `${node}: answered ${bytes.length} bytes` };
      return { node, hash: bytes, height: Number(r.headers.get('x-height') || 0) };
    } catch (e) {
      return { node, refused: `${node}: ${e.message}` };
    }
  }));
  const said = reads.filter((x) => x.hash);
  const refused = reads.filter((x) => x.refused).map((x) => x.refused);
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
 * A HANDOUT FEWER THAN `needed` SIGNER NODES HOLD IS A STAKE NOBODY CAN OPEN.
 * Reconstruction takes five of seven; a page that dealt to seven, reached
 * three and joined anyway would put a player at a paying round whose stake can
 * never be settled - and every signer node that did not store it REFUSES the entry,
 * so most of the committee has no record of that player at all.
 *
 * Measured before this existed, with three of seven reachable:
 *
 *   settlement signer nodes holding the handout   3 of 7
 *   the threshold to open it               5
 *   reconstructable                        false
 *   the node the page joined               201, joined
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
// `out`: given, `out.posted` (each seat's own post) is set before the first answer - a market order hands its entries after them without
// waiting for this answer
export async function postHandout(stake, nodes, { fetcher = fetch, needed: asked, graceMs = 300, waitMs = 20000, out = null } = {}) {
  if (!stake || !stake.body) throw new Error('there is no dealt stake to publish');
  // THE SIGNER NODES THAT MUST HOLD IT are the threshold it was dealt at - which
  // `stakeFor` makes the round's. The default was a flat 5 (M3.3-26).
  const needed = asked ?? stake.handout?.needed;
  if (!Number.isInteger(needed) || needed < 1)
    throw new Error('this stake does not say how many signer nodes open it');
  if (!Array.isArray(nodes) || !nodes.length)
    throw new Error('no node to publish this handout to');
  // EVERY NODE AT ONCE (2026-10-02, the join's 2-3 s): posted one after another, the handout was ~0.8 s of a funded
  // paid join before its lock (0.0.2476). Read in the nodes' order.
  // NOT THE SLOWEST SEAT'S TIME (playtest 2026-10-23 ~21:05Z, "First order is always slow second is <1s"; measured on UI 343: 11.3 s and
  // 22.9 s between the deposit and the lock, all 14 seats waited for while a busy one answered late): answered once `needed` seats took it
  // and every seat answered or `graceMs` passed after that; the others' answers come in the background (`rest`). A seat that never answers
  // is a seat that refused, after `waitMs`.
  const answers = nodes.map((node) => ({ node, why: `${node}: not answered yet` }));
  const posts = nodes.map(async (node, i) => {
    const at = node.replace(/\/+$/, '') + '/handout';
    try {
      const r = await fetcher(at, { method: 'POST', body: stake.body, signal: AbortSignal.timeout(waitMs) });
      answers[i] = r.ok ? { node, ok: true } : { node, why: `${node}: ${(await r.text()).trim()}` };
    } catch (e) {
      answers[i] = { node, why: `${node}: ${e.message}` };
    }
  });
  const rest = Promise.all(posts).then(() => answers.slice());
  const posted = new Map(nodes.map((node, i) => [node, posts[i]]));   // each seat's own post: its entry goes after it
  if (out) out.posted = posted;
  await new Promise((res) => {
    let left = posts.length, grace = null;
    const done = () => { clearTimeout(grace); res(); };
    for (const p of posts) p.then(() => {
      if (--left === 0) return done();
      if (!grace && answers.filter((a) => a.ok).length >= needed) grace = setTimeout(done, graceMs);
    });
  });
  const accepted = answers.filter((a) => a.ok).map((a) => a.node);
  const refused = answers.filter((a) => !a.ok).map((a) => a.why);
  if (accepted.length < needed)
    return {
      ok: false, accepted: accepted.length, needed, refused, rest, posted,
      why: `${accepted.length} of the ${needed} signer nodes needed to open this stake took the `
        + 'handout, so it could never be settled',
    };
  return { ok: true, accepted: accepted.length, needed, refused, rest, posted };
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
 * WHAT THIS ENTRY STAKES: an order in a paid market round brings its own amount - the page sets it on its
 * round object as `orderStakeMsat`, beside the contract's fields, so the round's id and bytes are untouched - and every
 * other entry stakes the round's stake_msat.
 */
export const stakeOf = (round) => (round && round.orderStakeMsat !== undefined && round.orderStakeMsat !== null
  ? BigInt(round.orderStakeMsat) : BigInt((round && round.stakeMsat) || 0n));

/**
 * DOES THIS ROUND'S STAKE GO INTO A FEDERATION LOCK? A paying round that names a
 * non-zero federation_id (§6, §23.6).
 */
export const roundLocks = (round) => roundPays(round)
  && round.federationId instanceof Uint8Array && (round.federationId.some((b) => b !== 0) || takesAnyFederation(round));

/**
 * A ROUND THAT TAKES ANY FEDERATION, RESOLVED TO THE ONE THIS PLAYER LOCKS IN (2026.0.3 step 7): the same round - its
 * id kept, since the id is its contract's and the contract names no federation - with `federationId` the chosen one, so the
 * wallet, the lock and the entry below need nothing else; `anyFederation` tells entryFor to name it on the entry. Any other
 * round is answered as it is.
 */
export function inFederation(round, federationId) {
  if (!round || !takesAnyFederation(round)) return round;
  const fid = typeof federationId === 'string' ? fromHex(federationId) : federationId;
  if (!(fid instanceof Uint8Array) || fid.length !== 32 || fid.every((b) => b === 0)) throw new Error('a round that takes any federation is locked in a named one');
  return { ...round, id: round.id instanceof Uint8Array && round.id.length === 32 ? round.id : roundId(round), federationId: fid, anyFederation: true };
}

/** 1 type + 2 version + 32 round + 33 claim key + 32 signer node, then a 64-byte signature. */
const ATTESTATION_BYTES = 100;

/**
 * THE CLAIM KEY A LOCK MAY NAME (v4.6.2 §23.1 step 0, F3): "The key is valid
 * only with signatures from >=5 signer nodes; a client MUST refuse to lock to a key
 * without them. Otherwise one signer node could serve its own key and, after the
 * shares are released, claim a loser's stake for itself."
 *
 * Every node the page holds is asked for its signer node's signed (round_id,
 * claim_pk); the answers are grouped by key and counted by protocol
 * `claimKeyIsAttested` over the round's SETTLEMENT signer nodes - the same list the
 * stake is dealt to - at the round's own threshold. A key short of it is
 * refused by name; the one that stands comes back with the attested set's id,
 * which the entry names as claim_key_attestation_ref.
 */
export async function attestedClaimKey({ round, signerNodes, nodes, curve, fetcher = fetch, timeoutMs = 30000 } = {}) {
  if (!round || !(round.id instanceof Uint8Array)) throw new Error('there is no round id to ask a claim key for');
  if (!curve || typeof curve.verify !== 'function') throw new Error('checking a claim key needs the page\'s curve');
  const id = toHex(round.id);
  const byKey = new Map();
  const refused = [];
  // EVERY NODE AT ONCE (measured 2026-10-14 03:26Z on testnet4): asked one after another, the 14 seats a v2 round
  // draws from took 27 s here - a round whose key all 7 signer nodes had attested since 03:24Z - and a market order's 60 s
  // expiry and an 8 s RPS table both ran out before the pick. Read together, kept in the nodes' order as before.
  // AND DONE ONCE ENOUGH HAVE ATTESTED (kanban #606, measured 2026-10-24 06:36Z: a market bot's first order of a window waited 44 s
  // here - every seat was waited for, one of them slow, though the signer nodes' attestations had stood seconds in): each answer is
  // taken as it comes, and the key is answered the moment its attestation stands; the slower seats are not waited for.
  // `timeoutMs`: a seat that has not answered by then is counted as refusing.
  const take = ({ refused: why, bytes, node }) => {
    if (why) { refused.push(why); return null; }
    try {
      if (bytes.length !== ATTESTATION_BYTES + 64) { refused.push(`${node}: answered ${bytes.length} bytes, not one signed claim key`); return null; }
      const a = decodeClaimKeyAttestation(bytes.subarray(0, ATTESTATION_BYTES));
      if (toHex(a.roundId) !== id) { refused.push(`${node}: attested a claim key for another round`); return null; }
      const k = toHex(a.claimPk);
      if (!byKey.has(k)) byKey.set(k, { claimPk: a.claimPk, signatures: [] });
      byKey.get(k).signatures.push({ signerNodePubkey: a.signerNodePubkey, signature: bytes.subarray(ATTESTATION_BYTES) });
      return k;
    } catch (e) { refused.push(`${node}: ${e.message}`); return null; }
  };
  const judge = (k) => {
    const { claimPk, signatures } = byKey.get(k);
    return { claimPk, said: claimKeyIsAttested({ roundId: round.id, claimPk, signatures, signerNodes,
      settlementSlots: round.settlementSlots, verify: (s, m, kk) => curve.verify(s, m, kk) }) };
  };
  const early = await new Promise((resolve) => {
    let left = (nodes || []).length;
    if (!left) { resolve(null); return; }
    for (const node of nodes) {
      (async () => {
        try {
          const r = await readWithOneRetry(fetcher, node.replace(/\/+$/, '') + '/claim-key?round=' + id, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined);
          if (!r.ok) return { refused: `${node}: answered ${r.status} ${(await r.text()).trim()}` };
          return { bytes: new Uint8Array(await r.arrayBuffer()), node };
        } catch (e) { return { refused: `${node}: ${e.message}` }; }
      })().then((answer) => {
        const k = take(answer);
        if (k) { const j = judge(k); if (j.said.ok) resolve({ ok: true, claimPk: j.claimPk, ref: j.said.ref, attested: j.said.attested, needed: j.said.needed, refused }); }
        if (--left === 0) resolve(null);
      });
    }
  });
  if (early) return early;
  let best = null;
  for (const k of byKey.keys()) {
    const { said } = judge(k);
    if (said.ok) { const { claimPk } = byKey.get(k); return { ok: true, claimPk, ref: said.ref, attested: said.attested, needed: said.needed, refused }; }
    if (!best || (said.attested || 0) > (best.attested || 0)) best = said;
  }
  return {
    ok: false, refused, attested: best ? best.attested || 0 : 0,
    why: best ? `no claim key has this round's attestation: ${best.why}` : `no signer node served a claim key for this round${refused.length ? ': ' + refused.join('; ') : ''}`,
  };
}

/**
 * HOW MANY SETTLEMENT NODES MUST HAVE SEEN A STAKE HELD (23.1 step 5): the
 * round's threshold, the one rule the door, the settle and the dealing read
 * (2 of 2, 5 of 7). It was its own copy - "2 on two slots, 5 otherwise" - and
 * counted a stake committed on committees the node has no threshold for.
 */
/**
 * THE ATTESTED CLAIM KEY, WAITED FOR - A LITTLE. The signer nodes make the round's
 * claim key themselves when they are assigned to it, and one of them can need a second
 * run: measured on a Daily 2-of-2 paying round, one signer node held the key 266 ms
 * after the round was up and the other at 1582 ms, and a page opened on the
 * link at once counted "1 of 2" and refused the signer node. So the page asks again,
 * every `everyMs`, for up to `waitMs`, and says each short count through
 * `onWait`. The rule is unchanged: nothing short of the round's threshold is
 * ever accepted, and at the end the last answer - a refusal - is returned.
 */
export async function awaitAttestedClaimKey(args, { waitMs = 30000, everyMs = 1000, onWait = () => {},
  ask = attestedClaimKey, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const until = now() + waitMs;
  for (;;) {
    const got = await ask(args);
    if (got.ok || now() + everyMs > until) return got;
    onWait(got);
    await sleep(everyMs);
  }
}

export function stakeSeenNeeded(contract) {
  return receiptsNeeded(contract?.settlementSlots ?? contract?.nodes?.length);
}

/**
 * HOW MANY OF THE ROUND'S SETTLEMENT SIGNER NODES HAVE SEEN THIS STAKE HELD.
 *
 * 23.1 step 5: "STAKE_COMMITTED is recorded once >=5 settlement nodes have seen
 * the held HTLC." Each node answers for itself (`GET /stake`, its own
 * Lightning). The signer nodes are KEYS (`fetchSettlementSignerNodes`) and the page holds
 * URLS, so each URL is asked who it is (`GET /identity`) and only a settlement
 * signer node's answer is counted, once per key. A signer node no URL answers for - down, or
 * never listed - is counted as NOT seen and named in `unanswered`.
 *
 *   { seen, of, needed, unanswered, committed, per }
 *
 * `committed` is a label for the page: it gates nothing. Each node still
 * refuses its own receipt until it has seen the stake.
 */
/**
 * WHO ANSWERS AT A URL, ASKED ONCE A FEW MINUTES (2026-10-16: "Lower the amount of concurrent connections and network
 * load"; measured on live UI 154: GET /identity 434 times in a 60 s window of one run - every settlement and stake look asked
 * every node who it is, each time). A node's key does not change behind its URL; a kept answer is used for IDENTITY_KEEP_MS,
 * and only an answer is kept - a node that failed is asked again the next time.
 */
export const IDENTITY_KEEP_MS = 300000;
const IDENTITIES = new Map();
export const forgetIdentities = () => IDENTITIES.clear();
export async function identityAt(fetcher, base, { now = Date.now() } = {}) {
  const kept = IDENTITIES.get(base);
  if (kept && now - kept.at < IDENTITY_KEEP_MS) return kept.key;
  const r = await readWithOneRetry(fetcher, base + '/identity');
  if (!r.ok) throw new Error(`identity answered ${r.status}`);
  const key = toHex(new Uint8Array(await r.arrayBuffer()));
  IDENTITIES.set(base, { key, at: now });
  return key;
}

export async function stakeSeenBy({ entryId, signerNodes, nodes, contract, fetcher = fetch } = {}) {
  const want = new Set((signerNodes || []).map((k) => toHex(k)));
  const eid = typeof entryId === 'string' ? entryId : toHex(entryId);
  const answered = new Set();
  const per = [];
  let seen = 0;
  for (const node of nodes || []) {
    const base = String(node).replace(/\/+$/, '');
    let key;
    try { key = await identityAt(fetcher, base); } catch (e) { per.push({ node, why: e.message }); continue; }
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

/**
 * IS THIS RUN DECIDED AT THE SIGNER NODES THAT ANSWERED? (rule (a), 2026-10-05): every answer FINAL or a
 * decided outcome (VOID, FORFEIT), or every answer says the stake is FREE. What ends the settlement watch now that no node
 * answers a hold (§23.6) - measured before, the watch ended on `hold` only and so never ended, polling every 5 s until the tab
 * closed.
 */
const DECIDED = ['FINAL', 'VOID', 'FORFEIT'];
export function settlementDecided(s) {
  const said = s && Array.isArray(s.per) ? s.per.filter((p) => p && p.key && ('finality' in p || 'stake' in p)) : [];
  if (!s || !s.answered || !said.length) return false;
  return said.every((p) => p.stake === 'FREE') || said.every((p) => DECIDED.includes(p.finality));
}

/**
 * WHERE THIS STAKE STANDS, asked of every settlement signer node (MF item 14).
 *
 * Each signer node answers `GET /settlement` for itself - whether it has seen the stake, where the
 * run's result stands, and when its objection window closes - and the signer nodes are found at the
 * page's addresses the way `stakeSeenBy` finds them, one answer per signer node key:
 *
 *   finality      SUSPENDED if any signer node says so, FINAL when all do,
 *                 PROVISIONALLY_FINAL when any has a result, else null
 *   windowClosesAtMs  the LATEST signer node's window end - nothing moves before it
 *
 *   { of, answered, finality, windowClosesAtMs, per }
 *
 * The hold's state, its amount, the pool, the owed row and the refund height used to be read here too.
 * All five were the withdrawn Lightning custody's hold invoice and its settle (§23.6, RULED 2026-09-22 22:59), and no
 * signer node reports them any more.
 */
export async function settlementBy({ entryId, signerNodes, nodes, fetcher = fetch } = {}) {
  const want = new Set((signerNodes || []).map((k) => toHex(k)));
  const eid = typeof entryId === 'string' ? entryId : toHex(entryId);
  const answered = new Map();
  const per = [];
  for (const node of nodes || []) {
    const base = String(node).replace(/\/+$/, '');
    let key;
    try { key = await identityAt(fetcher, base); } catch (e) { per.push({ node, why: e.message }); continue; }
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
  const states = all.map((a) => a.finality);
  const ends = all.map((a) => a.windowClosesAtMs).filter((v) => v !== null && v !== undefined).map(Number);
  return {
    of: want.size,
    answered: answered.size,
    finality: states.includes('SUSPENDED') ? 'SUSPENDED'
      : (all.length && states.every((f) => f === 'FINAL')) ? 'FINAL'
        : states.some((f) => f === 'PROVISIONALLY_FINAL' || f === 'FINAL') ? 'PROVISIONALLY_FINAL' : null,
    windowClosesAtMs: ends.length ? Math.max(...ends) : null,
    per,
  };
}

/**
 * WHO THE SETTLEMENT COMMITTEE IS, ASKED OF EVERY NODE THE ROUND NAMED.
 *
 * A STAKE IS DEALT TO THE SETTLEMENT SIGNER NODES AND TO NOBODY ELSE, and the list
 * the page already holds is the wrong one. Measured on nine bonded nodes with
 * seven game/verify slots and seven settlement slots:
 *
 *   /committee?role=game          7 signer nodes
 *   /committee?role=settlement    7 signer nodes
 *   contract.nodes (the union)    9      <- what `joinFromQuery` hands over
 *   in both committees            5
 *   settlement-only               2
 *
 * `Roster.signerNodesFor` says so in its own words - "a contract carries one flat
 * `nodes` list, so the assigned set is the union of the role committees" - so
 * dealing to it would seal nine shares for a seven-of-which-five scheme, two
 * of them to signer nodes that can never open one. A stake nobody can open at payout
 * is a stake that is lost, which is worse than one never dealt.
 *
 * ASKED OF EVERY NODE AND REFUSED ON DISAGREEMENT, exactly as the randomness
 * is: one node's answer about who may open a player's stake is one node
 * choosing who may open it.
 */
export async function fetchSettlementSignerNodes(id, nodes, { fetcher = fetch } = {}) {
  if (!Array.isArray(nodes) || !nodes.length)
    throw new Error('no node to ask which signer nodes settle this round');
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
      const signerNodes = [];
      for (let at2 = 0; at2 < bytes.length; at2 += 32) signerNodes.push(bytes.subarray(at2, at2 + 32));
      said.push({ node, signerNodes });
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
  const first = key(said[0].signerNodes);
  for (const s of said.slice(1)) {
    if (key(s.signerNodes) !== first)
      throw new Error(`${said[0].node} and ${s.node} name two different settlement `
        + 'committees, so a stake dealt here could be opened by neither');
  }
  return { signerNodes: said[0].signerNodes, agreed: said.length, refused };
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
export async function worldSeedFor({ entry, round, nodes, contract, fetcher = fetch } = {}) {
  if (!entry) throw new Error('there is no entry to seed a world for');
  const id = typeof round === 'string' ? round : toHex(round);
  const beacon = await fetchRandomness(id, nodes, { fetcher });
  return {
    // THE ONE FUNCTION (seed.js worldSeedWord): the round's contract chooses the rule - one world per round, or per player
    seedWord: worldSeedWord({ entry, roundRandomness: beacon.randomness, contract, roundId: fromHex(id), sharedWorld: sharedWorldOf(contract.gameId) }),
    // AND WHERE IN IT THIS PLAYER STARTS (kanban #828): a shared world's place, the one the signer nodes' replay takes
    slot: worldSlot({ entry, contract, sharedWorld: sharedWorldOf(contract.gameId) }),
    randomness: beacon.randomness,
    height: beacon.height,
    agreed: beacon.agreed,
  };
}

/**
 * THE PLACES OF A SHARED WORLD ALREADY TAKEN (kanban #828), off the entries the round's seats hold (GET /api/round-result, public,
 * and open before a round ends). Asked of every node at once and never for longer than `waitMs`: a seat that says nothing, or
 * says it late, only costs a place that may be shared. Join in seconds (ruling 2026-10-02): this is not a thing to wait for.
 */
export async function slotsTaken({ round, nodes, fetcher = fetch, waitMs = 700 } = {}) {
  const id = typeof round === 'string' ? round : toHex(round);
  const taken = new Set();
  const reads = (nodes || []).map(async (node) => {
    try {
      const r = await fetcher(node.replace(/\/+$/, '') + '/api/round-result?round=' + id);
      if (!r.ok) return;
      for (const p of (await r.json()).players || []) taken.add(slotOfEntryId(fromHex(p.entry)));
    } catch { /* that seat says nothing */ }
  });
  let timer;
  await Promise.race([Promise.all(reads), new Promise((go) => { timer = setTimeout(go, waitMs); })]);
  clearTimeout(timer);
  return taken;
}

/**
 * A SESSION KEY WHOSE ENTRY STARTS AT A PLACE NOBODY HOLDS (kanban #828). A hash gives two players the same place 1 time in
 * WORLD_SLOTS, and the session key is the one part of an entry nothing else depends on: it signs the run's marks and no lock
 * names it. So a shared-world entry draws its key again while the id it makes lands on a place listed as taken. `makeKey`
 * answers { raw, ... }; on a per-player round, with all places taken or with nothing listed: the first key, as before.
 * Two players joining in the same instant cannot see each other, and can still share a place then.
 */
export async function keyOnFreeSlot({ makeKey, entry, contract, nodes, fetcher = fetch, waitMs, tries = 64 } = {}) {
  let sharedWorld = null;
  try { sharedWorld = contract && entry && Array.isArray(nodes) && nodes.length ? sharedWorldOf(contract.gameId) : null; } catch { sharedWorld = null; }
  if (!sharedWorld || !worldIsShared(contract, sharedWorld)) return makeKey();
  const rid = roundId(contract);
  const taken = await slotsTaken({ round: rid, nodes, fetcher, ...(waitMs === undefined ? {} : { waitMs }) });
  const slotOf = (k) => worldSlot({ entry: { ...entry, roundId: rid, sessionPubkey: k.raw }, contract, sharedWorld });
  let key = await makeKey();
  for (let i = 1; i < tries && taken.size < WORLD_SLOTS && taken.has(slotOf(key)); i++) key = await makeKey();
  return key;
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
/**
 * THE BOND OF A SEAT ON THIS ROUND'S COMMITTEE (measured 2026-10-16 07:51Z on the hotfix page: "no proven endpoint: the
 * advertisement is for 2fca1090..., which is not on this round's committee"). daily.json names ONE bond - seat 1's - and a round's
 * committee is 7 of 14 seats, so about half the rounds could not be joined at all. The bond named first if its node is on the
 * committee, else the first of the round's seats whose own /bond names a committee member; the named one when none answers.
 */
export async function committeeBond(o = {}) {
  const found = await committeeBonds(o);
  return found.length ? found[0].where : o.bond;
}
/**
 * EVERY COMMITTEE SEAT'S BOND, WITH THE ANSWER ALREADY READ (measured 2026-10-16 11:20:47Z on preview UI 151 after
 * Unity's PLAY: the entry made, then "no proven endpoint: no bond: no provider proved that bond into the chain (provider 0: no
 * answer in 10000 ms)" two seconds before the round's start - one provider, and it read again the /bond this search had just
 * read). In the candidates' order, each { where, body }: the bond prover takes the body as it is, and the next seat when one
 * does not prove.
 */
export async function committeeBonds({ bond, nodes = [], committee = [], fetcher = fetch, timeoutMs = 8000, enough = Infinity } = {}) {
  const keys = new Set((committee || []).map((k) => toHex(k)));
  const candidates = [...new Set([bond, ...(nodes || []).map((n) => `${String(n).replace(/\/+$/, '')}/bond`)].filter(Boolean))];
  const whose = async (u) => {
    try {
      const r = await fetcher(u, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const o = await r.json();
      const a = o && typeof o.hex === 'string' ? advertInTransaction(fromHex(o.hex)) : null;
      return a && a.nodePubkey instanceof Uint8Array && keys.has(toHex(a.nodePubkey)) ? { where: u, body: o } : null;
    } catch { return null; }
  };
  // ANSWERED ONCE `enough` WERE FOUND (kanban #601: one seat that does not answer held every fresh read of a round 8 s), else when all answered
  const found = [];
  await new Promise((res) => {
    let left = candidates.length;
    if (!left) return res();
    for (const u of candidates) whose(u).then((x) => { if (x) found.push(x); if (--left === 0 || found.length >= enough) res(); });
  });
  return found.sort((a, b) => candidates.indexOf(a.where) - candidates.indexOf(b.where));
}
/** How many committee seats' bonds a join hands the bond prover, at most. */
export const COMMITTEE_BONDS_ASKED = 3;

export function bondProvider(where, { fetcher = fetch, body = null } = {}) {
  const get = async (ask, opts) => {
    // AN ANSWER ALREADY READ (committeeBonds) is taken as it is: the proof is checked against the chain all the same
    let o = body;
    if (!o) {
      const r = await readWithOneRetry(fetcher, where, opts);
      if (!r.ok) throw new Error(`the bond provider answered ${r.status}`);
      o = await r.json();
    }
    const proof = (x) => ({ transaction: fromHex(x.hex), branch: (x.merkle || []).map(fromHex), position: x.pos | 0 });
    // A CARRIED BOND: the ancestor bond, and beside it its re-affirmation and its advertisement update
    return {
      ...proof(o),
      ...(o.update && o.update.hex ? { update: proof(o.update) } : {}),
      ...(o.reaffirm && o.reaffirm.hex ? { reaffirm: proof(o.reaffirm) } : {}),
    };
  };
  // ITS SOURCE AS THE HEADER PROVIDERS NAME ONE (sourceKey): the seats behind one public host differ by path, and tagged by origin
  // alone two of them were "one server listed twice" (measured on preview UI 152: every join refused so)
  get.tag = sourceKey(where);
  return get;
}

/**
 * The three globals the jslib reads, resolved from a URL - or null.
 *
 * Null is the shipping default and it is not an error: a page nobody sent
 * anywhere is the single-player daily, which is what almost every visitor
 * opens. Only a URL that NAMES a round changes that.
 */
// READ ONCE PER ROUND, NOT PER ORDER (kanban #601, 2026-10-23: "601 target is below 300ms on web"; measured on UI 344: the press to the
// join's first step was 99-132 ms, the round, its advert and its committee's bonds read from the seats again for every order; on UI 345,
// 8 s whenever the kept answer had run out - committeeBonds waits 8 s for a seat that does not answer): a round's contract is its id's,
// so the answer is kept up to JOIN_KEPT_MS per query and read again behind it once it is JOIN_FRESH_MS old - a press never waits for that
// read; the lobby warms it while it shows the round. A failed read is not kept. Each caller gets its own copy of the top level (the page
// sets `federation` on it).
const JOIN_KEPT = new Map();
const JOIN_KEPT_MS = 900000;
const JOIN_FRESH_MS = 60000;
export async function joinFromQuery(search, { fetcher = fetch, kept = fetcher === fetch } = {}) {
  const named = joinQuery(search);
  if (!named) return null;
  if (!kept) return readJoin(named, fetcher);
  const key = JSON.stringify(named);
  const now = Date.now();
  for (const [k, v] of JOIN_KEPT) if (v.at + JOIN_KEPT_MS < now) JOIN_KEPT.delete(k);
  const read = () => {
    const k = { at: Date.now(), p: readJoin(named, fetcher) };
    k.p.then(() => { const was = JOIN_KEPT.get(key); if (!was || was.at <= k.at || !was.done) JOIN_KEPT.set(key, Object.assign(k, { done: true })); },
      () => { if (JOIN_KEPT.get(key) === k) JOIN_KEPT.delete(key); });
    return k;
  };
  let k = JOIN_KEPT.get(key);
  if (!k) { k = read(); JOIN_KEPT.set(key, k); }
  else if (k.done && now - k.at > JOIN_FRESH_MS && !k.refreshing) { k.refreshing = true; read(); }   // the kept answer serves; a new one behind it
  return { ...(await k.p) };
}
async function readJoin(named, fetcher) {

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
      headers: headerSources(named.chainFrom).map((u) => httpProvider(u.replace(/\/+$/, '') + '/headers', { tag: sourceKey(u) })),
      // EVERY COMMITTEE SEAT FOUND, UP TO COMMITTEE_BONDS_ASKED, each with the /bond it answered; the named bond when none did
      bonds: await (async () => {
        const found = await committeeBonds({ bond: named.bond, nodes: named.nodes, committee: contract.nodes, fetcher, enough: COMMITTEE_BONDS_ASKED });
        return found.length ? found.slice(0, COMMITTEE_BONDS_ASKED).map((b) => bondProvider(b.where, { fetcher, body: b.body }))
          : [bondProvider(named.bond, { fetcher })];
      })(),
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
 * dropped. `sessionStorage` is per tab, which is exactly the lifetime a signer node
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
 * REFUSAL rather than random bytes: joining a player at a money round under a
 * key nobody can spend from is worse than not joining them.
 */
//
// WHAT IS KEPT NOW IS THE SEED, NOT A KEY (§24, v4.6.2, F2). The tab used to
// keep one secret and hand its point out as `player_pubkey` for every round -
// a key the player never backed up and could not check, the same in every
// round, so every lock it made was linkable. A payout and a refund go to that
// key. The spec's rule: the key comes from a PLAYER SEED the player holds and
// backs up, fresh per round, with a fingerprint the player compares outside
// the page. So the tab keeps 32 bytes of seed, and `playerFor` makes each
// round's key from it by `arena-protocol/src/player-key.js`.
//
// AND A SEED THE PLAYER ALREADY HOLDS COMES BACK IN. A seed this page minted is
// a seed this page knows: a lying page could mint one, show it as the backup,
// and enters the player under it, and the fingerprint would agree with itself.
// The check means something only for a seed that existed BEFORE this page -
// the player's backup, pasted in (`importSeed`). So: the tab's seed - imported
// or minted - if it has one; else a fresh one for this tab alone. Nothing goes
// in storage every tab shares, so two tabs that never imported stay two
// players; a returning session pastes the backup again.
const SEED_FROM = 'arena.player.seed.from';
const HEX_SEED = /^[0-9a-f]{64}$/i;
/** Where the tab keeps its seed - read, never minted, by the donation notes a failed round link shows. */
export const TAB_SEED_KEY = 'arena.player.seed';

export function tabSeed({ storage, random, key = TAB_SEED_KEY } = {}) {
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
export function importSeed(text, { storage, key = 'arena.player.seed' } = {}) {
  const hex = String(text == null ? '' : text).trim().toLowerCase();
  if (!HEX_SEED.test(hex))
    throw new Error('a player seed is 64 hex digits - the backup this page showed you, or your own');
  if (storage) { storage.setItem(key, hex); storage.setItem(SEED_FROM, 'imported'); }
  return fromHex(hex);
}

/**
 * RESTORE THE SEED IN SETTINGS, OVERWRITING THE CURRENT ONE (2026-10-04 23:48; plan accepted
 * 2026-10-05). `text` is what the player typed - the 24 words or the 64 hex (seedHexFromInput). On success it REPLACES the
 * tab's one current seed (`session` 'arena.player.seed', origin 'imported') - never a second active seed - and keeps the
 * restored phrase in the browser's kept list (`kept` 'arena.seeds'); the OLD phrase stays in that list, inactive, since its
 * wallet and round records are keyed by it. The caller reloads. Refused before anything is written: a live run in this
 * tab; a wrong word (by name); a seed another open tab holds (its heartbeat 'arena.seed.held.<id>' under 12 s old - the
 * keeper's lock would otherwise drop it after the reload). Returns { ok, hex, from, previous } or { ok: false, why }.
 */
export function restoreSeed({ text, session, kept, now = Date.now(), liveRun = false } = {}) {
  if (liveRun) return { ok: false, why: 'leave the round first: the seed cannot change during a run' };
  const got = seedHexFromInput(text);
  if (!got.ok) return { ok: false, why: got.why };
  const hex = got.hex;
  const previous = session ? session.getItem(TAB_SEED_KEY) : null;
  if (kept) {
    let held = null;
    try { held = JSON.parse(kept.getItem('arena.seed.held.' + hex.slice(0, 16)) || 'null'); } catch { held = null; }
    const mine = session ? session.getItem('arena.tab.id') : null;
    if (held && held.tab !== mine && Number(now) - Number(held.at) <= 12000)
      return { ok: false, why: 'that seed is open in another tab: close it there first' };
  }
  if (session) { session.setItem(TAB_SEED_KEY, hex); session.setItem(SEED_FROM, 'imported'); }
  if (kept) {
    let list = [];
    try { list = JSON.parse(kept.getItem('arena.seeds') || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    if (!list.some((x) => x && x.hex === hex)) { list.push({ hex, from: 'imported', at: Number(now) }); kept.setItem('arena.seeds', JSON.stringify(list)); }
  }
  return { ok: true, hex, from: got.from, previous };
}

/** Whether this tab's seed is one the player brought ('imported') or the page made ('minted'). */
export const seedOrigin = ({ storage } = {}) =>
  (storage && storage.getItem(SEED_FROM) === 'imported' ? 'imported' : 'minted');

/** The 32-byte id of a round: its own when it carries one, else its contract's hash. */
const roundIdOf = (round) => (round.id instanceof Uint8Array && round.id.length === 32 ? round.id : roundId(round));

/**
 * THIS ROUND'S PLAYER, from the seed: the secret, the x-only key a payout and a
 * refund go to, and the fingerprint the page shows for the player to compare
 * outside it (`arena-node/tools/refund-key.mjs <seed> <round id>`).
 */
// `order`: an order this tab places in a market round - its own key, so its own lock, payout and return;
// 0 (a game's entry, a single pick) is the round's key as it always was
export function playerFor(round, { seed, curve, order = 0 } = {}) {
  if (!round) throw new Error('there is no round to join');
  if (!curve || typeof curve.pointX !== 'function')
    throw new Error('a player identity is a key on a curve, and none was injected');
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new Error('a player key comes from the player\'s 32-byte seed, and none was given');
  const rid = roundIdOf(round);
  const secret = playerSecretFor(seed, rid, order);
  const pubkey = curve.pointX(secret);
  return { seed, roundId: rid, secret, pubkey, fingerprint: refundFingerprint(pubkey), order };
}

/**
 * The signer node this page takes at a round it did not write.
 *
 * The amounts are the ROUND'S, not the page's: a stake it disagrees with is a
 * stake the node would refuse, and copying the number out of the contract is
 * the only way a page can be sure it is asking for the signer node that exists.
 *
 * THE STAKE IS DEALT BY `stakeFor` NOW, and handed in. Without one this still
 * commits to nothing - `random(32)` and `NO_SHARES` - which is the M2 signer node and
 * is still the honest thing for a round with no money behind it. What it must
 * never do is look computed when it is not, which is why it is named here.
 *
 * The world secret IS load-bearing already: it is the player's own, it seeds
 * their world, and a node that had it could predict the round they are about
 * to drive.
 */
/**
 * THE FEE LOCK A STAKE LOCK CARRIES, CHECKED (Pick b): its image H(F) of the F it
 * hands over and its amount the entry's own fee - or none. A fee lock that is not
 * that is refused here, so the page never names one a signer node would refuse.
 */
function feeLockOf(stakeLock, round) {
  const f = stakeLock && stakeLock.feeLock;
  if (!f) return null;
  if (!(f.preimage instanceof Uint8Array) || f.preimage.length !== 32 || f.preimage.every((b) => b === 0))
    throw new Error('that fee lock hands over no F, so it could never be claimed');
  if (!f.fields || !f.fields.paymentImage || f.fields.paymentImage.kind !== 'hash'
    || toHex(f.fields.paymentImage.bytes) !== toHex(sha256(f.preimage)))
    throw new Error('that fee lock is not locked to H(F) of the F it hands over');
  const want = entryFeeMsat(stakeOf(round), feeBpsForRound(round));
  if (f.fields.amountMsat !== want) throw new Error(`that fee lock holds ${f.fields.amountMsat} msat and the entry's fee is ${want}`);
  return f;
}

// `pick`: the outcome an entry into a market round backs (§0A.7a) - written only when given.
// `confirmedGames`: game ids (hex) of markets the player confirmed a second time on this page (§0A.6).
// `limitPrice` / `orderExpiryMs`: an ORDER on a market's book - the pick it backs at most this price of
// the scale (protocol order-book.js), until that time (0n: until the market closes); written only with a pick.
export function entryFor(round, { seed, curve, playerPubkey, random, joinTick = 0, stake, claimKey, stakeLock,
  donationMsat = 0n, pick = undefined, confirmedGames = null, limitPrice = undefined, orderExpiryMs = 0n, playerOrder = 0, operatorId = null, frontendPk = null, items = null,
  bot = false } = {}) {
  if (!round) throw new Error('there is no round to join');
  // THE PLAYER'S OWN DONATION (M3.2 6e, §22A), chosen on the page
  // (`chooseDonation`) and written here - never rewritten by anybody else. It
  // must leave the fee inside the stake, by the signer node's own rule, so the page
  // never builds an entry a signer node refuses. Before: this wrote 0n on every entry.
  if (typeof donationMsat !== 'bigint' || donationMsat < 0n)
    throw new Error('a donation is a BigInt millisatoshi amount, 0 or more');
  {
    const stakeMsat = stakeOf(round);
    const feeBps = feeBpsForRound(round);
    const fee = feeMatchesEntry({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat, feeBps), donationMsat }, { feeBps });
    if (!fee.ok) throw new Error(fee.why);
  }
  // A PAYING ROUND OF AN UNKNOWN GAME, OR ON A CORE ITS GAME DOES NOT LIST, IS REFUSED (§5, §0A.6): no override,
  // no flag. A free round risks nothing and is joined as before.
  if (roundPays(round)) { const core = gameIsKnownGood(round.gameId, round.simCoreHash, round.configHash, { networkId: round.networkId, confirmed: confirmedGames, protocolVersion: round.protocolVersion }); if (!core.ok) throw new Error(core.why); }
  // A PICK IS AN OUTCOME INDEX (§0A.7a): the seats check it against the game's outcomes; here only its shape
  if (pick !== undefined && pick !== null && (!Number.isInteger(pick) || pick < 0 || pick > 255)) throw new Error('a pick is an outcome index, 0 to 255');
  const order = limitPrice !== undefined && limitPrice !== null;
  if (order && (pick === undefined || pick === null)) throw new Error('an order backs an outcome: it needs a pick');
  if (order && (!Number.isInteger(limitPrice) || limitPrice < 1 || limitPrice > 0xffffffff)) throw new Error('a limit price is a whole number of the price scale, 1 or more');
  if (order && typeof orderExpiryMs !== 'bigint') throw new Error('an order\'s expiry is BigInt ms (0n: until the market closes)');
  // THE SIGNER NODE'S KEY IS THE SEED'S KEY FOR THIS ROUND, and nothing else (§24,
  // v4.6.2, F2). A payout and a refund go to it, so a page that joined a player
  // under any other key - a bug, or a host that lies - would send the money
  // where the player's own check (`refund-key.mjs`) cannot find it. So the key
  // is derived here, and a key or a dealt stake naming another is refused.
  // `playerOrder`: an order's own key - the seed's key for this round and that order number, checked the same way
  const player = playerFor(round, { seed, curve, order: playerOrder });
  if (playerPubkey !== undefined && toHex(playerPubkey) !== toHex(player.pubkey))
    throw new Error('that player key is not the one this seed makes for this round: a payout or '
      + 'refund to it reaches a key the player cannot check');
  if (stake && stake.handout && toHex(stake.handout.playerPubkey) !== toHex(player.pubkey))
    throw new Error('that stake was dealt under another player key than this seed\'s for this round');
  if (stake && (!stake.stakeCommitment || !stake.vssSharesRef))
    throw new Error('that is not a dealt stake: it names no commitment or no shares');
  if (stake && stake.vssSharesRef.some((b) => b !== 0) && !stake.stakePoint)
    throw new Error('that stake publishes shares and names no stake point, so no signer node could check them');
  // A PAYING ROUND LOCKS ITS STAKE, OR IT IS NO ROUND (§23.6, RULED 2026-09-24): one that takes a stake and names
  // no federation was the withdrawn hold invoice's, and no entry is built for it.
  if (roundPays(round) && !roundLocks(round))
    throw new Error('this round takes a stake and names no federation, so it is not a round of this network (§23.6)');
  // A LOCKING ROUND'S ENTRY NAMES THE ATTESTED CLAIM KEY (§23.1 step 0): with
  // no attestation the page refuses the signer node - "a client MUST refuse to lock
  // to a key without them" - rather than name a key nobody vouched for.
  if (roundLocks(round) && !(claimKey && claimKey.ref instanceof Uint8Array && claimKey.ref.some((b) => b !== 0)))
    throw new Error('this round\'s stake goes into a federation lock, and no claim key has its signer nodes\' '
      + 'attestation: a client must refuse to lock to a key without it (23.1 step 0)');
  // AND IT NAMES THE LOCK ITSELF (§7 stake_lock_outpoint, W1b). The page used to
  // write zeros here for every round, so a lock round's signer node named no lock and
  // the signer node could only refuse it. A lock round's entry is not built without a
  // real outpoint, and a round that locks nothing is not handed one.
  if (roundLocks(round) && !(stakeLock && stakeLock.outpoint && stakeLock.outpoint.txid instanceof Uint8Array
    && stakeLock.outpoint.txid.length === 32 && stakeLock.outpoint.txid.some((b) => b !== 0)))
    throw new Error('this round\'s stake goes into a federation lock, and no lock was made: an entry naming '
      + 'no stake lock outpoint is one no signer node can commit (23.1 step 5)');
  if (!roundLocks(round) && stakeLock)
    throw new Error('this round names no federation, so there is no lock for its entry to name');
  if (stakeLock && stake && stake.stakePoint && !(stakeLock.fields && stakeLock.fields.paymentImage
    && toHex(stakeLock.fields.paymentImage.bytes) === toHex(stake.stakePoint)))
    throw new Error('that lock is not to this stake\'s point, so it is not this entry\'s lock');
  return {
    playerPubkey: player.pubkey,
    stakeCommitment: stake ? stake.stakeCommitment : random(32),
    // NONE ON A SHARED-WORLD ROUND: 32 zero bytes, kept so the entry's encoding and id stay the same shape
    worldSecret: worldIsShared(round, sharedWorldOf(round.gameId)) ? new Uint8Array(32) : random(32),
    // 23.1's `vss_shares_ref`. With a dealt stake it names the handout the
    // committee accepted; without one it is 32 zero bytes, and the field is in
    // the signed bytes either way - so an entry that has shares and one that
    // has none can never be the same entry id.
    vssSharesRef: stake ? stake.vssSharesRef : NO_SHARES,
    // §7's stake-lock fields (v4.6.2). A dealt stake names its point - the
    // handout's A0, which every signer node checks the shares against (F1). A lock
    // round's entry names its lock's outpoint (W1b); the fee lock is not made
    // yet (parked), so it and a non-locking round's outpoint are zeros, said
    // here rather than defaulted.
    stakePoint: stake && stake.stakePoint ? stake.stakePoint : new Uint8Array(33),
    // AND ITS FEE LOCK, ONLY WHEN THE PAGE MADE ONE (Pick b: a fee lock is minted only when claiming it
    // can pay a signer node): F handed over openly (F5) and the lock's outpoint. Otherwise zeros, said
    // here - no fee lock, nothing to claim.
    //
    // THERE IS NO SECOND BRANCH. A paying round with no fee lock used to mint a random F anyway, because
    // "on Lightning custody that lock is its own hold invoice" and a hold on a zero preimage was refused.
    // That hold was the withdrawn Lightning custody's, which does not exist (§23.6, RULED 2026-09-22 22:59): the only fee lock
    // is the federation's, and a round that mints none has no fee secret to name.
    feePreimage: feeLockOf(stakeLock, round) ? stakeLock.feeLock.preimage : new Uint8Array(32),
    stakeLockOutpoint: stakeLock ? { txid: stakeLock.outpoint.txid, outIdx: BigInt(stakeLock.outpoint.outIdx) }
      : { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: feeLockOf(stakeLock, round)
      ? { txid: stakeLock.feeLock.outpoint.txid, outIdx: BigInt(stakeLock.feeLock.outpoint.outIdx) }
      : { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: roundLocks(round) ? claimKey.ref : new Uint8Array(32),
    // THE DONATION OUTPUTS THE LOCK TRANSACTION MADE (2026-10-03): named only when there are any
    ...(stakeLock && Array.isArray(stakeLock.donations) && stakeLock.donations.filter((d) => !d.reserve).length
      ? { donationOutpoints: stakeLock.donations.filter((d) => !d.reserve).map((d) => ({ txid: d.txid, outIdx: BigInt(d.outIdx) })) } : {}),
    // THE RESERVE LOCK (protocol 11, §27A.9.2): the output the lock transaction paid the federation's reserve key
    ...(stakeLock && Array.isArray(stakeLock.donations) && stakeLock.donations.some((d) => d.reserve)
      ? { reserveOutpoint: (({ txid, outIdx }) => ({ txid, outIdx: BigInt(outIdx) }))(stakeLock.donations.find((d) => d.reserve)) } : {}),
    // THE FEDERATION ITS LOCKS ARE IN, on a round that takes any (inFederation; contracts.js FEDERATION_MARKER)
    ...(round.anyFederation ? { federationId: round.federationId } : {}),
    // THE OPERATOR THIS PLAYER IS (§7 operator_id_declaration): only when the player declared one (a player who runs nodes)
    ...(operatorId instanceof Uint8Array && operatorId.length === 32 && operatorId.some((b) => b !== 0) ? { operatorId } : {}),
    // THE WEBSITE THAT BROUGHT THIS ENTRY (2026.0.9): the page's own payout key, paid 20% of the nodes' fee on this
    // stake out of the nodes' 5% - never more for the player. Only on a round of version 9 or later (a seat refuses it below), and
    // only a 33-byte compressed key
    ...(frontendPk instanceof Uint8Array && frontendPk.length === 33 && (frontendPk[0] === 2 || frontendPk[0] === 3)
      && Number(round.protocolVersion) >= FRONTEND_FEE_VERSION ? { frontendPk } : {}),
    // THE ITEMS IT PLAYS WITH (protocol 10): each with its owner's proof for this entry (item-buy.js entryItemsFor) -
    // only on a round of version 10 or later, and only when there are any, so every other entry keeps its bytes
    ...(Array.isArray(items) && items.length && Number(round.protocolVersion) >= ITEMS_VERSION ? { items } : {}),
    // THE PICK, ON A MARKET ROUND (§0A.7a): after every other field, so an entry without one keeps its bytes
    ...(pick !== undefined && pick !== null ? { pick } : {}),
    // AND THE ORDER, after the pick (protocol contracts.js ORDER_MARKER): its limit price and expiry
    ...(order ? { limitPrice, orderExpiryMs } : {}),
    // A BOT'S ENTRY (kanban #581: a market maker script, never a player): marked, so the leaderboard and its payouts leave it out
    ...(bot === true ? { bot: true } : {}),
    stakeMsat: stakeOf(round),
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
    feeMsat: entryFeeMsat(stakeOf(round), feeBpsForRound(round)),
    donationMsat,
    joinTick,
  };
}

/**
 * THE PAGE AS DEALER. 23.1 step 1 and 2, and the half letter 29 left named.
 *
 * The player chooses P, publishes `sha256(P)` as the stake commitment their
 * hold invoice is issued against, splits P 5-of-7 over the settlement
 * committee and seals one share to each signer node. Nobody else ever sees P: the
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
export async function stakeFor(round, { signerNodes, curve, random, playerPubkey, needed: asked, confirmedGames = null } = {}) {
  if (!round || !round.id) throw new Error('a stake is dealt for a round, and that is not one');
  // NO STAKE ON A CORE THIS CLIENT DOES NOT KNOW (§5). Refused before anything
  // is dealt, so a backdoored round gets no handout, no hold and no signer node.
  { const core = gameIsKnownGood(round.gameId, round.simCoreHash, round.configHash, { networkId: round.networkId, confirmed: confirmedGames, protocolVersion: round.protocolVersion }); if (!core.ok) throw new Error(core.why); }
  // AT THE ROUND'S THRESHOLD, the one the node's door takes and its settle
  // opens at (M3.3-26). The default was a flat 5 whatever the round, and any
  // other number is a stake the door refuses - so it is refused here first.
  if (round.settlementSlots === undefined)
    throw new Error('this round names no settlement slots, so no threshold to deal its stake at');
  const needed = sharesNeededFor(round);
  if (asked !== undefined && asked !== needed)
    throw new Error(`a stake dealt ${asked} of ${signerNodes ? signerNodes.length : 0} is refused: `
      + `this round's stakes open at ${needed} of ${round.settlementSlots}`);
  if (!Array.isArray(signerNodes) || signerNodes.length < needed)
    throw new Error(`a threshold of ${needed} cannot be dealt to ${signerNodes ? signerNodes.length : 0} signer nodes`);
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
    preimage, signerNodes, roundId: round.id, playerPubkey,
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
    // A0 - so every signer node can check the shares open to this stake (F1).
    stakePoint: dealt.handout.commitments[0],
    handout: dealt.handout,
    // Ready to POST to every signer node, because a handout no signer node accepted is a
    // reference the entry cannot name.
    body: encodeHandout(dealt.handout),
  };
}
