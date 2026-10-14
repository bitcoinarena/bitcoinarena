// THE RUN IS SAFE BEFORE THE VICTORY SCREEN (§13A "Client duty", kanban #315): "on delivery, the reference client uploads its complete
// transcript to at least two committee nodes and, if configured, to an independent mirror before showing the victory screen. This is
// what makes the veto work for a player who closes the browser immediately afterwards."
//
// The batches already stream to the seats live, so "uploads" is checked, not repeated: each committee node is asked for the transcript
// it holds (GET /transcript: its bytes, x-transcript-hash, x-ticks); the run is safe once AT LEAST TWO hold the same transcript - one
// hash - reaching the run's last tick. The mirror, when one is configured, is handed those bytes, after they are checked against the
// hash the nodes agree on. Until two agree the page holds the victory screen and says why.
import { decodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export const NODES_HOLDING = 2;

/**
 * `nodes` the committee's bases; `finalTick` the run's last tick (the client's own count); `mirror` an optional base. Answers
 * { safe, holders: [base], hash, ticks, mirrored, why }.
 */
export async function secureTranscript({ roundId, entryId, nodes, finalTick, mirror = null, fetcher = fetch } = {}) {
  const q = `round=${toHex(roundId)}&entry=${toHex(entryId)}`;
  const said = [];
  const held = await Promise.all([...new Set(nodes || [])].map(async (base) => {
    try {
      const r = await fetcher(`${String(base).replace(/\/+$/, '')}/transcript?${q}`);
      if (!r.ok) { said.push(`${base}: ${r.status}`); return null; }
      const ticks = Number(r.headers.get('x-ticks')), hash = String(r.headers.get('x-transcript-hash') || '').toLowerCase();
      return { base, ticks, hash, bytes: new Uint8Array(await r.arrayBuffer()) };
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
  if (best.length < NODES_HOLDING)
    return { safe: false, holders: best.map((h) => h.base), hash: best[0] ? best[0].hash : null, ticks: best[0] ? best[0].ticks : null, mirrored: false,
      why: `${best.length} of the ${NODES_HOLDING} committee nodes the run needs hold its whole transcript (${said.join('; ') || 'no answer'})` };
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
  return { safe: true, holders: best.map((h) => h.base), hash: best[0].hash, ticks: best[0].ticks, mirrored,
    why: `${best.length} committee nodes hold the whole transcript${mirror ? (mirrored ? ', and the mirror took it' : ` (mirror: ${mirrorWhy})`) : ''}` };
}
