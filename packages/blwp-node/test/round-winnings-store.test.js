// THE WINNINGS STORE A PAYOUT DEPENDS ON: putWinnings, putSendPlan and markSend, the three round.js methods winnings-send.js
// writes with (kanban #149 step 6, plan comment 249, Go 2026-10-05). Each row written, read back through the store's own
// readers (winnings, sendAttemptsOf, sendPlansOf), the attempt count, and markSend's state change. The six unused store
// methods (putPayout, payoutsInState, putHoldExpiry, holdExpiry, putInvoiceExpiry, invoiceExpiry) stay and are not tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (u) => Buffer.from(u).toString('hex');
const RID = b32(0x11), E1 = b32(0x21), E2 = b32(0x22), D1 = b32(0x31);
function store() {
  let now = 1_790_000_000_000;
  const round = new Round(openStore(':memory:'), () => now);
  // the round and its two entries the winnings rows name (winnings and winnings_sends reference entries; a donation send
  // names a send id, not an entry). The contract bytes are not read by these methods.
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(Buffer.from(RID), Buffer.from('round'), now);
  for (const e of [E1, E2]) round.db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(Buffer.from(e), Buffer.from(RID), Buffer.from('entry'), now);
  return { round, tick: (ms) => { now += ms; return now; }, now: () => now };
}
const plan = (entryId, attempt, more = {}) => ({ entryId, roundId: RID, attempt, address: 'winner@example.com', invoice: `lntbs${attempt}invoice`,
  paymentHash: 'AB'.repeat(32), invoiceMsat: 98000n, payoutMsat: 98000n, owedMsat: 98000n, gatewayUrl: 'https://gw.example/',
  gatewayPk: '02' + 'CD'.repeat(32), expiration: 700, why: 'the winner\'s invoice stands', ...more });

test('putWinnings: a row written and read back; an update keeps its first owed time, its request and its paid time', () => {
  const { round, tick, now } = store();
  const at = now();
  round.putWinnings({ entryId: E1, roundId: RID, owedMsat: 98000n, state: 'OWED', why: 'the round is FINAL' });
  assert.deepEqual(round.winnings(E1), { entryId: E1, roundId: RID, owedMsat: 98000n, state: 'OWED', request: null,
    why: 'the round is FINAL', owedMs: at, paidMs: null });
  assert.equal(round.winnings(E2), null, 'no row: null');
  tick(5000);
  round.putWinnings({ entryId: E1, roundId: RID, owedMsat: 98000n, state: 'SENDING', request: 'lntbs1request', why: 'sent to the gateway' });
  tick(5000);
  const paid = now();
  round.putWinnings({ entryId: E1, roundId: RID, owedMsat: 98000n, state: 'PAID', why: 'the gateway paid', paidMs: paid });
  tick(5000);
  round.putWinnings({ entryId: E1, roundId: RID, owedMsat: 97000n, state: 'PAID', why: 'read again' });
  assert.deepEqual(round.winnings(E1), { entryId: E1, roundId: RID, owedMsat: 97000n, state: 'PAID', request: 'lntbs1request',
    why: 'read again', owedMs: at, paidMs: paid }, 'owed time and request kept, paid time kept once set, the rest replaced');
});

test('putSendPlan: one row per attempt, the first of an attempt stands, hex read in lower case, a donation send kept apart; the latest attempt is the plan', () => {
  const { round, tick } = store();
  round.putSendPlan(plan(E1, 0));
  round.putSendPlan(plan(E1, 0, { invoice: 'lntbs-other', why: 'a second write of attempt 0' }));
  tick(1000);
  round.putSendPlan(plan(E1, 1, { invoiceMsat: 97000n, why: 'attempt 1, a fresh invoice' }));
  round.putSendPlan(plan(E2, 0, { address: 'second@example.com' }));
  round.putSendPlan(plan(D1, 0, { donation: true, address: 'lnurl1donee', payoutMsat: 24500n, owedMsat: 24500n, invoiceMsat: 24500n }));
  const attempts = round.sendAttemptsOf(RID);
  assert.deepEqual(attempts.map((a) => [hex(a.entryId).slice(0, 2), a.attempt, a.donation]), [['21', 0, false], ['21', 1, false], ['22', 0, false], ['31', 0, true]],
    'entry then attempt order, the donation send among them');
  const first = attempts[0];
  assert.deepEqual([first.invoice, first.why, first.state], ['lntbs0invoice', 'the winner\'s invoice stands', 'PLANNED'], 'the first write of an attempt stands');
  assert.deepEqual([first.paymentHash, first.gatewayPk], ['ab'.repeat(32), '02' + 'cd'.repeat(32)], 'hex kept in lower case');
  assert.deepEqual([first.invoiceMsat, first.payoutMsat, first.owedMsat, first.expiration], [98000n, 98000n, 98000n, 700n]);
  assert.deepEqual([first.txid, first.outIdx, first.preimage], [null, null, null]);
  const plans = round.sendPlansOf(RID);
  assert.deepEqual(plans.map((p) => [hex(p.entryId).slice(0, 2), p.attempt]), [['21', 1], ['22', 0], ['31', 0]], 'the latest attempt of each send');
  assert.equal(plans[0].invoiceMsat, 97000n);
  assert.equal(round.db.prepare('SELECT COUNT(*) AS n FROM donation_sends').get().n, 1, 'the donation send in donation_sends');
  assert.equal(round.db.prepare('SELECT COUNT(*) AS n FROM winnings_sends').get().n, 3);
  assert.deepEqual(round.sendAttemptsOf(b32(0x99)), [], 'another round: none');
});

test('markSend: the state and why of that attempt only; its contract and preimage kept once named; a donation send marked the same way', () => {
  const { round, tick } = store();
  round.putSendPlan(plan(E1, 0));
  round.putSendPlan(plan(E1, 1));
  round.putSendPlan(plan(D1, 0, { donation: true }));
  const updated = (entry, attempt) => round.db.prepare('SELECT updated_ms FROM winnings_sends WHERE entry_id = ? AND attempt = ? UNION ALL '
    + 'SELECT updated_ms FROM donation_sends WHERE entry_id = ? AND attempt = ?').get(Buffer.from(entry), attempt, Buffer.from(entry), attempt).updated_ms;
  const planned = updated(E1, 1);
  const at = tick(2000);
  round.markSend({ entryId: E1, attempt: 1, state: 'SENT', why: 'the contract is funded', txid: 'f0'.repeat(32), outIdx: 2 });
  const sent = round.sendAttemptsOf(RID).find((a) => hex(a.entryId).startsWith('21') && a.attempt === 1);
  assert.deepEqual([sent.state, sent.why, sent.txid, sent.outIdx, sent.preimage], ['SENT', 'the contract is funded', 'f0'.repeat(32), 2, null]);
  assert.equal(updated(E1, 1), at);
  assert.ok(at > planned);
  const other = round.sendAttemptsOf(RID).find((a) => hex(a.entryId).startsWith('21') && a.attempt === 0);
  assert.deepEqual([other.state, other.txid], ['PLANNED', null], 'attempt 0 untouched');
  tick(2000);
  round.markSend({ entryId: E1, attempt: 1, state: 'PAID', why: 'the gateway paid', preimage: '99'.repeat(32) });
  const paid = round.sendPlansOf(RID).find((p) => hex(p.entryId).startsWith('21'));
  assert.deepEqual([paid.state, paid.why, paid.txid, paid.outIdx, paid.preimage], ['PAID', 'the gateway paid', 'f0'.repeat(32), 2, '99'.repeat(32)],
    'the contract named before is kept; the preimage added');
  round.markSend({ entryId: D1, attempt: 0, state: 'FAILED', why: 'no route' });
  const d = round.sendPlansOf(RID).find((p) => p.donation);
  assert.deepEqual([d.state, d.why], ['FAILED', 'no route']);
  round.markSend({ entryId: b32(0x77), attempt: 0, state: 'PAID', why: 'nobody' });
  assert.equal(round.sendAttemptsOf(RID).length, 3, 'marking a send that does not exist adds nothing');
});
