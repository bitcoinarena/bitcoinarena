// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT PRESENTS ITS NOTES TO A LIQUIDATION (spec §23A.5 step 2): "The client does the rest on its own: on
// every start it presents each unspent note it holds for that federation, as it would present them to the federation itself."
//
// ONLY TO A LIQUIDATION THE ARBITRATION SET SIGNED, AT THE DOOR IT SIGNED (kanban #1148, the 2026-11-06 state-machine audit): it took the
// list and its `claims` URL from the first seat that answered, never passed the chain tip, and deleted the kept notes on a refusal's
// wording - so one seat listing { federation: <the player's>, claims: "https://attacker" } emptied the wallet into bearer e-cash posted there.
// Now a federation is acted on only when k of the chain's arbitration keys signed its liquidation event (arbitration-event.js
// standingLiquidation), the notes go only to the door that event names, the claim window is the signed halt height on the network's pinned
// clocks against the tip the page read, and a kept claim is TAKEN only when a later signed event lists this seed's payout key as accepted.
//
// ONE CLAIM, ONE RECORD, ONE TRANSITION FUNCTION (claimStep). Each state is written (putRoomy) before the step that cannot be undone:
//   none --(the intent written)--> intent --(sendAllEcash, the notes written)--> kept --(posted at the signed door, it answered ok)--> posted
//   intent --(the wallet held nothing / could not hand over)--> none;  kept|posted --(a signed event lists this payout key accepted)--> none
// A record that cannot be written stops the claim before the wallet is touched. Notes handed over that then cannot be written are taken
// back into the wallet (receiveEcash); a halted federation that cannot take them back has them presented at the signed door at once.
import { standingLiquidation, acceptedFor } from '../../arena-protocol/src/arbitration-event.js';
import { putRoomy } from './page-lock.js';
import { BOND_TERMS } from './committee.js';

const LIQUIDATION_ECASH_PREFIX = 'arena-liquidation-ecash-';   // the arena- names: was blwp- (moved once by movedKey, kanban #522)
export const pendingClaimKey = (fid, pk = null) => `${LIQUIDATION_ECASH_PREFIX}${String(fid).toLowerCase()}${pk ? '-' + String(pk).toLowerCase() : ''}`;
export const CLAIM_STATES = Object.freeze({ NONE: 'none', INTENT: 'intent', KEPT: 'kept', POSTED: 'posted' });
const CLAIM_EDGES = Object.freeze({ none: ['intent', 'kept'], intent: ['kept', 'none'], kept: ['posted', 'none'], posted: ['posted', 'none'] });
const REPOST_MS = 3600000;
// kanban #1837: an intent younger than this is another tab's hand-over in flight, not one a closed tab left (page-lock.js LOCK_INTENT_LIVE_MS)
export const CLAIM_INTENT_LIVE_MS = 120000;
/** The chain's arbitration set as standingLiquidation reads it: committee.js BOND_TERMS names its fields arbitrationKeys / arbitrationK. */
export const arbitrationOf = (network) => { const g = BOND_TERMS[network]; return g ? { keys: g.arbitrationKeys, k: g.arbitrationK } : null; };   // a posted claim not yet listed by the set is presented again at most hourly (the door answers "claimed before")

/** THE ONE TRANSITION: `rec` (or null) to state `to` with `patch`; null for none. Throws for a step the claim does not take. */
export function claimStep(rec, to, patch = {}) {
  const from = rec && rec.state ? rec.state : 'none';
  if (!(CLAIM_EDGES[from] || []).includes(to)) throw new Error(`a liquidation claim goes ${from} -> ${(CLAIM_EDGES[from] || []).join(' | ')}, not -> ${to}`);
  return to === 'none' ? null : { v: 2, ...(rec || {}), ...patch, state: to };
}

/** A kept record: v2 JSON, or the notes string an older page kept (read as kept). */
function readClaim(storage, key) {
  const raw = storage.getItem(movedKey(storage, key));
  if (!raw) return null;
  if (raw.startsWith('{')) { try { const r = JSON.parse(raw); if (r && r.v === 2 && r.state) return r; } catch { /* the older form */ } }
  return { v: 2, state: 'kept', ecash: raw, legacy: true };
}
// ONE RECORD PER FEDERATION AND PAYOUT KEY (kanban #1771, state audit 2026-11-12 SM2 page-3): the record was one per federation and named no
// phrase, so one browser's two phrases shared it - phrase P1's 'posted' record kept phrase P2's notes from ever being handed over (P2's tab
// read `taken` with its own key, saw 'posted', and only re-posted P1's notes under P2's key), and P2's notes were worthless once the window
// closed. Now every record names its payoutPk, and a phrase uses the plain key only when it is free or its own (an older record that names
// no key is read as this phrase's, as before); a record another key wrote stays for that key, and this phrase keeps its own at
// <key>.<16 hex of its key> - so each record is posted, and dropped as taken, only with the key it was written for.
export function claimSlot(storage, base, pk) {
  const own = `${base}.${String(pk).toLowerCase().slice(-64, -48)}`;
  if (storage.getItem(movedKey(storage, own)) != null) return own;
  const raw = storage.getItem(movedKey(storage, base));
  if (raw == null) return base;
  let owner = null;
  if (String(raw).startsWith('{')) { try { const j = JSON.parse(raw); owner = j && typeof j.payoutPk === 'string' ? j.payoutPk.toLowerCase() : null; } catch { owner = null; } }
  return !owner || owner === String(pk).toLowerCase() ? base : own;
}
const writeClaim = (storage, key, rec, put) => (rec === null ? storage.removeItem(key) : put(storage, key, JSON.stringify(rec)));

/**
 * `events`: the arbitration set's { event, signatures } rows a seat lists at GET /liquidations (any seat: it can withhold, not forge);
 * `network` the page's chain; `arbitration` { keys, k } the chain's arbitration set (committee.js BOND_TERMS); `held`: federation ids hex
 * this browser holds a wallet in; `walletFor(fid)`: the open lock client of that federation (sendAllEcash, receiveEcash, pendingOutputs);
 * `payoutPk`: the claim key hex (02/03 and x, or x), or `payoutPkFor(fid)`; `height`: the chain tip the page read - none, and nothing is handed over;
 * `storage`: getItem/setItem/removeItem; `verify(sig, msg, key)` the page's schnorr check (window.ARENA_CURVE.verify - this client carries no
 * crypto). `liquidations` (a seat's own list) is no longer read. Answers one row per federation acted on.
 */
export async function presentNotes({ events, network, arbitration = arbitrationOf(network), verify, held, walletFor, payoutPk = null,
  payoutPkFor = null, height, storage, fetcher = fetch, put = putRoomy, nowMs = Date.now() }) {
  const out = [];
  if (typeof verify !== 'function') return [{ ok: false, why: 'nothing handed over: no signature check was given to read the arbitration set with' }];
  const mine = [...new Set((held || []).map((f) => String(f).toLowerCase()))];
  const listed = [...new Set((events || []).filter((r) => r && r.event && r.event.kind === 'liquidation').map((r) => String(r.event.federation || '').toLowerCase()))];
  for (const fid of mine.filter((f) => listed.includes(f))) {
    const st = standingLiquidation({ events, federation: fid, network, keys: arbitration && arbitration.keys, k: arbitration && arbitration.k, verify });
    if (!st.ok) { out.push({ federation: fid, ok: false, why: `nothing handed over: ${st.why}` }); continue; }
    const pk = String(payoutPkFor ? payoutPkFor(fid) : payoutPk || '').toLowerCase();
    if (!/^(0[23])?[0-9a-f]{64}$/.test(pk)) { out.push({ federation: fid, ok: false, why: 'no payout key to claim to' }); continue; }
    const door = st.door + '/liquidation-claims';
    const taken = acceptedFor(st.event, pk).length > 0;
    // EVERY STEP A COMPARE-AND-SET ON THE STORED RECORD (kanban #1837, state audit 2026-11-12): a step wrote claimStep(the copy in memory) over
    // whatever was stored, so a second tab's hand-over (another phrase, the same federation) was written over by the first one's late `kept`, and
    // the notes that had left the second wallet were kept nowhere. A step now writes only when the stored record is still the one this pass read
    // or wrote last; otherwise it throws and the notes take the path of notes that cannot be written (back into the wallet, or the door now)
    const seen = new Map();
    const read = (key) => { const raw = storage.getItem(movedKey(storage, key)); seen.set(key, raw ?? null); return raw; };
    const step = (key, rec, to, patch) => {
      const next = claimStep(rec, to, patch);
      if (seen.has(key) && (storage.getItem(key) ?? null) !== seen.get(key)) throw new Error('another tab changed this claim record');
      writeClaim(storage, key, next, put); seen.set(key, next === null ? null : JSON.stringify(next)); return next;
    };

    // THE NOTES. ONE RECORD PER PHRASE (kanban #1771; #1837 found it again - merged in #1489 onto #1771's claimSlot): this payout key's own record
    const eKey = claimSlot(storage, pendingClaimKey(fid), pk);   // kanban #1771: this payout key's own record
    read(eKey);   // kanban #1837: the record this pass read, for the compare-and-set of every step
    let rec = readClaim(storage, eKey);
    // TAKEN ONLY WHEN IT WAS PRESENTED (kanban #1230, audit 3 #1210 FIXES-2): `taken` is read per payout key, and a notes record whose POST had
    // failed (kept, never presented) was dropped when the set accepted another claim of that key - the pending outputs', or an earlier one -
    // and the notes that had left the wallet were lost. A record the door never answered (no answer, or a 5xx) is presented again, whatever the
    // set lists for its key; one the door answered (taken, or refused as claimed before) is taken by the set's word
    if (rec && (rec.state === 'posted' || rec.answered) && taken) { step(eKey, rec, 'none'); out.push({ federation: fid, ok: true, taken: true, why: 'the arbitration set lists this claim as accepted' }); rec = undefined; }
    if (rec !== undefined) {
      const inWindow = Number.isInteger(height) && height >= st.window.opens && height <= st.window.closes;
      if (!Number.isInteger(height)) out.push({ federation: fid, ok: false, why: 'the chain tip is not known: nothing is handed over', kept: !!rec });
      else if (!inWindow && !rec) out.push({ federation: fid, ok: false, why: height < st.window.opens ? `claims open at ${st.window.opens}` : 'the claims closed' });
      else {
        // an intent left by a tab closed during the hand-over: what the wallet still holds is handed over again below
        // - and only one older than CLAIM_INTENT_LIVE_MS (kanban #1837): a younger one is another tab of this phrase handing over now
        let live = false;
        if (rec && rec.state === 'intent' && nowMs - Number(rec.atMs || 0) < CLAIM_INTENT_LIVE_MS) { live = true; out.push({ federation: fid, ok: false, why: 'another tab is handing these notes over now' }); }
        else if (rec && rec.state === 'intent') { rec = step(eKey, rec, 'none'); out.push({ federation: fid, ok: false, why: 'an earlier hand-over did not finish; the wallet hands over what it still holds' }); }
        if (!rec && inWindow && !live) {
          let wrote = false;
          try { rec = step(eKey, null, 'intent', { door: st.door, atMs: nowMs, payoutPk: pk }); wrote = true; }
          catch (e) { out.push({ federation: fid, ok: false, why: `nothing handed over: this browser could not write the claim first (${e.message})` }); }
          if (wrote) {
            let sent = null, w = null;
            try { w = await walletFor(fid); sent = JSON.parse(await w.sendAllEcash()); }
            catch (e) { try { rec = step(eKey, rec, 'none'); } catch { rec = null; } out.push({ federation: fid, ok: false, why: `the wallet could not hand over its notes: ${e.message}` }); }
            if (sent && !sent.ecash) { try { rec = step(eKey, rec, 'none'); } catch { /* another tab's record now: not ours to clear */ } rec = null; out.push({ federation: fid, ok: true, nothing: true, why: 'this wallet holds no note of that federation' }); }
            if (sent && sent.ecash) {
              try { rec = step(eKey, rec, 'kept', { ecash: sent.ecash }); }
              catch (e) {
                // THE NOTES LEFT THE WALLET AND CANNOT BE WRITTEN: back into the wallet, or - a halted federation - at the signed door now
                let back = false;
                try { if (w && typeof w.receiveEcash === 'function') { await w.receiveEcash(sent.ecash); back = true; } } catch { back = false; }
                if (back) { try { if ((storage.getItem(eKey) ?? null) === seen.get(eKey)) storage.removeItem(eKey); } catch { /* the intent stays: the next start finds the wallet holding them */ } out.push({ federation: fid, ok: false, why: `this browser could not keep the notes (${e.message}); they are back in the wallet` }); rec = null; }
                else rec = { v: 2, state: 'kept', ecash: sent.ecash, memoryOnly: true };
              }
            }
          }
        }
        if (rec && (rec.state === 'kept' || (rec.state === 'posted' && nowMs - Number(rec.postedAtMs || 0) >= REPOST_MS))) {
          try {
            const r = await fetcher(door, { method: 'POST', body: JSON.stringify({ federation: fid, ecash: rec.ecash, payoutPk: pk }), signal: AbortSignal.timeout(30000) });
            const j = await r.json().catch(() => ({}));
            if (r.ok && !rec.memoryOnly) rec = step(eKey, rec, 'posted', { door: st.door, postedAtMs: nowMs });
            // the door answered it (kanban #1230): a refusal is an answer too - the notes reached it - a 5xx is not. AND ONLY A REFUSAL OF THESE NOTES
            // (kanban #1264, audit 4 #1257 fixesA-2): the door's own "not taken" answers - the claim window not open yet at its tip, no seat holding the
            // federation HALTED yet, the notes not validated, a reissue refused, a tunnel's 4xx - took nothing, and counting them dropped the notes once
            // another claim of the key was accepted. An answer counts when it names the notes it refused (`refused`), as "claimed before" does
            else if (!r.ok && !(Number(r.status) >= 500) && Array.isArray(j.refused) && j.refused.length > 0 && !rec.memoryOnly && !rec.answered) { rec = { ...rec, answered: true }; try { if ((storage.getItem(eKey) ?? null) === seen.get(eKey)) { writeClaim(storage, eKey, rec, put); seen.set(eKey, JSON.stringify(rec)); } } catch { /* kept in memory */ } }
            out.push({ federation: fid, ok: !!r.ok, accepted: j.accepted || [], refused: j.refused || [], inWindow: j.inWindow, why: j.why || null, kept: !rec.memoryOnly, door: st.door,
              // kanban #1237: taken, and it waits for the federation's spent set
              ...(j.spentSetPublished === false ? { waitsForSpentSet: true } : {}), ...(rec.memoryOnly ? { memoryOnly: true } : {}) });
          } catch (e) { out.push({ federation: fid, ok: false, why: e.message, kept: !rec.memoryOnly, door: st.door }); }
        } else if (rec && rec.state === 'posted') out.push({ federation: fid, ok: true, posted: true, kept: true, why: 'presented; waiting for the arbitration set to list it', door: st.door });
      }
    }

    // AND THE OUTPUTS STILL IN ISSUANCE AT THE HALT (spec §23A.5 "Notes still in issuance at the halt", RULED 2026-10-14): what was issued to this
    // seed and never signed - the lock client's pendingOutputs - presented by their issuance requests, at the same signed door, kept the same way
    try {
      const pKey = claimSlot(storage, pendingRequestsKey(fid), pk);   // kanban #1771: per payout key, as the notes
      let prec = null;
      const raw = storage.getItem(movedKey(storage, pKey));
      seen.set(pKey, raw ?? null);
      if (raw) { try { const j = JSON.parse(raw); prec = Array.isArray(j) ? { v: 2, state: 'kept', reqs: j } : (j && j.v === 2 ? j : null); } catch { prec = null; } }
      if (prec && (prec.state === 'posted' || prec.answered) && taken) { step(pKey, prec, 'none'); prec = undefined; }
      if (prec !== undefined && Number.isInteger(height) && height >= st.window.opens && height <= st.window.closes) {
        if (!prec) {
          const w = await walletFor(fid);
          const reqs = w && typeof w.pendingOutputs === 'function' ? (JSON.parse(await w.pendingOutputs()) || []).map((x) => x.request).filter(Boolean) : [];
          if (reqs.length) prec = step(pKey, null, 'kept', { reqs, door: st.door, payoutPk: pk });
        }
        if (prec && (prec.state === 'kept' || (prec.state === 'posted' && nowMs - Number(prec.postedAtMs || 0) >= REPOST_MS))) {
          const r = await fetcher(door, { method: 'POST', body: JSON.stringify({ federation: fid, pending: prec.reqs, payoutPk: pk }), signal: AbortSignal.timeout(60000) });
          const j = await r.json().catch(() => ({}));
          if (r.ok) prec = step(pKey, prec, 'posted', { door: st.door, postedAtMs: nowMs });
          out.push({ federation: fid, pending: true, ok: !!r.ok, accepted: j.accepted || [], refused: j.refused || [], why: j.why || null, kept: true, door: st.door });
        }
      }
    } catch (e) { out.push({ federation: fid, pending: true, ok: false, why: e.message }); }
  }
  return out;
}
/**
 * THE ARBITRATION SET'S CLAIMS DOORS (kanban #1148): one per liquidation of `network` whose signed event stands - where this seed's payouts
 * are listed (GET /liquidation-payouts). A seat's `claims` field is not read: it is that seat operator's word.
 */
export function liquidationDoors({ events, network, arbitration = arbitrationOf(network), verify }) {
  if (typeof verify !== 'function') return [];
  const fids = [...new Set((events || []).filter((r) => r && r.event && r.event.kind === 'liquidation').map((r) => String(r.event.federation || '').toLowerCase()))];
  const doors = new Set();
  for (const fid of fids) {
    const st = standingLiquidation({ events, federation: fid, network, keys: arbitration && arbitration.keys, k: arbitration && arbitration.k, verify });
    if (st.ok) doors.add(st.door);
  }
  return [...doors];
}

export const pendingRequestsKey = (fid) => `arena-liquidation-pending-${String(fid).toLowerCase()}`;

// THE KEY A CLAIM IS PAID TO: one per federation, from the player's seed alone (the derivation of a round's player key over a
// round id of its own, H(tag || federation id)), so a seed restored on another device collects what the first presented.
// A payout is a pre-expired lock to refundKeyOf(that key), collected by Refund under it - as a slash payout is.
import { playerSecretFor } from '../../arena-protocol/src/player-key.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { movedKey } from './storage-keys.js';

export function liquidationKeyFor(seed, federationHex, curve) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('a claim key comes from the player\'s 32-byte seed');
  if (!curve || typeof curve.pointX !== 'function') throw new Error('a claim key is a key on a curve, and none was injected');
  const secret = playerSecretFor(seed, taggedHash('ARENA/v1/LiquidationKey', fromHex(String(federationHex).toLowerCase())), 0);
  const pubkey = curve.pointX(secret);
  return { secret, pubkey, payoutPk: toHex(refundKeyOf(pubkey)) };
}

/**
 * THE PAYOUTS OF A LIQUIDATION THAT NAME THIS SEED (`listed`: the arbitration set's GET /liquidation-payouts), each collected
 * by Refund into `client` - this player's wallet of the federation the payout was locked in - once (`storage` notes it).
 */
export async function collectLiquidationPayouts({ listed, seed, curve, clientFor, storage }) {
  const out = [];
  for (const p of (listed && listed.payouts) || []) {
    const key = liquidationKeyFor(seed, p.federation, curve);
    if (String(p.payoutPk).toLowerCase() !== key.payoutPk) continue;
    const note = movedKey(storage, `arena-liquidation-paid-${p.txid}:${p.outIdx}`);
    if (storage.getItem(note)) { out.push({ ...p, ok: true, kept: true }); continue; }
    const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(p.msat), claimPk: key.payoutPk, refundPk: key.payoutPk, expiration: 0 };
    try {
      const client = await clientFor(p.into);
      const said = JSON.parse(await client.refund(p.txid, Number(p.outIdx), JSON.stringify(fields), toHex(key.secret)));
      if (said.accepted === true) storage.setItem(note, JSON.stringify({ msat: p.msat, at: Date.now() }));
      out.push({ ...p, ok: said.accepted === true, why: said.accepted === true ? null : (said.error || 'the federation did not accept the refund') });
    } catch (e) { out.push({ ...p, ok: false, why: e.message }); }
  }
  return out;
}
