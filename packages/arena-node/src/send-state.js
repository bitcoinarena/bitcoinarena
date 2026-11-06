// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE ONE SEND ATTEMPT STANDS, AS ONE ENUM WITH ONE TRANSITION FUNCTION (kanban #1154, the state machine audit of 2026-11-06).
//
// Before this the states of a winnings or donation send were strings written wherever the code got to: any `markSend` set any state
// over any other, so nothing said PAID was final or that a send was marked SENDING before the gateway was asked. Now every move of a
// row goes through `sendMove` (round.js `markSend` applies it as a compare-and-set on the row's state), and the order is:
//
//   PLANNED   the plan this seat checked and kept (attempt 0), or a re-send a seat of the round proposed and this seat checked (attempt N+1).
//             The only state a kept first plan can be replaced in, and only by a lower plan a seat of the round signed (winnings-send.js `check`).
//   HELD      a donation share whose recipient did not answer: settled into a contract under the committee key, re-sent once it answers.
//   FUNDING   a re-send's transaction (the expired contract refunded into the new one) about to go to the guardians: persisted first.
//   SENDING   the contract is funded and the gateway is about to be asked to pay it: persisted before the ask.
//   PAID      the gateway's preimage, checked against the invoice's hash. Final.
//   REFUNDED  a protocol-27 send that expired unpaid, its presigned refund (c) accepted. Final.
//
// Nothing irreversible happens to a send before its state says so: the guardians are handed a re-send only from FUNDING, the gateway is
// asked only from SENDING. A row in a final state never moves.
export const SEND = Object.freeze({
  PLANNED: 'PLANNED', HELD: 'HELD', FUNDING: 'FUNDING', SENDING: 'SENDING', PAID: 'PAID', REFUNDED: 'REFUNDED',
});

const NEXT = Object.freeze({
  [SEND.PLANNED]: [SEND.HELD, SEND.FUNDING, SEND.SENDING, SEND.PAID],
  [SEND.HELD]: [SEND.HELD],
  [SEND.FUNDING]: [SEND.FUNDING, SEND.SENDING, SEND.PAID],
  // SENDING again: the gateway was asked and did not pay; the row keeps its contract and says why
  [SEND.SENDING]: [SEND.SENDING, SEND.PAID, SEND.REFUNDED],
  [SEND.PAID]: [],
  [SEND.REFUNDED]: [],
});

export const isSendState = (s) => Object.prototype.hasOwnProperty.call(NEXT, s);
export const isFinalSend = (s) => s === SEND.PAID || s === SEND.REFUNDED;

/** THE ONE TRANSITION FUNCTION: may a send attempt in `from` move to `to`? { ok } or { ok: false, why }. */
export function sendMove(from, to) {
  if (!isSendState(to)) return { ok: false, why: `${to} is not a state a send can be in` };
  if (!isSendState(from)) return { ok: false, why: `the send is in ${from}, which is no state a send can be in` };
  return NEXT[from].includes(to) ? { ok: true } : { ok: false, why: `a send in ${from} does not move to ${to}` };
}

/** Every state a send may move to `to` from: the WHERE of round.js's compare-and-set. */
export function statesBefore(to) {
  return Object.keys(NEXT).filter((from) => NEXT[from].includes(to));
}
