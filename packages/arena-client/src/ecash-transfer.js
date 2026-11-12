// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// E-CASH IN FLIGHT (kanban #1149, the 2026-11-06 state-machine audit): a send of e-cash makes a bearer string - whoever holds it can
// receive it - and the page's merge (arena.ecash.pending.*) and exchange (arena.ecash.exchange.*) wrote their record of it only after
// the send returned. A storage write that threw (a full browser) lost the string; the exchange POSTed the same string to each seat in
// turn until one said OK, so every seat that answered 4xx held a spendable copy; a kept record was dropped after any receive answer,
// a `Rejected` (spent elsewhere) included; and what came back was never compared with what was sent.
//
// ONE TRANSFER, ONE RECORD, ONE TRANSITION FUNCTION (ecashTransferStep), every move a compare-and-set on the stored record
// (moveEcashTransfer) written with putRoomy BEFORE the step that cannot be undone:
//   none --(the intent written)--> intent --(the wallet sent, the string written)--> kept
//   intent --(the wallet sent nothing / its log holds no send of this intent)--> none
//   MERGE (the counterparty is this browser's own wallet):  kept --(received: Success/AlreadyReceived, credited >= agreed)--> none
//   EXCHANGE (exactly one seat):  kept --(the seat named, written)--> handed --(POST to that seat only)--> answered --(received)--> none
//     handed --(the seat refused / never answered for 10 min)--> reclaiming --(the notes received back into the wallet they left)--> none
//     reclaiming --(Rejected after a silence: the seat took them)--> handed (asked again, same seat, same notes)
//   credited < agreed --> short (kept: the evidence);  Rejected (spent by someone else) --> refused (kept: the evidence)
// A record is removed only on Success/AlreadyReceived with the credited amount at least what was agreed.
//
// THE LOCK CLIENT KEEPS THE STRING TOO: the stock mintv2 send writes it into the wallet's operation log in the same commit that marks
// the notes spent, and the 2.0 lock client tags that send with the record's key (sendEcash(msat, key) / sendAllEcash(key)) and finds
// it again (sentEcash(key)): an intent left by a closed tab is resolved from the wallet that sent. An older lock client has no sentEcash;
// its intent stays, named, and is never counted as money.
import { putRoomy } from './page-lock.js';

export const ECASH_PENDING_PREFIX = 'arena.ecash.pending.';
export const ECASH_EXCHANGE_PREFIX = 'arena.ecash.exchange.';
export const ECASH_TRANSFER_STATES = Object.freeze({ NONE: 'none', INTENT: 'intent', KEPT: 'kept', HANDED: 'handed', RECLAIMING: 'reclaiming',
  ANSWERED: 'answered', SHORT: 'short', REFUSED: 'refused' });
const TRANSFER_EDGES = Object.freeze({
  none: ['intent'],
  intent: ['kept', 'none'],
  kept: ['handed', 'reclaiming', 'none', 'short', 'refused'],
  handed: ['answered', 'reclaiming', 'handed'],
  reclaiming: ['none', 'short', 'handed', 'refused', 'reclaiming'],
  answered: ['none', 'short', 'refused'],
  short: [], refused: [], unreadable: [],
});
export const ECASH_HANDED_RECLAIM_MS = 600000;   // a seat silent this long after the hand-over: the notes are taken back (if it did not take them)
const SEAT_NOT_TAKEN = new Set([400, 404, 409, 429]);   // the seat's own refusal: it says it took nothing (ecash-exchange.js answers these before or instead of a receive)

/** THE ONE TRANSITION: `rec` (or null) to state `to` with `patch`; null for none. Throws for a step a transfer does not take. */
export function ecashTransferStep(rec, to, patch = {}) {
  const from = rec && rec.state ? rec.state : 'none';
  if (!(TRANSFER_EDGES[from] || []).includes(to)) throw new Error(`an e-cash transfer goes ${from} -> ${(TRANSFER_EDGES[from] || []).join(' | ') || 'nowhere'}, not -> ${to}`);
  if (to === 'none') return null;
  const next = { ...(rec || {}), ...patch, v: 3, state: to };
  delete next.memoryOnly;
  return next;
}

/** A kept record as v3: a v3 JSON; an older page's { ecash, msat, ... } (a merge's: kept; an exchange's: reclaiming, its seats unknown). */
export function readEcashTransfer(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null || raw === undefined) return null;
  let r = null; try { r = JSON.parse(raw); } catch { r = null; }
  if (r && r.v === 3 && typeof r.state === 'string') return r;
  if (r && typeof r.ecash === 'string' && r.ecash) {
    return String(key).startsWith(ECASH_EXCHANGE_PREFIX)
      ? { ...r, v: 3, state: 'reclaiming', seat: null, refusedBySeat: false, legacy: true }
      : { ...r, v: 3, state: 'kept', legacy: true };
  }
  if (typeof raw === 'string' && /^fedimint[0-9a-v]+$/i.test(raw.trim())) return { v: 3, state: 'kept', ecash: raw.trim(), legacy: true };
  return { v: 3, state: 'unreadable' };
}

/** THE MOVE: the step, written only if the stored record is still the one this step started from (another tab may have moved it). */
export function moveEcashTransfer(storage, key, rec, to, patch = {}, put = putRoomy) {
  const next = ecashTransferStep(rec, to, patch);
  const now = readEcashTransfer(storage, key);
  if (JSON.stringify(now) !== JSON.stringify(rec)) {
    const e = new Error(`the transfer ${key} moved under this step (${rec ? rec.state : 'none'} -> ${now ? now.state : 'none'})`);
    e.code = 'ECASH_TRANSFER_MOVED';
    throw e;
  }
  if (next === null) storage.removeItem(key); else put(storage, key, JSON.stringify(next));
  return next;
}
const moved = (e) => e && e.code === 'ECASH_TRANSFER_MOVED';

/** What a record still holds on its way, msat: a kept, handed or taken-back string, or a seat's answer not yet received. Intent, short, refused: 0. */
export function ecashTransferMsatInFlight(rec) {
  if (!rec) return 0n;
  try {
    if (['kept', 'handed', 'reclaiming'].includes(rec.state)) return BigInt(rec.msat || 0);
    if (rec.state === 'answered') return BigInt(rec.answerMsat || rec.msat || 0);
  } catch { return 0n; }
  return 0n;
}

// THE STRING'S FACE VALUE, read here (the 1.9 lock client's receive does not say it): fedimint's prefixed base32 (lowercase RFC 4648 hex
// alphabet, least significant bits first) of the mintv2 ECash - a Vec of fields, each a BigSize variant and a BigSize-length payload;
// variant 0 the federation id (32 bytes), variant 1 a note whose first byte is its denomination (2^d msat). Null for anything else.
const B32 = '0123456789abcdefghijklmnopqrstuv';
export function ecashFaceValue(ecash) {
  const s = String(ecash || '').trim().toLowerCase();
  if (!s.startsWith('fedimint')) return null;
  const bytes = [];
  let buf = 0, bits = 0;
  for (const c of s.slice(8)) {
    const v = B32.indexOf(c);
    if (v < 0) return null;
    buf |= v << bits; bits += 5;
    while (bits >= 8) { bytes.push(buf & 0xff); buf >>= 8; bits -= 8; }
  }
  let p = 0;
  const big = () => {
    if (p >= bytes.length) throw new Error('short');
    const b = bytes[p++];
    const n = b < 0xfd ? 0 : b === 0xfd ? 2 : b === 0xfe ? 4 : 8;
    if (!n) return BigInt(b);
    if (p + n > bytes.length) throw new Error('short');
    let x = 0n; for (let i = 0; i < n; i++) x = (x << 8n) | BigInt(bytes[p++]);
    return x;
  };
  try {
    const fields = big();
    if (fields > 100000n) return null;
    let msat = 0n, notes = 0, federation = null;
    for (let i = 0n; i < fields; i++) {
      const variant = big(), len = big();
      if (BigInt(p) + len > BigInt(bytes.length)) return null;
      const body = bytes.slice(p, p + Number(len)); p += Number(len);
      if (variant === 0n) { if (body.length !== 32) return null; federation = body.map((b) => b.toString(16).padStart(2, '0')).join(''); }
      else if (variant === 1n) { if (!body.length || body[0] > 63) return null; msat += 1n << BigInt(body[0]); notes++; }
    }
    if (p !== bytes.length) return null;
    return { msat, federation, notes };
  } catch { return null; }
}
const creditedOf = (got, ecash) => {
  if (got && got.msat !== undefined && got.msat !== null && /^\d+$/.test(String(got.msat))) return BigInt(got.msat);
  const f = ecashFaceValue(ecash);
  return f ? f.msat : null;
};

/** The send this wallet's log kept for `key` (2.0 lock client): { ecash, msat } or null; undefined when the wallet cannot say. */
async function sentByIntent(wallet, key) {
  if (!wallet || typeof wallet.sentEcash !== 'function') return undefined;
  try { const r = JSON.parse(await wallet.sentEcash(key)); return r && r.ecash ? r : null; } catch { return undefined; }
}

/**
 * THE SEND, KEPT BEFORE IT HAPPENS: the intent (`fields`) written under `key`, then the wallet's send (`amountMsat`, or everything when
 * null) tagged with `key`, then the string written. A browser that cannot write the intent sends nothing; one that cannot write the
 * string gets the notes back into the wallet; failing that they are answered in memory (`memoryOnly`) and the intent stays.
 * Answers { ok, sent, rec, msat, why, nothing, memoryOnly }.
 */
export async function sendKeptEcash({ storage, key, wallet, amountMsat = null, fields = {}, put = putRoomy, nowMs = Date.now() }) {
  let rec;
  try { rec = moveEcashTransfer(storage, key, null, 'intent', { ...fields, atMs: nowMs }, put); }
  catch (e) { return { ok: false, sent: false, why: `nothing sent: this browser could not write the transfer first (${e.message})` }; }
  const drop = () => { try { moveEcashTransfer(storage, key, rec, 'none', {}, put); } catch { /* moved by another tab */ } };
  let sent;
  try { sent = JSON.parse(await (amountMsat === null ? wallet.sendAllEcash(key) : wallet.sendEcash(String(amountMsat), key))); }
  catch (e) {
    const found = await sentByIntent(wallet, key);   // a send that threw after its commit is in the wallet's log; one before it spent nothing
    if (!found) { drop(); return { ok: false, sent: false, why: `the wallet could not send: ${e && e.message ? e.message : e}` }; }
    sent = found;
  }
  if (!sent || !sent.ecash) { drop(); return { ok: true, sent: false, nothing: true, msat: '0' }; }
  try {
    rec = moveEcashTransfer(storage, key, rec, 'kept', { ecash: sent.ecash, msat: String(sent.msat) }, put);
    return { ok: true, sent: true, rec, msat: String(sent.msat) };
  } catch (e) {
    let back = false;
    try { const got = JSON.parse(await wallet.receiveEcash(sent.ecash)); back = got.state === 'Success' || got.state === 'AlreadyReceived'; } catch { back = false; }
    if (back) { drop(); return { ok: false, sent: false, why: `this browser could not keep the notes (${e.message}); they are back in the wallet` }; }
    return { ok: false, sent: true, memoryOnly: true, rec: { ...rec, state: 'kept', ecash: sent.ecash, msat: String(sent.msat), memoryOnly: true }, msat: String(sent.msat),
      why: `this browser could not keep the notes (${e.message}) and the wallet did not take them back; the intent ${key} stays` };
  }
}

/** AN INTENT LEFT BEHIND, resolved from the wallet that sent: its kept string (kept), or no send of it (none). { ok, rec, unknown, nothing }. */
export async function recoverEcashIntent({ storage, key, rec, wallet, put = putRoomy }) {
  if (!rec || rec.state !== 'intent') return { ok: false, why: 'not an intent' };
  const found = await sentByIntent(wallet, key);
  if (found === undefined) return { ok: false, unknown: true, why: 'this lock client cannot tell whether that send happened: the intent stays' };
  try {
    if (found === null) { moveEcashTransfer(storage, key, rec, 'none', {}, put); return { ok: true, nothing: true }; }
    return { ok: true, rec: moveEcashTransfer(storage, key, rec, 'kept', { ecash: found.ecash, msat: String(found.msat), recovered: true }, put) };
  } catch (e) { return { ok: false, why: e.message, moved: moved(e) }; }
}

/**
 * A KEPT STRING RECEIVED (`field` of `rec`: 'ecash', or 'answer' for a seat's), by `receive(ecash)` (a wallet's receiveEcash). The record
 * is removed only on Success/AlreadyReceived with the credited amount (the receive's msat, else the string's face value) at least
 * `agreedMsat`; less is `short`; a Rejected is `onRejected` ('refused', or 'handed' for notes a silent seat took). `settle(got)` runs
 * between a Success and the removal (the page waits for the balance to show it). Answers { ok, state, credited, short, refused, retry, why }.
 */
export async function receiveKeptEcash({ storage, key, rec, receive, field = 'ecash', agreedMsat = null, federation = null, onRejected = 'refused',
  settle = null, put = putRoomy }) {
  const ecash = rec && rec[field];
  if (!ecash) return { ok: false, why: 'the record keeps no e-cash to receive' };
  const agreed = BigInt(agreedMsat === null ? rec.msat || 0 : agreedMsat);
  const face = ecashFaceValue(ecash);
  const write = (to, patch) => { if (rec.memoryOnly) return null; try { return moveEcashTransfer(storage, key, rec, to, patch, put); } catch (e) { if (moved(e)) return null; throw e; } };
  if (federation && face && face.federation && face.federation !== String(federation).toLowerCase())
    return { ok: false, why: `that e-cash is of federation ${face.federation.slice(0, 8)}, not ${String(federation).slice(0, 8)}: not received` };
  let got;
  try { got = JSON.parse(await receive(ecash)); }
  catch (e) { return { ok: false, retry: true, why: e && e.message ? e.message : String(e) }; }
  const state = got && got.state;
  if (state === 'Success' || state === 'AlreadyReceived') {
    const credited = creditedOf(got, ecash);
    if (credited !== null && credited >= agreed) {
      if (settle && state === 'Success') { try { await settle(got); } catch { /* the removal does not wait longer */ } }
      write('none', {});
      return { ok: true, state, credited: String(credited) };
    }
    write('short', { creditedMsat: credited === null ? null : String(credited), agreedMsat: String(agreed), receivedState: state });
    return { ok: true, state, short: true, credited: credited === null ? null : String(credited),
      why: `credited ${credited === null ? 'an unreadable amount' : credited + ' msat'} for ${agreed} msat agreed: the record is kept` };
  }
  if (state === 'Rejected') {
    write(onRejected, onRejected === 'handed' ? { seatTook: true } : { why: `the federation said Rejected: the ${field === 'answer' ? 'seat\'s' : 'kept'} notes were spent elsewhere` });
    return { ok: false, state, refused: onRejected === 'refused', why: 'the federation said Rejected' };
  }
  return { ok: false, state, retry: true, why: `the federation said ${state}` };
}

// THE EXCHANGE (kanban #614): the seat's side is ecash-exchange.js; a retry with the same notes is answered the same, never paid twice
async function askSeat({ seat, rec, fetcher, timeoutMs }) {
  let r;
  try {
    r = await fetcher(String(seat).replace(/\/+$/, '') + '/exchange', { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ from: rec.from, to: rec.to, ecash: rec.ecash, amountMsat: String(rec.msat) }) });
  } catch (e) { return { silent: e && e.message ? e.message : String(e) }; }
  if (r.ok) {
    let a = null; try { a = await r.json(); } catch { a = null; }
    return a && typeof a.ecash === 'string' && a.ecash ? { answer: a } : { silent: 'the seat answered no e-cash' };
  }
  let body = ''; try { body = (await r.text()).trim().slice(0, 160); } catch { body = ''; }
  return SEAT_NOT_TAKEN.has(r.status) ? { refused: `${r.status} ${body}` } : { silent: `${r.status} ${body}` };
}

/**
 * ONE EXCHANGE RECORD MOVED AS FAR AS IT GOES NOW. `walletFrom` holds the notes handed over (taken back into it), `walletTo()` opens
 * the wallet the seat's answer goes into. Answers { ok, msat, state, short, reclaimed, pending, lost, why }.
 */
export async function advanceEcashExchange({ storage, key, rec, walletFrom, walletTo, fetcher = fetch, seats = [], nowMs = Date.now(), put = putRoomy,
  timeoutMs = 60000 }) {
  const mv = (to, patch) => (rec = moveEcashTransfer(storage, key, rec, to, patch, put));
  try {
    for (let i = 0; i < 6; i++) {
      if (!rec) return { ok: false, why: 'the record is gone' };
      if (rec.state === 'intent') {
        const r = await recoverEcashIntent({ storage, key, rec, wallet: walletFrom, put });
        if (!r.ok || r.nothing) return { ok: false, pending: !!r.unknown, why: r.nothing ? 'the wallet never sent it' : r.why };
        rec = r.rec; continue;
      }
      if (rec.state === 'kept') { mv('reclaiming', { refusedBySeat: true, seatSaid: 'never handed to a seat' }); continue; }
      if (rec.state === 'handed') {
        // EXACTLY ONE COUNTERPARTY: the seat named before the hand-over; only a record of an older page (no seat named) asks its seats in turn
        let a = { silent: 'no seat named' };
        for (const seat of rec.seat ? [rec.seat] : seats) { a = await askSeat({ seat, rec, fetcher, timeoutMs }); if (a.answer) break; }
        if (a.answer) { mv('answered', { answer: a.answer.ecash, answerMsat: String(a.answer.msat || ''), answeredAtMs: nowMs }); continue; }
        if (a.refused && rec.seat) { mv('reclaiming', { refusedBySeat: true, seatSaid: a.refused }); continue; }
        if (nowMs - Number(rec.handedAtMs || 0) >= ECASH_HANDED_RECLAIM_MS && !rec.seatTook) { mv('reclaiming', { refusedBySeat: false, seatSaid: a.silent || a.refused }); continue; }
        mv('handed', { lastAskMs: nowMs, seatSaid: a.silent || a.refused });
        return { ok: false, pending: true, why: `the seat has not answered yet (${a.silent || a.refused}); asked again with the same notes` };
      }
      if (rec.state === 'reclaiming') {
        const r = await receiveKeptEcash({ storage, key, rec, receive: (e) => walletFrom.receiveEcash(e), field: 'ecash', federation: rec.from,
          onRejected: rec.refusedBySeat && rec.seat ? 'refused' : 'handed', put });
        if (r.ok) return { ok: false, reclaimed: true, short: !!r.short, why: rec.seatSaid || 'taken back' };
        if (r.state === 'Rejected') return r.refused ? { ok: false, lost: true, why: `the seat ${rec.seat} refused and the notes were spent: kept as evidence` }
          : { ok: false, pending: true, why: 'the seat took the notes: it is asked again for its answer' };
        return { ok: false, pending: true, why: r.why };
      }
      if (rec.state === 'answered') {
        const face = ecashFaceValue(rec.answer);
        if (face && face.federation && face.federation !== String(rec.to).toLowerCase()) {
          mv('refused', { why: `the seat answered e-cash of federation ${face.federation.slice(0, 8)}` });
          return { ok: false, lost: true, why: `the seat ${rec.seat} answered e-cash of another federation: kept as evidence` };
        }
        const w = await walletTo();
        const r = await receiveKeptEcash({ storage, key, rec, receive: (e) => w.receiveEcash(e), field: 'answer', agreedMsat: rec.msat, federation: rec.to, put });
        return r.ok ? { ok: true, msat: r.credited, state: r.state, short: !!r.short, why: r.why } : { ok: false, pending: !!r.retry, lost: !!r.refused, state: r.state, why: r.why };
      }
      return { ok: false, done: true, why: `kept as ${rec.state}` };
    }
    return { ok: false, pending: true, why: 'not finished in one pass' };
  } catch (e) { return { ok: false, pending: true, why: e && e.message ? e.message : String(e) }; }
}

/**
 * THE PAGE'S EXCHANGE: `needMsat` of `walletFrom` (federation `from`) into federation `to` through ONE seat - the first of `seats`
 * whose offer (GET /exchange, which hands nothing over) holds enough of `to`. A seat that refuses gets nothing more: the notes are taken
 * back, and only then is the next offering seat handed new ones. Answers { ok, from, to, msat, state, short, why }.
 */
export async function exchangeEcashInto({ storage, from, to, needMsat, seats, walletFrom, walletTo, fetcher = fetch, put = putRoomy,
  nowMs = Date.now(), onStep = () => {}, timeoutMs = 60000, offerTimeoutMs = 8000, maxSeats = 3, phrase16 = null }) {
  const need = BigInt(needMsat);
  const offering = [];
  for (const seat of seats || []) {
    try {
      const r = await fetcher(String(seat).replace(/\/+$/, '') + '/exchange?federations=' + to, { signal: AbortSignal.timeout(offerTimeoutMs) });
      if (!r.ok) continue;
      const o = await r.json();
      if (BigInt((o && o.holds && o.holds[to]) || 0) >= need && BigInt((o && o.maxMsat) || 0) >= need) offering.push(seat);
    } catch { /* not this seat */ }
    if (offering.length >= maxSeats) break;
  }
  if (!offering.length) return { ok: false, from, why: `no seat offers ${Math.ceil(Number(need) / 1000)} sat in federation ${String(to).slice(0, 8)}` };
  let why = '';
  for (let i = 0; i < offering.length; i++) {
    const seat = offering[i];
    const key = `${ECASH_EXCHANGE_PREFIX}${nowMs}.${i}`;
    const s = await sendKeptEcash({ storage, key, wallet: walletFrom, amountMsat: need, fields: { kind: 'exchange', from, to, msat: String(need), seat, ...(phrase16 ? { fromKey: String(phrase16).slice(0, 16) } : {}) }, put, nowMs });
    if (!s.sent || s.memoryOnly) return { ok: false, from, why: s.why || 'nothing sent' };
    let rec;
    try { rec = moveEcashTransfer(storage, key, s.rec, 'handed', { seat, handedAtMs: nowMs }, put); }
    catch (e) {
      const back = await advanceEcashExchange({ storage, key, rec: s.rec, walletFrom, walletTo, fetcher, nowMs, put, timeoutMs });
      return { ok: false, from, why: `the hand-over could not be written first (${e.message}); ${back.reclaimed ? 'the notes are back' : back.why}` };
    }
    onStep(`exchanging at ${String(seat).replace(/^https?:\/\//, '').slice(0, 40)}`);
    const r = await advanceEcashExchange({ storage, key, rec, walletFrom, walletTo, fetcher, nowMs, put, timeoutMs });
    if (r.ok) return { ok: true, from, to, msat: r.msat, state: r.state, short: r.short, why: r.why, seat };
    why = r.why;
    if (!r.reclaimed) return { ok: false, from, why, pending: !!r.pending };
  }
  return { ok: false, from, why: why || 'every offering seat refused' };
}

/**
 * EVERY EXCHANGE OF THIS TAB'S PHRASE, moved on: `walletFor(federationHex)` opens a wallet of the phrase `phrase16`. Answers one row per
 * record acted on.
 * ONE PHRASE'S EXCHANGE IS FINISHED ONLY INTO THAT PHRASE'S WALLETS (kanban #1641, the 2026-11-12 state audit): the records are shared
 * by every tab of the browser, and two tabs may be two players. A record named no phrase, so tab B (phrase P2) resumed tab A's (P1)
 * handed record and received the seat's e-cash for P1's notes into P2's wallet, then removed the record - while A still held P1. Now
 * exchangeEcashInto writes the sending phrase (fromKey, as the merge records do) and a record of another phrase is left alone: its own
 * tab, or the next tab opened on it, moves it on. A record of an older page names no phrase and is moved only when the caller says the
 * browser keeps one phrase (`takeUnnamed`, as scanLostDeposits' dropUnnamed).
 */
export async function resumeEcashExchanges({ storage, keys, walletFor, fetcher = fetch, seats = [], nowMs = Date.now(), put = putRoomy, timeoutMs = 30000,
  phrase16 = null, takeUnnamed = false }) {
  const mine = phrase16 ? String(phrase16).slice(0, 16) : null;
  const out = [];
  for (const key of (keys || []).filter((k) => String(k).startsWith(ECASH_EXCHANGE_PREFIX))) {
    const rec = readEcashTransfer(storage, key);
    if (!rec || ['short', 'refused', 'unreadable'].includes(rec.state)) continue;
    if (rec.fromKey ? rec.fromKey !== mine : !takeUnnamed) continue;   // another phrase's (kanban #1641), or unnamed in a browser of many phrases
    try {
      const walletFrom = await walletFor(rec.from);
      const r = await advanceEcashExchange({ storage, key, rec, walletFrom, walletTo: () => walletFor(rec.to), fetcher, seats, nowMs, put, timeoutMs });
      out.push({ key, ...r });
    } catch (e) { out.push({ key, ok: false, why: e && e.message ? e.message : String(e) }); }
  }
  return out;
}
