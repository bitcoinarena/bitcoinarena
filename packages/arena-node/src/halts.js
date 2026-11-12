// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALT, AS A SEAT OBSERVES AND PROVES IT (spec §23A.5 "How a halt is proven", RULED 2026-10-14 on the owner's delegation;
//), step 2 of the ruling. The proof itself is arena-protocol's halt-proof.js; this is the seat's part:
//
//   OBSERVE  every `everyMs`, for each federation whose record this seat holds (not CLOSED), ask every guardian endpoint the
//            record lists for its session count (`ask(endpoint)`, the stock API's session_count). The highest session any
//            guardian names is the federation's; the chain height at which this seat first saw it is first_height; the
//            guardians that answered are `answering`. Once that session has not moved for abandon_blocks, the seat signs an
//            observation, keeps it and hands it to its peers (`post(observation)`).
//   TAKE     a peer's observation (POST /halt-observations) is kept - newest height per federation and seat - when its seat is an
//            active census seat and its signature stands.
//   PROVE    haltOf(fid): the halt proof over the kept observations against the newest record held, voided by any session this
//            seat saw after S. A federation it proves is HALTED for the liquidation (liquidations.js), from the proof's height.
//   KEPT     across restarts (kanban #326, measured 2026-10-21 22:2xZ: T2's seats, rolled at 157,238, held no observation and
//            counted abandon_blocks again from the roll): `save({ observations, seen })` after each change, `load()` at start - the
//            observations held, and what this seat saw of each federation (its session and first_height). Sessions only grow, so a
//            session seen again after a restart has not moved since; a higher one restarts the clock as before. A stored list of
//            observations alone (the first format) still reads.
//   UNHEARD  a seat that has never heard a guardian of the federation answer (measured 2026-10-21 23:5xZ: T2's guardians exit on
//            "Consensus session timed out", so seats rolled after it saw no session at all and would sign session 0 beside the
//            others' 783) names the highest session its peers' signed observations name - it saw no guardian past it either - from
//            its own first_height; a session it hears itself restarts the clock as before.
//   ONE ANSWER IS NOT BELIEVED (kanban #1158): the session a seat reads is the (f + 1)-th highest its guardians answer (sessionReading) -
//            at least f + 1 of them name it or higher, so one honest guardian at least has reached it; before, the highest of any one
//            answer was taken, and one guardian answering 2^31 froze every seat's clock there and proved a running federation HALTED.
//            A seat that never heard a guardian takes its peers' session only when need - 1 of their signed observations name it or
//            higher (need: the halt quorum), never one peer's word. And a proof at S is void at a seat whose own reading, this pass,
//            is below S: f + 1 guardians answer that they never reached it. The clock's one transition is clockStep.
import { signHaltObservation, decodeHaltObservation, encodeHaltObservation, haltProof, haltObservationId, haltQuorum } from '../../arena-protocol/src/halt-proof.js';
import { faultsOf } from '../../arena-protocol/src/federation-record.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** The k-th highest of `values` (whole numbers), or null with fewer than k. */
export function kthHighest(values, k) {
  const v = (values || []).filter(Number.isInteger).sort((a, b) => b - a);
  return Number.isInteger(k) && k >= 1 && v.length >= k ? v[k - 1] : null;
}
/** THE SESSION A SEAT READS of a federation of `nominal` guardians from their answers [session]: the (f + 1)-th highest, or null. */
export const sessionReading = (sessions, nominal) => kthHighest(sessions, faultsOf(Math.max(1, nominal)) + 1);

/** The clock's rule version kept with it: a view stored before (the highest single answer) is read again from the next reading. */
export const CLOCK_RULE = 2;
/**
 * THE CLOCK'S ONE TRANSITION (kanban #1158). `was` { session, firstHeight, heard, rule } or null; `reading` this pass's sessionReading or
 * null; `peerSessions` the sessions of the peers' signed observations held; `need` the halt quorum of this seat's census; `tip`.
 *   no view                   -> the reading (0 when none) from tip
 *   reading above the session -> the reading from tip (the federation moved: the clock starts again)
 *   a view of the old rule    -> the reading from tip once one differs (a single guardian's answer is not kept)
 *   never heard, no reading   -> the session need - 1 peers name or exceed, from its own first_height, when one is higher
 *   else                      -> unchanged (sessions only grow: a lower reading, some guardians gone quiet, moves nothing)
 * Answers the new view (the same object when unchanged).
 */
export function clockStep(was, { reading, peerSessions = [], need = 1, tip }) {
  let now;
  if (!was) now = { session: reading === null ? 0 : reading, firstHeight: tip, heard: reading !== null, ...(reading !== null ? { rule: CLOCK_RULE } : {}) };
  else if (reading !== null && (reading > was.session || (was.rule !== CLOCK_RULE && reading !== was.session))) now = { session: reading, firstHeight: tip, heard: true, rule: CLOCK_RULE };
  else if (reading !== null && was.rule !== CLOCK_RULE) now = { ...was, heard: true, rule: CLOCK_RULE };
  else now = was;
  if (reading === null && !now.heard) {
    const named = kthHighest(peerSessions, Math.max(1, need - 1));
    if (named !== null && named > now.session) now = { session: named, firstHeight: now.firstHeight, heard: false, ...(now.rule ? { rule: now.rule } : {}) };
  }
  return now;
}

export function createHalts({ records, censusSeats, clocks, verify, sign, ownKey, height, ask, post = async () => {}, load = () => [], save = () => {}, say = () => {} }) {
  const seen = new Map();                    // federation hex -> { session, firstHeight, answering: [peer key], at }
  const kept = new Map();                    // federation hex -> Map(observer hex -> observation)
  const stored = (() => { try { return load(); } catch { return null; } })();
  const storedObs = Array.isArray(stored) ? stored : (stored && stored.observations) || [];
  for (const o of storedObs) { try { keep(decodeWithSig(o)); } catch { /* a stored observation that no longer reads */ } }
  for (const [fid, w] of Object.entries((stored && !Array.isArray(stored) && stored.seen) || {})) {
    if (Number.isInteger(w.session) && Number.isInteger(w.firstHeight)) seen.set(fid, { session: w.session, firstHeight: w.firstHeight, heard: w.heard === undefined ? w.session > 0 : !!w.heard, ...(w.rule === CLOCK_RULE ? { rule: CLOCK_RULE } : {}), answering: [], at: Number(w.at) || 0, reading: null });
  }

  function decodeWithSig(o) { return { ...decodeHaltObservation(fromHex(String(o.observation))), signature: fromHex(String(o.signature)) }; }
  const asJson = (o) => ({ observation: toHex(encodeHaltObservation(o)), signature: toHex(o.signature) });
  function keep(o) {
    const fid = toHex(o.federationId);
    const m = kept.get(fid) || new Map(); kept.set(fid, m);
    const had = m.get(toHex(o.observer));
    if (had && had.height >= o.height) return false;
    m.set(toHex(o.observer), o);
    return true;
  }
  // A STORED OBSERVATION IS HELD TO THE SAME RULE AS ONE TAKEN (kanban #2282, refute of #1819): load() reads the halts file before the
  // federation records and the census are known, so a file a pre-#1819 build filled (one census seat's observations of 300 made-up
  // federations, 4.06 MB rewritten on every fresh observation) was held again after the upgrade and carried by every later save. An
  // observation stands only when its federation's record is held, its answering list is no longer than that record's guardians and its
  // observer is a census seat; list() answers only those, and persist() drops the rest from memory and from the file (a one-time prune of
  // an old file at its first save). A criterion whose source is still empty (no record or no census seat known yet) drops nothing.
  function standing(fid, o, seats) {
    const held = records.recordOf(fid);
    if (!held) return false;
    if ((o.answering || []).length > (held.record.guardians || []).length) return false;
    return !seats || seats.has(toHex(o.observer));
  }
  const censusSet = () => { const s = new Set((censusSeats() || []).map(toHex)); return s.size ? s : null; };
  function prune() {
    if (!(records.list() || []).length) return;
    const seats = censusSet();
    for (const [fid, m] of [...kept]) {
      const keepM = new Map([...m].filter(([, o]) => standing(fid, o, seats)));
      if (keepM.size === m.size) continue;
      if (keepM.size) kept.set(fid, keepM);
      else kept.delete(fid);
    }
  }
  const persist = () => { prune(); return save({ observations: [...kept.values()].flatMap((m) => [...m.values()].map(asJson)),
    seen: Object.fromEntries([...seen].map(([fid, w]) => [fid, { session: w.session, firstHeight: w.firstHeight, heard: !!w.heard, ...(w.rule ? { rule: w.rule } : {}), at: w.at }])) }); };

  /** One pass over every federation this seat holds a record of; answers what it saw and signed. */
  async function observe() {
    const tip = await height();
    const out = [];
    for (const fid of (records.list() || []).map((x) => x.federation)) {
      const held = records.recordOf(fid);
      if (!held || held.status === 'CLOSED') continue;
      const answers = await Promise.all((held.record.guardians || []).map(async (g) => {
        try { const s = await ask(String(g.endpoint || '')); return Number.isInteger(s) ? { peerKey: g.peerKey, session: s } : null; } catch { return null; }
      }));
      const ok = answers.filter(Boolean);
      // A NEW SESSION RESTARTS THE CLOCK; a federation too few of whose guardians answer keeps the last session it was seen at (clockStep)
      const reading = sessionReading(ok.map((a) => a.session), (held.record.guardians || []).length);
      const was = seen.get(fid);
      const peerSessions = [...(kept.get(fid) || new Map()).values()].filter((o) => toHex(o.observer) !== toHex(ownKey)).map((o) => o.session);
      let now = clockStep(was ? { session: was.session, firstHeight: was.firstHeight, heard: was.heard, ...(was.rule ? { rule: was.rule } : {}) } : null,
        { reading, peerSessions, need: haltQuorum(new Set((censusSeats() || []).map(toHex)).size), tip });
      const moved = !was || now.session !== was.session || now.firstHeight !== was.firstHeight || now.heard !== was.heard || now.rule !== was.rule;
      if (!moved) now = was;
      now.answering = ok.map((a) => a.peerKey); now.at = Date.now(); now.reading = reading;
      seen.set(fid, now);
      if (moved) persist();
      const row = { federation: fid.slice(0, 16), session: now.session, firstHeight: now.firstHeight, height: tip, answering: ok.length, of: (held.record.guardians || []).length };
      if (tip - now.firstHeight >= clocks.abandonBlocks) {
        const o = signHaltObservation({ federationId: fromHex(fid), session: now.session, firstHeight: now.firstHeight, height: tip,
          answering: now.answering, observer: ownKey }, sign);
        if (keep(o)) persist();
        try { await post(asJson(o)); } catch { /* the peers read it from GET /halt-observations too */ }
        row.signed = true;
        say({ halt: 'observed', ...row });
      }
      out.push(row);
    }
    return out;
  }

  /** POST /halt-observations: a peer's signed observation { observation: hex, signature: hex }. */
  function take(said) {
    let o; try { o = decodeWithSig(said || {}); } catch (e) { return { ok: false, status: 400, why: `not a halt observation: ${e.message}` }; }
    const seats = new Set((censusSeats() || []).map(toHex));
    if (!seats.has(toHex(o.observer))) return { ok: false, status: 409, why: 'that observer is not an active seat of this seat\'s census' };
    // ONLY OF A FEDERATION THIS SEAT HOLDS A RECORD OF, ITS ANSWERING LIST NO LONGER THAN THE RECORD'S GUARDIANS (kanban #1819, audit #1489 r6
    // gossip): keep() opened an entry for any federation id and each fresh one rewrote the whole halts file, so one census seat signing
    // observations of 600 made-up federations was held 600 times and 2,438 MB went to disk. proofOf answers only for a held record, so such an
    // observation never counted; one that arrives before its record is refused and taken from the observer's next pass (it posts every pass).
    const held = records.recordOf(toHex(o.federationId));
    if (!held) return { ok: false, status: 409, why: 'this seat holds no record of that federation' };
    if ((o.answering || []).length > (held.record.guardians || []).length) return { ok: false, status: 409, why: 'that observation names more answering guardians than the record lists' };
    if (!verify(o.signature, haltObservationId(o), o.observer)) return { ok: false, status: 409, why: 'that observation is not signed by its seat' };
    const fresh = keep(o);
    if (fresh) persist();
    return { ok: true, status: fresh ? 201 : 200, kept: fresh };
  }

  /** The halt proof of a federation, against the newest record held; null when none stands. */
  function proofOf(fid) {
    const held = records.recordOf(fid);
    if (!held) return null;
    const all = [...(kept.get(fid) || new Map()).values()];
    if (!all.length) return null;
    const mine = seen.get(fid);
    const laterSession = mine ? mine.session : null;       // a session this seat saw after S voids a proof at S
    const p = haltProof(all, { record: held.record, censusSeats: censusSeats(), abandonBlocks: clocks.abandonBlocks, verify,
      laterSession: laterSession !== null && all.every((o) => o.session < laterSession) ? laterSession : null });
    if (!p.ok) return null;
    // A SESSION THIS SEAT SAW PAST THE PROOF'S VOIDS IT, WHATEVER ELSE IS HELD (kanban #1223, audit 2 #1204 FED-A2): the void above is passed
    // only while every kept observation is below the session seen, so one census seat's observation at a huge session switched it off and a
    // federation that had stalled and recovered was proven HALTED again from its old halt height
    if (mine && Number.isInteger(mine.session) && mine.session > p.session) return null;
    // f + 1 OF ITS GUARDIANS ANSWER THIS SEAT NOW BELOW S (kanban #1158): they never reached the session the halt is said to stop at
    if (mine && Number.isInteger(mine.reading) && mine.reading < p.session) return null;
    return p;
  }
  const haltedFederations = () => [...kept.keys()].filter((fid) => proofOf(fid));
  /** The halt a liquidation counts from: { height, proof } or null. */
  const haltOf = (fid) => { const p = proofOf(fid); return p ? { height: p.haltHeight, proof: p } : null; };
  const list = (fid) => { const f = String(fid).toLowerCase(); const seats = censusSet();
    return [...(kept.get(f) || new Map()).values()].filter((o) => standing(f, o, seats)).map(asJson); };
  return { observe, take, proofOf, haltOf, haltedFederations, list, seen: (fid) => seen.get(fid) || null, CLOCK_RULE };
}

/**
 * A GUARDIAN'S SESSION COUNT, asked as the stock client asks (fedimint's JSON-RPC over WebSocket, `session_count`). `overrides`
 * is FM_WS_API_CONNECT_OVERRIDES' "public=local,..." - a seat reaches its own machine's guardians by their local socket.
 */
export async function wsSessionCount(endpoint, opts = {}) {
  const n = await wsGuardianCall(endpoint, 'session_count', opts);
  if (!Number.isInteger(n)) throw new Error(`session_count answered ${JSON.stringify(n)}`);
  return n;
}

/**
 * ONE CALL TO A GUARDIAN'S API over its websocket (fedimint JSON-RPC: `method`, params [{ auth, params }]) - a module's endpoint
 * is `module_<instance id>_<name>`, an admin one takes the admin password as `auth`. The endpoint is mapped through
 * FM_WS_API_CONNECT_OVERRIDES as the guardians' own clients map it. Answers the result, or throws the error.
 */
export async function wsGuardianCall(endpoint, method, { auth = null, params = null, overrides = process.env.FM_WS_API_CONNECT_OVERRIDES || '', timeoutMs = 10000, WebSocketImpl = null } = {}) {
  let url = String(endpoint || '');
  for (const pair of String(overrides).split(',')) {
    const i = pair.indexOf('=');
    if (i > 0 && url.replace(/\/+$/, '') === pair.slice(0, i).replace(/\/+$/, '')) { url = pair.slice(i + 1); break; }
  }
  if (!/^wss?:\/\//.test(url)) throw new Error(`no guardian endpoint to ask: ${endpoint}`);
  const WS = WebSocketImpl || (await import('ws')).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    const done = (f, v) => { clearTimeout(t); try { ws.close(); } catch { /* closed */ } f(v); };
    const t = setTimeout(() => done(reject, new Error('no answer in time')), timeoutMs);
    ws.on('error', (e) => done(reject, e));
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [{ auth, params }] })));
    ws.on('message', (m) => { try { const j = JSON.parse(String(m)); if (j.id === 1) done(j.error || !('result' in j) ? reject : resolve, j.error || !('result' in j) ? new Error(JSON.stringify(j.error || j)) : j.result); } catch (e) { done(reject, e); } });
  });
}
