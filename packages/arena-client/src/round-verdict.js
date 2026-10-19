// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO WON THE ROUND, AS THE CLIENT SHOWS IT (§13 RoundResult): "what every client shows as THE BULLS WIN / THE
// BEARS WIN, the same for every player in the round, whenever they drove". Each seat answers its own signed result at
// GET /round-result once the round has ended; the client takes the one result that `threshold` distinct keys of the round's
// settlement committee - the committee THIS client derived, never a seat's word for it - signed, and shows nothing otherwise.
import { roundResultStands, frontOf, frontName } from '../../arena-protocol/src/round-result.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';

const VERDICT_WORDS = Object.freeze({ BULLS: 'THE BULLS WIN', BEARS: 'THE BEARS WIN', FLAT: 'NOBODY WINS: THE PRICE CLOSED WHERE IT OPENED' });
const verdictPct = (open, close) => `${close >= open ? '+' : ''}${(((close - open) / open) * 100).toFixed(2)}%`;

/**
 * `roundId` 32 bytes; `nodes` the seats' base URLs; `committee` the settlement committee's keys (hex or bytes) this client
 * derived; `verify(signature, message, key)` BIP-340. Answers { ok, front, openCents, closeCents, says, signers } or why not.
 */
export async function roundVerdict({ roundId, nodes, committee, verify, threshold = null, fetcher = fetch, timeoutMs = 8000 }) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) return { ok: false, why: 'no 32-byte round id' };
  if (!Array.isArray(committee) || !committee.length) return { ok: false, why: 'no settlement committee to count signatures against' };
  let need = threshold;
  if (!Number.isInteger(need)) { try { need = receiptsNeeded(committee.length); } catch { need = committee.length; } }
  const hex = Array.from(roundId, (b) => b.toString(16).padStart(2, '0')).join('');
  const byResult = new Map();   // `${open}:${close}` -> { openCents, closeCents, sigs }
  const said = [];
  await Promise.all((nodes || []).map(async (base) => {
    try {
      const r = await fetcher(`${String(base).replace(/\/+$/, '')}/round-result?round=${hex}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { said.push(`${base}: ${(await r.text()).slice(0, 120)}`); return; }
      const j = await r.json();
      if (!Number.isInteger(j.openCents) || !Number.isInteger(j.closeCents) || !j.key || !j.signature) return;
      const k = `${j.openCents}:${j.closeCents}`;
      if (!byResult.has(k)) byResult.set(k, { openCents: j.openCents, closeCents: j.closeCents, sigs: [] });
      byResult.get(k).sigs.push({ key: j.key, signature: j.signature });
    } catch (e) { said.push(`${base}: ${e.message}`); }
  }));
  for (const x of byResult.values()) {
    const front = frontOf(x.openCents, x.closeCents);
    const st = roundResultStands({ result: { roundId, openCents: x.openCents, closeCents: x.closeCents, front }, sigs: x.sigs, committee, threshold: need, verify });
    if (!st.ok) continue;
    const name = frontName(front);
    return { ok: true, front: name, openCents: x.openCents, closeCents: x.closeCents, says: `${VERDICT_WORDS[name]} (${verdictPct(x.openCents, x.closeCents)})`, signers: st.signed.length, needed: need };
  }
  const best = Math.max(0, ...[...byResult.values()].map((x) => x.sigs.length));
  return { ok: false, why: byResult.size ? `no result is signed by ${need} of the committee (at most ${best} agree)` : `no seat has a result yet${said.length ? `: ${said[0]}` : ''}` };
}
