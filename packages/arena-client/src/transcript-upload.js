// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RUN IS SAFE BEFORE THE VICTORY SCREEN (§13A "Client duty"): "on delivery, the reference client uploads its complete
// transcript to at least two committee nodes and, if configured, to an independent mirror before showing the victory screen. This is
// what makes the veto work for a player who closes the browser immediately afterwards."
//
// The batches already stream to the seats live, so "uploads" is checked, not repeated: each committee node is asked for the transcript
// it holds (GET /transcript: its bytes, x-transcript-hash, x-ticks); the run is safe once AT LEAST TWO hold the same transcript - one
// hash - reaching the run's last tick. The mirror, when one is configured, is handed those bytes, after they are checked against the
// hash the nodes agree on. Until two agree the page holds the victory screen and says why.
import { decodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { SETTLEMENT_THRESHOLD } from '../../arena-protocol/src/payout.js';

// AS MANY AS SETTLE THE ROUND (2026-10-30: "0 of 2 macht gar keinen sinn"): the two was the two-node test network's; a run fewer than five signer nodes hold cannot settle
export const NODES_HOLDING = SETTLEMENT_THRESHOLD;
// kanban #1508: EACH NODE GETS A BOUNDED WAIT. One seat that takes GET /transcript and never answers (or dribbles the body) held the
// whole ask - and with it the page's "keep this tab open" - for ever, while the other seats held the run. A node whose answer (its
// status and headers) has not come within this many ms is counted as unanswered and the others decide. kanban #1868: the bound is on
// the ANSWER and on a body that STALLS this long, never on the whole transfer - an honest seat still sending on a slow link is not silent.
export const NODE_WAIT_MS = 8000;

/**
 * `nodes` the committee's bases; `finalTick` the run's last tick (the client's own count); `mirror` an optional base. Answers
 * { safe, holders: [base], hash, ticks, mirrored, why }.
 */
export async function secureTranscript({ roundId, entryId, nodes, finalTick, mirror = null, fetcher = fetch, need = NODES_HOLDING, waitMs = NODE_WAIT_MS } = {}) {
  const q = `round=${toHex(roundId)}&entry=${toHex(entryId)}`;
  const said = [];
  // kanban #1508, #1687: every request this function makes - each node's GET /transcript and the mirror's POST - races one timer for
  // its answer; the abort also ends a fetcher that honours the signal. Kept inside the function: the page runs this function out of
  // the bundle, and the #1687 check runs exactly that text.
  // kanban #1868: the timer covers time to the answer only. Which transcript a node holds is in its answer's headers (x-transcript-hash,
  // x-ticks - the same headers the count always rested on), so the count reads no body at all and drops each one at once: before, one
  // 8 s timer ran over all seven ~117 KB bodies arriving together on one link, and below ~0.8 Mbit/s every honest seat was cut off as
  // "no answer" on every try, a run all seven hold reported not held. Bytes are read only for the mirror, one holder at a time, bounded
  // by a stall (no byte for waitMs) and a total of 8 x waitMs, so a seat that dribbles cannot hold "safe" either.
  const bounded = async (url, init) => {
    const ac = new AbortController();
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => { ac.abort(); no(new Error(`no answer in ${waitMs} ms`)); }, waitMs); });
    try { return { r: await Promise.race([late, fetcher(url, { ...init, signal: ac.signal })]), ac }; }
    catch (e) { ac.abort(); throw e; }
    finally { clearTimeout(timer); }
  };
  const readBytes = async (r, ac) => {
    let stall, total, cut;
    const stop = new Promise((_, no) => { cut = (why) => { ac.abort(); no(new Error(why)); }; });
    const poke = () => { clearTimeout(stall); stall = setTimeout(() => cut(`body stalled for ${waitMs} ms`), waitMs); };
    poke();
    total = setTimeout(() => cut(`body not read in ${8 * waitMs} ms`), 8 * waitMs);
    const read = (async () => {
      const reader = r.body && typeof r.body.getReader === 'function' ? r.body.getReader() : null;
      if (!reader) return new Uint8Array(await r.arrayBuffer());
      const parts = []; let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        poke(); parts.push(value); n += value.length;
      }
      const out = new Uint8Array(n); let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    })();
    try { return await Promise.race([stop, read]); }
    finally { clearTimeout(stall); clearTimeout(total); }
  };
  // a body the count does not need is cancelled, not aborted: an abort after the answer would also reject a body nobody reads
  const drop = (r) => { try { const c = r && r.body && typeof r.body.cancel === 'function' ? r.body.cancel() : null; if (c && c.catch) c.catch(() => {}); } catch { /* nothing to drop */ } };
  const getFrom = (base) => bounded(`${String(base).replace(/\/+$/, '')}/transcript?${q}`, {});
  const held = await Promise.all([...new Set(nodes || [])].map(async (base) => {
    try {
      const { r } = await getFrom(base);
      drop(r);   // kanban #1868: the count needs the headers only; the body is not downloaded
      if (!r.ok) { said.push(`${base}: ${r.status}`); return null; }
      const ticks = Number(r.headers.get('x-ticks')), hash = String(r.headers.get('x-transcript-hash') || '').toLowerCase();
      return { base, ticks, hash };
    } catch (e) { said.push(`${base}: ${e.message}`); return null; }
  }));
  const groups = new Map();
  for (const h of held) {
    if (!h || !/^[0-9a-f]{64}$/.test(h.hash)) continue;
    if (!(h.ticks >= finalTick)) { said.push(`${h.base}: holds ${h.ticks} of ${finalTick} ticks`); continue; }
    if (!groups.has(h.hash)) groups.set(h.hash, []);
    groups.get(h.hash).push(h);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
  if (best.length < need)
    return { safe: false, need, holders: best.map((h) => h.base), hash: best[0] ? best[0].hash : null, ticks: best[0] ? best[0].ticks : null, mirrored: false,
      why: `${best.length} of the ${need} committee nodes the run needs hold its whole transcript (${said.join('; ') || 'no answer'})` };
  let mirrored = false, mirrorWhy = null;
  if (mirror) {
    // kanban #1868: one holder's bytes at a time (the link is not split seven ways), checked against the agreed hash before the POST
    let copy = null;
    for (const h of best) {
      try {
        const { r, ac } = await getFrom(h.base);
        if (!r.ok) { drop(r); continue; }
        const bytes = await readBytes(r, ac);
        if (toHex(transcriptHash(decodeTranscript(bytes))) === h.hash) { copy = { ...h, bytes }; break; }
      } catch { /* the next holder */ }
    }
    if (!copy) mirrorWhy = 'no node\'s bytes hash to the transcript the nodes agree on';
    else {
      try {
        // kanban #1687: a mirror that takes the POST and never answers no longer holds "safe" once the nodes agree
        const { r } = await bounded(`${String(mirror).replace(/\/+$/, '')}/transcript?${q}`, { method: 'POST', body: copy.bytes });
        drop(r);
        mirrored = r.ok; if (!r.ok) mirrorWhy = `the mirror answered ${r.status}`;
      } catch (e) { mirrorWhy = e.message; }
    }
  }
  return { safe: true, need, holders: best.map((h) => h.base), hash: best[0].hash, ticks: best[0].ticks, mirrored,
    why: `${best.length} committee nodes hold the whole transcript${mirror ? (mirrored ? ', and the mirror took it' : ` (mirror: ${mirrorWhy})`) : ''}` };
}
