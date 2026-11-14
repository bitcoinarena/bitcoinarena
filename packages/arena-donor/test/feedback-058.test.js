// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEEDBACK #058 (Hexbox, high, 2026-11-14 03:30Z, commit e70dd5e): ARENA-DONOR MOVES A DEV'S MONEY OUT OF A FEDERATION ON ONE SEAT'S
// UNSIGNED WORD. donor.js invitesFromSeats fills the donor's fedStates from the FIRST seat that lists a federation: the status is the
// seat's plain JSON field, the successor the record's successorId after a bare split (no signature, census or threshold check - a record
// with no signatures reads fine), keyed by the seat's own `federation` field. bin/arena-donor.mjs then runs migrateFromDraining whenever
// that state says DRAINING with a successor whose invite it knows - and the same seat lists that "successor" with its own invite. Two
// honest seats saying OPEN change nothing: the first lister wins. And `!states[fid]` with a module-level fedStates reads a federation's
// state once per process, so a real DRAIN signed later is never acted on until a restart.
// Safe behaviour: one seat's unsigned record and JSON status do not make a federation DRAINING towards a successor; a later answer is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invitesFromSeats } from '../src/donor.js';
import { buildFederationRecord, encodeFederationRecord, joinSignedRecord, splitSignedRecord } from '../../arena-protocol/src/federation-record.js';

const b = (n) => new Uint8Array(32).fill(n);
const R = b(0x52), X = b(0x58), NET = b(0x4e);
const hex = (u) => Buffer.from(u).toString('hex');
// an UNSIGNED record (0 signatures, no guardians) naming its federation's invite and, for the evil seat, a successor X
const recordHex = (fid, invite, successorId = null) => hex(joinSignedRecord(encodeFederationRecord(buildFederationRecord({ federationId: fid, networkId: NET, invite,
  nominal: 4, guardians: [], successorId, height: 100 })), []));
const decode = (h) => splitSignedRecord(Buffer.from(h, 'hex')).record;   // what bin/arena-donor.mjs hands in
const fetcherFor = (answers) => async (url) => { const a = answers[url.replace('/federations', '')]; if (!a) throw new Error('down'); return { json: async () => a }; };

test('#058: one seat listing R as DRAINING with an unsigned record naming X does not set R\'s state, while two seats list R OPEN', async () => {
  const answers = {
    'http://evil': { federations: [{ federation: hex(R), status: 'DRAINING', record: recordHex(R, 'fed11real', X) }, { federation: hex(X), status: 'OPEN', record: recordHex(X, 'fed11evil') }] },
    'http://seat-2': { federations: [{ federation: hex(R), status: 'OPEN', record: recordHex(R, 'fed11real') }] },
    'http://seat-3': { federations: [{ federation: hex(R), status: 'OPEN', record: recordHex(R, 'fed11real') }] },
  };
  const states = {};
  const invites = await invitesFromSeats({ seats: Object.keys(answers), fetcher: fetcherFor(answers), decode, states });
  console.log(`  FACTS #058: states[R] = ${JSON.stringify(states[hex(R)])}; invite of X known: ${!!invites[hex(X)]}`);
  const st = states[hex(R)];
  assert.ok(!(st && st.status === 'DRAINING' && st.successor === hex(X)),
    `one seat's unsigned word made R DRAINING towards X (the donor then empties the dev's wallet in R into X): ${JSON.stringify(st)}`);
});

test('#058 (2): a federation\'s state is read again on a later pass - a real DRAINING after an OPEN is seen', async () => {
  const S = b(0x53);
  const states = {};
  await invitesFromSeats({ seats: ['http://s'], fetcher: fetcherFor({ 'http://s': { federations: [{ federation: hex(R), status: 'OPEN', record: recordHex(R, 'fed11real') }] } }), decode, states });
  await invitesFromSeats({ seats: ['http://s'], fetcher: fetcherFor({ 'http://s': { federations: [{ federation: hex(R), status: 'DRAINING', record: recordHex(R, 'fed11real', S) }] } }), decode, states });
  console.log(`  FACTS #058 (2): states[R] after OPEN then DRAINING -> S: ${JSON.stringify(states[hex(R)])}`);
  assert.notEqual(states[hex(R)] && states[hex(R)].status, 'OPEN', 'the second pass\'s DRAINING was never read: the state stays the first one for the life of the process');
});
