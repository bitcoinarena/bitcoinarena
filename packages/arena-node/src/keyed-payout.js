// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE PAYOUT FROM A CARRIER'S OR AN ARBITER'S OWN E-CASH, PAID ONCE (kanban #1174, the state machine audit of 2026-11-06, high). The stake-lock tool's
// `pay` is a subprocess: a crash after the guardians took the transaction and before the caller wrote its txid, and the next pass paid the players
// and the reserves again. Now every payout is a record in the caller's own state, moved only by `payoutStep`:
//   NONE    nothing asked
//   ASKED   written BEFORE the tool is called: the payout's idempotency key (the tool's operation is H("arena-payout:" || key), which the client
//           refuses to submit twice) and its list, kept - a retry pays exactly that list under that key, never a list worked out again
//   PAID    the transaction the tool answered, with each payout's outpoint (the caller writes it, with its own bookkeeping, in one write)
// A pass that finds ASKED asks the tool first what that key paid (`pay-sent`): found, it is PAID with that transaction; never submitted, it is
// paid now under the same key; refused by the guardians (nothing paid), it is paid under the next key (`key#n`). A tool that cannot answer
// `pay-sent` (one built before this) leaves the payout ASKED and HELD - said, never paid twice. PAID goes nowhere.
// The template is held-proof-run.js's journal: persist (or refuse) before the irreversible step.
export const PAYOUT = Object.freeze({ NONE: 'NONE', ASKED: 'ASKED', PAID: 'PAID' });
const MOVES = Object.freeze({ [PAYOUT.NONE]: [PAYOUT.ASKED], [PAYOUT.ASKED]: [PAYOUT.ASKED, PAYOUT.PAID], [PAYOUT.PAID]: [] });
export const payoutOf = (rec) => (rec && rec.step) || PAYOUT.NONE;

/** The record `rec` moved to `to` (MOVES), `fields` merged in - compare-and-set on its step: answers false, `rec` unchanged, for any other move. */
export function payoutStep(rec, to, fields = {}) {
  if (!MOVES[payoutOf(rec)].includes(to)) return false;
  Object.assign(rec, fields, { step: to });
  return true;
}

const listOf = (list) => list.map((x) => ({ key: String(x.key).toLowerCase(), msat: String(x.msat) }));
// the recorded list as the tool is handed it: msat as BigInt
const asked = (rec) => rec.list.map((x) => ({ key: x.key, msat: BigInt(x.msat) }));

/**
 * PAY `list` ONCE under `key`. `rec` the payout's record (kept in the caller's state, moved here), `save()` persists that state - called once
 * the record is ASKED, before the tool is. `pay(list, key)` -> { txid, payouts } or throws; `paidBack(list, key)` -> { found, txid, payouts,
 * rejected } or throws (a tool without `pay-sent`). `list` [{ key, msat }] is taken only from NONE; ASKED pays the list it recorded.
 * -> { ok: true, txid, payouts, list, again } with `rec` PAID (the caller writes it), or { ok: false, why, held } with `rec` ASKED.
 */
export async function keyedPay({ rec, save, list, key, pay, paidBack, now = Date.now }) {
  if (payoutOf(rec) === PAYOUT.PAID) return { ok: true, txid: rec.txid, payouts: rec.payouts || [], list: rec.list, again: true };
  if (payoutOf(rec) === PAYOUT.NONE) {
    payoutStep(rec, PAYOUT.ASKED, { key: String(key), base: String(key), attempt: 0, list: listOf(list), askedAtMs: now() });
    save();
  } else {
    // ASKED BEFORE A STOP (or a pay that did not answer): what did that key pay?
    let back;
    try { back = await paidBack(asked(rec), rec.key); } catch (e) {
      return { ok: false, held: true, why: `a payout under ${rec.key} was asked before and the tool cannot say what it paid (${String(e.message || e).slice(0, 160)}): held, never paid twice` };
    }
    if (back && back.found) {
      payoutStep(rec, PAYOUT.PAID, { txid: String(back.txid), payouts: back.payouts || [], paidAtMs: now(), readBack: true });
      return { ok: true, txid: rec.txid, payouts: rec.payouts, list: rec.list, again: true };
    }
    if (back && back.rejected) {
      payoutStep(rec, PAYOUT.ASKED, { attempt: Number(rec.attempt || 0) + 1, key: `${rec.base || rec.key}#${Number(rec.attempt || 0) + 1}`, askedAtMs: now(), refused: String(back.why || 'refused') });
      save();
    }
  }
  let paid;
  try { paid = await pay(asked(rec), rec.key); } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 300) }; }
  if (!paid || !paid.txid) return { ok: false, why: 'the tool answered no payout transaction' };
  payoutStep(rec, PAYOUT.PAID, { txid: String(paid.txid), payouts: paid.payouts || [], paidAtMs: now(), again: !!paid.again });
  return { ok: true, txid: rec.txid, payouts: rec.payouts, list: rec.list, again: !!paid.again };
}

/**
 * The tool's `pay` and `pay-sent` over a runner `run(args)` that answers the tool's JSON line or { error } (arbiter.js, liquidation-claims.js):
 * { pay, paidBack } for keyedPay, each payout row as the tool prints it (refund_pk, out_idx, contract_id, amount_msat).
 */
export function runPayouts(run) {
  const arg = (list) => list.map((x) => `${x.key}:${x.msat}`).join(',');
  return {
    pay: async (list, key) => { const r = await run(['--mode', 'pay', '--payouts', arg(list), '--key', key]); if (!r || !r.txid) throw new Error(String((r && r.error) || JSON.stringify(r))); return r; },
    paidBack: async (list, key) => {
      const r = await run(['--mode', 'pay-sent', '--payouts', arg(list), '--key', key]);
      if (!r || r.mode !== 'pay-sent') throw new Error((r && r.error) || 'no answer to pay-sent');
      return { found: !!r.found, rejected: !!r.rejected, txid: r.txid || null, payouts: r.payouts || [], why: r.why || null };
    },
  };
}
