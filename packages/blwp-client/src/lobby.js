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
import { joinQuery, fetchRound, roundPays } from './join.js';
import { checkedNames } from './identity.js';
import { lobbyListingId } from '../../protocol/src/lobby-listing.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

/** How far a signer node's signed time may be from this page's clock and still count. */
export const LOBBY_SKEW_MS = 60000;

/**
 * HOW LONG A SIGNER NODE HAS TO ANSWER ONE LOBBY READ (2026-09-17: "never hang forever"). Measured before on the Daily with
 * one tunnel silent: the first /rounds failed after 125.1 s and the next node's took 60 s, while the page sat on
 * "Connecting …" for 185 s and then showed a closed round with PLAY enabled for 237 s. 10 s is the session's own limit for a
 * provider ("no answer in 10000 ms"), so the lobby and the run give up on a node at the same point.
 */
export const SIGNER_ANSWER_MS = 10000;

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
    const asked = Promise.resolve().then(() => fetcher(url, abort ? { ...opts, signal: abort.signal } : opts));
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
  if (nodes.length < 2 || typeof daily.bond !== 'string' || !/^[0-9a-f]{128}$/.test(String(daily.advert))) return null;
  const q = new URLSearchParams({ node: nodes.join(','), bond: daily.bond, advert: daily.advert });
  if (typeof daily.federation === 'string' && daily.federation) q.set('federation', daily.federation);
  // THE FUNDED GATEWAYS (the owner 2026-09-30 14:30): the gateways holding e-cash in the federation, the only ones a deposit
  // may go through (page-lock.js depositGateway). A string or a list; carried as one comma-separated `gateway`.
  const gws = (Array.isArray(daily.gateway) ? daily.gateway : typeof daily.gateway === 'string' ? daily.gateway.split(',') : [])
    .map((g) => String(g).trim()).filter((g) => /^https?:\/\//.test(g));
  if (gws.length) q.set('gateway', gws.join(','));
  const search = '?' + q.toString();
  try { return lobbyQuery(search) ? search : null; } catch { return null; }
}

/** Is this node's listing of this round its signer node's own signed word? */
function lobbySigned(verify, { id, nodeKey, nowMs, x }) {
  try {
    return !!verify(fromHex(String(x.sig)), lobbyListingId({ roundId: fromHex(id), nodePubkey: fromHex(nodeKey), nowMs: BigInt(nowMs),
      phase: x.phase, assignedHere: !!x.assignedHere, joined: Number(x.joined), playing: Number(x.playing) }), fromHex(nodeKey));
  } catch { return false; }
}

/**
 * EVERY ROUND THE NAMED NODES HOLD, CHECKED, AND WHICH OF THEM ITS SIGNER NODES AGREE ON.
 *
 * `verify(sig, msg, key)` is BIP-340, injected like every curve in this bundle.
 * @returns {{ rows: object[], refused: string[] }} rows open before pending,
 *   soonest entry close first; a round past its entry close is not a row.
 */
const CONTRACTS = new Map();                     // round id hex -> its contract (the id is its hash)

export async function fetchLobby({ nodes, fetcher = fetch, nowMs = Date.now(), verify, skewMs = LOBBY_SKEW_MS, answerMs = SIGNER_ANSWER_MS } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('a lobby asks the nodes it was named, and it was named none');
  if (typeof verify !== 'function') throw new Error('a lobby checks each signer node\'s signed listing, and no verify was injected');
  const refused = [];
  const unanswered = [];                                    // signer nodes that did not answer within answerMs
  const said = new Map();                                   // id -> [{ node, key, ... }]
  const ask = answerWithin(fetcher, answerMs);
  // EVERY NODE AT ONCE, each within its limit: asked one after another, one silent node held the next one's answer back
  // and a lobby of two cost two limits. Answers are read in the order the nodes were named.
  const unique = [...new Set(nodes)];
  const answers = await Promise.all(unique.map((node) =>
    // AT MOST 8 UPCOMING ROUNDS OF EACH SERIES (`next`): a node holding two series lists ~1150 rounds otherwise - 63 s,
    // past what the lobby waits for a node. A lobby shows one round per kind; eight leaves the lead's choice its room.
    ask(`${String(node).replace(/\/+$/, '')}/rounds?next=${LOBBY_PER_SERIES}`).then((r) => ({ r }), (e) => ({ e }))));
  for (const [k, node] of unique.entries()) {
    try {
      const { r, e } = answers[k];
      if (e) throw e;
      if (!r.ok) { refused.push(`${node}: answered ${r.status}`); continue; }
      const body = await r.json();
      const nodeKey = String(body && body.node).toLowerCase();
      const at = Number(body && body.nowMs);
      for (const x of (body && Array.isArray(body.rounds)) ? body.rounds : []) {
        const id = String(x && x.id).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(id)) { refused.push(`${node}: listed something that is not a round id`); continue; }
        if (!said.has(id)) said.set(id, []);
        const signed = /^[0-9a-f]{64}$/.test(nodeKey) && Number.isFinite(at) && lobbySigned(verify, { id, nodeKey, nowMs: at, x });
        said.get(id).push({ node, key: nodeKey, joined: Number(x.joined) || 0, playing: Number(x.playing) || 0,
          watching: Number(x.watching) || 0, free: !!x.free, phase: x.phase, assignedHere: !!x.assignedHere,
          signed, fresh: Number.isFinite(at) && Math.abs(at - nowMs) <= skewMs,
          names: Array.isArray(x.names) ? x.names : [] });
      }
    } catch (e) { refused.push(`${node}: ${e.message}`); if (e && e.silent) unanswered.push(String(node)); }
  }
  const rows = [];
  // A ROUND'S CONTRACT FROM A NODE THAT ANSWERED FIRST, so a silent one costs its limit once per paint, not once per row.
  const answeredFirst = [...unique.filter((n) => !unanswered.includes(String(n))), ...unique.filter((n) => unanswered.includes(String(n)))];
  // KEPT BY ID, FETCHED 16 AT A TIME (the owner 2026-09-30, testnet4 series 3cfbe516: ~450 rounds listed, each contract
  // fetched one after another on every paint). A round's id is its contract's hash, so a kept contract cannot go stale.
  const wanted = [...said.keys()].filter((id) => !CONTRACTS.has(id));
  for (let i = 0; i < wanted.length; i += 16)
    await Promise.all(wanted.slice(i, i + 16).map((id) => fetchRound(id, answeredFirst, { fetcher: ask })
      .then(({ contract }) => { CONTRACTS.set(id, contract); }, (e) => { refused.push(`${id.slice(0, 16)}: ${e.message}`); })));
  for (const [id, counts] of said) {
    const contract = CONTRACTS.get(id);
    if (!contract) continue;
    const now = BigInt(Math.floor(nowMs));
    if (now >= contract.entryCloseMs) continue;
    const pays = roundPays(contract);
    // NO 2-OF-2 PAYING FEDERATION IS OFFERED (PRIORITIES item 5; the owner 2026-09-27 10:04). One node is one guardian, so
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
      c.counts = !!(c.signed && c.fresh && signerNodes.has(c.key) && c.phase === 'open' && c.assignedHere);
      if (c.counts) agreeing.add(c.key);
    }
    rows.push({
      id, phase,
      free: !pays,
      wallet: pays ? 'federation-lock' : 'none',
      stakeMsat: contract.stakeMsat,
      committeeTimeMs: Number(contract.committeeTimeMs), startTimeMs: Number(contract.startTimeMs),
      entryCloseMs: Number(contract.entryCloseMs),
      said: counts,
      signerNodesAgree: agreeing.size, needed, signerNodes: signerNodes.size,
      joinable: phase === 'open' && agreeing.size >= needed,
      // A NODE THAT CALLED A PAYING ROUND FREE, OR THE REVERSE, IS NAMED: the row
      // says what the contract says, and the disagreement is shown beside it.
      disagrees: counts.filter((c) => c.free !== !pays).map((c) => c.node),
      names: checkedNames(counts.flatMap((c) => c.names), id, verify),
      contract,
    });
  }
  rows.sort((x, y) => (x.phase === y.phase ? x.entryCloseMs - y.entryCloseMs : (x.phase === 'open' ? -1 : 1)));
  return { rows, refused, unanswered };
}

/**
 * ONE FREE ROUND AND ONE PAYING ROUND, NEVER TWO OF EITHER (the owner 2026-09-15 16:08: "ALWAYS
 * exactly ONE no-money FREE round and ONE paying 2-of-2"). The signer nodes hold more than one of a kind
 * for a while - a rollover opens the next round a minute before the last one's entry closes, and
 * a launcher restart opens a fresh pair beside the pair it left. Measured before: the Daily listed
 * 2 FREE and 2 PAID. Per kind this keeps one row: a joinable one over one that is not, an open one
 * over a pending one, then the one with the most entry left. Order is kept.
 */
// A SERIES ROUND CLOSES ITS ENTRY AT ITS START, and a paying join - the deposit, then the stake lock - takes minutes: the
// row shown is the soonest series round that still leaves this much.
// 3 MIN, NOT 20 (INSTANT-1527, the owner 2026-09-30 15:23: "A payable round is always in the lobby. The player can join one
// now. Do not hide paying rows until their start is 20 minutes away"). The 20 min covered a join whose deposit invoice
// took 5-7 min - measured, the lock client's depositFor alone was 256.8 s. The invoice is asked at once now and the wallet
// is open from the lobby; measured on game 2, payment to a committed entry was ~50 s. A series starts a round every 90 s,
// so the row shown starts within 3 to 4.5 min.
// 90 S, THE JOIN ITSELF (the owner 2026-09-30: the next possible paid round is always visible - no 3 minute lead): the row is the next paying round a join can still enter before its entry closes at its start. Measured live on
// the testnet4 page 13:54Z: PLAY to the deposit invoice 23.5 s; game 2, payment to a committed entry ~50 s.
export const SERIES_JOIN_LEAD_MS = 90000;
export const LOBBY_PER_SERIES = 8;
/**
 * A LOBBY READ THAT GOT NO ANSWER KEEPS ITS LAST ROWS (the owner 2026-10-01 15:25, HARD: "A player opening the page sees a
 * free row and a paid testnet4 row together. Do not drop free to show testnet4. Do not drop testnet4 to show free.").
 * Measured on the live page under load: each paint read the free nodes and the testnet4 nodes, and a side whose nodes did
 * not answer in time came back with no rows - the page showed the paid row alone, then both, then the free row alone. A
 * read with rows is taken as it is; one with no rows because its nodes went unanswered (or refused) keeps the rows it last
 * had, while their entry is still open. A side that answered and lists nothing lists nothing.
 */
export function lobbyKeepWhenUnanswered(previousRows, got, nowMs = Date.now()) {
  const rows = (got && got.rows) || [];
  if (rows.length) return rows;
  const silent = !!(got && ((got.unanswered && got.unanswered.length) || (got.refused && got.refused.length)));
  if (!silent) return rows;
  return (previousRows || []).filter((r) => Number(r.entryCloseMs) > Number(nowMs));
}

export function lobbyOnePerKind(rows, nowMs = Date.now(), { paidSeriesOnly = false } = {}) {
  // ONLY 90-SECOND PAID ROUNDS (the owner 2026-10-01: "We want always 90 second rounds in Testnet ... no paid row till
  // then"): with `paidSeriesOnly` a paying round that is not a series round - the runner's one-off with its 6 h entry
  // window - is never listed; until a series' rounds can be joined there is no paid row. Free rows are untouched.
  // Measured 05:26Z: series 8172fffd's round 0, a day out, showed as "PAID · 100 sats · closes 1113:28 · 0 of 5 signer nodes
  // - waiting" - a paid row before any can be joined. So a paid row is listed only once it can be joined.
  if (paidSeriesOnly) rows = rows.filter((r) => r.free || (!!(r.contract && r.contract.seriesId instanceof Uint8Array) && !!r.joinable));
  // THE SERIES FIRST (the owner 2026-09-30 08:50: "Only the 72-hour series ... count"; a one-off round such as 5eaa0966 does
  // not): a round of a series beats one naming none; among series rounds, the soonest with the join lead left; otherwise
  // as before - joinable, then open, then the latest entry close.
  const series = (r) => !!(r.contract && r.contract.seriesId instanceof Uint8Array);
  const leads = (r) => r.entryCloseMs - nowMs >= SERIES_JOIN_LEAD_MS;
  // A SERIES' START, its round's start less i x 90 s: of two series the later-starting one is the one posted after
  // (the owner 2026-09-30: "That series takes priority over the old posted rounds").
  const seriesStart = (r) => BigInt(r.contract.startTimeMs) - BigInt(r.contract.roundIndex || 0) * 90000n;
  // THE NEWEST SERIES DECIDES THE STAKE, THE SOONEST ROUND OF THAT STAKE WINS (the owner 2026-09-30: "the newest series
  // decides only the stake. Among joinable rows with that stake, the soonest round wins"; 16:31: until the new series is
  // active the old rounds stand). Per kind, the stake of the newest series with a JOINABLE row - open and assigned - is the
  // stake shown: 100 sat over 3cfbe516's 10000 once 8172fffd can be joined, and before that the old series' own. Between
  // two series of that one stake - 8172fffd and the next day's - nothing but the soonest round decides: measured by the rule
  // before this, k=2's first round, joinable 2 h before its start, would have hidden 8172fffd's last two hours of rounds.
  const winningStake = new Map();
  for (const r of rows) {
    if (!series(r) || !r.joinable) continue;
    const kind = r.free ? 'free' : 'paying';
    const had = winningStake.get(kind);
    if (!had || seriesStart(r) > had.start) winningStake.set(kind, { start: seriesStart(r), stake: BigInt(r.stakeMsat) });
  }
  const ofWinningStake = (r) => { const w = winningStake.get(r.free ? 'free' : 'paying'); return !w || BigInt(r.stakeMsat) === w.stake; };
  const better = (x, y) => (ofWinningStake(x) !== ofWinningStake(y) ? ofWinningStake(x)
    : x.joinable !== y.joinable ? x.joinable
    : series(x) !== series(y) ? series(x)
      : series(x) && leads(x) !== leads(y) ? leads(x)
        : series(x) ? x.entryCloseMs < y.entryCloseMs
          : x.phase !== y.phase ? x.phase === 'open' : x.entryCloseMs > y.entryCloseMs);
  const kept = new Map();
  for (const r of rows) {
    const kind = r.free ? 'free' : 'paying';
    if (!kept.has(kind) || better(r, kept.get(kind))) kept.set(kind, r);
  }
  const keep = new Set(kept.values());
  return rows.filter((r) => keep.has(r));
}

/** A row's stake in whole sats, as the lobby says it: 0 for a free round. */
export const lobbyStakeSats = (row) => (row.free ? 0 : Number(BigInt(row.stakeMsat) / 1000n));

const lobbyClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** One row as the page shows it; the page draws this string and adds nothing. */
export function lobbyLine(row, nowMs = Date.now()) {
  const money = row.free ? 'free - no wallet, no Lightning'
    : `stake ${String(row.stakeMsat / 1000n)} sat - a federation stake lock`;
  const when = row.phase === 'pending'
    ? `committee: pending, entry opens in ${lobbyClock(row.committeeTimeMs - nowMs)}`
    : `entry open, closes in ${lobbyClock(row.entryCloseMs - nowMs)}`;
  const agree = `${row.signerNodesAgree} of ${row.needed} signer nodes agree`
    + (row.phase === 'open' && !row.joinable ? ` - waiting for ${row.needed - row.signerNodesAgree} more` : '');
  const counts = row.said.map((c) => `${c.joined} joined, ${c.playing} playing (says ${c.node})`).join('; ');
  const who = row.names && row.names.length ? ` · players: ${row.names.map((n) => n.name).join(', ')}` : '';
  return `${money} · ${when} · ${agree} · ${counts || 'no signer node counts'}${who}`
    + (row.disagrees.length ? ` · ${row.disagrees.join(', ')} listed it as ${row.free ? 'paying' : 'free'}` : '');
}
