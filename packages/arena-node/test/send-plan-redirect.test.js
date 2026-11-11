// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NOBODY REDIRECTS A DONATION SEND TO THEIR OWN INVOICE (kanban #1154, critical; the state machine audit of 2026-11-06).
//
// The scenario, as an outsider with no seat key plays it against two real signer nodes and the fake lock port:
//   the walk-away's settlement plans one Lightning send per donation recipient; the moment the asker hands its plan out, the outsider
//   reads it at GET /settle-sends (public), mints for each send an invoice of its OWN node - the address's description hash
//   (sha256 of its public metadata) and the plan's amount - grinds the payment hash until its plan sorts below the kept one, and posts
//   that plan to every seat. Before the fix the seats kept it (first writer, or "a lower planKey replaces"), the asker adopted it, the
//   settlement built the send contracts to the outsider's hashes and the gateway paid the outsider.
// Now every door asks for a seat's signature, and every checker fetches an invoice of its own from the address and requires the plan's
// invoice to be signed by the same node: the outsider's plan is refused at every seat, and the recipients are paid.
// And the re-send door: an unsigned attempt N+1, or one signed by a key that is no seat of the round, is refused before it is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf, METADATA } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { testInvoice } from './bolt11-fixture.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { sha256, toHex } from '../../arena-protocol/src/hash.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { HOSTED } from './plugins/hosted.js';

const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };
// the seat signature, where this tree has it (a tree from before #1154 has no such module, and takes the plan unsigned anyway)
const ask = await import('../src/send-plan-ask.js').catch(() => null);
const OUTSIDER_NODE = new Uint8Array(32).fill(0x0b);   // the outsider's own Lightning node key
// a door's answer, printable: a 201 is the seat's signed acceptance (bytes), a refusal its text
const said = async (r) => (r.status === 201 ? `201 kept it (signed acceptance, ${(await r.arrayBuffer()).byteLength} bytes)` : `${r.status} ${(await r.text()).trim().slice(0, 220)}`);
const planKey = (rows) => rows.map((r) => String(r.paymentHash).toLowerCase()).sort().join(':');

/** The outsider's plan: the honest plan's rows, each with an invoice of the outsider's node, its hash ground below the honest plan's. */
function outsiderPlan(honest, port) {
  const below = planKey(honest).slice(0, 64);
  return honest.map((r) => {
    if (!r.invoice) return r;
    let preimage, hash;
    for (let i = 0; i < 1e6; i++) { preimage = new Uint8Array(randomBytes(32)); hash = toHex(sha256(preimage)); if (hash < below) break; }
    // the outsider's node knows its preimage: the fake gateway "pays" whoever holds it
    port.preimages.set(hash, preimage);
    const invoice = testInvoice({ amountMsat: BigInt(r.invoiceMsat), paymentHash: sha256(preimage), descriptionHash: sha256(new TextEncoder().encode(METADATA)),
      secret: OUTSIDER_NODE });
    return { ...r, invoice, paymentHash: hash };
  });
}

test('an outsider\'s plan with its own invoices - right amount, right description hash, a lower planKey - posted to every seat pays the outsider nothing; the recipients are paid', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 300, donationSets: [TEST_DONATION_SET_REGTEST] } });
  const asker = proposerOf(w);
  const real = asker.settlements.fetcher;
  const facts = { posted: [], bySeat: [], ownHashes: [], honestKey: null, ownKey: null };
  let attacked = false;
  // THE OUTSIDER STRIKES THE MOMENT THE ASKER HANDS ITS PLAN OUT: everything it uses is public
  asker.settlements.fetcher = async (u, o) => {
    if (!attacked && o && o.method === 'POST' && String(u).includes('/settle-sends?')) {
      attacked = true;
      facts.done = false;
      const honest = await (await fetch(`http://127.0.0.1:${asker.port}/settle-sends?round=${toHex(w.rid)}`)).json();
      const own = outsiderPlan(honest, port);
      facts.honestKey = planKey(honest).slice(0, 16);
      facts.ownKey = planKey(own).slice(0, 16);
      facts.ownHashes = own.filter((r) => r.invoice).map((r) => r.paymentHash);
      for (const d of w.nodes) {
        try {
          const r = await fetch(`http://127.0.0.1:${d.port}/settle-sends?round=${toHex(w.rid)}`, { method: 'POST', body: JSON.stringify(own) });
          facts.posted.push(`${d === asker ? 'asker' : 'peer'} ${await said(r)}`);
        } catch (e) { facts.posted.push(`${d === asker ? 'asker' : 'peer'} threw ${e.message}`); }
      }
      // AND THE SAME PLAN SIGNED BY A SEAT OF THE ROUND (a seat turned bad, or its key taken): the door lets it in, and the checker's own
      // invoice from the address names another payee than the plan's
      if (ask) for (const d of w.nodes) {
        const signer = w.nodes.find((x) => x !== d);
        const body = JSON.stringify(own);
        const headers = { [ask.SEND_PLAN_ASK_HEADER]: ask.signSendPlanAsk({ kind: ask.PLAN_ASK.PROPOSE, roundId: w.rid, body,
          secret: signer.round.identity.secret, pubkey: signer.round.pubkey }) };
        try {
          const r = await fetch(`http://127.0.0.1:${d.port}/settle-sends?round=${toHex(w.rid)}`, { method: 'POST', body, headers });
          facts.bySeat.push(`${d === asker ? 'asker' : 'peer'} ${await said(r)}`);
        } catch (e) { facts.bySeat.push(`${d === asker ? 'asker' : 'peer'} threw ${e.message}`); }
      }
    }
    return real(u, o);
  };
  const hookDone = () => facts.posted.length === w.nodes.length && (!ask || facts.bySeat.length === w.nodes.length);
  try {
    await lockAndPlay(w, WALKER, { noMarks: true });
    await closeRound(w);
    const st = await untilSettled(w, 60000);
    let sends = [];
    for (const stop = Date.now() + 30000; Date.now() < stop; await wait(250)) {
      sends = asker.round.sendPlansOf(w.rid).filter((r) => r.donation);
      if (sends.length && sends.every((r) => r.state === 'PAID')) break;
    }
    for (const stop = Date.now() + 10000; Date.now() < stop && attacked && !hookDone(); await wait(100));
    const paidHashes = port.gatewayPayments.map((x) => String(x.paymentHash));
    const toOutsider = paidHashes.filter((h) => facts.ownHashes.includes(h)).length;
    console.log(`  FACTS #1154: attacked ${attacked}; outsider plan key ${facts.ownKey} below honest ${facts.honestKey}; posted to ${facts.posted.length} of ${w.nodes.length} seats: ${facts.posted.join(' | ')}`);
    if (ask) console.log(`  FACTS #1154: signed by a seat: ${facts.bySeat.join(' | ')}`);
    console.log(`  FACTS #1154: settlement ${st.state}; gateway payments ${paidHashes.length}, to the outsider ${toOutsider}; sends ${JSON.stringify(sends.map((r) => [r.paymentHash.slice(0, 8), r.state]))}`);
    assert.ok(attacked, 'the asker never handed a plan out');
    assert.ok(facts.ownKey < facts.honestKey, 'the outsider\'s plan does not sort below the honest one');
    assert.equal(toOutsider, 0, `the gateway paid the outsider ${toOutsider} time(s)`);
    assert.equal(facts.posted.length, w.nodes.length, 'the outsider did not reach every seat');
    assert.ok(facts.posted.every((x) => / 403 /.test(` ${x} `)), `a seat took the outsider's plan: ${facts.posted.join(' | ')}`);
    assert.ok(facts.bySeat.length === w.nodes.length && facts.bySeat.every((x) => / 409 .*pays node/.test(` ${x}`)),
      `a seat took the outsider's invoices on a seat's signature: ${facts.bySeat.join(' | ')}`);
    assert.equal(st.state, 'ACCEPTED', st.why);
    assert.ok(sends.length && sends.every((r) => r.state === 'PAID' && !facts.ownHashes.includes(r.paymentHash)), JSON.stringify(sends.map((r) => [r.paymentHash, r.state])));
    assert.equal(port.gatewayPayments.length, TEST_DONATION_SET_REGTEST.recipients.length, 'each recipient was not paid once');

    // THE RE-SEND DOOR: unsigned, or signed by no seat of the round - refused before anything is checked or kept
    const row = asker.round.sendPlansOf(w.rid).find((r) => r.invoice);
    const body = JSON.stringify({ entry: toHex(row.entryId), attempt: row.attempt + 1, address: row.address, invoice: row.invoice, paymentHash: row.paymentHash,
      invoiceMsat: String(row.invoiceMsat), payoutMsat: String(row.payoutMsat), owedMsat: String(row.owedMsat), gatewayUrl: row.gatewayUrl, gatewayPk: row.gatewayPk,
      expiration: String(row.expiration) });
    const stranger = new Uint8Array(32).fill(0x0c);
    const forged = toHex(schnorr.getPublicKey(stranger)) + toHex(schnorr.sign(sha256(new TextEncoder().encode(body)), stranger));
    const peer = w.nodes.find((d) => d !== asker);
    const unsigned = await fetch(`http://127.0.0.1:${peer.port}/resend-sends?round=${toHex(w.rid)}`, { method: 'POST', body });
    const notSeat = await fetch(`http://127.0.0.1:${peer.port}/resend-sends?round=${toHex(w.rid)}`, { method: 'POST', body, headers: { 'x-send-plan-ask': forged } });
    const answers = [`${unsigned.status} ${(await unsigned.text()).trim()}`, `${notSeat.status} ${(await notSeat.text()).trim()}`];
    console.log(`  FACTS #1154: re-send door: unsigned ${answers[0].slice(0, 120)} | stranger ${answers[1].slice(0, 120)}`);
    assert.match(answers[0], /^403 .*only from a seat of the round/);
    assert.match(answers[1], /^403 .*not one of the round's seats/);
    assert.equal(peer.round.sendAttemptsOf(w.rid).filter((r) => r.attempt > 0).length, 0, 'a re-send was kept from no seat');
  } finally { asker.settlements.fetcher = real; await w.close(); }
});

// THE STATE OF A SEND MOVES ONLY AS ONE TRANSITION FUNCTION ALLOWS (send-state.js), applied by the store as a compare-and-set
test('a send row moves only as sendMove allows: PAID and REFUNDED are final, nothing jumps a step, one row per (entry, attempt)', async () => {
  const states = await import('../src/send-state.js').catch(() => null);
  assert.ok(states, 'this tree has no single send state machine');
  const { SEND, sendMove } = states;
  const r = new Round(openStore(':memory:'), () => 1000, { plugins: HOSTED });
  const row = { entryId: b32(0x31), roundId: b32(0x32), attempt: 0, address: 'lnurl1x', invoice: 'lnbcrt1', paymentHash: 'aa'.repeat(32), invoiceMsat: 1n,
    payoutMsat: 2n, owedMsat: 2n, gatewayUrl: 'http://gw', gatewayPk: '02'.padEnd(66, '1'), expiration: 9n, donation: true, why: 't' };
  assert.equal(r.putSendPlan(row), true);
  assert.equal(r.putSendPlan({ ...row, paymentHash: 'bb'.repeat(32) }), false, 'a second plan for one (entry, attempt) was kept over the first');
  assert.equal(r.sendAttemptsOf(row.roundId)[0].paymentHash, 'aa'.repeat(32));
  const move = (state) => r.markSend({ entryId: row.entryId, attempt: 0, state, why: state });
  const stateNow = () => r.sendAttemptsOf(row.roundId)[0].state;
  const walk = [[SEND.REFUNDED, false], [SEND.SENDING, true], [SEND.HELD, false], [SEND.PAID, true], [SEND.SENDING, false], [SEND.PLANNED, false], ['MADE-UP', false]];
  const seen = walk.map(([to, want]) => { const got = move(to); assert.equal(got, want, `${to}`); return `${to}:${got ? 'moved' : 'refused'}->${stateNow()}`; });
  console.log(`  FACTS #1154: ${seen.join(' ')}`);
  assert.equal(stateNow(), SEND.PAID);
  assert.deepEqual([sendMove(SEND.PLANNED, SEND.FUNDING).ok, sendMove(SEND.FUNDING, SEND.SENDING).ok, sendMove(SEND.REFUNDED, SEND.PAID).ok, sendMove(SEND.HELD, SEND.SENDING).ok],
    [true, true, false, false]);
});
