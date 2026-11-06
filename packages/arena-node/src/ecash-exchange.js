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
import { createHash } from 'node:crypto';

export const EXCHANGE = Object.freeze({ RECEIVING: 'receiving', TAKEN: 'taken', SENDING: 'sending', PAID: 'paid', REFUSED: 'refused' });
export const EXCHANGE_NEXT = Object.freeze({
  NONE: [EXCHANGE.RECEIVING],
  [EXCHANGE.RECEIVING]: [EXCHANGE.TAKEN, EXCHANGE.REFUSED],
  [EXCHANGE.TAKEN]: [EXCHANGE.SENDING],
  [EXCHANGE.SENDING]: [EXCHANGE.PAID],
  [EXCHANGE.PAID]: [], [EXCHANGE.REFUSED]: [],
});

export function createEcashExchange({ db, portOf, maxMsat = 1_000_000n, perHourMsat = 20_000_000n, now = () => Date.now(), log = () => {} }) {
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
  const get = db.prepare('SELECT * FROM ecash_exchanges WHERE id = ?');
  // an hour's spend counts what is out or on its way out
  const lastHour = db.prepare("SELECT out_msat, pay_msat FROM ecash_exchanges WHERE state IN ('paid', 'sending') AND made_ms >= ?");
  let queue = Promise.resolve();
  const hex64 = /^[0-9a-f]{64}$/;
  const refuse = (status, why) => ({ ok: false, status, why });

  /** THE ONE WRITE (kanban #1160): `from` -> `to` along EXCHANGE_NEXT, compare-and-set on the state; nothing written otherwise. */
  function transition(id, from, to, fields = {}) {
    if (!(EXCHANGE_NEXT[from || 'NONE'] || []).includes(to)) return refuse(409, `an exchange does not go from ${from || 'nothing'} to ${to}`);
    const cols = Object.keys(fields);
    let c;
    if (!from) {
      c = db.prepare(`INSERT OR IGNORE INTO ecash_exchanges (id, state, made_ms${cols.map((k) => `, ${k}`).join('')}) VALUES (@id, @state, @made_ms${cols.map((k) => `, @${k}`).join('')})`)
        .run({ ...fields, id, state: to, made_ms: now() });
    } else {
      c = db.prepare(`UPDATE ecash_exchanges SET state = @state${cols.map((k) => `, ${k} = @${k}`).join('')} WHERE id = @id AND state = @from`).run({ ...fields, id, state: to, from });
    }
    return c.changes === 1 ? { ok: true, state: to } : refuse(409, `that exchange is no longer ${from || 'new'} here: not moved to ${to}`);
  }
  const note = (id, state, why) => db.prepare('UPDATE ecash_exchanges SET why = ? WHERE id = ? AND state = ?').run(String(why).slice(0, 300), id, state);

  async function exchange({ from, to, ecash, amountMsat }) {
    from = String(from || '').toLowerCase(); to = String(to || '').toLowerCase();
    if (!hex64.test(from) || !hex64.test(to)) return refuse(400, 'from and to are federation ids, 32 bytes hex');
    if (from === to) return refuse(400, 'from and to are the same federation: nothing to exchange');
    if (typeof ecash !== 'string' || ecash.length < 20 || ecash.length > 200_000) return refuse(400, 'ecash is the e-cash string of federation `from`');
    let want; try { want = BigInt(amountMsat); } catch { want = -1n; }
    if (want <= 0n) return refuse(400, 'amountMsat is the amount the e-cash carries');
    if (want > maxMsat) return refuse(409, `this seat exchanges at most ${maxMsat / 1000n} sat at a time`);
    const id = createHash('sha256').update(ecash.trim()).digest('hex');
    const run = queue.then(() => step({ id, from, to, ecash: ecash.trim(), want }));
    queue = run.catch(() => {});
    return run;
  }

  const paidAnswer = (r, again) => ({ ok: true, ...(again ? { again: true } : {}), msat: String(r.out_msat), ecash: r.out_ecash, federation: r.to_fed });

  async function step({ id, from, to, ecash, want }) {
    let r = get.get(id);
    if (r && r.state === EXCHANGE.PAID) return paidAnswer(r, true);
    if (r && r.state === EXCHANGE.REFUSED) return refuse(409, `federation ${r.from_fed.slice(0, 8)} did not reissue that e-cash: ${r.why || 'refused'}`);
    if (r && (r.from_fed !== from || r.to_fed !== to)) return refuse(409, 'that e-cash is in an exchange between two other federations here');
    const [pin, pout] = await Promise.all([portOf(from), portOf(to)]);
    if (!pin || !pout || typeof pin.ecashReceive !== 'function' || typeof pout.ecashSend !== 'function')
      return refuse(409, 'this seat holds no client of one of the two federations, or its tool cannot move e-cash');
    if (!r) {
      const paidHour = lastHour.all(now() - 3_600_000).reduce((t, x) => t + BigInt(x.out_msat || x.pay_msat || 0), 0n);
      if (paidHour + want > perHourMsat) return refuse(429, `this seat's exchanges for this hour are spent (${perHourMsat / 1000n} sat an hour)`);
      // the seat can pay before it takes anything
      const holds = await pout.ecashBalance();
      if (holds < want) return refuse(409, `this seat holds ${holds / 1000n} sat in federation ${to.slice(0, 8)}: too little for ${want / 1000n} sat`);
      // THE RECORD FIRST (kanban #1160): the exchange exists before the player's notes are reissued
      const t = transition(id, null, EXCHANGE.RECEIVING, { from_fed: from, to_fed: to, want_msat: String(want) });
      if (!t.ok) return t;
      r = get.get(id);
    }
    // THE PLAYER'S NOTES IN: reissued into the seat's client of `from`
    if (r.state === EXCHANGE.RECEIVING) {
      let got;
      try { got = await pin.ecashReceive(ecash); }
      catch (e) { note(id, EXCHANGE.RECEIVING, `the receive did not answer: ${e.message}`); return refuse(503, `federation ${from.slice(0, 8)} did not answer the reissue (${String(e.message).slice(0, 120)}); ask again with the same e-cash`); }
      let carried = null;
      if (got.state === 'Success') carried = BigInt(got.msat || 0);
      else if (got.state === 'AlreadyReceived') {
        // OUR OWN EARLIER RECEIVE: the row was written before it, so this string was reissued for this exchange - its amount as the tool
        // reads it back (a tool from before #1160 cannot: the exchange is held, nothing paid)
        if (got.earlier && got.earlier !== 'Success') { note(id, EXCHANGE.RECEIVING, `the earlier receive is ${got.earlier}`); return refuse(503, `the earlier reissue of that e-cash is ${got.earlier}; ask again`); }
        if (got.carriedMsat === undefined || got.carriedMsat === null) {
          note(id, EXCHANGE.RECEIVING, 'received here before; this seat\'s tool does not say how much: held for the operator');
          log(`[exchange] ${id.slice(0, 12)}: received before, amount unknown to this tool - held, nothing paid`);
          return refuse(503, 'that e-cash is taken here and its amount cannot be read back yet: held, nothing paid twice');
        }
        carried = BigInt(got.carriedMsat);
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
      const t = transition(id, EXCHANGE.TAKEN, EXCHANGE.SENDING, { pay_msat: String(pay) });
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
