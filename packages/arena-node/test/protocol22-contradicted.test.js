// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CONTRADICTED AUDIT IN A PAID PROTOCOL-22 ROUND (kanban #725, #724; spec §13A.1): the round of protocol22-paid.test.js - seven seats,
// the auditor beside them, two real stakes - and the AUDIT every seat holds is contradicted by a valid objection: the seats' own word
// (auditDesk.contradict, what rerunAndFile records on every seat once an objection holds; the objection and the re-run themselves, and
// the AUDIT_CONTRADICTED slash proof the seat files, are audit-slash.test.js's, on the one-seat fixture whose five keys sign a false run).
// Then the round settles with money: the auditors' line is paid to nobody, the seats take the whole nodes' part after the website's
// line, the winner's and the website's lines are what they were, and every seat keeps the AUDIT's bytes and signature as the evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { LOSER } from './window-fixture.js';
import { seatsAndAuditor, winnerUnder, owedTable, WEBSITE, str } from './protocol22-fixture.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('the AUDIT contradicted by a valid objection: the auditors\' line is paid to nobody, the seats take the whole nodes\' part, the evidence kept', { timeout: 170000 }, async () => {
  const { w, auditor, key: auditorKey, close } = await seatsAndAuditor();
  try {
    const winner = await winnerUnder(w);
    const won = await lockAndPlay(w, winner, { frontendPk: WEBSITE });
    const lost = await lockAndPlay(w, LOSER);
    let did = null, marked = null;
    await closeRound(w, { inside: async () => {
      did = await auditor.auditor.pass();
      // THE SEATS' WORD THAT A VALID OBJECTION CONTRADICTED A RESULT THE AUDIT VOUCHED FOR (what rerunAndFile records on every seat
      // once an objection holds - the objection path itself is audit-slash.test.js's): each marks the AUDIT it holds
      marked = w.nodes.map((d) => d.auditDesk.contradict(w.rid, `entry ${toHex(lost.eid)}: VOID after a valid objection`));
    } });
    const got = await untilSettled(w, 60000);
    const paid = [...w.port.payouts.values()];
    const byKey = new Map(paid.map((p) => [toHex(p.payoutPk), p.msat]));
    const owed = owedTable(w, { winner: won, loser: lost, auditors: [] });
    const seatKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    const rows = await Promise.all(w.nodes.map(async (d) => (await (await fetch(`http://127.0.0.1:${d.port}/audits?round=${toHex(w.rid)}`)).json()).audits));
    const facts = { state: got.state, why: got.why || null, audit: did, marked,
      contradictedEverywhere: rows.every((r) => r.length === 1 && /VOID after a valid objection/.test(r[0].contradicted) && r[0].audit && r[0].audit.length > 128),
      auditorLine: str(byKey.get(toHex(refundKeyOf(fromHex(auditorKey))))) ?? null, lines: paid.length,
      seats: seatKeys.map((k) => str(byKey.get(k))), owedSeats: seatKeys.map((k) => str(owed.perSeat.get(k))), website: str(byKey.get(toHex(WEBSITE))), winner: str(byKey.get(toHex(refundKeyOf(winner.key)))) };
    console.log('  FACTS (protocol 22 paid, AUDIT contradicted):', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.deepEqual(did, [{ round: toHex(w.rid), audited: 2, seats: 7 }]);
    assert.deepEqual(marked, w.nodes.map(() => [auditorKey]), 'every seat marked the one AUDIT it held');
    assert.equal(facts.contradictedEverywhere, true);
    assert.equal(byKey.has(toHex(refundKeyOf(fromHex(auditorKey)))), false, 'a contradicted AUDIT is paid');
    assert.equal(paid.length, 1 + 1 + 7, 'the winner, the website, seven seats - no auditor');
    assert.deepEqual(seatKeys.map((k) => byKey.get(k)), seatKeys.map((k) => owed.perSeat.get(k)), 'the seats take the whole nodes\' part after the website');
    assert.equal(byKey.get(toHex(WEBSITE)), owed.websiteMsat);
    assert.equal(byKey.get(toHex(refundKeyOf(winner.key))), owed.net);
  } finally { await close(); }
});
