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
//   kept|posted --(the door: not being liquidated any more, the notes received back into the wallet)--> none   (kanban #1849)
// A TAKEN CLAIM KEEPS ITS NOTES UNTIL IT IS PAID OR THEY ARE BACK (kanban #2196, #2292; a44 refute of #1849): a claim the set listed as
// accepted was dropped with its e-cash, and a federation that came back before the window's end was never liquidated - plan() paid nothing,
// the set's book keeps only nonces, and the notes were out of the wallet for good. Its notes now move to takenClaimKey (written before the
// record is dropped) and stay there until GET /liquidation-payouts names this key, or until they are received back into the wallet after the
// door's 409 "not being liquidated". A RETURN NEVER STALLS THE PASS (kanban #2196): the door answers that 409 also while the federation is
// still halted (no seat has taken its HALTED record yet), and the lock client's receiveEcash then never answers - so the return waits at most
// returnWaitMs; it goes on in the background (one per e-cash string) and lets the notes go only once the wallet says Success/AlreadyReceived.
// A record that cannot be written stops the claim before the wallet is touched. Notes handed over that then cannot be written are taken
// back into the wallet (receiveEcash); a halted federation that cannot take them back has them presented at the signed door at once.
import { standingLiquidation, acceptedFor } from '../../arena-protocol/src/arbitration-event.js';
import { putRoomy } from './page-lock.js';
import { BOND_TERMS } from './committee.js';

const LIQUIDATION_ECASH_PREFIX = 'arena-liquidation-ecash-';   // the arena- names: was blwp- (moved once by movedKey, kanban #522)
export const pendingClaimKey = (fid, pk = null) => `${LIQUIDATION_ECASH_PREFIX}${String(fid).toLowerCase()}${pk ? '-' + String(pk).toLowerCase() : ''}`;
/** kanban #1849: the halt height a federation came back from after this page handed its notes over (they were received back). */
export const returnedClaimKey = (fid) => `arena-liquidation-returned-${String(fid).toLowerCase()}`;
export const CLAIM_STATES = Object.freeze({ NONE: 'none', INTENT: 'intent', KEPT: 'kept', POSTED: 'posted' });
const CLAIM_EDGES = Object.freeze({ none: ['intent', 'kept'], intent: ['kept', 'none'], kept: ['posted', 'none'], posted: ['posted', 'none'] });
const REPOST_MS = 3600000;
/** kanban #2196: the notes of claims the set listed as accepted, per federation and payout key, until paid or back in the wallet. */
export const takenClaimKey = (fid, pk) => `arena-liquidation-taken-${String(fid).toLowerCase()}.${String(pk).toLowerCase().slice(-64, -48)}`;
/** kanban #2196: how long one pass waits for a return into the wallet; a halted federation's receive never answers. */
export const RETURN_WAIT_MS = 2000;
const RETURNING = new Map();   // e-cash string -> the receive in flight (one per string, whichever pass started it)
function readTaken(storage, key) {
  try { const j = JSON.parse(storage.getItem(key) || 'null'); return j && Array.isArray(j.items) ? j.items.filter((x) => x && typeof x.ecash === 'string') : []; } catch { return []; }
}
/** The door's own "this federation is not being liquidated" (409, no note named as refused): the notes may come back into the wallet. */
const notLiquidated = (r, j) => !r.ok && Number(r.status) === 409 && !(Array.isArray(j.refused) && j.refused.length) && /not being liquidated/.test(String(j.why || ''));
/**
 * kanban #2196: receive `ecash` back into wallet `w`, waiting at most `waitMs`. `onBack(state)` runs once the wallet answers
 * Success/AlreadyReceived - in this pass, or later in the background. Answers the state if it was back in time, else null.
 */
async function returnToWallet(w, ecash, waitMs, onBack) {
  if (!w || typeof w.receiveEcash !== 'function') return null;
  let p = RETURNING.get(ecash);
  if (!p) {
    p = (async () => {
      try { const got = JSON.parse(await w.receiveEcash(ecash)); return got && (got.state === 'Success' || got.state === 'AlreadyReceived') ? got.state : null; } catch { return null; }
    })();
    RETURNING.set(ecash, p);
    p.then((back) => { RETURNING.delete(ecash); if (back) { try { onBack(back); } catch { /* the next pass sees the notes again and AlreadyReceived */ } } });
  }
  let t = null;
  try { return await Promise.race([p, new Promise((res) => { t = setTimeout(() => res(null), waitMs); })]); } finally { clearTimeout(t); }
}
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
  payoutPkFor = null, height, storage, fetcher = fetch, put = putRoomy, nowMs = Date.now(), returnWaitMs = RETURN_WAIT_MS }) {
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
    // kanban #2196: the halt this pass reads, and where a return into the wallet is noted (the taken notes below use them too)
    const returnedKey = returnedClaimKey(fid);
    const haltH = st.event && st.event.halt ? Number(st.event.halt.height) : null;
    // TAKEN ONLY WHEN IT WAS PRESENTED (kanban #1230, audit 3 #1210 FIXES-2): `taken` is read per payout key, and a notes record whose POST had
    // failed (kept, never presented) was dropped when the set accepted another claim of that key - the pending outputs', or an earlier one -
    // and the notes that had left the wallet were lost. A record the door never answered (no answer, or a 5xx) is presented again, whatever the
    // set lists for its key; one the door answered (taken, or refused as claimed before) is taken by the set's word
    const tKey = takenClaimKey(fid, pk);
    // TAKEN, THE NOTES KEPT UNTIL PAID OR BACK (kanban #2196, #2292): written to tKey first; a record whose notes cannot be kept stays as it is
    if (rec && (rec.state === 'posted' || rec.answered) && taken) {
      let keptTaken = !rec.ecash;
      if (rec.ecash) {
        try {
          const items = readTaken(storage, tKey);
          if (!items.some((x) => x.ecash === rec.ecash)) items.push({ ecash: rec.ecash, haltHeight: haltH, door: st.door, postedAtMs: Number(rec.postedAtMs || 0), atMs: nowMs });
          put(storage, tKey, JSON.stringify({ v: 1, items })); keptTaken = true;
        } catch { keptTaken = false; }
      }
      if (keptTaken) { step(eKey, rec, 'none'); out.push({ federation: fid, ok: true, taken: true, why: 'the arbitration set lists this claim as accepted' }); }
      else out.push({ federation: fid, ok: false, why: 'the arbitration set lists this claim as accepted; this browser could not keep its notes until the payout, so the record stays' });
      rec = undefined;
    }
    // THE TAKEN NOTES (kanban #2196): let go once the set lists the payout naming this key; presented again hourly, and received back into the
    // wallet when the door answers that the federation is not being liquidated any more (it came back before the payout)
    const tookRows = [];   // its rows follow the hand-over's, so a pass still answers first what it did with the wallet
    const takenItems = readTaken(storage, tKey);
    if (takenItems.length) {
      let paid = false;
      try {
        const r = await fetcher(`${st.door}/liquidation-payouts?federation=${fid}`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (r && r.ok) { const j = await r.json(); paid = ((j && j.payouts) || []).some((p) => p && String(p.federation).toLowerCase() === fid && String(p.payoutPk).toLowerCase() === pk); }
      } catch { paid = false; }
      if (paid) { try { storage.removeItem(tKey); } catch { /* read again next pass */ } tookRows.push({ federation: fid, ok: true, paid: true, why: 'the payout of this claim is listed: the taken notes are let go', door: st.door }); }
      else {
        for (const it of takenItems) {
          if (nowMs - Number(it.postedAtMs || 0) < REPOST_MS) { tookRows.push({ federation: fid, ok: true, taken: true, kept: true, why: 'accepted; waiting for the payout', door: st.door }); continue; }
          try {
            const r = await fetcher(door, { method: 'POST', body: JSON.stringify({ federation: fid, ecash: it.ecash, payoutPk: pk }), signal: AbortSignal.timeout(30000) });
            const j = await r.json().catch(() => ({}));
            try { put(storage, tKey, JSON.stringify({ v: 1, items: readTaken(storage, tKey).map((x) => (x.ecash === it.ecash ? { ...x, postedAtMs: nowMs } : x)) })); } catch { /* presented again next pass */ }
            let back = null;
            if (notLiquidated(r, j)) {
              const w = await Promise.resolve().then(() => walletFor(fid)).catch(() => null);
              back = await returnToWallet(w, it.ecash, returnWaitMs, () => {
                try { put(storage, returnedKey, JSON.stringify({ haltHeight: it.haltHeight, atMs: nowMs })); } catch { /* the next pass hands over and takes back again */ }
                const left = readTaken(storage, tKey).filter((x) => x.ecash !== it.ecash);
                if (left.length) put(storage, tKey, JSON.stringify({ v: 1, items: left })); else storage.removeItem(tKey);
              });
            }
            tookRows.push(back ? { federation: fid, ok: true, returned: true, why: 'that federation is not being liquidated any more: the taken notes are back in the wallet', door: st.door }
              : { federation: fid, ok: true, taken: true, kept: true, why: j.why || 'accepted; waiting for the payout', door: st.door });
          } catch (e) { tookRows.push({ federation: fid, ok: false, taken: true, kept: true, why: e.message, door: st.door }); }
        }
      }
    }
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
        // ONE RETURN PER HALT (kanban #1849): notes taken back because the federation came back are not handed over again for the same signed
        // halt - the event still stands, and every pass would empty the wallet into a door that takes nothing
        let returnedHalt = null;
        try { returnedHalt = JSON.parse(storage.getItem(returnedKey) || 'null'); } catch { returnedHalt = null; }
        if (!rec && inWindow && !live && returnedHalt && Number(returnedHalt.haltHeight) === haltH) out.push({ federation: fid, ok: true, returned: true, why: 'that federation came back from this halt: nothing is handed over again' });
        else if (!rec && inWindow && !live) {
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
            // THE FEDERATION CAME BACK BEFORE THE PAYOUT (kanban #1849, state audit 2026-11-12): once 2f + 1 guardians return, no seat lists it
            // HALTED, the door answers "not being liquidated" (409, no note refused), plan() pays nothing, and the set's book keeps only nonces -
            // no e-cash it could redeem - so a kept/posted record held the player's whole balance out of the wallet for good. Not accepted for
            // this key, the kept notes are received back into the wallet; the record goes to none only on Success/AlreadyReceived (this
            // wallet's own receive - a federation that is still halted cannot reissue, and the record stays). Reissued, their nonces are
            // spent, so a later liquidation's spent set refuses the set's stale rows of them.
            // kanban #2196: also a claim of a key the set accepted another claim of (these notes were never answered), and never longer than
            // returnWaitMs - the door says this also while the federation is still halted, and a halted federation's receive never answers;
            // the record goes only when the wallet says the notes are back (now, or later in the background) and still holds these notes
            let back = null;
            if (notLiquidated(r, j)) {
              const ecash = rec.ecash, memoryOnly = !!rec.memoryOnly;
              const w = await Promise.resolve().then(() => walletFor(fid)).catch(() => null);
              back = await returnToWallet(w, ecash, returnWaitMs, () => {
                try { put(storage, returnedKey, JSON.stringify({ haltHeight: haltH, atMs: nowMs })); } catch { /* the next pass hands over and takes back again */ }
                if (memoryOnly) return;
                const now = readClaim(storage, eKey);
                if (now && now.ecash === ecash && (now.state === 'kept' || now.state === 'posted')) storage.removeItem(eKey);
              });
              if (back) seen.set(eKey, storage.getItem(eKey) ?? null);
            }
            if (back) { out.push({ federation: fid, ok: true, returned: true, why: 'that federation is not being liquidated any more: the kept notes are back in the wallet', door: st.door }); rec = null; }
            else out.push({ federation: fid, ok: !!r.ok, accepted: j.accepted || [], refused: j.refused || [], inWindow: j.inWindow, why: j.why || null, kept: !rec.memoryOnly, door: st.door,
              // kanban #1237: taken, and it waits for the federation's spent set
              ...(j.spentSetPublished === false ? { waitsForSpentSet: true } : {}), ...(rec.memoryOnly ? { memoryOnly: true } : {}) });
          } catch (e) { out.push({ federation: fid, ok: false, why: e.message, kept: !rec.memoryOnly, door: st.door }); }
        } else if (rec && rec.state === 'posted') out.push({ federation: fid, ok: true, posted: true, kept: true, why: 'presented; waiting for the arbitration set to list it', door: st.door });
      }
    }

    out.push(...tookRows);

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
// A door's list is that door's word (kanban #1853): the claim key is derived once per distinct federation the list names, and
// for at most MAX_LIQUIDATION_FEDERATIONS of them - an honest list names the few liquidated federations, many payouts each; a
// padded one naming thousands of federations no longer costs the tab one EC multiply per row.
//
// Kanban #2252 / #2264 (audit45 refute of #1853): (1) the cap counted every federation the list named, other players' too, and
// an honest set's list holds every liquidation it ever paid, oldest first - after 32 of them the newest one's payout was never
// collected. The rows are now read newest first, and `federations` (the federations this page holds, then those the signed
// liquidation events name) puts those rows first and leaves every other federation underived; the cap bounds only what is left.
// (2) every row naming this seed's payout key cost a wallet open and a refund round trip, and the door learns that key from the
// player's own POST: matching rows are deduplicated by txid:outIdx and at most MAX_LIQUIDATION_PAYOUTS_PER_FEDERATION are
// claimed per federation (an honest list holds a player's few: notes, pending, remainder).
//
// Kanban #2328 (audit45 refute of #2252/#2264, skeptic 2): a count cap on matching rows let anyone starve a player on an HONEST
// door - a payout key is public (GET /liquidation-claims), so a stranger holding a few dust notes presented them late, one per
// pass, naming the victim's key, and the 16 newer dust rows took every slot; the victim's real (older, large) payout was never
// claimed. Likewise a row already collected (kept) took a slot on every reload, so a payout whose Refund once failed was never
// retried. Now only a FAILED claim (refused, unknown outpoint, wallet error) costs one of the per-federation slots: a kept row
// and an accepted refund cost none (an accepted one is a real note the federation paid this key, so the work is bounded by
// real money). Within a federation the rows are claimed largest msat first (newest first among equals), so a padded list
// cannot put its refusals ahead of a real payout of any size above theirs.
export const MAX_LIQUIDATION_FEDERATIONS = 32;
export const MAX_LIQUIDATION_PAYOUTS_PER_FEDERATION = 16;
export async function collectLiquidationPayouts({ listed, seed, curve, clientFor, storage, federations }) {
  const out = [];
  const keys = new Map();
  const claimed = new Map();
  const seen = new Set();
  const all = Array.isArray(listed && listed.payouts) ? listed.payouts : [];
  const fidOf = (p) => String((p && p.federation) || '').toLowerCase();
  let rows = all.slice().reverse();
  if (Array.isArray(federations)) {
    const rank = new Map();
    for (const f of federations) { const k = String(f || '').toLowerCase(); if (/^[0-9a-f]{64}$/.test(k) && !rank.has(k)) rank.set(k, rank.size); }
    rows = rows.filter((p) => rank.has(fidOf(p))).sort((a, b) => rank.get(fidOf(a)) - rank.get(fidOf(b)));   // stable: newest first within one
  }
  // kanban #2328: within one federation, the largest payout first (stable: newest first among equals); federations keep their order
  const fedAt = new Map();
  for (const p of rows) { const f = fidOf(p); if (!fedAt.has(f)) fedAt.set(f, fedAt.size); }
  const msatOf = (p) => { try { const v = BigInt(String(p && p.msat)); return v > 0n ? v : 0n; } catch { return 0n; } };
  rows = rows.map((p, i) => ({ p, i, f: fedAt.get(fidOf(p)), m: msatOf(p) }))
    .sort((a, b) => (a.f - b.f) || (a.m > b.m ? -1 : a.m < b.m ? 1 : a.i - b.i)).map((x) => x.p);
  for (const p of rows) {
    const fid = fidOf(p);
    if (!/^[0-9a-f]{64}$/.test(fid)) continue;
    let key = keys.get(fid);
    if (!key) {
      if (keys.size >= MAX_LIQUIDATION_FEDERATIONS) continue;
      key = liquidationKeyFor(seed, fid, curve);
      keys.set(fid, key);
    }
    if (String(p.payoutPk).toLowerCase() !== key.payoutPk) continue;
    const at = `${String(p.txid).toLowerCase()}:${Number(p.outIdx)}`;
    if (seen.has(at)) continue;
    seen.add(at);
    const note = movedKey(storage, `arena-liquidation-paid-${p.txid}:${p.outIdx}`);
    if (storage.getItem(note)) { out.push({ ...p, ok: true, kept: true }); continue; }   // kanban #2328: a kept row costs no slot
    if ((claimed.get(fid) || 0) >= MAX_LIQUIDATION_PAYOUTS_PER_FEDERATION) continue;   // only failed claims fill the cap
    const failed = () => claimed.set(fid, (claimed.get(fid) || 0) + 1);
    const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(p.msat), claimPk: key.payoutPk, refundPk: key.payoutPk, expiration: 0 };
    try {
      const client = await clientFor(p.into);
      const said = JSON.parse(await client.refund(p.txid, Number(p.outIdx), JSON.stringify(fields), toHex(key.secret)));
      if (said.accepted === true) storage.setItem(note, JSON.stringify({ msat: p.msat, at: Date.now() }));
      else failed();
      out.push({ ...p, ok: said.accepted === true, why: said.accepted === true ? null : (said.error || 'the federation did not accept the refund') });
    } catch (e) { failed(); out.push({ ...p, ok: false, why: e.message }); }
  }
  return out;
}
