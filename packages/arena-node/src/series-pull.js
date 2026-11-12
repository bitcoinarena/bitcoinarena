// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * A NODE FETCHES THE DAY'S SERIES ITSELF (kanban #757, 2026-10-28: "today's rounds don't seat"). The poster pushes each series line
 * (POST /series) to every census node at the endpoint its bond advert names. An installed node whose tunnel address changed since its
 * advert (b36828fa: advert cups-grades-..., reachable at top-linda-jose-visibility) never got a push, and a node that did get one refused
 * it (402: only its own operator's funded file names a series funded). Drawn in 67 of the day's rounds, it held none of them: it could
 * not list, seat, sign PRESENT for or play any.
 *
 * So every node asks the nodes it knows, every PULL_EVERY_MS: which series do you hold (GET /series), and for each one it does not hold,
 * its line (GET /series-template?id=). A line is believed only when it hashes to the id asked for; `take(template)` then checks it as
 * POST /series does - creator signature, lead, hosted game, donation set, federation - and, in place of the operator naming it funded,
 * that the series' publication is confirmed on this node's own chain. A series refused is asked again after RETRY_MS (its publication
 * may not be confirmed yet, its view may still be reading).
 *
 *   peers()         the other nodes' roots (http/https), the announced address first
 *   held()          the ids (hex) of the series this node holds
 *   take(t)         -> { ok, why } for a parsed series line
 *   parse(line)     series-line.js parseSeriesLine;  idOf(t) -> the series id, hex
 */
export const PULL_EVERY_MS = 120000;
export const PULL_PEERS = 4;
export const PULL_PER_PASS = 40;
export const RETRY_MS = 300000;
// ONE PEER CANNOT SPEND THE PASS (kanban #2424): a /series answer is read up to PULL_LISTING_BYTES, a whole pass ends by PULL_PASS_MS,
// and a peer whose lines fail PULL_PEER_STRIKES times in a pass is not asked for the ids only it lists
export const PULL_LISTING_BYTES = 1 << 20;
export const PULL_PASS_MS = 90000;
export const PULL_PEER_STRIKES = 3;

export function createSeriesPull({ peers, held, take, parse, idOf, fetchFn = fetch, say = () => {}, now = Date.now,
  perPass = PULL_PER_PASS, askPeers = PULL_PEERS, retryMs = RETRY_MS, timeoutMs = 15000,
  passMs = PULL_PASS_MS, listingBytes = PULL_LISTING_BYTES, peerStrikes = PULL_PEER_STRIKES }) {
  const refusedAt = new Map();         // series id hex -> { atMs, why }
  let busy = false, start = 0, last = null;
  // the listing read up to listingBytes (kanban #2424): a body without a stream reader (a test double) is read as it is
  const capped = async (r) => {
    if (!r.body || typeof r.body.getReader !== 'function') return r.json();
    const reader = r.body.getReader(); const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > listingBytes) { reader.cancel().catch(() => {}); throw new Error(`its answer passed ${listingBytes} bytes`); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))).toString('utf8'));
  };
  const json = async (u) => { const r = await fetchFn(u, { signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? capped(r) : null; };

  /** One pass: the series the asked peers hold that this node does not, fetched, checked and taken. Never throws. */
  const pass = async () => {
    if (busy) return last;
    busy = true;
    const out = { atMs: now(), asked: 0, answered: 0, missing: 0, took: 0, refused: [] };
    try {
      const all = [...new Set((await peers()) || [])].filter((u) => /^https?:\/\//.test(u));
      // A FEW PEERS A PASS, TAKEN IN TURN: every seat holds the day's series, so four answers are plenty, and a dead one is passed by
      const ask = [];
      for (let i = 0; i < Math.min(askPeers, all.length); i++) ask.push(all[(start + i) % all.length]);
      start = all.length ? (start + ask.length) % all.length : 0;
      out.asked = ask.length;
      const have = new Set(held());
      const from = new Map();          // id -> [peer roots that list it]
      await Promise.all(ask.map(async (u) => {
        let got = null; try { got = await json(`${u}/series`); } catch { got = null; }
        if (!got || !Array.isArray(got.series)) return;
        out.answered++;
        for (const s of got.series) {
          const id = String((s && s.series) || '').toLowerCase();
          // a series whose rounds have all started is of no use here any more - but one not begun yet is: its rounds are written only
          // a horizon ahead (3 h), so a whole day posted at 02:00Z shows `ahead: 0` until 21:00Z (kanban #788, measured 2026-10-30
          // 03:0xZ: the 7 test host seats, which the day's poster does not reach, held none of 10-31's 12 series an hour after their
          // posting confirmed, every second-host seat listing them with ahead 0 - pulled only after their committee time)
          const notBegun = Number(s.startTimeMs) > now();
          if (!/^[0-9a-f]{64}$/.test(id) || have.has(id) || !(Number(s.ahead) > 0 || notBegun)) continue;
          if (!from.has(id)) from.set(id, []);
          from.get(id).push(u);
        }
      }));
      out.missing = from.size;
      // ONE PEER'S MADE-UP IDS DO NOT TAKE THE PASS (kanban #2424): ids more asked peers list go first, an id only one peer lists
      // spends that peer's share of the pass (perPass / peers asked), a peer whose lines fail peerStrikes times is not asked again
      // this pass for the ids only it lists, and the whole pass ends by passMs - not 15 s for each of 40 reads
      const order = [...from].map(([id, roots], i) => ({ id, roots, i })).sort((a, b) => (b.roots.length - a.roots.length) || (a.i - b.i));
      const share = Math.max(1, Math.ceil(perPass / Math.max(1, ask.length)));
      const solo = new Map(), strikes = new Map();
      const strike = (u) => strikes.set(u, (strikes.get(u) || 0) + 1);
      const endAt = Date.now() + passMs;
      let done = 0;
      for (const { id, roots } of order) {
        if (done >= perPass || Date.now() >= endAt) break;
        const r = refusedAt.get(id);
        if (r && now() - r.atMs < retryMs) continue;
        if (roots.length === 1) {
          const u = roots[0];
          if ((solo.get(u) || 0) >= share || (strikes.get(u) || 0) >= peerStrikes) continue;
          solo.set(u, (solo.get(u) || 0) + 1);
        }
        done++;
        let why = 'no peer answered its line';
        for (const u of roots) {
          const left = endAt - Date.now();
          if (left <= 0) break;
          let line = null;
          try { const res = await fetchFn(`${u}/series-template?id=${id}`, { signal: AbortSignal.timeout(Math.min(timeoutMs, left)) }); line = res.ok ? await res.text() : null; } catch { line = null; }
          if (!line) { strike(u); continue; }
          let t; try { t = parse(line.trim()); } catch (e) { strike(u); why = `its line did not read: ${e.message}`; continue; }
          // A LINE IS BELIEVED ONLY AS ITS OWN ID: whatever a peer sends, it must hash to the id asked for
          if (idOf(t) !== id) { strike(u); why = `${u} answered a line of another series`; continue; }
          let got; try { got = await take(t); } catch (e) { got = { ok: false, why: e.message }; }
          if (got && got.ok) { why = null; break; }
          why = (got && got.why) || 'refused';
          break;                       // the same line from another peer is refused the same way
        }
        if (why === null) { out.took++; refusedAt.delete(id); }
        else { refusedAt.set(id, { atMs: now(), why }); out.refused.push({ series: id.slice(0, 16), why: String(why).slice(0, 160) }); }
      }
      if (refusedAt.size > 5000) refusedAt.clear();
      if (out.took || out.refused.length) say(`[series] pulled from ${out.answered} of ${out.asked} node(s): ${out.took} taken, ${out.refused.length} not yet${out.refused.length ? ` (${out.refused[0].series}: ${out.refused[0].why})` : ''}`);
    } catch (e) { out.error = e.message; } finally { busy = false; }
    last = out;
    return out;
  };
  return { pass, last: () => last };
}
