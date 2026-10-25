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
import { createHash } from 'node:crypto';

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
  const get = db.prepare('SELECT * FROM ecash_exchanges WHERE id = ?');
  const put = db.prepare(`INSERT INTO ecash_exchanges (id, from_fed, to_fed, in_msat, out_msat, out_ecash, state, why, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET in_msat = excluded.in_msat, out_msat = excluded.out_msat, out_ecash = excluded.out_ecash, state = excluded.state, why = excluded.why`);
  const lastHour = db.prepare("SELECT out_msat FROM ecash_exchanges WHERE state = 'paid' AND made_ms >= ?");
  let queue = Promise.resolve();
  const hex64 = /^[0-9a-f]{64}$/;

  async function exchange({ from, to, ecash, amountMsat }) {
    from = String(from || '').toLowerCase(); to = String(to || '').toLowerCase();
    if (!hex64.test(from) || !hex64.test(to)) return { ok: false, status: 400, why: 'from and to are federation ids, 32 bytes hex' };
    if (from === to) return { ok: false, status: 400, why: 'from and to are the same federation: nothing to exchange' };
    if (typeof ecash !== 'string' || ecash.length < 20 || ecash.length > 200_000) return { ok: false, status: 400, why: 'ecash is the e-cash string of federation `from`' };
    let want; try { want = BigInt(amountMsat); } catch { want = -1n; }
    if (want <= 0n) return { ok: false, status: 400, why: 'amountMsat is the amount the e-cash carries' };
    if (want > maxMsat) return { ok: false, status: 409, why: `this seat exchanges at most ${maxMsat / 1000n} sat at a time` };
    const id = createHash('sha256').update(ecash.trim()).digest('hex');
    const run = queue.then(() => step({ id, from, to, ecash: ecash.trim(), want }));
    queue = run.catch(() => {});
    return run;
  }

  async function step({ id, from, to, ecash, want }) {
    const had = get.get(id);
    if (had && had.state === 'paid') return { ok: true, again: true, msat: String(had.out_msat), ecash: had.out_ecash, federation: had.to_fed };
    const paidHour = lastHour.all(now() - 3_600_000).reduce((t, r) => t + BigInt(r.out_msat || 0), 0n);
    if (!had && paidHour + want > perHourMsat) return { ok: false, status: 429, why: `this seat's exchanges for this hour are spent (${perHourMsat / 1000n} sat an hour)` };
    const [pin, pout] = await Promise.all([portOf(from), portOf(to)]);
    if (!pin || !pout || typeof pin.ecashReceive !== 'function' || typeof pout.ecashSend !== 'function')
      return { ok: false, status: 409, why: 'this seat holds no client of one of the two federations, or its tool cannot move e-cash' };
    // the seat can pay before it takes anything
    if (!had) {
      const holds = await pout.ecashBalance();
      if (holds < want) return { ok: false, status: 409, why: `this seat holds ${holds / 1000n} sat in federation ${to.slice(0, 8)}: too little for ${want / 1000n} sat` };
    }
    // THE PLAYER'S NOTES IN: reissued into the seat's client of `from`. Kept as taken before anything is paid out.
    let got = had && had.in_msat ? { state: 'Success', msat: BigInt(had.in_msat) } : null;
    if (!got) {
      got = await pin.ecashReceive(ecash);
      if (got.state === 'AlreadyReceived' && !had) return { ok: false, status: 409, why: 'that e-cash was received here before, and not through this exchange' };
      if (got.state !== 'Success' && got.state !== 'AlreadyReceived') {
        put.run(id, from, to, null, null, null, 'refused', `the federation said ${got.state}`, now());
        return { ok: false, status: 409, why: `federation ${from.slice(0, 8)} did not reissue that e-cash: ${got.state} (spent before?)` };
      }
      put.run(id, from, to, String(got.msat), null, null, 'taken', null, now());
    }
    if (got.msat <= 0n) return { ok: false, status: 409, why: 'that e-cash carried nothing' };
    // THE SEAT'S NOTES OUT: what was taken, never more than was asked
    const pay = got.msat < want ? got.msat : want;
    let out;
    try { out = await pout.ecashSend(pay); }
    catch (e) {
      put.run(id, from, to, String(got.msat), null, null, 'taken', `paying out failed: ${String(e.message).slice(0, 160)}`, now());
      log(`[exchange] ${id.slice(0, 12)}: ${got.msat} msat taken in ${from.slice(0, 8)}, the payout in ${to.slice(0, 8)} failed: ${e.message} - asked again, it is paid`);
      return { ok: false, status: 503, why: `the payout in federation ${to.slice(0, 8)} failed (${String(e.message).slice(0, 120)}); ask again with the same e-cash` };
    }
    put.run(id, from, to, String(got.msat), String(out.msat), out.ecash, 'paid', null, now());
    log(`[exchange] ${id.slice(0, 12)}: ${got.msat} msat in ${from.slice(0, 8)} -> ${out.msat} msat out in ${to.slice(0, 8)}`);
    return { ok: true, msat: String(out.msat), ecash: out.ecash, federation: to };
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

  return { exchange, offer };
}
