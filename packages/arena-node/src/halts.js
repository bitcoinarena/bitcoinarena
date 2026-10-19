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
import { signHaltObservation, decodeHaltObservation, encodeHaltObservation, haltProof, haltObservationId } from '../../arena-protocol/src/halt-proof.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export function createHalts({ records, censusSeats, clocks, verify, sign, ownKey, height, ask, post = async () => {}, load = () => [], save = () => {}, say = () => {} }) {
  const seen = new Map();                    // federation hex -> { session, firstHeight, answering: [peer key], at }
  const kept = new Map();                    // federation hex -> Map(observer hex -> observation)
  for (const o of load() || []) { try { keep(decodeWithSig(o)); } catch { /* a stored observation that no longer reads */ } }

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
  const persist = () => save([...kept.values()].flatMap((m) => [...m.values()].map(asJson)));

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
      const top = ok.length ? Math.max(...ok.map((a) => a.session)) : null;
      const was = seen.get(fid);
      // A NEW SESSION RESTARTS THE CLOCK; a federation none of whose guardians answers keeps the last session it was seen at
      const now = !was || (top !== null && top > was.session) ? { session: top === null ? (was ? was.session : 0) : top, firstHeight: tip } : was;
      now.answering = ok.map((a) => a.peerKey); now.at = Date.now();
      seen.set(fid, now);
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
    return p.ok ? p : null;
  }
  const haltedFederations = () => [...kept.keys()].filter((fid) => proofOf(fid));
  /** The halt a liquidation counts from: { height, proof } or null. */
  const haltOf = (fid) => { const p = proofOf(fid); return p ? { height: p.haltHeight, proof: p } : null; };
  const list = (fid) => [...(kept.get(String(fid).toLowerCase()) || new Map()).values()].map(asJson);
  return { observe, take, proofOf, haltOf, haltedFederations, list, seen: (fid) => seen.get(fid) || null };
}

/**
 * A GUARDIAN'S SESSION COUNT, asked as the stock client asks (fedimint's JSON-RPC over WebSocket, `session_count`). `overrides`
 * is FM_WS_API_CONNECT_OVERRIDES' "public=local,..." - a seat reaches its own machine's guardians by their local socket.
 */
export async function wsSessionCount(endpoint, { overrides = process.env.FM_WS_API_CONNECT_OVERRIDES || '', timeoutMs = 10000, WebSocketImpl = null } = {}) {
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
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session_count', params: [{ auth: null, params: null }] })));
    ws.on('message', (m) => { try { const j = JSON.parse(String(m)); if (j.id === 1) done(Number.isInteger(j.result) ? resolve : reject, Number.isInteger(j.result) ? j.result : new Error(JSON.stringify(j.error || j))); } catch (e) { done(reject, e); } });
  });
}
