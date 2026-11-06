// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DEPOSITS STOP ON A RESERVE ALARM (kanban #1093 part 5, ruling #1106): a seat keeps the first mark of theft per federation and lists it
// with the record; a client that reads one from any seat refuses deposits into that federation, and never picks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReserveAlarms, alarmRefusal } from '../src/reserve-alarms.js';
import { federationStatuses, pickFederation, depositFederation, alarmSays } from '../../arena-client/src/federations.js';

const FED = 'ab'.repeat(32), OTHER = 'cd'.repeat(32);

test('the book: the first mark per federation stands, kept and loaded again; a mark without its proof is refused by name', () => {
  let saved = [];
  const b = createReserveAlarms({ save: (all) => { saved = all; }, nowMs: () => 1 });
  assert.match(b.raise({ federation: FED, kind: 'theft', height: 1 }).why, /one of inflation, unbacked-spend/);
  assert.match(b.raise({ federation: FED, kind: 'inflation', height: 1 }).why, /signed session/);
  assert.match(b.raise({ federation: FED, kind: 'unbacked-spend', height: 1 }).why, /names its transaction/);
  assert.deepEqual(b.raise({ federation: FED, kind: 'inflation', height: 900, session: 9600, issuedMsat: 5n, redeemedMsat: 7n }).kept, true);
  assert.equal(b.raise({ federation: FED, kind: 'unbacked-spend', height: 901, txid: 'ee'.repeat(32) }).kept, false, 'the first stands');
  assert.deepEqual(b.of(FED), { federation: FED, kind: 'inflation', height: 900, session: 9600, issuedMsat: '5', redeemedMsat: '7', seenAtMs: 1, state: 'RAISED' });
  assert.equal(b.of(OTHER), null);
  assert.deepEqual(createReserveAlarms({ load: () => saved }).of(FED).session, 9600, 'kept across a restart');
});

test('the client: one seat naming an alarm stops deposits into that federation; it is never picked; the page says why', async () => {
  const fetcher = async (url) => ({ ok: true, status: 200, json: async () => ({ federations: [
    ...(url.includes('seat-1') ? [{ federation: FED, record: '00', alarm: { kind: 'inflation', height: 900, session: 9600 } }] : [{ federation: FED, record: '00' }]),
    { federation: OTHER, record: '00' }] }) });
  const all = await federationStatuses({ nodes: ['https://seat-1', 'https://seat-2'], census: [], verify: () => false, fetcher });
  const a = all.get(FED), o = all.get(OTHER);
  assert.deepEqual([a.alarm.kind, a.alarm.from, a.allows.deposit, a.allows.withdraw], ['inflation', 'https://seat-1', false, true], 'deposits stop; Withdraw stays');
  assert.deepEqual([o.alarm, o.allows.deposit], [undefined, true]);
  const open = (f, load, extra = {}) => ({ federation: f, status: 'OPEN', load, invite: `inv-${f.slice(0, 2)}`, allows: { deposit: true }, ...extra });
  assert.equal(pickFederation([open(FED, 0.1, { alarm: { kind: 'inflation' } }), open(OTHER, 0.9)]).federation, OTHER, 'the lower load with an alarm is not picked');
  assert.equal(pickFederation([open(FED, 0.1, { alarm: { kind: 'inflation' } })]), null);
  assert.equal(depositFederation({ lobbyInvite: 'lobby', statuses: [open(FED, 0.1, { alarm: { kind: 'unbacked-spend' } })] }).federation, null);
  assert.match(alarmSays({ alarm: { kind: 'inflation' } }), /^Deposits into this federation are stopped: in its own signed history, more e-cash was redeemed than was ever issued/);
  assert.match(alarmSays({ alarm: { kind: 'unbacked-spend' } }), /spent on the chain with no peg-out its guardians signed/);
  assert.equal(alarmSays({}), '');
});

test('alarmRefusal: a staked round of an alarmed federation is refused by name; a free round, another federation or no alarm is not (kanban #1108)', () => {
  const fid = new Uint8Array(32).fill(0xab), other = new Uint8Array(32).fill(0xcd);
  const alarms = createReserveAlarms();
  assert.equal(alarmRefusal(alarms, { stakeMsat: 1000n, federationId: fid }), null, 'no alarm yet');
  alarms.raise({ federation: 'ab'.repeat(32), kind: 'inflation', height: 300, session: 41 });
  assert.match(alarmRefusal(alarms, { stakeMsat: 1000n, federationId: fid }), /mark of theft in federation abababababababab \(inflation at signed session 41, height 300\): no deposit, entry or lock/);
  assert.equal(alarmRefusal(alarms, { stakeMsat: 0n, federationId: fid }), null, 'a free round moves no money');
  assert.equal(alarmRefusal(alarms, { stakeMsat: 1000n, federationId: other }), null);
  assert.equal(alarmRefusal(null, { stakeMsat: 1000n, federationId: fid }), null);
  alarms.raise({ federation: 'cd'.repeat(32), kind: 'unbacked-spend', height: 310, txid: 'ee'.repeat(32) });
  assert.match(alarmRefusal(alarms, { stakeMsat: 1n, federationId: other }), /an unbacked spend of its reserve by eeee/);
});
