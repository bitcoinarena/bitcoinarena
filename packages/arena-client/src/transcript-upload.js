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
// whole ask - and with it the page's "keep this tab open" - for ever, while the other seats held the run. A node that has not answered,
// body read, within this many ms is counted as unanswered and the others decide.
export const NODE_WAIT_MS = 8000;

/**
 * `nodes` the committee's bases; `finalTick` the run's last tick (the client's own count); `mirror` an optional base. Answers
 * { safe, holders: [base], hash, ticks, mirrored, why }.
 */
export async function secureTranscript({ roundId, entryId, nodes, finalTick, mirror = null, fetcher = fetch, need = NODES_HOLDING, waitMs = NODE_WAIT_MS } = {}) {
  const q = `round=${toHex(roundId)}&entry=${toHex(entryId)}`;
  const said = [];
  const held = await Promise.all([...new Set(nodes || [])].map(async (base) => {
    // kanban #1508: the fetch and its body read race one timer; the abort also ends a fetcher that honours the signal
    const ac = new AbortController();
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => { ac.abort(); no(new Error(`no answer in ${waitMs} ms`)); }, waitMs); });
    try {
      return await Promise.race([late, (async () => {
        const r = await fetcher(`${String(base).replace(/\/+$/, '')}/transcript?${q}`, { signal: ac.signal });
        if (!r.ok) { said.push(`${base}: ${r.status}`); return null; }
        const ticks = Number(r.headers.get('x-ticks')), hash = String(r.headers.get('x-transcript-hash') || '').toLowerCase();
        return { base, ticks, hash, bytes: new Uint8Array(await r.arrayBuffer()) };
      })()]);
    } catch (e) { said.push(`${base}: ${e.message}`); return null; }
    finally { clearTimeout(timer); }
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
    const copy = best.find((h) => { try { return toHex(transcriptHash(decodeTranscript(h.bytes))) === h.hash; } catch { return false; } });
    if (!copy) mirrorWhy = 'no node\'s bytes hash to the transcript the nodes agree on';
    else {
      try {
        const r = await fetcher(`${String(mirror).replace(/\/+$/, '')}/transcript?${q}`, { method: 'POST', body: copy.bytes });
        mirrored = r.ok; if (!r.ok) mirrorWhy = `the mirror answered ${r.status}`;
      } catch (e) { mirrorWhy = e.message; }
    }
  }
  return { safe: true, need, holders: best.map((h) => h.base), hash: best[0].hash, ticks: best[0].ticks, mirrored,
    why: `${best.length} committee nodes hold the whole transcript${mirror ? (mirrored ? ', and the mirror took it' : ` (mirror: ${mirrorWhy})`) : ''}` };
}
