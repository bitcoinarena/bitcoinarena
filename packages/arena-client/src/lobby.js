// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOBBY, AS THE PAGE READS IT (M3.3-34, §25).
//
// "Find a round: link, QR, copied round_id, a lobby - carries nothing." So the
// page is handed the same names a join link carries - the nodes, where the bond
// and the headers are asked for, the signed advertisement - and NO round. It
// asks each named node which rounds it holds (GET /rounds), and every id it is
// told of is fetched and hashed exactly as a join link's is (`fetchRound`): a
// node that lists a round and answers with a different contract gets no row.
//
// WHAT A ROW SAYS COMES FROM THE CONTRACT, NOT FROM THE LISTING. Whether a round
// is free (no stake, no wallet, no Lightning) and whether its entry is open are
// read off the verified contract and this page's clock. The signer node counts are
// shown as what each node says.
//
// AND JOIN IS OFFERED AT THE ROUND'S THRESHOLD OF ITS OWN SIGNER NODES (2 of 2 here,
// 5 of 7 on mainnet). Every mark needs that many receipts, so a round only one
// signer node of a 2-of-2 holds is a round nobody can play. Each signer node signs its
// listing under its node key (lobby-listing.js); a row is joinable only when
// that many DISTINCT keys the verified contract names have signed "open,
// joined here", recently. One server cannot sign for two signer nodes.
//
// Joining is the join link: the same query with `round=` added. Nothing here
// signer nodes anybody, and nothing here mints a round.
//
// AND WHO IS JOINED, BY THE NAMES THEY CHOSE: each signer node serves the name records
// its joined players signed (lobby-name.js); a row carries the ones that check
// (identity.js `checkedNames`) - never a key in place of a name.
import { protocolVersionName } from '../../arena-protocol/src/protocol-version.js';
import { joinQuery, fetchRound, roundPays } from './join.js';
import { checkedNames } from './identity.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { entryOpenUntilMs } from './late-join.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { marketOf } from '../../arena-protocol/src/known-game.js';
import { KNOWN_GOOD_GAMES } from '../../arena-protocol/src/known-games.js';
import { entryWarnings } from './entry-warnings.js';
import { stakeWithinCeiling, isTestNetwork } from '../../arena-protocol/src/census-health.js';

/** How far a signer node's signed time may be from this page's clock and still count. */
export const LOBBY_SKEW_MS = 60000;

/**
 * HOW LONG A SIGNER NODE HAS TO ANSWER ONE LOBBY READ (2026-09-17: "never hang forever"). Measured before on the Daily with
 * one tunnel silent: the first /rounds failed after 125.1 s and the next node's took 60 s, while the page sat on
 * "Connecting …" for 185 s and then showed a closed round with PLAY enabled for 237 s. 10 s is the session's own limit for a
 * provider ("no answer in 10000 ms"), so the lobby and the run give up on a node at the same point.
 */
export const SIGNER_ANSWER_MS = 10000;
/** How long the lobby waits for the other seats once half of them answered. */
export const LOBBY_LAST_MS = 2500;

/**
 * `fetcher` with a limit: a read that has not answered in `ms` is refused with the words the lobby shows, and a real
 * fetch is aborted rather than left open. An injected fetcher that ignores the signal still loses the race.
 */
export function answerWithin(fetcher, ms = SIGNER_ANSWER_MS) {
  return (url, opts = {}) => {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (abort) abort.abort();
        reject(Object.assign(new Error(`did not answer in ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}`), { silent: true }));
      }, ms);
    });
    // THE WHOLE ANSWER WITHIN THE LIMIT, NOT ONLY ITS HEADERS (measured on testnet4 2026-10-16 ~18:45Z: federation
    // B's seats sent /rounds headers at once and the body over 19-45 s; the limit stopped at the headers, the lobby's first read
    // waited for every body, and Unity's lobby listed no round for over a minute). The body is read inside the race, and the
    // caller gets it already in hand.
    const asked = Promise.resolve().then(() => fetcher(url, abort ? { ...opts, signal: abort.signal } : opts)).then(async (r) => {
      if (!r || typeof r.arrayBuffer !== 'function' || typeof Response !== 'function') return r;
      const body = [101, 204, 205, 304].includes(r.status) ? null : await r.arrayBuffer();
      return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
    });
    return Promise.race([asked, late]).finally(() => clearTimeout(timer));
  };
}

/**
 * WHAT A LOBBY LINK NAMES, or null when this is not one: a link that names a
 * round is a join, and a link that names no node is the offline daily. Held to
 * the same rules as a join link (two chain sources, a bond, an advertisement).
 */
export function lobbyQuery(search) {
  const q = new URLSearchParams(
    typeof search === 'string' ? (search.startsWith('?') ? search.slice(1) : search) : search);
  if ((q.get('round') || '').trim()) return null;
  if (!(q.get('node') || '').trim()) return null;
  q.set('round', '0'.repeat(64));
  const named = joinQuery(q.toString());
  return { nodes: named.nodes, chainFrom: named.chainFrom, bond: named.bond, advert: named.advert,
    federation: named.federation };
}

/** The join link for one lobby row: this lobby's query with the round added. */
export function lobbyJoinSearch(search, id) {
  if (!/^[0-9a-f]{64}$/.test(String(id))) throw new Error('a lobby joins a round by its 32-byte id');
  const q = new URLSearchParams(
    typeof search === 'string' ? (search.startsWith('?') ? search.slice(1) : search) : search);
  q.set('round', id);
  return '?' + q.toString();
}

/**
 * THE DAILY'S LOBBY AT THE BARE ROOT: `daily.json`, deployed beside the page,
 * names what a lobby link names - the signer nodes, where the bond is asked for, the
 * signed advertisement - and nothing else. It becomes that link's query, held
 * to the same rules (`lobbyQuery`), so it trusts nothing a link would not; a
 * file that names a round, or fails a rule, is no lobby, and the root stays
 * the offline daily.
 * @returns {string|null} '?node=...&bond=...&advert=...' or null
 */
export function dailyLobbySearch(daily) {
  if (!daily || typeof daily !== 'object' || Array.isArray(daily)) return null;
  if ('round' in daily) return null;
  const nodes = Array.isArray(daily.node) ? daily.node.map(String) : [];
  // TWO NODES TO START FROM, NOT THE NETWORK (2026-10-13: "The client may not have a hard coded node list it must
  // be found on the fly"): daily.json names where a page starts - two, because a chain is read from two independent sources
  // (joinQuery) - and the page finds the rest in the census it checks
  if (nodes.length < 2 || typeof daily.bond !== 'string' || !/^[0-9a-f]{128}$/.test(String(daily.advert))) return null;
  const q = new URLSearchParams({ node: nodes.join(','), bond: daily.bond, advert: daily.advert });
  if (typeof daily.federation === 'string' && daily.federation) q.set('federation', daily.federation);
  // THE FUNDED GATEWAYS (2026-09-30 14:30): the gateways holding e-cash in the federation, the only ones a deposit
  // may go through (page-lock.js depositGateway). A string or a list; carried as one comma-separated `gateway`.
  const gws = (Array.isArray(daily.gateway) ? daily.gateway : typeof daily.gateway === 'string' ? daily.gateway.split(',') : [])
    .map((g) => String(g).trim()).filter((g) => /^https?:\/\//.test(g));
  if (gws.length) q.set('gateway', gws.join(','));
  const search = '?' + q.toString();
  try { return lobbyQuery(search) ? search : null; } catch { return null; }
}

/** Is this node's listing of this round its signer node's own signed word? */
function lobbySigned(verify, args) {
  const a = lobbySignedArgs(args);
  try { return !!a && !!verify(a.sig, a.msg, a.key); } catch { return false; }
}
/** What a listing's signature is checked with - { sig, msg, key } - or null for one that does not parse. */
function lobbySignedArgs({ id, nodeKey, nowMs, x }) {
  try {
    return { sig: fromHex(String(x.sig)), msg: lobbyListingId({ roundId: fromHex(id), nodePubkey: fromHex(nodeKey), nowMs: BigInt(nowMs),
      phase: x.phase, assignedHere: !!x.assignedHere, joined: Number(x.joined), playing: Number(x.playing) }), key: fromHex(nodeKey) };
  } catch { return null; }
}

/**
 * EVERY ROUND THE NAMED NODES HOLD, CHECKED, AND WHICH OF THEM ITS SIGNER NODES AGREE ON.
 *
 * `verify(sig, msg, key)` is BIP-340, injected like every curve in this bundle.
 * @returns {{ rows: object[], refused: string[] }} rows open before pending,
 *   soonest entry close first; a round past its entry close is not a row.
 */
const CONTRACTS = new Map();                     // round id hex -> its contract (the id is its hash)
// A ROUND WHOSE CONTRACT COULD NOT BE FETCHED OR READ IS NOT ASKED FOR AGAIN FOR UNREADABLE_MS (measured
// 2026-10-08: once the seats listed the Arena series' rounds - a layout this client does not read - the page asked every seat
// for each listed round's contract on every poll, 714 /round requests in 25 s, none of them ever kept). Round id -> when it failed.
const UNREADABLE = new Map();
export const UNREADABLE_MS = 30000;

/** How long after its entry closes a round the seats still list is named among the lobby's `closed`. */
export const CLOSED_KEPT_MS = 2n * 3600n * 1000n;

export async function fetchLobby({ nodes, fetcher = fetch, nowMs = Date.now(), verify, verifyMany = null, skewMs = LOBBY_SKEW_MS, answerMs = SIGNER_ANSWER_MS } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('a lobby asks the nodes it was named, and it was named none');
  if (typeof verify !== 'function') throw new Error('a lobby checks each signer node\'s signed listing, and no verify was injected');
  const refused = [];
  const unanswered = [];                                    // signer nodes that did not answer within answerMs
  const failed = [];                                        // signer nodes whose read failed outright: none answered = none reached
  const said = new Map();                                   // id -> [{ node, key, ... }]
  const ask = answerWithin(fetcher, answerMs);
  // EVERY NODE AT ONCE, each within its limit: asked one after another, one silent node held the next one's answer back
  // and a lobby of two cost two limits. Answers are read in the order the nodes were named.
  const unique = [...new Set(nodes)];
  // ONCE HALF HAVE ANSWERED, THE REST GET LOBBY_LAST_MS MORE (measured on testnet4 2026-10-16: seven seats answered in
  // 0.3-1.7 s and federation B's seven in 19-45 s, and the first lobby waited the full limit for them): the lobby is drawn from
  // the seats that answered; a late one is in the next read, a second later
  let settle = null; let answeredCount = 0;
  const settled = new Promise((resolve) => { settle = resolve; });
  const answers = await Promise.all(unique.map((node) => {
    // AT MOST 8 UPCOMING ROUNDS OF EACH SERIES (`next`): a node holding two series lists ~1150 rounds otherwise - 63 s,
    // past what the lobby waits for a node. A lobby shows one round per kind; eight leaves the lead's choice its room.
    const one = ask(`${String(node).replace(/\/+$/, '')}/rounds?next=${LOBBY_PER_SERIES}`).then((r) => ({ r }), (e) => ({ e }));
    one.then(() => { answeredCount += 1; if (answeredCount * 2 >= unique.length && unique.length > 2) setTimeout(settle, LOBBY_LAST_MS); });
    return Promise.race([one, settled.then(() => ({ e: Object.assign(new Error(`did not answer within ${LOBBY_LAST_MS} ms of half the seats`), { silent: true }) }))]);
  }));
  for (const [k, node] of unique.entries()) {
    try {
      const { r, e } = answers[k];
      if (e) throw e;
      if (!r.ok) { refused.push(`${node}: answered ${r.status}`); failed.push(String(node)); continue; }
      const body = await r.json();
      const nodeKey = String(body && body.node).toLowerCase();
      const at = Number(body && body.nowMs);
      for (const x of (body && Array.isArray(body.rounds)) ? body.rounds : []) {
        const id = String(x && x.id).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(id)) { refused.push(`${node}: listed something that is not a round id`); continue; }
        if (!said.has(id)) said.set(id, []);
        // THE SIGNATURE CHECKED WHEN IT IS FIRST ASKED, ONCE (kanban #573, playtest 2026-10-21: "the Rps game is lagging a bit on an iPhone
        // 16" - measured with its client open: 12,761 BIP-340 checks in 10 s, 3.7 s of the main thread on an M1 Max, one for every seat's
        // listing of every round on each paint, while only a round's own signer nodes count): `signed` is read only for a listing that
        // could count - fresh, from a signer node of that round, open and assigned there (c.counts below) - and kept
        let checked = null;
        const parses = /^[0-9a-f]{64}$/.test(nodeKey) && Number.isFinite(at);
        const signedNow = () => (checked === null ? (checked = parses && lobbySigned(verify, { id, nodeKey, nowMs: at, x })) : checked);
        said.get(id).push({ node, key: nodeKey, joined: Number(x.joined) || 0, playing: Number(x.playing) || 0,
          watching: Number(x.watching) || 0, free: !!x.free, phase: x.phase, assignedHere: !!x.assignedHere, ...(typeof x.played === 'boolean' ? { played: x.played } : {}),
          get signed() { return signedNow(); }, fresh: Number.isFinite(at) && Math.abs(at - nowMs) <= skewMs,
          // for verifyMany (below): what it is checked with, and its answer kept
          checkArgs: () => (parses ? lobbySignedArgs({ id, nodeKey, nowMs: at, x }) : null), setChecked: (ok) => { checked = !!ok; },
          names: Array.isArray(x.names) ? x.names : [],
          // THE GAME'S WARNINGS BEFORE ENTRY (§18A.7): the seat's word, only known codes kept (entry-warnings.js)
          warnings: Array.isArray(x.warnings) ? x.warnings.filter((k) => typeof k === 'string') : [],
          // RESERVE SEATS (§5A.7): the seat's word on who is seated - the join checks the certificate itself
          committee: x.committee && typeof x.committee === 'object' ? x.committee : null });
      }
    } catch (e) { refused.push(`${node}: ${e.message}`); failed.push(String(node)); if (e && e.silent) unanswered.push(String(node)); }
  }
  const rows = [], closed = [];
  // A ROUND'S CONTRACT FROM A NODE THAT ANSWERED FIRST, so a silent one costs its limit once per paint, not once per row.
  const answeredFirst = [...unique.filter((n) => !unanswered.includes(String(n))), ...unique.filter((n) => unanswered.includes(String(n)))];
  // KEPT BY ID, FETCHED 16 AT A TIME (2026-09-30, testnet4 series 3cfbe516: ~450 rounds listed, each contract
  // fetched one after another on every paint). A round's id is its contract's hash, so a kept contract cannot go stale.
  const wanted = [...said.keys()].filter((id) => !CONTRACTS.has(id) && !(nowMs - (UNREADABLE.get(id) ?? -Infinity) < UNREADABLE_MS));
  for (let i = 0; i < wanted.length; i += 16)
    await Promise.all(wanted.slice(i, i + 16).map((id) => fetchRound(id, answeredFirst, { fetcher: ask })
      .then(({ contract }) => { CONTRACTS.set(id, contract); UNREADABLE.delete(id); }, (e) => { UNREADABLE.set(id, nowMs); refused.push(`${id.slice(0, 16)}: ${e.message}`); })));
  // EVERY SIGNATURE THAT COULD COUNT, CHECKED IN ONE BATCH OFF THE PAGE'S THREAD (kanban #573): `verifyMany([{ sig, msg, key }])` answers
  // a promise of booleans (the page runs it in a worker); without it each listing is checked by `verify` when it is first asked, as before
  if (typeof verifyMany === 'function') {
    const todo = [];
    for (const [id, counts] of said) {
      const contract = CONTRACTS.get(id);
      if (!contract || BigInt(Math.floor(nowMs)) >= contract.entryCloseMs) continue;
      const signerNodes = new Set(contract.nodes.map((k) => toHex(k)));
      for (const c of counts) if (c.fresh && signerNodes.has(c.key) && c.phase === 'open' && c.assignedHere) { const a = c.checkArgs(); if (a) todo.push([c, a]); else c.setChecked(false); }
    }
    if (todo.length) {
      let ok = null;
      try { ok = await verifyMany(todo.map(([, a]) => a)); } catch { ok = null; }
      // a batch that did not answer leaves each listing to `verify`, as before
      if (Array.isArray(ok) && ok.length === todo.length) todo.forEach(([c], i) => c.setChecked(ok[i] === true));
    }
  }
  for (const [id, counts] of said) {
    const contract = CONTRACTS.get(id);
    if (!contract) continue;
    const now = BigInt(Math.floor(nowMs));
    // A ROUND WHOSE ENTRY HAS CLOSED takes no row - but one the seats still list, closed within the last 2 h, is named apart
    //: a player's orders in it are read back from its seats after a reload, and its result follows
    if (now >= contract.entryCloseMs) { if (now - contract.entryCloseMs < CLOSED_KEPT_MS) closed.push({ id, contract, entryCloseMs: Number(contract.entryCloseMs) }); continue; }
    const pays = roundPays(contract);
    // NO 2-OF-2 PAYING FEDERATION IS OFFERED (PRIORITIES item 5; 2026-09-27 10:04). One node is one guardian, so
    // a paying round's committee is its federation's guardians - seven, 5 of 7 - and two signer nodes cannot be that.
    // Such a round gets no row, however its nodes list it; it is named with the refusals. The free 2-of-2 stays.
    if (pays && contract.nodes.length === 2) {
      refused.push(`${id.slice(0, 16)}: a paying round on a 2-of-2 committee is not offered - a paying round's signer nodes are its federation's guardians, one node one guardian`);
      continue;
    }
    const phase = now < contract.committeeTimeMs ? 'pending' : 'open';
    // WHO COUNTS: a signer node of THIS round (its key in the verified contract), its
    // own signature, recent, saying open and assigned. Each key once.
    const signerNodes = new Set(contract.nodes.map((k) => toHex(k)));
    let needed;
    try { needed = receiptsNeeded(contract.gameVerifySlots); } catch { needed = contract.nodes.length; }
    const agreeing = new Set();
    for (const c of counts) {
      c.counts = !!(c.fresh && signerNodes.has(c.key) && c.phase === 'open' && c.assignedHere && c.signed);   // the signature last: it is the costly part
      if (c.counts) agreeing.add(c.key);
    }
    // THE SEATED (§5A.7): where the seats seat, the row lists who a certificate seats - and is not joined before one stands
    const seatingSaid = counts.map((c) => c.committee).filter((x) => x && x.seated);
    const seatedBy = seatingSaid.find((x) => x.seated.game && x.seated.settlement) || null;
    const seating = !seatingSaid.length ? null : seatedBy
      ? { state: 'named', game: seatedBy.game, settlement: seatedBy.settlement, drawn: seatedBy.drawnCount || null }
      : { state: seatingSaid.some((x) => x.equivocated) ? 'equivocated' : 'pending' };
    rows.push({
      id, phase,
      seating,
      free: !pays,
      wallet: pays ? 'federation-lock' : 'none',
      stakeMsat: contract.stakeMsat,
      committeeTimeMs: Number(contract.committeeTimeMs), startTimeMs: Number(contract.startTimeMs),
      // A LATE-JOIN ROUND IS OFFERED ONLY WHILE A JOIN STILL REACHES A SEAT BEFORE 45 s OF ITS RUN REMAIN: its
      // close here is start + 37 s less the join's time, not the bytes' start + 45 s - the row, its "closes in" and the pick.
      entryCloseMs: entryOpenUntilMs(contract),
      said: counts,
      signerNodesAgree: agreeing.size, needed, signerNodes: signerNodes.size,
      joinable: phase === 'open' && agreeing.size >= needed && (!seating || seating.state === 'named'),
      // A NODE THAT CALLED A PAYING ROUND FREE, OR THE REVERSE, IS NAMED: the row
      // says what the contract says, and the disagreement is shown beside it.
      disagrees: counts.filter((c) => c.free !== !pays).map((c) => c.node),
      names: checkedNames(counts.flatMap((c) => c.names), id, verify),
      // WHAT THE PLAYER IS WARNED OF BEFORE ENTRY (§18A.7 / §22A): a paying round's only
      warnings: pays ? entryWarnings(contract, counts.flatMap((c) => c.warnings || [])) : [],
      contract,
      // THE ROUND'S GAME, FROM ITS CONTRACT (checked against the round id above, so no node's word): one row per game and
      // kind; a market (§0A.7a) - pinned, or a round naming no core, which only a market does - is joined by its pick sheet
      game: contract.gameId instanceof Uint8Array ? toHex(contract.gameId) : '',
      // AND ITS NAME AND VERSION RANK (2026-10-16: "games show up as duplicates it's always the same round twice" -
      // nextblock v1's duty day and v3's grid start a round at the same instants, and the lobby kept one row per game ID)
      gameName: contract.gameId instanceof Uint8Array && KNOWN_GOOD_GAMES[toHex(contract.gameId)] ? KNOWN_GOOD_GAMES[toHex(contract.gameId)].name : '',
      gameRank: contract.gameId instanceof Uint8Array && KNOWN_GOOD_GAMES[toHex(contract.gameId)] ? Number(KNOWN_GOOD_GAMES[toHex(contract.gameId)].requiredProtocolVersion || 1) : 0,
      market: contract.gameId instanceof Uint8Array ? marketOf(contract.gameId) : null,
      // A ROUND OF A MARKET TEMPLATE ASKS ITS OWN QUESTION (feature 5): from the contract checked above, never a node's word
      event: contract.event || null,
      marketLike: contract.simCoreHash instanceof Uint8Array && contract.simCoreHash.every((b) => b === 0),
    });
  }
  rows.sort((x, y) => (x.phase === y.phase ? x.entryCloseMs - y.entryCloseMs : (x.phase === 'open' ? -1 : 1)));
  return { rows, closed, refused, unanswered, failed, asked: unique.length };
}

/**
 * ONE FREE ROUND AND ONE PAYING ROUND, NEVER TWO OF EITHER (2026-09-15 16:08: "ALWAYS
 * exactly ONE no-money FREE round and ONE paying 2-of-2"). The signer nodes hold more than one of a kind
 * for a while - a rollover opens the next round a minute before the last one's entry closes, and
 * a launcher restart opens a fresh pair beside the pair it left. Measured before: the Daily listed
 * 2 FREE and 2 PAID. Per kind this keeps one row: a joinable one over one that is not, an open one
 * over a pending one, then the one with the most entry left. Order is kept.
 */
// A SERIES ROUND CLOSES ITS ENTRY AT ITS START, and a paying join - the deposit, then the stake lock - takes minutes: the
// row shown is the soonest series round that still leaves this much.
// 3 MIN, NOT 20 (INSTANT-1527, 2026-09-30 15:23: "A payable round is always in the lobby. The player can join one
// now. Do not hide paying rows until their start is 20 minutes away"). The 20 min covered a join whose deposit invoice
// took 5-7 min - measured, the lock client's depositFor alone was 256.8 s. The invoice is asked at once now and the wallet
// is open from the lobby; measured on game 2, payment to a committed entry was ~50 s. A series starts a round every 90 s,
// so the row shown starts within 3 to 4.5 min.
// 90 S, THE JOIN ITSELF (2026-09-30: the next possible paid round is always visible - no 3 minute lead): the row is the next paying round a join can still enter before its entry closes at its start. Measured live on
// the testnet4 page 13:54Z: PLAY to the deposit invoice 23.5 s; game 2, payment to a committed entry ~50 s.
export const SERIES_JOIN_LEAD_MS = 90000;
// 15 S WHEN NOTHING HAS TO BE DEPOSITED FIRST (2026-10-03: "I always have to wait for the next round that starts in
// XX minutes"): a free row, or a paid row whose stake the player wallet already holds, is the soonest round with 15 s of
// entry left - measured on 0.0.2483, a funded paid PLAY 12.96 s before the start showed the round loaded in 1.20 s and its
// entry was taken at 7 of 7 before the start (V4, 3a16ec30). A wallet that must take a deposit first keeps the 90 s.
export const FUNDED_JOIN_LEAD_MS = 15000;
// NO LEAD (2026-10-04: "es darf niemals mehr als 90 Sekunden bei 'closes in' stehen. Ich darf immer
// 45 sekunden in einer Runde bereits joinen"): the paid row is the soonest series round whose entry is still open, funded
// or not. A series opens a round every 90 s and its entry closes 45 s after its start, so the row's "closes in" is never
// over 90 s. Measured on 0.0.2527: an empty wallet's 90 s lead showed "closes in 1:41" for a round starting in 0:56.
// A join whose deposit misses the entry close moves on to the next round (the page, ARENA_LOBBY_ACT.join).
export const JOIN_LEAD_MS = 0;
export const LOBBY_PER_SERIES = 8;
/**
 * A LOBBY READ THAT GOT NO ANSWER KEEPS ITS LAST ROWS (2026-10-01 15:25, HARD: "A player opening the page sees a
 * free row and a paid testnet4 row together. Do not drop free to show testnet4. Do not drop testnet4 to show free.").
 * Measured on the live page under load: each paint read the free nodes and the testnet4 nodes, and a side whose nodes did
 * not answer in time came back with no rows - the page showed the paid row alone, then both, then the free row alone. A
 * read with rows is taken as it is; one with no rows because its nodes went unanswered (or refused) keeps the rows it last
 * had, while their entry is still open (a read still in flight, `pending`, the same). A side that answered and lists
 * nothing lists nothing.
 */
export function lobbyKeepWhenUnanswered(previousRows, got, nowMs = Date.now()) {
  const rows = (got && got.rows) || [];
  if (rows.length) return rows;
  const silent = !!(got && (got.pending || (got.unanswered && got.unanswered.length) || (got.refused && got.refused.length)));
  if (!silent) return rows;
  return (previousRows || []).filter((r) => Number(r.entryCloseMs) > Number(nowMs));
}

/**
 * THE ROUND PLAY CHOSE STAYS THE ROW OF ITS KIND (2026-10-02: "once a round has been selected with play the
 * highlighting may no longer change when the other round is newer, currently while it's waiting it is switching the
 * highlight to the other round"): lobbyOnePerKind picks the soonest round that still leaves the join lead, so while a join
 * waits for its round the pick moved on to the next one. With `joinedId` named and still listed, its row replaces the
 * pick of its own kind (free or paying); the other kind is untouched. Unlisted (over), nothing is pinned.
 */
export function lobbyKeepJoined(picked, rows, joinedId) {
  if (!joinedId) return picked;
  const joined = (rows || []).find((r) => r.id === joinedId);
  if (!joined) return picked;
  const kind = (r) => (r.free ? 'free' : 'paying');
  const replaced = picked.map((r) => (kind(r) === kind(joined) ? joined : r));
  return picked.some((r) => kind(r) === kind(joined)) ? replaced : [...replaced, joined];
}

export function lobbyOnePerKind(rows, nowMs = Date.now(), { paidSeriesOnly = false, leadMsFor = () => JOIN_LEAD_MS } = {}) {
  // ONLY 90-SECOND PAID ROUNDS (2026-10-01: "We want always 90 second rounds in Testnet ... no paid row till
  // then"): with `paidSeriesOnly` a paying round that is not a series round - the runner's one-off with its 6 h entry
  // window - is never listed; until a series' rounds can be joined there is no paid row. Free rows are untouched.
  // Measured 05:26Z: series 8172fffd's round 0, a day out, showed as "PAID · 100 sats · closes 1113:28 · 0 of 5 signer nodes
  // - waiting" - a paid row before any can be joined. So a paid row is listed only once it can be joined.
  if (paidSeriesOnly) rows = rows.filter((r) => r.free || (!!(r.contract && r.contract.seriesId instanceof Uint8Array) && !!r.joinable));
  // THE SERIES FIRST (2026-09-30 08:50: "Only the 72-hour series ... count"; a one-off round such as 5eaa0966 does
  // not): a round of a series beats one naming none; among series rounds, the soonest with the join lead left; otherwise
  // as before - joinable, then open, then the latest entry close.
  const series = (r) => !!(r.contract && r.contract.seriesId instanceof Uint8Array);
  const leads = (r) => r.entryCloseMs - nowMs > leadMsFor(r);
  // A SERIES' START, its round's start less i x 90 s: of two series the later-starting one is the one posted after
  // (2026-09-30: "That series takes priority over the old posted rounds").
  const seriesStart = (r) => BigInt(r.contract.startTimeMs) - BigInt(r.contract.roundIndex || 0) * 90000n;
  // THE NEWEST SERIES DECIDES THE STAKE, THE SOONEST ROUND OF THAT STAKE WINS (2026-09-30: "the newest series
  // decides only the stake. Among joinable rows with that stake, the soonest round wins"; 16:31: until the new series is
  // active the old rounds stand). Per kind, the stake of the newest series with a JOINABLE row - open and assigned - is the
  // stake shown: 100 sat over 3cfbe516's 10000 once 8172fffd can be joined, and before that the old series' own. Between
  // two series of that one stake - 8172fffd and the next day's - nothing but the soonest round decides: measured by the rule
  // before this, k=2's first round, joinable 2 h before its start, would have hidden 8172fffd's last two hours of rounds.
  const winningStake = new Map();
  // ONE ROW PER GAME AND KIND: a market's paying row never takes nextblock's - BY THE GAME'S NAME, so its
  // versions share the row (v1's and v3's rounds of one instant were two rows, "always the same round twice")
  const kindOf = (r) => `${r.gameName || r.game || ''}:${r.free ? 'free' : 'paying'}`;
  for (const r of rows) {
    if (!series(r) || !r.joinable) continue;
    const kind = kindOf(r);
    const had = winningStake.get(kind);
    if (!had || seriesStart(r) > had.start) winningStake.set(kind, { start: seriesStart(r), stake: BigInt(r.stakeMsat) });
  }
  const ofWinningStake = (r) => { const w = winningStake.get(kindOf(r)); return !w || BigInt(r.stakeMsat) === w.stake; };
  const better = (x, y) => (ofWinningStake(x) !== ofWinningStake(y) ? ofWinningStake(x)
    : x.joinable !== y.joinable ? x.joinable
    : series(x) !== series(y) ? series(x)
      : series(x) && leads(x) !== leads(y) ? leads(x)
        : series(x) ? (x.entryCloseMs !== y.entryCloseMs ? x.entryCloseMs < y.entryCloseMs : Number(x.gameRank || 0) > Number(y.gameRank || 0))
          : x.phase !== y.phase ? x.phase === 'open' : x.entryCloseMs > y.entryCloseMs);
  const kept = new Map();
  for (const r of rows) {
    const kind = kindOf(r);
    if (!kept.has(kind) || better(r, kept.get(kind))) kept.set(kind, r);
  }
  const keep = new Set(kept.values());
  return rows.filter((r) => keep.has(r));
}

/**
 * THE ROWS AS THEY ARE READ (2026-10-05: "That row is the round it can still enter. It is not the round
 * after next."): one per kind, paid rows of a series only, no lead whatever the wallet holds, picked at `nowMs` - the clock of
 * the read, not of the last paint. Measured on 0.0.2740 with a funded seat: the last paint's pick left the closed round as
 * the row for ~1 s after each entry close. A join on a listed round keeps that round while the join is still going (`going`:
 * PLAY just before the close is still joining after it, and the seats take its entry until start + 45 s), and otherwise
 * only WHILE ITS ENTRY IS OPEN: measured on 0.0.2741, a join left "joined" on a closed round (a run's end, then "exit game")
 * kept it as the row ("closes in 0:00", not joinable) for as long as the nodes listed it.
 */
export function lobbyRowsAt(rows, nowMs = Date.now(), joinedId = null, { going = false } = {}) {
  const held = (rows || []).find((r) => r.id === joinedId);
  const keep = held && (going || Number(held.entryCloseMs) > Number(nowMs)) ? joinedId : null;
  return lobbyKeepJoined(lobbyOnePerKind(rows || [], nowMs, { paidSeriesOnly: true }), rows, keep);
}

/** A row's stake in whole sats, as the lobby says it: 0 for a free round. */
export const lobbyStakeSats = (row) => (row.free ? 0 : Number(BigInt(row.stakeMsat) / 1000n));

const lobbyClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** One row as the page shows it; the page draws this string and adds nothing. */
// AND ITS FEDERATION'S LOAD (§23A.3,: "the seats show load beside every round"; "The lobby shows every round with
// its federation and load"): `loads` is the page's verified statuses by federation id hex (federationStatuses), the load of
// a paying row's federation said beside its stake when known
const fedWords = (row, loads) => {
  const fid = row.contract && row.contract.federationId instanceof Uint8Array ? toHex(row.contract.federationId) : null;
  if (!fid) return '';
  const f = loads && typeof loads.get === 'function' ? loads.get(fid) : null;
  // AND WHY, WHEN IT IS NOT THE ONE A SEAT WOULD NAME (§23A.3: "A seat opening a round names the OPEN federation with the
  // lowest load ...; a creator who names another has the client show why"): another OPEN federation the page holds is lower
  let why = '';
  if (f && typeof f.load === 'number' && typeof loads.values === 'function') {
    const lower = [...loads.values()].filter((x) => x && x.status === 'OPEN' && typeof x.load === 'number' && x.federation !== fid && x.load < f.load)
      .sort((a, b) => a.load - b.load)[0];
    if (lower) why = ` - not the lowest-load federation: ${String(lower.federation).slice(0, 8)} is at ${lower.load.toFixed(2)}`;
  }
  return ` in federation ${fid.slice(0, 8)}` + (f && typeof f.load === 'number' ? ` (load ${f.load.toFixed(2)}${why})` : '');
};
/**
 * WHAT THE PLAYER SEES BEFORE APPROVAL (spec §22A "Transparency": "the selected node identities (or "pending" per §5A.5), any
 * committee overlap, whether any selected operator is playing"; §5A.13 "The client MUST show, before commitment, whether any
 * selected node's operator is playing"). From a paying row's seating (who the certificate seats), the census
 * this page checked (each node's advert names its operator_id) and the round's players (their checked name records):
 *   { pending, settlement: [{ node, operator }], operators, both, operatorsPlaying }
 */
export function approvalFacts(row, census = null) {
  if (!row || !row.seating || row.seating.state !== 'named') return { pending: true };
  const opOf = new Map();
  for (const e of census || []) {
    const k = e && e.pubkey ? (e.pubkey instanceof Uint8Array ? toHex(e.pubkey) : String(e.pubkey)).toLowerCase() : null;
    if (k) opOf.set(k, String((e.advert && e.advert.operatorId) || '').toLowerCase());
  }
  const game = (row.seating.game || []).map((k) => String(k).toLowerCase());
  const settlement = (row.seating.settlement || []).map((k) => String(k).toLowerCase());
  const both = settlement.filter((k) => game.includes(k)).length;
  const operators = [...new Set([...game, ...settlement].map((k) => opOf.get(k)).filter(Boolean))];
  const players = new Set((row.names || []).map((n) => String(n.player || '').toLowerCase()).filter(Boolean));
  return { pending: false, settlement: settlement.map((node) => ({ node, operator: opOf.get(node) || null })), operators, both,
    of: settlement.length, operatorsPlaying: operators.filter((o) => players.has(o)), censusKnown: opOf.size > 0 };
}

/** The lobby line's words for a stake ceiling (census-health.js stakeWithinCeiling's answer). */
export function ceilingWords(c, contract) {
  const test = contract && contract.networkId && isTestNetwork(contract.networkId);
  const limit = c.ceilingSats === 0n ? 'play money only' : `up to ${String(c.ceilingSats)} sat a stake`;
  return c.ok ? ` · stake ceiling: ${limit} - this stake is within it`
    : ` · stake ceiling: ${limit} - this stake is over it${test ? ' (a test network: shown, not enforced)' : ': refused'}`;
}

/** The lobby line's words for approvalFacts. */
export function approvalWords(f, tooOld = []) {
  // NODES LEFT OUT FOR THEIR PROTOCOL VERSION (scope 3): "node X: protocol too old"
  const old = Array.isArray(tooOld) && tooOld.length
    ? ` · left out, protocol too old: ${tooOld.map((x) => `${String(x.node).slice(0, 8)} (speaks ${(x.speaks || []).map(protocolVersionName).join(', ') || 'none'})`).join(', ')}` : '';
  if (!f || f.pending) return ' · selected nodes: pending (§5A.5)' + old;
  const ops = !f.censusKnown ? 'operators not read yet' : `${f.operators.length} operator${f.operators.length === 1 ? '' : 's'}${f.operators.length ? ` (${f.operators.map((o) => o.slice(0, 8)).join(', ')})` : ''}`;
  return ` · ${ops} · in both committees: ${f.both} of ${f.of}` + (f.operatorsPlaying.length
    ? ` · a selected operator is playing: ${f.operatorsPlaying.map((o) => o.slice(0, 8)).join(', ')}` : ' · no selected operator is playing') + old;
}

export function lobbyLine(row, nowMs = Date.now(), { loads = null, census = null, tooOld = null } = {}) {
  // A MARKET'S ROW (§0A.7a): its name, its outcomes, its entry close - the pick sheet says the rest
  if (row.market || row.marketLike) {
    const m = row.market;
    // a round of a template (feature 5) is shown by its own question and labels
    const ev = row.event;
    const what = ev ? `${ev.question}${m ? ` (${m.name})` : ''} · ${ev.outcomes.length} outcomes: ${ev.outcomes.join(' / ')}${m ? '' : ' · a market this page does not know (second confirmation)'}`
      : m ? `${m.name} · ${m.outcomes.length} outcomes: ${m.outcomes.join(' / ')}` : 'a market this page does not know (second confirmation)';
    const money = row.free ? 'free' : `stake ${String(row.stakeMsat / 1000n)} sat`;
    const when = row.phase === 'pending' ? `entry opens in ${lobbyClock(row.committeeTimeMs - nowMs)}` : `pick closes in ${lobbyClock(row.entryCloseMs - nowMs)}`;
    return `${what} · ${money} · ${when}`;
  }
  const money = row.free ? 'free - no wallet, no Lightning'
    : `stake ${String(row.stakeMsat / 1000n)} sat - a federation stake lock${fedWords(row, loads)}`;
  const when = row.phase === 'pending'
    ? `committee: pending, entry opens in ${lobbyClock(row.committeeTimeMs - nowMs)}`
    : `entry open, closes in ${lobbyClock(row.entryCloseMs - nowMs)}`;
  // "N signer nodes agree (M needed)", never "7 of 5" (2026-10-04 11:25Z)
  const agree = `${row.signerNodesAgree} signer ${row.signerNodesAgree === 1 ? 'node agrees' : 'nodes agree'} (${row.needed} needed)`
    + (row.phase === 'open' && !row.joinable ? ` - waiting for ${row.needed - row.signerNodesAgree} more` : '');
  const counts = row.said.map((c) => `${c.joined} joined, ${c.playing} playing (says ${c.node})`).join('; ');
  const who = row.names && row.names.length ? ` · players: ${row.names.map((n) => n.name).join(', ')}` : '';
  // RESERVE SEATS (§5A.7): who is seated, of how many drawn
  const seat = !row.seating ? '' : row.seating.state === 'named'
    ? ` · signer nodes: ${row.seating.settlement.length}${row.seating.drawn ? ` of ${row.seating.drawn.settlement} drawn` : ''} (${row.seating.settlement.map((k) => k.slice(0, 8)).join(', ')})`
    : row.seating.state === 'equivocated' ? ' · two certificates: the round is void' : ' · signer nodes not named yet';
  // AND, FOR A PAYING ROW, WHO SETTLES IT (§22A / §5A.13): operators, overlap, an operator playing
  const approval = row.free ? '' : approvalWords(approvalFacts(row, typeof census === 'function' ? census(row.contract) : census),
    typeof tooOld === 'function' ? (row.contract && row.contract.censusRoot ? tooOld(row.contract) : []) : tooOld || []);
  // THE STAKE CEILING THE CENSUS SUPPORTS (§5A.10): computed here from the census this page checked; a test network
  // shows it and refuses nothing (ruling A of the load rule), mainnet refuses a stake over it
  const entries = row.free ? null : (typeof census === 'function' ? census(row.contract) : census);
  const ceiling = !entries || !entries.length || !row.contract ? '' : ceilingWords(stakeWithinCeiling({ entries, stakeSats: row.stakeMsat / 1000n }), row.contract);
  return `${money} · ${when} · ${agree} · ${counts || 'no signer node counts'}${who}${seat}${approval}${ceiling}`
    + (row.disagrees.length ? ` · ${row.disagrees.join(', ')} listed it as ${row.free ? 'paying' : 'free'}` : '');
}

/**
 * A ROUND AN APP MAY OFFER (2026-10-26 ~10:2xZ, the owner on Rock Paper Scissors showing a running round while its tile said 0: "I think
 * that is fake right? ... Fix it in the SDK"): a free round, or a paid one whose committee at least one seat has drawn. Every app reads
 * its rounds through the page's ARENA_GAME.rows() / allRows(), so none offers a round no committee can be drawn for - after a chain
 * switch, a census of a branch the chain left, a census no node of the version is in. A row whose seats say nothing of its committee
 * (seats older than the committee listing) is offered, as before. Before, such a round was offered for 2 h after its committee time.
 */
export function lobbyRowOffered(r) {
  return !!r && lobbyRowNotOffered(r) === null;
}

/**
 * WHY A ROUND IS NOT OFFERED, or null when it is (kanban #761, 2026-10-28 ~10:50Z, the owner on Up/Down: "BTC up or down, 10:45-11:00 UTC?"
 * with Buy Up 50c active, and every order "Order not placed: this round is no longer listed in the lobby" - no round was seated that
 * morning, #757). A paid round is offered only when its committee is drawn AND, where the seats seat (§5A.7 reserve seats), seated in both
 * roles - the lobby's own `joinable` rule (seating 'named'); one drawn but not seated can take no order, so no app offers it.
 *   'not played'  most seats that say so do not play it in its window (the backup rule)
 *   'not drawn'   no seat has drawn its committee
 *   'not seated'  drawn, but no seat names both roles seated (or two certificates void it)
 */
export function lobbyRowNotOffered(r) {
  if (!r) return 'not listed';
  if (r.free) return null;
  // ONE GRID PLAYED PER WINDOW (§5A.5 the backup rule, kanban #702, 2026-10-26: "Yes make it part of the design, in the spec"): a seat names
  // a round it does not play in its window - a backup under a drawn primary, a primary whose backup took entries there - played: false;
  // a round most of the seats that say so do not play is not offered
  const plays = (r.said || []).filter((c) => c && typeof c.played === 'boolean');
  if (plays.length && plays.filter((c) => !c.played).length * 2 > plays.length) return 'not played';
  const said = (r.said || []).map((c) => c && c.committee).filter(Boolean);
  // a seat names a drawn committee by its members ({ drawn: { game: [...], settlement: [...] } }), an undrawn one drawn: false and why
  if (said.length && !said.some((c) => !!c.drawn)) return 'not drawn';
  // SEATED (§5A.7): where any seat speaks of seating, one names both roles seated (fetchLobby's `seating`, else the seats' own words)
  const seating = r.seating !== undefined ? r.seating : (() => {
    const s = said.filter((x) => x && x.seated);
    return !s.length ? null : s.some((x) => x.seated.game && x.seated.settlement) ? { state: 'named' } : { state: 'pending' };
  })();
  if (seating && seating.state !== 'named') return 'not seated';
  return null;
}

/**
 * WHAT A MARKET OR GAME SAYS WHEN ITS SOONEST WINDOW HAS NO PLAYABLE ROUND (kanban #761): `unoffered` the listed rounds of the game that are
 * not offered (each { id, entryCloseMs, startTimeMs, why }), `offered` the ones that are. Null when the soonest open window is playable, or
 * when no unplayable one is listed (the page's "next round" line says that). The text says why, and names the next playable window if any.
 */
export function unplayableWindowLine({ unoffered = [], offered = [], nowMs = Date.now(), periodMs = 0 } = {}) {
  const open = (xs) => xs.filter((r) => r && Number(r.entryCloseMs) > nowMs).sort((a, b) => Number(a.entryCloseMs) - Number(b.entryCloseMs));
  const bad = open(unoffered), good = open(offered);
  if (!bad.length) return null;
  const first = bad[0];
  if (good.length && Number(good[0].entryCloseMs) <= Number(first.entryCloseMs)) return null;
  const hm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16);
  const span = (r) => { const end = Number(r.entryCloseMs), start = periodMs ? end - periodMs : Number(r.startTimeMs) || 0;
    return start && start < end ? `${hm(start)}-${hm(end)} UTC` : `closing ${hm(end)} UTC`; };
  const why = first.why === 'not seated' ? 'its committee is not seated' : first.why === 'not drawn' ? 'its committee is not drawn'
    : first.why === 'not played' ? 'its window is played on another grid' : first.why === 'no reserve key' ? 'its federation has no reserve key yet' : 'it is not listed';
  const next = good[0];
  return { text: `No playable round for the ${span(first)} window - ${why}. ` + (next ? `Next playable window: ${span(next)}.` : 'No later window is playable yet.'),
    why: first.why, round: first.id || null, next: next ? next.id || null : null, nextCloseMs: next ? Number(next.entryCloseMs) : null };
}
