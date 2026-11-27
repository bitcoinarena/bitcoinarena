// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW ADDRESS CHECKED FROM OUTSIDE BEFORE IT GOES ON CHAIN (kanban #3886, node operators 2026-11: advertisements were posted for addresses
// nobody could reach - a dead quick tunnel, a Funnel name no seat reached, http only). Before the node posts an advertisement update naming
// an address it asks other seats GET /reach-probe?node=<its key> (reach-probe.js, #3798): each seat dials the addresses IT holds for this
// node - the census's and the node's newest signed announcement, which names the new address - asks GET /identity there and says whether
// this node's key answered, and if not why. The answer under the new address is what counts: dead, a broken certificate, http only, another
// node or an error - the update is not posted and the reason is said.
//
// What the probe proves: /identity under the address answers this node's 32-byte key (at most 64 bytes read, #3839), over TLS the seat's
// fetch checks (a broken certificate fails as 'tls'), with no redirect followed. That is all a seat or a page needs of the address: the
// probe is not widened (it stays a key-for-key check, never an open proxy).
import { jsonUpTo } from './peer-read.js';
import { addressRefusal } from './address-rules.js';

export const CHECK_SEATS_MOST = 3;
export const CHECK_TIMEOUT_MS = 20000;
export const CHECK_ANSWER_BYTES = 16384;
const norm = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/^ws(s?):/i, 'http$1:').toLowerCase();

/** The seats to ask: other nodes' census endpoints (https, never this node's own), each once, spread by `seed`. */
export function checkSeats({ entries = [], ownKey, most = CHECK_SEATS_MOST, seed = 0 } = {}) {
  const own = String(ownKey || '').toLowerCase();
  const hex = (b) => (typeof b === 'string' ? b : Buffer.from(b || []).toString('hex'));
  const seen = new Set(), out = [];
  for (const e of entries) {
    if (!e || !e.advert || hex(e.pubkey) === own) continue;
    const u = String(e.advert.endpoint || '').replace(/\/+$/, '');
    if (!/^https:\/\//i.test(u) || seen.has(norm(u))) continue;
    seen.add(norm(u)); out.push(u);
  }
  const start = out.length ? Math.abs(Math.trunc(Number(seed) || 0)) % out.length : 0;
  return [...out.slice(start), ...out.slice(0, start)].slice(0, most);
}

/** One sentence per failure kind (reach-probe.js failureKind / probeOne). */
export function kindText(r) {
  switch (r && r.kind) {
    case 'dns': return 'the name does not resolve';
    case 'tls': return 'its certificate is not valid';
    case 'timeout': return 'nothing answered in time';
    case 'refused': return 'the connection was refused';
    case 'blocked': return 'it points into a private network';
    case 'other-node': return 'another node answers there';
    case 'http': return `it answers HTTP ${r.status}`;
    default: return 'the connection failed';
  }
}

/**
 * ASK `seats` WHETHER `url` REACHES `node`. Answers { ok, url, asked, reached, failed, unknown, results: [{ seat, reached, kind?, status?,
 * ms?, region? }], why }. ok: at least `need` seats reached the key there and none failed. A seat that holds no announcement of `url` yet
 * is unknown, not a failure (the node announces every 10 min).
 */
export async function outsideCheck({ url, node, seats = [], fetchFn = fetch, need = 2, timeoutMs = CHECK_TIMEOUT_MS }) {
  const want = norm(url);
  const refused = addressRefusal(url);   // kanban #3887: never asked for an address the network cannot use
  if (refused) return { ok: false, url, asked: 0, reached: 0, failed: 0, unknown: 0, results: [], why: refused.why, howTo: refused.howTo };
  const results = await Promise.all(seats.map(async (seat) => {
    try {
      const r = await fetchFn(`${String(seat).replace(/\/+$/, '')}/reach-probe?node=${node}`, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const body = r.status === 200 ? await jsonUpTo(r, CHECK_ANSWER_BYTES) : null;
      if (r.status !== 200) { try { await r.body?.cancel(); } catch { /* gone */ } }
      const hit = body && Array.isArray(body.results) ? body.results.find((x) => x && norm(x.url) === want) : null;
      const region = body && typeof body.region === 'string' ? body.region.slice(0, 40) : null;
      if (!hit) return { seat, reached: null, region, why: body ? 'holds no announcement of this address yet' : `answered HTTP ${r.status}` };
      return { seat, reached: !!hit.reached, region, ...(hit.reached ? {} : { kind: hit.kind || null, status: hit.status || null }), ms: Number(hit.ms) || null };
    } catch (e) { return { seat, reached: null, why: `did not answer (${e.name === 'TimeoutError' ? 'timeout' : 'connection failed'})` }; }
  }));
  const reached = results.filter((r) => r.reached === true).length, failed = results.filter((r) => r.reached === false), unknown = results.filter((r) => r.reached === null).length;
  const ok = reached >= Math.min(need, seats.length || need) && !failed.length && reached > 0;
  let why = null;
  if (failed.length) why = `${failed.length} of ${results.length} seats could not reach ${url}: ${[...new Set(failed.map(kindText))].join('; ')}`;
  else if (!ok) why = seats.length ? `${reached} of ${results.length} seats reached ${url} (${unknown} could not check it yet): checked again in 10 min` : 'no other seat to check the address from';
  return { ok, url, asked: results.length, reached, failed: failed.length, unknown, results, why };
}
