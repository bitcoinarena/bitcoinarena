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

export function createSeriesPull({ peers, held, take, parse, idOf, fetchFn = fetch, say = () => {}, now = Date.now,
  perPass = PULL_PER_PASS, askPeers = PULL_PEERS, retryMs = RETRY_MS, timeoutMs = 15000 }) {
  const refusedAt = new Map();         // series id hex -> { atMs, why }
  let busy = false, start = 0, last = null;
  const json = async (u) => { const r = await fetchFn(u, { signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? r.json() : null; };

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
          // a series whose rounds have all started is of no use here any more
          if (!/^[0-9a-f]{64}$/.test(id) || have.has(id) || !(Number(s.ahead) > 0)) continue;
          if (!from.has(id)) from.set(id, []);
          from.get(id).push(u);
        }
      }));
      out.missing = from.size;
      let done = 0;
      for (const [id, roots] of from) {
        if (done >= perPass) break;
        const r = refusedAt.get(id);
        if (r && now() - r.atMs < retryMs) continue;
        done++;
        let why = 'no peer answered its line';
        for (const u of roots) {
          let line = null;
          try { const res = await fetchFn(`${u}/series-template?id=${id}`, { signal: AbortSignal.timeout(timeoutMs) }); line = res.ok ? await res.text() : null; } catch { line = null; }
          if (!line) continue;
          let t; try { t = parse(line.trim()); } catch (e) { why = `its line did not read: ${e.message}`; continue; }
          // A LINE IS BELIEVED ONLY AS ITS OWN ID: whatever a peer sends, it must hash to the id asked for
          if (idOf(t) !== id) { why = `${u} answered a line of another series`; continue; }
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
