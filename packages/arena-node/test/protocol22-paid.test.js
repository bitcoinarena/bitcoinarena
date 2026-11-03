// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAID ROUND AT PROTOCOL 22, END TO END, WITH MONEY (kanban #725, #724; spec §27A.9, §13A.1, §22A): seven in-process seats of one
// federation (the fixture's fake lock port), their claim key and the federation's reserve key both made by their own DKGs, and an eighth
// daemon that is no seat of the round and the one node that may audit it. Two players lock real stakes as the page makes them on
// protocol 11 and later - the nodes' 4 % in the fee lock, the developers' 4 % as donation outputs to the round's sets, the reserves' 2 %
// as one output to the reserve key - every seat verifies the three with the federation at the lock, one wins. Inside the window the
// auditor replays both runs from a seat and posts its AUDIT to every seat; the round goes FINAL past final_after, the seven settle
// through the lock port in one transaction, and the payouts hold to the msat: the winner's qualifier line, the seats' fee lines, the
// auditor's 10 % of the nodes' part, the website line of the entry that named one, the developers' and the reserve outputs the locks
// paid. Then the winner collects its payout contract by Refund under its own key, as the page's redeemPayout does.
// (The contradicted AUDIT: protocol22-contradicted.test.js. The fixture: protocol22-fixture.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, LOSER, STAKE } from './window-fixture.js';
import { seatsAndAuditor, winnerUnder, heldAt, owedTable, WEBSITE, key, str } from './protocol22-fixture.js';
import { roundSplit } from '../../arena-protocol/src/reserves.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { splitAcks, splitSignedAck, settlementAckId, countAcks, decodeSettlementTable } from '../../arena-protocol/src/settlement-ack.js';
import { slashHoldsOnTable, splitTableSlashEvidence, cutTableSlashEvidence, TABLE_IS_NOT_F } from '../../arena-protocol/src/slash.js';
import { signSettlementAck, joinAcks, settlementTableId, encodeSettlementTable } from '../../arena-protocol/src/settlement-ack.js';
import { tableBuild } from '../../arena-protocol/src/settlement-rebuild.js';
import { judgeTableProof } from '../src/arbiter.js';
import { createProofJudge } from '../src/proof-judge.js';
import { pointFromScalar } from '../src/curve.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { decodeRoundContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { runOf } from '../../arena-protocol/src/rerun.js';
import { pluginForRound } from '../src/plugins.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('a paid protocol-22 round on seven seats with an auditor: the reserve key known, every entry\'s three locks verified, the AUDIT posted inside the window, FINAL, settled to the msat, the winner collects', { timeout: 170000 }, async () => {
  const { w, auditor, key: auditorKey, close } = await seatsAndAuditor();
  try {
    assert.ok(w.reserveKey, 'the fixture made no reserve key');
    const winner = await winnerUnder(w);
    const won = await lockAndPlay(w, winner, { frontendPk: WEBSITE });
    const lost = await lockAndPlay(w, LOSER);
    // THE ENTRY AS THE PAGE MAKES IT ON PROTOCOL 11: 4 000 fee, 6 000 donation (4 000 developers + 2 000 reserves), net 90 000
    const split = roundSplit(STAKE);
    assert.deepEqual([won.entry.feeMsat, won.entry.donationMsat, netStakeMsat(won.entry)], [split.nodesMsat, split.protocolDevsMsat + split.gameDevsMsat + split.reservesMsat, STAKE - split.nodesMsat - split.protocolDevsMsat - split.gameDevsMsat - split.reservesMsat]);
    // EVERY SEAT SAW BOTH STAKES (the stake lock, the fee lock, the developers' outputs and the reserve output all verified there)
    for (const d of w.nodes) for (const p of [won, lost]) assert.ok(d.round.stakeSeen(p.eid), `seat ${d.port} did not count ${toHex(p.eid).slice(0, 8)}'s stake`);
    // THE RESERVE OUTPUT OF EACH ENTRY, KEPT BY EVERY SEAT AS A ROW UNDER THE RESERVE KEY (GET /reserves reads them)
    const reserveRows = w.nodes.map((d) => d.round.donationsFor(toHex(w.reserveKey)).map((r) => String(r.amountMsat ?? r.amount_msat)));
    const reservesDoor = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reserves`)).json();

    // INSIDE THE WINDOW: the auditor replays both runs from a seat, posts its AUDIT to all seven, each takes it
    let did = null;
    const heldBefore = new Map();
    await closeRound(w, { inside: async () => {
      assert.deepEqual(await w.nodes[0].auditor.pass(), [], 'a seat audits nothing of a round it sits in');
      did = await auditor.auditor.pass();
      for (const d of w.nodes) heldBefore.set(d.port, (await (await fetch(`http://127.0.0.1:${d.port}/audits?round=${toHex(w.rid)}`)).json()).audits.map((a) => [a.node, a.contradicted]));
    } });
    const got = await untilSettled(w, 60000);
    const paid = [...w.port.payouts.values()];
    const owed = owedTable(w, { winner: won, loser: lost, auditors: [auditorKey] });
    const byKey = new Map(paid.map((p) => [toHex(p.payoutPk), p.msat]));
    const seatKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    const facts = {
      state: got.state, why: got.why || null,
      audit: did, heldAtEverySeat: [...heldBefore.values()].every((h) => h.length === 1 && h[0][0] === auditorKey && h[0][1] === null),
      reserveRows, reservesDoor: (reservesDoor.federations || []).map((f) => ({ federation: String(f.federationId).slice(0, 8), key: f.key ? f.key.slice(0, 8) : null, members: f.members ? f.members.length : null, held: f.heldMsat ?? null, entries: f.entries ?? null })),
      loserLock: w.port.locks.has(key(lost.outpoint)) ? 'STILL HELD' : 'claimed', winnerLock: w.port.locks.has(key(won.outpoint)) ? 'held (comes back by its refund)' : 'GONE',
      feeLocks: [won, lost].map((p) => (w.port.locks.has(key(p.feeOutpoint)) ? 'held' : 'claimed')),
      payouts: paid.map((p) => [toHex(p.payoutPk).slice(0, 8), str(p.msat)]),
      winner: str(byKey.get(toHex(refundKeyOf(winner.key)))), owedWinner: str(owed.net),
      website: str(byKey.get(toHex(WEBSITE))), owedWebsite: str(owed.websiteMsat),
      auditor: str(byKey.get(toHex(refundKeyOf(fromHex(auditorKey))))), owedAuditor: str(owed.auditorMsat),
      seats: seatKeys.map((k) => str(byKey.get(k))), owedSeats: seatKeys.map((k) => str(owed.perSeat.get(k))),
      fee: str(owed.fee), gross: str(owed.gross),
      devOutputs: await Promise.all([won, lost].map(async (p) => Promise.all(p.donated.map((d) => heldAt(w.port, d.outpoint, d.recipientPk, d.amountMsat))))),
      reserveOutputs: await Promise.all([won, lost].map((p) => heldAt(w.port, p.reserved.outpoint, w.reserveKey, split.reservesMsat))),
      settlements: w.port.settlements.length,
    };
    console.log('  FACTS (protocol 22 paid, audited):', JSON.stringify(facts, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.deepEqual(did, [{ round: toHex(w.rid), audited: 2, seats: 7 }], 'both runs replayed as signed; the AUDIT taken by every seat');
    assert.equal(facts.heldAtEverySeat, true, 'every seat holds the one AUDIT, uncontradicted');
    assert.equal(facts.loserLock, 'claimed');
    assert.deepEqual(reserveRows, w.nodes.map(() => [String(split.reservesMsat), String(split.reservesMsat)]), 'every seat keeps both entries\' reserve outputs under the reserve key');
    assert.deepEqual(facts.feeLocks, ['claimed', 'claimed']);
    // THE MONEY TABLE, TO THE MSAT
    assert.equal(byKey.get(toHex(refundKeyOf(winner.key))), owed.net, 'the winner\'s qualifier line: the loser\'s net stake');
    assert.equal(byKey.get(toHex(WEBSITE)), owed.websiteMsat, 'the website\'s 10 % of the nodes\' fee on the stake it brought');
    assert.equal(byKey.get(toHex(refundKeyOf(fromHex(auditorKey)))), owed.auditorMsat, 'the auditor\'s 10 % of the nodes\' part after the website');
    assert.deepEqual(seatKeys.map((k) => byKey.get(k)), seatKeys.map((k) => owed.perSeat.get(k)), 'the seats\' shares of the rest');
    // THE WHOLE TRANSACTION: in, the loser's net stake and both fee locks (98 000); out, every line above; the msat the floors leave
    // (the seats' shares scaled to the rest, each floored) stay unspent in the transaction - fewer than one per line, never a payout
    const whole = [...byKey.values()].reduce((t, x) => t + x, 0n);
    const dust = owed.net + owed.fee - whole;
    assert.equal(whole, owed.net + owed.websiteMsat + owed.auditorMsat + [...owed.perSeat.values()].reduce((t, x) => t + x, 0n), 'the lines sum to the table');
    assert.ok(dust >= 0n && dust < BigInt(paid.length), `the floors' dust is ${dust} msat`);
    assert.equal(paid.length, 1 + 1 + 1 + 7, 'one line each: the winner, the website, the auditor, seven seats');
    console.log(`  MONEY TABLE (msat): stake 100000 x2 | fee lock ${split.nodesMsat} x2 | developers ${split.protocolDevsMsat + split.gameDevsMsat} x2 (outputs at the lock) | reserve ${split.reservesMsat} x2 (outputs at the lock) | net ${owed.net} x2`
      + ` || settlement in ${owed.net + owed.fee}: winner ${owed.net}, website ${owed.websiteMsat}, auditor ${owed.auditorMsat}, seats ${[...owed.perSeat.values()].join('+')}, dust ${dust}`);
    // THE DEVELOPERS' AND THE RESERVE OUTPUTS: paid at the lock, still held by the federation for their keys
    for (const p of facts.devOutputs) for (const o of p) assert.ok(o && o.msat, 'a developer output is not held for its key');
    for (const o of facts.reserveOutputs) assert.deepEqual(o, { key: toHex(w.reserveKey), msat: split.reservesMsat });

    // THE ACKS, PUBLISHED WITH THE SETTLEMENT (§5A.3, kanban #1040): a stranger reads them from a seat's door and checks the threshold from the bytes,
    // and the table this round really settled on stands against F of the round's real FINAL signatures, for every seat that acked it
    const door = await (await fetch(`http://127.0.0.1:${w.nodes[1].port}/settlement-acks?round=${toHex(w.rid)}`)).json();
    assert.equal(door.settlements.length, 1, 'one transaction acked');
    const published = door.settlements[0];
    assert.equal(published.txid, got.message, 'the acks name the settled transaction');
    const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
    const ackSeats = w.c.nodes;
    const acks = splitAcks(fromHex(published.acks));
    const counted = countAcks({ acks, seats: ackSeats, slots: w.c.settlementSlots, roundId: w.rid, payoutTableId: fromHex(published.payoutTableId), settlementTxid: fromHex(published.txid), verify });
    assert.equal(counted.final, true, `${counted.agreed} of ${counted.needed} acks stand from the door`);
    const table = decodeSettlementTable(fromHex(published.table));
    assert.equal(table.rows.length, 2, 'one row a played entry');
    const seat = w.nodes[0].round;
    const stored = seat.get(w.rid).contract;
    const contract = decodeRoundContract(new Uint8Array(stored));
    const finals = [won, lost].map((p) => {
      const signedResult = seat.results(w.rid, p.eid)[0].bytes;
      const body = decodePlayerResult(splitSignedResult(signedResult).body);
      return { entry: decodeEntryContract(seat.entry(p.eid)), signedResult, finalSigs: seat.finalSigs(w.rid, p.eid, runOf(body)).map((r) => r.bytes) };
    });
    const plugin = pluginForRound(contract, seat.plugins);
    const asked = (ack, tableBytes) => { const a = splitSignedAck(ack);
      return slashHoldsOnTable({ proof: { roundId: w.rid, playerPubkey: new Uint8Array(32), nodePubkey: a.nodePubkey, transcriptHash: a.ack.payoutTableId, signedResultId: settlementAckId(a.ack), bondTxid: b32(1), bondVout: 0 },
        signedAck: ack, acks, table: tableBytes, finals, contract, manifest: plugin.plugin.manifest, committee: ackSeats, verify, advert: { nodePubkey: a.nodePubkey, bondTxid: b32(1), bondVout: 0 } }); };
    for (const ack of acks) { const honest = asked(ack, fromHex(published.table)); assert.equal(honest.slashed, false, honest.why); assert.match(honest.why, /exactly F/); }
    // THE PAIR REBUILDS (§5A.3, kanban #1043), on the real plan with its fee part, its auditor and its website: the table's claims and payouts, the loser's real P and the fixture's hash give
    // exactly the settled txid, and each honest seat stands under the arbiter's own judgement; every read is made and none of them finds anything false
    const shownEntries = finals.map((f) => f.entry);
    const P = new Map(w.port.settlements[0].claims.filter((c) => c.kind !== 'fee').map((c) => [toHex(lost.eid), c.preimage]));
    const built = tableBuild({ table, entries: new Map([won, lost].map((p, i) => [toHex(p.eid), shownEntries[i]])), preimages: P, pointOf: pointFromScalar });
    assert.equal(built.ok, true, built.why);
    assert.equal((await w.port.settle(built.build)).txid, published.txid, 'the settled transaction rebuilds from its table');
    assert.equal(table.claims.length, 3, 'the loser\'s stake and both fee locks');
    assert.equal(table.payouts.length, paid.length);
    const feesOf = () => w.port.feeRule;
    const asJudged = (ack, list, tableBytes, txid) => { const a = splitSignedAck(ack); return { a, verdict: slashHoldsOnTable({ proof: { roundId: w.rid, playerPubkey: new Uint8Array(32), nodePubkey: a.nodePubkey, transcriptHash: a.ack.payoutTableId, signedResultId: settlementAckId(a.ack), bondTxid: b32(1), bondVout: 0 },
      signedAck: ack, acks: list, table: tableBytes, entries: shownEntries, finals, contract, manifest: plugin.plugin.manifest, committee: ackSeats, verify, rebuiltTxid: txid, feesOf, advert: { nodePubkey: a.nodePubkey, bondTxid: b32(1), bondVout: 0 } }) }; };
    for (const ack of acks) { const { verdict } = asJudged(ack, acks, fromHex(published.table), fromHex(published.txid)); assert.equal(verdict.slashed, false, verdict.why); }

    // FIVE SEATS ACK THE HONEST TABLE OVER ANOTHER TRANSACTION, the honest seat is asked about it, reads it at their door, and files: listed, served, relayed and judged from the bytes
    const five = w.nodes.slice(0, 5), honestSeat = w.nodes[6];
    const off = b32(0xfa);
    const falseAcks = five.map((d) => signSettlementAck({ roundId: w.rid, payoutTableId: fromHex(published.payoutTableId), settlementTxid: off }, d.round.pubkey, (m) => schnorr.sign(m, d.round.identity.secret)));
    const askedOff = await honestSeat.settlements.ack(w.rid, { txid: toHex(off) });
    assert.match(askedOff.why, /it commits to no other bytes/);
    assert.deepEqual(honestSeat.round.settlementSuspects(0).map(toHex), [toHex(w.rid)], 'the ask marked the round');
    const realFetch = honestSeat.settlements.fetcher;
    honestSeat.settlements.fetcher = async (url, o) => (String(url).includes('/settlement-acks') ? { ok: true, json: async () => ({ settlements: [{ scope: '', txid: toHex(off), payoutTableId: published.payoutTableId, table: published.table, acks: toHex(joinAcks(falseAcks)) }] }) } : realFetch(url, o));
    honestSeat.settlements.stakeSecrets = { open: async () => ({ ok: true, preimage: P.get(toHex(lost.eid)) }) };
    const adverts = new Map(five.map((d) => [toHex(d.round.pubkey), { nodePubkey: d.round.pubkey, bondTxid: b32(0x60 + five.indexOf(d)), bondVout: 1 }]));
    const relay = `http://127.0.0.1:${w.nodes[5].port}`;
    const report = await honestSeat.settlements.fileTableProofs(w.rid, { advertOf: (k) => adverts.get(k), relays: [relay] });
    console.log('  FILED:', JSON.stringify({ filed: report.filed.length, published: report.published, refused: report.refused }));
    assert.equal(report.filed.length, 5, `five seats acked it: ${report.refused.join('; ')}`);
    assert.equal(report.published, 5, 'each proof kept by the relay');
    const again = await honestSeat.settlements.fileTableProofs(w.rid, { advertOf: (k) => adverts.get(k) });
    assert.equal(again.filed.length, 0, 'filed once');
    const base = `http://127.0.0.1:${honestSeat.port}`;
    const listed = (await (await fetch(`${base}/slashes`)).json()).tableSlashes;
    assert.deepEqual(listed.map((x) => x.node).sort(), five.map((d) => toHex(d.round.pubkey)).sort());
    const served = cutTableSlashEvidence(new Uint8Array(await (await fetch(`${base}/table-slash-proofs?round=${toHex(w.rid)}`)).arrayBuffer()));
    assert.equal(served.length, 5);
    assert.equal((await fetch(`${base}/table-slash-proofs?round=zz`)).status, 400);
    const relayed = await fetch(`${relay}/slash/${listed[0].proof}`);
    assert.equal(relayed.status, 200, 'the relay keeps it under its id');
    assert.equal((await fetch(`${relay}/slash/${'00'.repeat(32)}`, { method: 'PUT', body: served[0] })).status, 409, 'and only under its own');
    for (const record of served) {
      const got = splitTableSlashEvidence(record);
      const advert = adverts.get(toHex(got.proof.nodePubkey));
      const verdict = await judgeTableProof({ evidence: record, roundIdBytes: w.rid, contract, manifest: plugin.plugin.manifest, committee: ackSeats, advert, bondOutpoint: { txid: advert.bondTxid, vout: advert.bondVout }, feesOf,
        txidOf: async (_t, b) => fromHex((await w.port.settle(b)).txid) });
      assert.equal(verdict.slashed, true, verdict.why);
      assert.equal(verdict.offence, TABLE_IS_NOT_F);
      assert.match(verdict.why, /does not rebuild from the table/);
    }
    // A SEAT'S OWN WORD (kanban #1065), off the complete proof at the relay: this reader's client rebuilds the table
    const filedTable = honestSeat.round.tableSlashProofs(w.rid)[0];
    const complete = new Uint8Array(await (await fetch(`${relay}/slash/${toHex(filedTable.proofId)}`)).arrayBuffer());
    const accusedAdvert = adverts.get(toHex(filedTable.nodePubkey));
    const census = [{ pubkey: filedTable.nodePubkey, txid: accusedAdvert.bondTxid, vout: accusedAdvert.bondVout, advert: accusedAdvert }];
    const client = { fees: async () => null, txid: async (b) => fromHex((await w.port.settle(b)).txid) };
    const seat = (over = {}) => createProofJudge({ committeeOf: () => ({ ok: true, committee: ackSeats }), censusOf: () => ({ ok: true, entries: census }), manifestOf: () => plugin.plugin.manifest, clientOf: async () => client, coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => undefined, ...over });
    const said = await seat()(complete);
    assert.equal(said.verdict, true, said.why);
    assert.equal(seat().read(complete).kind, 'table');
    assert.equal((await seat({ clientOf: async () => null })(complete)).verdict, undefined, 'no client of that federation: this seat cannot say');
    assert.equal((await seat({ manifestOf: () => null })(complete)).verdict, undefined, 'nor one that does not host the game');
    // AN HONEST PAIR, THE SAME FILING: nothing is filed, and a false ack by one seat is not a table anything stood on
    const honestRound = await w.nodes[5].settlements.fileTableProofs(w.rid, { advertOf: (k) => adverts.get(k) });
    assert.equal(honestRound.filed.length, 0, 'the honest pair files nothing');
    const lone = asJudged(falseAcks[0], falseAcks.slice(0, 1), fromHex(published.table), fromHex(published.txid));
    assert.match(lone.verdict.why, /1 of the 5 seats acked/);
    assert.equal(toHex(settlementTableId(table)), published.payoutTableId, 'the table reads back to its own id');
    assert.equal(toHex(encodeSettlementTable(table)), published.table, 'and to its own bytes');
    console.log(`  ACKS: ${counted.agreed} of ${counted.needed} over table ${published.payoutTableId.slice(0, 16)}, settlement ${published.txid.slice(0, 16)}; every ack's table is F of the FINAL results`);

    // THE WINNER COLLECTS: its payout contract, refunded under its own key (page-lock.js redeemPayout: Refund under the player's
    // refund key), as the lock port's guardians check it - the contract expired from the start, the signature the refund key's
    const txid = w.port.settlements[0] && got.message ? got.message : null;
    assert.ok(txid, 'no settlement txid to collect from');
    const idx = paid.findIndex((p) => toHex(p.payoutPk) === toHex(refundKeyOf(winner.key)));
    const refund = { outpoint: { txid: fromHex(txid), outIdx: BigInt(idx) }, amountMsat: owed.net };
    const nonce = b32(0x77);
    const unsigned = await w.port.settle({ claimPk: refundKeyOf(winner.key), claims: [], payouts: [], nonce, refunds: [refund] });
    const collected = await w.port.settle({ claimPk: refundKeyOf(winner.key), claims: [], payouts: [], nonce, refunds: [refund],
      signature: schnorr.sign(fromHex(unsigned.message), winner.secret) });
    console.log(`  COLLECTED: ${collected.accepted} ${collected.error || ''} - ${owed.net} msat by refund under ${toHex(refundKeyOf(winner.key)).slice(0, 12)}`);
    assert.equal(collected.accepted, true, collected.error);
    assert.equal(w.port.locks.has(`${txid}:${idx}`), false, 'the winner\'s payout contract is still held after its refund');
    // AND NOBODY ELSE'S KEY COLLECTS IT: the loser's secret does not move the auditor's line
    const other = paid.findIndex((p) => toHex(p.payoutPk) === toHex(refundKeyOf(fromHex(auditorKey))));
    const stolen = await w.port.settle({ claimPk: refundKeyOf(winner.key), claims: [], payouts: [], nonce, refunds: [{ outpoint: { txid: fromHex(txid), outIdx: BigInt(other) }, amountMsat: owed.auditorMsat }],
      signature: schnorr.sign(fromHex(unsigned.message), winner.secret) });
    assert.equal(stolen.accepted, false);
  } finally { await close(); }
});
