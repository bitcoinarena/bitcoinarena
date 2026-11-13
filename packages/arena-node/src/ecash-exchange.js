// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// MONEY MOVED BETWEEN FEDERATIONS WITHOUT LIGHTNING (kanban #614, 2026-10-24: "Kein Lightning swap, sondern übertragen in die andere
// federation was viel schneller gehen muss"): a player whose notes are in one federation and whose round is in another hands this seat
// e-cash of the first; the seat reissues it into its own client there and hands back the same amount of its own notes of the second.
// No gateway, no invoice: two reissues, one in each federation.
//
// THE TRUST: the player's notes are taken before the seat's are given. The seat could keep them; seats are the project's own, and every
// exchange is kept here. A RETRY IS ANSWERED THE SAME (an answer lost on the way must not lose the money): the exchange is keyed by
// the hash of the e-cash handed in, and the e-cash handed out is kept with it - asked again, it is answered again, never paid twice.
// ONE AT A TIME: the seat's client directory takes one process at a time (its settle uses it too). LIMITS: `maxMsat` per exchange,
// `perHourMsat` over the last hour, both at the seat's own choice.
//
// THE STATES (kanban #1160), one enum and one transition function, each step compare-and-set, each written BEFORE the side effect it names:
//   none -> receiving   the row exists before the player's notes are reissued: a stop in the middle leaves "receiving", and the retry's
//                       AlreadyReceived is this exchange's own receive (its amount the string's, as the tool reads it back)
//   receiving -> taken  the notes are in, with what they carried | -> refused: the federation would not reissue them
//   taken -> sending    the payout is named (its key: the exchange id) before the seat's notes leave
//   sending -> paid     the notes out, kept. A retry in "sending" never spends blind: it reads the keyed send back from the tool's
//                       operation log (stake-lock ecash-sent); found, it is the answer; not found, the send is made then; a tool that
//                       cannot say holds the exchange and pays nothing a second time.
//   paid, refused       go nowhere.
//
// THE NOTES, NOT THE STRING (kanban #1204 RES-3): the federation reads an e-cash string case-blind and drops the bits after its last
// whole byte, so one set of notes has many spellings - and a row keyed by the spelling took a re-cased copy as a new exchange whose
// AlreadyReceived (the notes' own earlier receive) it paid again. Now (1) the row is keyed by the notes: the bytes the federation
// decodes (noteKey, Fedimint's base32 exactly), and (2) an AlreadyReceived is this exchange's own only when THIS row asked for the
// reissue before (`receive_asked`, written before each ask): a row's first ask that answers AlreadyReceived was received under another
// exchange or outside the seat, and is refused for good.
import { durably } from './store.js';
import { createHash } from 'node:crypto';

// Fedimint's base32 (fedimint-core base32.rs decode_prefixed_bytes): lowercased, the "fedimint" prefix, RFC 4648 lower-case alphabet,
// 5 bits a character, least significant first, the bits after the last whole byte dropped
const B32 = '0123456789abcdefghijklmnopqrstuv';
export function decodeEcashBytes(ecash) {
  const s = String(ecash || '').trim().toLowerCase();
  if (!s.startsWith('fedimint')) return null;
  const out = []; let buf = 0, bits = 0;
  for (const ch of s.slice('fedimint'.length)) {
    const v = B32.indexOf(ch); if (v < 0) return null;
    buf |= v << bits; bits += 5;
    while (bits >= 8) { out.push(buf & 0xff); buf >>>= 8; bits -= 8; }
  }
  return Uint8Array.from(out);
}
/** THE EXCHANGE'S KEY (kanban #1204 RES-3): sha256 of the notes' bytes; a string the federation cannot decode keys by its lowercased self. */
export function noteKey(ecash) {
  const b = decodeEcashBytes(ecash);
  return createHash('sha256').update(b ? Buffer.concat([Buffer.from('notes:'), Buffer.from(b)]) : Buffer.from(`string:${String(ecash).trim().toLowerCase()}`)).digest('hex');
}

export const EXCHANGE = Object.freeze({ RECEIVING: 'receiving', TAKEN: 'taken', SENDING: 'sending', PAID: 'paid', REFUSED: 'refused' });
export const EXCHANGE_NEXT = Object.freeze({
  NONE: [EXCHANGE.RECEIVING],
  [EXCHANGE.RECEIVING]: [EXCHANGE.TAKEN, EXCHANGE.REFUSED],
  [EXCHANGE.TAKEN]: [EXCHANGE.SENDING],
  [EXCHANGE.SENDING]: [EXCHANGE.PAID],
  [EXCHANGE.PAID]: [], [EXCHANGE.REFUSED]: [],
});

export function createEcashExchange({ db, portOf, maxMsat = 1_000_000n, perHourMsat = 20_000_000n, now = () => Date.now(), log = () => {}, halted = () => null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS ecash_exchanges (
    id        TEXT PRIMARY KEY,
    from_fed  TEXT NOT NULL,
    to_fed    TEXT NOT NULL,
    in_msat   TEXT,
    out_msat  TEXT,
    out_ecash TEXT,
    state     TEXT NOT NULL,
    why       TEXT,
    made_ms   INTEGER NOT NULL
  )`);
  // kanban #1160: what the exchange asked for, and the amount the payout is named for before it leaves
  for (const col of ['want_msat', 'pay_msat']) if (!db.prepare('PRAGMA table_info(ecash_exchanges)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE ecash_exchanges ADD COLUMN ${col} TEXT`);
  // kanban #1204 RES-3: 0 on a new row until its first reissue is asked; a row from before (NULL) may have asked already
  if (!db.prepare('PRAGMA table_info(ecash_exchanges)').all().some((c) => c.name === 'receive_asked')) db.exec('ALTER TABLE ecash_exchanges ADD COLUMN receive_asked INTEGER');
  // kanban #1637: when the payout was named (TAKEN -> SENDING) - the hour counts a payout in the hour it is named, not the hour its row was made
  if (!db.prepare('PRAGMA table_info(ecash_exchanges)').all().some((c) => c.name === 'pay_ms')) db.exec('ALTER TABLE ecash_exchanges ADD COLUMN pay_ms INTEGER');
  const markAsked = db.prepare("UPDATE ecash_exchanges SET receive_asked = 1 WHERE id = ? AND state = 'receiving'");
  const get = db.prepare('SELECT * FROM ecash_exchanges WHERE id = ?');
  // an hour's spend counts what is out or on its way out, by the time its payout was named (kanban #1637; a row from before: when it was made)
  // - and a RECEIVING row whose reissue was asked (receive_asked 1, or NULL from before #1204) at what it asked for (kanban #2143, audit44
  // refute 21): its notes may be with the seat already, its answer lost; the row being checked is not counted against itself
  const ASKED_RECEIVING = "(state = 'receiving' AND (receive_asked IS NULL OR receive_asked = 1))";
  const lastHour = db.prepare(`SELECT state, out_msat, pay_msat, want_msat FROM ecash_exchanges WHERE id != ? AND (state IN ('paid', 'sending') OR ${ASKED_RECEIVING}) AND COALESCE(pay_ms, made_ms) >= ?`);
  // what the seat owes out of its notes already: payouts named and not yet paid, notes taken whose payout is not named yet (kanban #1637),
  // and reissues asked whose answer never came (kanban #2143): a RECEIVING row that asked may hold the player's notes - a new exchange paid
  // out of the seat's notes meanwhile left that player's retry with notes taken and nothing to pay him with. Counted at want_msat
  const owedRows = db.prepare(`SELECT state, in_msat, want_msat, pay_msat FROM ecash_exchanges WHERE to_fed = ? AND id != ? AND (state IN ('taken', 'sending') OR ${ASKED_RECEIVING})`);
  let queue = Promise.resolve();
  const hex64 = /^[0-9a-f]{64}$/;
  const refuse = (status, why) => ({ ok: false, status, why });

  /** THE ONE WRITE (kanban #1160): `from` -> `to` along EXCHANGE_NEXT, compare-and-set on the state; nothing written otherwise. */
  function transition(id, from, to, fields = {}) {
    if (!(EXCHANGE_NEXT[from || 'NONE'] || []).includes(to)) return refuse(409, `an exchange does not go from ${from || 'nothing'} to ${to}`);
    const cols = Object.keys(fields);
    let c;
    // EVERY STEP ON THE DISK BEFORE THE NEXT EFFECT (kanban #1243): the receive and the send follow these writes
    return durably(db, () => {
    if (!from) {
      c = db.prepare(`INSERT OR IGNORE INTO ecash_exchanges (id, state, made_ms${cols.map((k) => `, ${k}`).join('')}) VALUES (@id, @state, @made_ms${cols.map((k) => `, @${k}`).join('')})`)
        .run({ ...fields, id, state: to, made_ms: now() });
    } else {
      c = db.prepare(`UPDATE ecash_exchanges SET state = @state${cols.map((k) => `, ${k} = @${k}`).join('')} WHERE id = @id AND state = @from`).run({ ...fields, id, state: to, from });
    }
    return c.changes === 1 ? { ok: true, state: to } : refuse(409, `that exchange is no longer ${from || 'new'} here: not moved to ${to}`);
    });
  }
  const note = (id, state, why) => db.prepare('UPDATE ecash_exchanges SET why = ? WHERE id = ? AND state = ?').run(String(why).slice(0, 300), id, state);

  async function exchange({ from, to, ecash, amountMsat }) {
    from = String(from || '').toLowerCase(); to = String(to || '').toLowerCase();
    if (!hex64.test(from) || !hex64.test(to)) return refuse(400, 'from and to are federation ids, 32 bytes hex');
    if (from === to) return refuse(400, 'from and to are the same federation: nothing to exchange');
    if (typeof ecash !== 'string' || ecash.length < 20 || ecash.length > 200_000) return refuse(400, 'ecash is the e-cash string of federation `from`');
    let want; try { want = BigInt(amountMsat); } catch { want = -1n; }
    if (want <= 0n) return refuse(400, 'amountMsat is the amount the e-cash carries');
    // a row from before kanban #1204 is keyed by the string as it came: its retries find it there
    const legacy = createHash('sha256').update(ecash.trim()).digest('hex');
    const id = get.get(legacy) ? legacy : noteKey(ecash);
    const run = queue.then(() => step({ id, from, to, ecash: ecash.trim(), want }));
    queue = run.catch(() => {});
    return run;
  }

  const paidAnswer = (r, again) => ({ ok: true, ...(again ? { again: true } : {}), msat: String(r.out_msat), ecash: r.out_ecash, federation: r.to_fed });

  async function step({ id, from, to, ecash, want }) {
    let r = get.get(id);
    if (r && r.state === EXCHANGE.PAID) return paidAnswer(r, true);
    // NOT E-CASH, NO ROW (kanban #2384, #2436, audit44 refute 21 s2): a string the federation's own base32 cannot read (decodeEcashBytes is
    // its decode_prefixed_bytes exactly) is never reissued anywhere - the tool fails before it reaches a guardian. Written as a RECEIVING row
    // and asked, it stayed RECEIVING with receive_asked 1 for good, and #2143 counted it as owed at the stranger's want_msat and in the hour:
    // garbage posted for free pinned the seat's balance (honest exchanges 409 "holds 0 sat free") and spent its hour (429). Refused 400
    // before anything is written; a row such a string left from before is closed REFUSED (it never held notes) and counts no more.
    if (!decodeEcashBytes(ecash)) {
      if (r && r.state === EXCHANGE.RECEIVING) transition(id, EXCHANGE.RECEIVING, EXCHANGE.REFUSED, { why: 'not e-cash: the string does not decode' });
      return refuse(400, 'that is not e-cash: the string does not decode as fedimint notes');
    }
    // A TAKEN ROW IS NEVER ANSWERED 4xx (kanban #1583, audit #1489 sm1-page-2): the page reads 400/404/409/429 as "this seat took nothing",
    // takes its notes back (Rejected - the seat holds them) and gives the exchange up as refused for good. A row whose notes this seat took or
    // may have taken (TAKEN, SENDING, RECEIVING asked before) meets a passing condition here - its client of a federation not up yet after a
    // restart, the cap lowered - with 503 "ask again"; only a new row, or a RECEIVING one never asked, may still be refused
    const holdsNotes = !!r && (r.state === EXCHANGE.TAKEN || r.state === EXCHANGE.SENDING
      || (r.state === EXCHANGE.RECEIVING && (r.receive_asked === null || r.receive_asked === undefined || Number(r.receive_asked) === 1)));
    if (!r && want > maxMsat) return refuse(409, `this seat exchanges at most ${maxMsat / 1000n} sat at a time`);
    if (r && r.state === EXCHANGE.REFUSED) return refuse(409, `federation ${r.from_fed.slice(0, 8)} did not reissue that e-cash: ${r.why || 'refused'}`);
    if (r && (r.from_fed !== from || r.to_fed !== to)) return refuse(409, 'that e-cash is in an exchange between two other federations here');
    // NO NEW EXCHANGE OUT OF OR INTO A FEDERATION BEING LIQUIDATED (kanban #1244, audit 3 MONEY-3): its notes are claimed at the arbitration set,
    // and notes claimed there and exchanged here too would be paid twice. Asked before anything is written - and only for an exchange whose notes
    // this seat has not taken yet (kanban #1272, audit 4 #1257 fixesB-1): one taken before the halt (TAKEN, SENDING) is paid out, a PAID one is
    // answered again (above); refused, they stayed with the seat for good and the player was never paid
    // AN ASKED REISSUE IS FINISHED AFTER A HALT (kanban #1579, state audit 2026-11-12): a RECEIVING row that asked already (receive_asked
    // = 1, or NULL from before #1204) may hold the player's notes in the seat's client - spent at the federation, so the arbitration set
    // refuses his claim too. Refused here it stayed RECEIVING for good and nothing was paid. Such a row asks again below and takes only
    // AlreadyReceived (its own earlier reissue, from before the halt); a fresh Success after the halt is refused like a new exchange.
    let haltedWhy = null;
    if (!r || r.state === EXCHANGE.RECEIVING) {
      for (const fid of [from, to]) {
        // a halt check that cannot answer refuses (kanban #1577): read as "not halted", a liquidated federation's notes were paid twice
        let h = null; try { h = halted(String(fid || '').toLowerCase()); } catch (e) { return refuse(503, `cannot tell whether federation ${String(fid).slice(0, 16)} is being liquidated: ${e && e.message ? e.message : e}`); }
        if (h) { haltedWhy = `federation ${String(fid).slice(0, 16)} is being liquidated${Number.isInteger(h.height) ? ` (halted at ${h.height})` : ''}: its notes are claimed at the arbitration set, not exchanged here`; break; }
        // an asked RECEIVING row (holdsNotes, kanban #1583) is never refused 4xx here: it goes on to finish its reissue (#1579); a new or unasked row gets 409 below
      }
      const askedEarlier = r && (r.receive_asked === null || r.receive_asked === undefined || Number(r.receive_asked) === 1);
      if (haltedWhy && !askedEarlier) return refuse(409, haltedWhy);
    }
    const [pin, pout] = await Promise.all([portOf(from), portOf(to)]);
    if (!pin || !pout || typeof pin.ecashReceive !== 'function' || typeof pout.ecashSend !== 'function')
      return holdsNotes ? refuse(503, 'this seat\'s client of one of the two federations is not up yet and it holds your exchange: ask again with the same e-cash')
        : refuse(409, 'this seat holds no client of one of the two federations, or its tool cannot move e-cash');
    // THE SEAT CAN PAY BEFORE IT TAKES ANYTHING, and within its hour - asked before EVERY reissue, not only a new row's first (kanban #1637,
    // audit 2026-11-12 sm2 federation-1): a row left in RECEIVING by a reissue that did not answer was retried later with no check, while
    // other exchanges had spent the seat's notes in `to` meanwhile - the retry took the player's notes and the payout then failed
    if (!r || r.state === EXCHANGE.RECEIVING) {
      const w = r ? BigInt(r.want_msat || want) : want;
      const paidHour = lastHour.all(id, now() - 3_600_000).reduce((t, x) => t + BigInt((x.state === EXCHANGE.RECEIVING ? x.want_msat : (x.out_msat || x.pay_msat)) || 0), 0n);
      let no = null;
      if (paidHour + w > perHourMsat) no = refuse(429, `this seat's exchanges for this hour are spent (${perHourMsat / 1000n} sat an hour)`);
      else {
        const owed = owedRows.all(to, id).reduce((t, x) => {
          if (x.state === EXCHANGE.SENDING) return t + BigInt(x.pay_msat || 0);
          if (x.state === EXCHANGE.RECEIVING) return t + BigInt(x.want_msat || 0);   // kanban #2143: an asked reissue, at what it asked
          const a = BigInt(x.in_msat || 0), b = BigInt(x.want_msat || x.in_msat || 0);
          return t + (a < b ? a : b);
        }, 0n);
        const holds = await pout.ecashBalance();
        const free = holds - owed;
        if (free < w) no = refuse(409, `this seat holds ${(free > 0n ? free : 0n) / 1000n} sat free in federation ${to.slice(0, 8)}: too little for ${w / 1000n} sat`);
      }
      if (no) {
        // a row whose earlier ask may have reached the federation (receive_asked 1, or a row from before #1204: NULL) is held - its notes may
        // be in already; one that never asked has taken nothing and stays RECEIVING for a later ask
        if (r && (r.receive_asked === null || r.receive_asked === undefined || Number(r.receive_asked) === 1)) {   // Number(null) is 0: NULL named here
          note(id, EXCHANGE.RECEIVING, `held: ${no.why}`);
          return refuse(503, `that exchange is held, nothing paid yet: ${no.why}; ask again later with the same e-cash`);
        }
        return no;
      }
    }
    if (!r) {
      // THE RECORD FIRST (kanban #1160): the exchange exists before the player's notes are reissued
      const t = transition(id, null, EXCHANGE.RECEIVING, { from_fed: from, to_fed: to, want_msat: String(want), receive_asked: 0 });
      if (!t.ok) return t;
      r = get.get(id);
    }
    // THE PLAYER'S NOTES IN: reissued into the seat's client of `from`
    if (r.state === EXCHANGE.RECEIVING) {
      // kanban #1204 RES-3: did THIS row ask before? Written before the ask, so a stop after it still counts the ask
      const askedBefore = r.receive_asked === null || r.receive_asked === undefined || Number(r.receive_asked) === 1;
      if (!askedBefore) durably(db, () => markAsked.run(id));   // on the disk before the ask (kanban #1243)
      let got;
      try { got = await pin.ecashReceive(ecash); }
      catch (e) { note(id, EXCHANGE.RECEIVING, `the receive did not answer: ${e.message}`); return refuse(503, `federation ${from.slice(0, 8)} did not answer the reissue (${String(e.message).slice(0, 120)}); ask again with the same e-cash`); }
      let carried = null;
      if (got.state === 'Success' && haltedWhy) {
        // kanban #1579: the earlier ask never reached the federation - this reissue is new, after the halt: not exchanged
        transition(id, EXCHANGE.RECEIVING, EXCHANGE.REFUSED, { why: `reissued after the halt, held for the operator: ${haltedWhy}`.slice(0, 300) });
        log(`[exchange] ${id.slice(0, 12)}: a fresh reissue after the halt - refused, held for the operator, nothing paid`);
        return refuse(409, haltedWhy);
      }
      if (got.state === 'Success') carried = BigInt(got.msat || 0);
      else if (got.state === 'AlreadyReceived' && !askedBefore) {
        // RECEIVED BEFORE, BUT NOT BY THIS EXCHANGE (kanban #1204 RES-3): another spelling of the same notes, or notes this seat took elsewhere
        transition(id, EXCHANGE.RECEIVING, EXCHANGE.REFUSED, { why: 'those notes were received here before, not by this exchange' });
        log(`[exchange] ${id.slice(0, 12)}: AlreadyReceived on its first ask - refused, nothing paid`);
        return refuse(409, `federation ${from.slice(0, 8)} has those notes here already, from another exchange: nothing paid`);
      } else if (got.state === 'AlreadyReceived') {
        // OUR OWN EARLIER RECEIVE: the row was written before it, so this string was reissued for this exchange - its amount as the tool
        // reads it back (a tool from before #1160 cannot: the exchange is held, nothing paid)
        if (got.earlier && got.earlier !== 'Success') { note(id, EXCHANGE.RECEIVING, `the earlier receive is ${got.earlier}`); return refuse(503, `the earlier reissue of that e-cash is ${got.earlier}; ask again`); }
        if (got.carriedMsat === undefined || got.carriedMsat === null) {
          note(id, EXCHANGE.RECEIVING, 'received here before; this seat\'s tool does not say how much: held for the operator');
          log(`[exchange] ${id.slice(0, 12)}: received before, amount unknown to this tool - held, nothing paid`);
          return refuse(503, 'that e-cash is taken here and its amount cannot be read back yet: held, nothing paid twice');
        }
        carried = BigInt(got.carriedMsat);
      } else if (got.state === 'Invalid') {
        // NOT NOTES OF THIS FEDERATION (kanban #2384, #2436): the tool could not read them as e-cash, or they are another federation's, or of
        // a denomination it does not take - answered before anything reached a guardian, so nothing was taken: closed for good, never owed
        transition(id, EXCHANGE.RECEIVING, EXCHANGE.REFUSED, { why: `not e-cash of this federation: ${String(got.why || 'invalid').slice(0, 200)}` });
        return refuse(400, `that is not e-cash of federation ${from.slice(0, 8)}: ${String(got.why || 'invalid').slice(0, 120)}`);
      } else {
        transition(id, EXCHANGE.RECEIVING, EXCHANGE.REFUSED, { why: `the federation said ${got.state}` });
        return refuse(409, `federation ${from.slice(0, 8)} did not reissue that e-cash: ${got.state} (spent before?)`);
      }
      const t = transition(id, EXCHANGE.RECEIVING, EXCHANGE.TAKEN, { in_msat: String(carried), why: null });
      if (!t.ok) return t;
      r = get.get(id);
    }
    // THE SEAT'S NOTES OUT: what was taken, never more than was asked - named before they leave
    if (r.state === EXCHANGE.TAKEN) {
      const taken = BigInt(r.in_msat || 0);
      if (taken <= 0n) return refuse(409, 'that e-cash carried nothing');
      const asked = BigInt(r.want_msat || want);
      const pay = taken < asked ? taken : asked;
      const t = transition(id, EXCHANGE.TAKEN, EXCHANGE.SENDING, { pay_msat: String(pay), pay_ms: now() });   // kanban #1637: the hour it counts in
      if (!t.ok) return t;
      return send(id, pout, pay, { fresh: true });
    }
    if (r.state === EXCHANGE.SENDING) return send(id, pout, BigInt(r.pay_msat), { fresh: false });
    return refuse(409, `that exchange is ${r.state} here`);
  }

  // THE PAYOUT, keyed by the exchange id: a retry reads the keyed send back instead of spending again (kanban #1160)
  async function send(id, pout, pay, { fresh }) {
    let out = null;
    if (!fresh) {
      if (typeof pout.ecashSent !== 'function') {
        note(id, EXCHANGE.SENDING, 'the payout may have left; this seat\'s tool cannot read it back: held for the operator');
        return refuse(503, 'the payout\'s outcome is not known here and this seat\'s tool cannot read it back: held, nothing paid twice');
      }
      let seen;
      try { seen = await pout.ecashSent(id); }
      catch (e) { note(id, EXCHANGE.SENDING, `the keyed send could not be read back: ${e.message}`); return refuse(503, `the payout's outcome cannot be read yet (${String(e.message).slice(0, 120)}); ask again with the same e-cash`); }
      if (seen && seen.found) out = { ecash: seen.ecash, msat: BigInt(seen.msat) };
    }
    if (!out) {
      try { out = await pout.ecashSend(pay, { key: id }); }
      catch (e) {
        note(id, EXCHANGE.SENDING, `paying out failed: ${String(e.message).slice(0, 160)}`);
        log(`[exchange] ${id.slice(0, 12)}: the payout of ${pay} msat failed: ${e.message} - asked again, it is read back or paid once`);
        return refuse(503, `the payout failed (${String(e.message).slice(0, 120)}); ask again with the same e-cash`);
      }
    }
    const t = transition(id, EXCHANGE.SENDING, EXCHANGE.PAID, { out_msat: String(out.msat), out_ecash: out.ecash, why: null });
    if (!t.ok) return t;
    const r = get.get(id);
    log(`[exchange] ${id.slice(0, 12)}: ${r.in_msat} msat in ${r.from_fed.slice(0, 8)} -> ${out.msat} msat out in ${r.to_fed.slice(0, 8)}`);
    return { ok: true, msat: String(out.msat), ecash: out.ecash, federation: r.to_fed };
  }

  /** What this seat can exchange: the federations it holds notes in, and how much, msat (kanban #614). */
  async function offer(feds) {
    const out = {};
    for (const f of feds) {
      try { const p = await portOf(String(f).toLowerCase()); if (p && typeof p.ecashBalance === 'function') out[String(f).toLowerCase()] = String(await p.ecashBalance()); }
      catch { /* not answered */ }
    }
    return { maxMsat: String(maxMsat), perHourMsat: String(perHourMsat), holds: out };
  }

  return { exchange, offer, stateOf: (id) => get.get(String(id)) || null };
}
