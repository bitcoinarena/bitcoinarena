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
// read off the verified contract and this page's clock. The seat counts are
// shown as what each node says.
//
// AND JOIN IS OFFERED AT THE ROUND'S THRESHOLD OF ITS OWN SEATS (2 of 2 here,
// 5 of 7 on mainnet). Every mark needs that many receipts, so a round only one
// seat of a 2-of-2 holds is a round nobody can play. Each seat signs its
// listing under its node key (lobby-listing.js); a row is joinable only when
// that many DISTINCT keys the verified contract names have signed "open,
// seated here", recently. One server cannot sign for two seats.
//
// Joining is the join link: the same query with `round=` added. Nothing here
// seats anybody, and nothing here mints a round.
import { joinQuery, fetchRound, roundPays, roundLocks } from './join.js';
import { lobbyListingId } from '../../protocol/src/lobby-listing.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

/** How far a seat's signed time may be from this page's clock and still count. */
export const LOBBY_SKEW_MS = 60000;

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

/** Is this node's listing of this round its seat's own signed word? */
function lobbySigned(verify, { id, nodeKey, nowMs, x }) {
  try {
    return !!verify(fromHex(String(x.sig)), lobbyListingId({ roundId: fromHex(id), nodePubkey: fromHex(nodeKey), nowMs: BigInt(nowMs),
      phase: x.phase, seatedHere: !!x.seatedHere, seated: Number(x.seated), playing: Number(x.playing) }), fromHex(nodeKey));
  } catch { return false; }
}

/**
 * EVERY ROUND THE NAMED NODES HOLD, CHECKED, AND WHICH OF THEM ITS SEATS AGREE ON.
 *
 * `verify(sig, msg, key)` is BIP-340, injected like every curve in this bundle.
 * @returns {{ rows: object[], refused: string[] }} rows open before pending,
 *   soonest entry close first; a round past its entry close is not a row.
 */
export async function fetchLobby({ nodes, fetcher = fetch, nowMs = Date.now(), verify, skewMs = LOBBY_SKEW_MS } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('a lobby asks the nodes it was named, and it was named none');
  if (typeof verify !== 'function') throw new Error('a lobby checks each seat\'s signed listing, and no verify was injected');
  const refused = [];
  const said = new Map();                                   // id -> [{ node, key, ... }]
  for (const node of [...new Set(nodes)]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/rounds`);
      if (!r.ok) { refused.push(`${node}: answered ${r.status}`); continue; }
      const body = await r.json();
      const nodeKey = String(body && body.node).toLowerCase();
      const at = Number(body && body.nowMs);
      for (const x of (body && Array.isArray(body.rounds)) ? body.rounds : []) {
        const id = String(x && x.id).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(id)) { refused.push(`${node}: listed something that is not a round id`); continue; }
        if (!said.has(id)) said.set(id, []);
        const signed = /^[0-9a-f]{64}$/.test(nodeKey) && Number.isFinite(at) && lobbySigned(verify, { id, nodeKey, nowMs: at, x });
        said.get(id).push({ node, key: nodeKey, seated: Number(x.seated) || 0, playing: Number(x.playing) || 0,
          watching: Number(x.watching) || 0, free: !!x.free, phase: x.phase, seatedHere: !!x.seatedHere,
          signed, fresh: Number.isFinite(at) && Math.abs(at - nowMs) <= skewMs });
      }
    } catch (e) { refused.push(`${node}: ${e.message}`); }
  }
  const rows = [];
  for (const [id, counts] of said) {
    let contract;
    try { ({ contract } = await fetchRound(id, nodes, { fetcher })); }
    catch (e) { refused.push(`${id.slice(0, 16)}: ${e.message}`); continue; }
    const now = BigInt(Math.floor(nowMs));
    if (now >= contract.entryCloseMs) continue;
    const pays = roundPays(contract);
    const phase = now < contract.committeeTimeMs ? 'pending' : 'open';
    // WHO COUNTS: a seat of THIS round (its key in the verified contract), its
    // own signature, recent, saying open and seated. Each key once.
    const seats = new Set(contract.nodes.map((k) => toHex(k)));
    let needed;
    try { needed = receiptsNeeded(contract.gameVerifySlots); } catch { needed = contract.nodes.length; }
    const agreeing = new Set();
    for (const c of counts) {
      c.counts = !!(c.signed && c.fresh && seats.has(c.key) && c.phase === 'open' && c.seatedHere);
      if (c.counts) agreeing.add(c.key);
    }
    rows.push({
      id, phase,
      free: !pays,
      wallet: !pays ? 'none' : (roundLocks(contract) ? 'federation-lock' : 'lightning'),
      stakeMsat: contract.stakeMsat,
      committeeTimeMs: Number(contract.committeeTimeMs), startTimeMs: Number(contract.startTimeMs),
      entryCloseMs: Number(contract.entryCloseMs),
      said: counts,
      seatsAgree: agreeing.size, needed, seats: seats.size,
      joinable: phase === 'open' && agreeing.size >= needed,
      // A NODE THAT CALLED A PAYING ROUND FREE, OR THE REVERSE, IS NAMED: the row
      // says what the contract says, and the disagreement is shown beside it.
      disagrees: counts.filter((c) => c.free !== !pays).map((c) => c.node),
      contract,
    });
  }
  rows.sort((x, y) => (x.phase === y.phase ? x.entryCloseMs - y.entryCloseMs : (x.phase === 'open' ? -1 : 1)));
  return { rows, refused };
}

const lobbyClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** One row as the page shows it; the page draws this string and adds nothing. */
export function lobbyLine(row, nowMs = Date.now()) {
  const money = row.free ? 'free - no wallet, no Lightning'
    : `stake ${String(row.stakeMsat / 1000n)} sat - ${row.wallet === 'federation-lock' ? 'a federation stake lock' : 'a Lightning payment'}`;
  const when = row.phase === 'pending'
    ? `committee: pending, entry opens in ${lobbyClock(row.committeeTimeMs - nowMs)}`
    : `entry open, closes in ${lobbyClock(row.entryCloseMs - nowMs)}`;
  const agree = `${row.seatsAgree} of ${row.needed} seats agree`
    + (row.phase === 'open' && !row.joinable ? ` - waiting for ${row.needed - row.seatsAgree} more` : '');
  const counts = row.said.map((c) => `${c.seated} seated, ${c.playing} playing (says ${c.node})`).join('; ');
  return `${money} · ${when} · ${agree} · ${counts || 'no seat counts'}`
    + (row.disagrees.length ? ` · ${row.disagrees.join(', ')} listed it as ${row.free ? 'paying' : 'free'}` : '');
}
