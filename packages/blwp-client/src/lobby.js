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
// read off the verified contract and this page's clock. The seat counts are the
// only thing taken from a node, and they are shown as what that node says.
//
// Joining is the join link: the same query with `round=` added. Nothing here
// seats anybody, and nothing here mints a round.
import { joinQuery, fetchRound, roundPays, roundLocks } from './join.js';

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
 * EVERY JOINABLE ROUND THE NAMED NODES HOLD, CHECKED.
 *
 * @returns {{ rows: object[], refused: string[] }} rows open before pending,
 *   soonest entry close first; a round past its entry close is not a row.
 */
export async function fetchLobby({ nodes, fetcher = fetch, nowMs = Date.now() } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('a lobby asks the nodes it was named, and it was named none');
  const refused = [];
  const said = new Map();                                   // id -> [{ node, seated, playing, watching }]
  for (const node of [...new Set(nodes)]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/rounds`);
      if (!r.ok) { refused.push(`${node}: answered ${r.status}`); continue; }
      const body = await r.json();
      for (const x of (body && Array.isArray(body.rounds)) ? body.rounds : []) {
        const id = String(x && x.id).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(id)) { refused.push(`${node}: listed something that is not a round id`); continue; }
        if (!said.has(id)) said.set(id, []);
        said.get(id).push({ node, seated: Number(x.seated) || 0, playing: Number(x.playing) || 0,
          watching: Number(x.watching) || 0, free: !!x.free });
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
    rows.push({
      id,
      phase: now < contract.committeeTimeMs ? 'pending' : 'open',
      free: !pays,
      wallet: !pays ? 'none' : (roundLocks(contract) ? 'federation-lock' : 'lightning'),
      stakeMsat: contract.stakeMsat,
      committeeTimeMs: Number(contract.committeeTimeMs), startTimeMs: Number(contract.startTimeMs),
      entryCloseMs: Number(contract.entryCloseMs),
      said: counts,
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
  const counts = row.said.map((c) => `${c.seated} seated, ${c.playing} playing (says ${c.node})`).join('; ');
  return `${money} · ${when} · ${counts || 'no seat counts'}`
    + (row.disagrees.length ? ` · ${row.disagrees.join(', ')} listed it as ${row.free ? 'paying' : 'free'}` : '');
}
