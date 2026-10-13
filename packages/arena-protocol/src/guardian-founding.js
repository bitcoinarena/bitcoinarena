// WHO THE GUARDIANS ARE: FOUNDING BY SORTITION (§23A.2, kanban #320). "Bond-weighted stateless sortition, §5A.6 unchanged, with the beacon
// block after trigger_height and the tag 'BLWP/v1/GUARDIAN', over the guardian-capable census minus operators already guarding an OPEN
// federation, one ticket per operator. federation_nominal are drawn, then three alternates in order. Nobody hand-picks." A drawn guardian
// that does not take part within founding_window is a no-show, replaced by the next alternate in order.
//
// Eligible: a bonded census node advertising guardian_capable and a guardian_endpoint, with a bond of at least bond_min_guardian, of an
// operator not guarding an OPEN federation; one ticket per operator (its lowest outpoint, its bonds summed into its weight).
import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt, toHex } from './hash.js';
import { TAG } from './constants.js';
import { weightOf } from './sortition.js';

export const ALTERNATES = 3;

const outpointOrder = (a, b) => { const x = toHex(a.txid) + ':' + a.vout, y = toHex(b.txid) + ':' + b.vout; return x < y ? -1 : x > y ? 1 : 0; };

/** One operator's ticket on the founding's seed: H_tag(seed || its lowest bond outpoint). */
export function guardianTicket(seed, entry) {
  const w = new Writer(); w.bytes32(seed); w.bytes32(entry.txid); w.u32(entry.vout);
  return bytesToBigInt(taggedHash(TAG.guardianTicket, w.finish()));
}

/**
 * THE FOUNDING DRAW. `entries` census entries ({ pubkey, txid, vout, bondSats, advert: { operatorId, guardianCapable, guardianEndpoint } });
 * `seed` the beacon block hash after trigger_height (32 bytes); `nominal` federation_nominal; `bondMinGuardian`; `guardingOpen` the
 * operator ids already guarding an OPEN federation. Answers { ok, drawn: [entry], alternates: [entry], eligible, why }.
 */
export function drawGuardians({ entries, seed, nominal, bondMinGuardian, guardingOpen = new Set() }) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) return { ok: false, why: 'a founding is drawn on the beacon after its trigger height' };
  if (typeof bondMinGuardian !== 'bigint' || bondMinGuardian <= 0n) return { ok: false, why: 'bond_min_guardian is a positive floor' };
  const byOp = new Map();
  for (const e of entries || []) {
    const a = e && e.advert;
    if (!a || a.guardianCapable !== true || !a.guardianEndpoint) continue;
    const op = String(a.operatorId || toHex(e.pubkey));
    if (guardingOpen.has(op)) continue;
    const had = byOp.get(op);
    if (!had) { byOp.set(op, { entry: e, bondSats: BigInt(e.bondSats) }); continue; }
    had.bondSats += BigInt(e.bondSats);
    if (outpointOrder(e, had.entry) < 0) had.entry = e;
  }
  const pool = [...byOp.values()].filter((x) => x.bondSats >= bondMinGuardian);
  if (pool.length < nominal)
    return { ok: false, eligible: pool.length, why: `${pool.length} guardian-capable operators hold bond_min_guardian and none guards an OPEN federation: a federation of ${nominal} is not founded with fewer` };
  const scored = pool.map((x) => ({ entry: x.entry, ticket: guardianTicket(seed, x.entry), weight: weightOf(x.bondSats, bondMinGuardian) }))
    .sort((a, b) => { const l = a.ticket * b.weight, r = b.ticket * a.weight; return l < r ? -1 : l > r ? 1 : outpointOrder(a.entry, b.entry); });
  return { ok: true, eligible: pool.length, drawn: scored.slice(0, nominal).map((s) => s.entry), alternates: scored.slice(nominal, nominal + ALTERNATES).map((s) => s.entry),
    why: `${nominal} drawn of ${pool.length} eligible operators, ${Math.min(ALTERNATES, pool.length - nominal)} alternates in order` };
}

/**
 * A NO-SHOW REPLACED: the drawn set after `noShows` (node keys hex that did not take part within founding_window) - each seat of a
 * no-show to the next alternate in order. Answers { ok, seated, used, why }; not ok when the alternates run out.
 */
export function replaceNoShows({ drawn, alternates, noShows }) {
  const out = new Set((noShows || []).map((k) => String(k).toLowerCase()));
  const queue = (alternates || []).filter((e) => !out.has(toHex(e.pubkey)));
  const seated = [];
  let used = 0;
  for (const e of drawn) {
    if (!out.has(toHex(e.pubkey))) { seated.push(e); continue; }
    const next = queue.shift();
    if (!next) return { ok: false, seated, used, why: 'more no-shows than alternates: the founding is drawn again at the next trigger' };
    seated.push(next); used++;
  }
  return { ok: true, seated, used, why: used ? `${used} no-show${used === 1 ? '' : 's'} replaced by the alternates in order` : 'every drawn guardian took part' };
}
