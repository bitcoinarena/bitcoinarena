// THE POOL, ON THE SIGNER NODES (RULED 2026-09-23: (ii), with (iii); never (i)). A qualifier who names no Lightning
// address is not paid: its share is split over the qualifiers who named one, by the payout table's own weights
// renormalised over them; with nobody addressed no stake lock is claimed. Split out of winnings-sent.test.js so each
// file runs inside the 180 s cap.
//   A  five qualifiers (two paying ranks), the top one unaddressed: the addressed second rank is sent the whole pot.
//   B  the only qualifier unaddressed: no stake lock claimed, no invoice asked; the fee locks still settle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { lockPort, TWO_GATEWAYS } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, standing, lnurl as lnurlFixture, nameAddress as nameAddressAt } from './lock-round-fixture.js';
import { WINNER, LOSER, wait, b32, qualifiersUnder } from './window-fixture.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { sendableInvoiceMsat, lowestLiveGateway } from '../../protocol/src/winnings-send.js';
import { toHex, sha256, fromHex } from '../../protocol/src/hash.js';

const nameAddress = (w, played) => nameAddressAt([w.a, w.b], played);
const lnurl = (port, lie) => lnurlFixture(port, lie);

const winningsAt = async (d, eid) => (await fetch(`http://127.0.0.1:${d.port}/winnings?entry=${toHex(eid)}`)).json();
async function untilPaid(w, eid, ms = 30000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await Promise.all([w.a, w.b].map((d) => winningsAt(d, eid)));
    if (got.every((g) => g.winnings && g.winnings.state === 'PAID')) return got;
  }
  return got;
}

// THE POOL, ON THE SIGNER NODES (ruled 2026-09-23). Five qualifiers make two paying ranks (K = ceil(5/4)); the
// players are real keys whose runs the core delivers with distinct scores - found under each round's own beacon
// (window-fixture qualifiersUnder), since a paying round seeds its players from it, highest score first.

test('POOL A on the signer nodes: the top qualifier names no address and the others do - its share is sent to the addressed paying rank, once, the pot is the payouts and their fees, and the unaddressed one is paid nothing', async () => {
  const port = lockPort();
  const addr = lnurl(port);
  const w = await lockRound({ port, serveOpts: { lnurlFetch: addr.fetchLike } });
  try {
    const Q5 = await qualifiersUnder(w.randomness, 5);
    const played = [];
    for (const who of Q5) played.push({ who, ...(await lockAndPlay(w, who)) });
    const lost = await lockAndPlay(w, LOSER);
    const [top, ...rest] = played;
    for (const q of rest) await nameAddress(w, q);
    await closeRound(w);
    const settled = await untilSettled(w);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    for (const q of rest.slice(0, 1)) await untilPaid(w, q.eid);
    const s = port.settlements.at(-1);
    const seats = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    const stake = s.payouts.filter((p) => !seats.includes(toHex(p.payoutPk)));
    const lockHeld = (o) => port.locks.has(`${toHex(o.txid)}:${o.outIdx}`);
    const net = netStakeMsat(lost.entry);
    const fee = (m) => port.feeRule.baseMsat + (m * port.feeRule.ppm) / 1000000n;
    const rows = await Promise.all(played.map(async (q) => Promise.all([w.a, w.b].map((d) => winningsAt(d, q.eid)))));
    console.log('  FACTS:', JSON.stringify({ stakePayouts: stake.map((p) => ({ msat: String(p.msat), fee: String(fee(p.msat)), sent: !!p.sent })), loserNet: String(net),
      inputFee: String(fee(net)), issued: addr.issued.map((x) => String(x.amountMsat)), gatewayPayments: port.gatewayPayments.length,
      rows: rows.map((r, i) => `${Q5[i].score}:${r.map((x) => (x.winnings ? x.winnings.state : '-')).join('/')}`), topLockHeld: lockHeld(top.outpoint) }));
    // THE TABLE PAYS TWO RANKS; the top one named nothing, so the second is paid the whole spendable pot, by one contract.
    assert.equal(stake.length, 1, 'not exactly one qualifier payout');
    assert.ok(stake[0].sent, 'the addressed qualifier was not sent its winning');
    assert.equal(stake[0].sent.paymentHash, addr.issued[0].paymentHash, 'the contract is not the addressed qualifier\'s invoice');
    assert.equal(stake.some((p) => toHex(p.payoutPk) === toHex(refundKeyOf(top.who.key))), false, 'the unaddressed qualifier was paid');
    assert.equal(stake[0].msat + fee(stake[0].msat) + fee(net), net, 'the payout and the fees are not the whole claimed pot');
    assert.equal(addr.issued.length, 1, 'more than the one paying addressed qualifier was asked for an invoice');
    assert.equal(port.gatewayPayments.length, 1, 'the gateway was not asked exactly once');
    assert.deepEqual(rows[1].map((x) => x.winnings && x.winnings.state), ['PAID', 'PAID'], 'the second rank is not PAID on both signer nodes');
    for (const i of [0, 2, 3, 4]) for (const x of rows[i]) assert.equal(x.winnings, null, `a winning was kept for the qualifier scoring ${Q5[i].score}`);
    assert.equal(lockHeld(top.outpoint), true, 'the unaddressed qualifier\'s own stake lock was spent - it comes back by its forfeit');
    // AND SETTLING AGAIN - what a restart does - pays nothing more.
    const before = { settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length };
    for (const d of [w.a, w.b]) await d.settlements.settle(w.rid);
    assert.deepEqual({ settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length }, before);
  } finally { await w.close(); }
});

test('POOL B on the signer nodes: the only qualifier names no address - no stake lock is claimed, no invoice asked, nothing sent; the fee locks still settle', async () => {
  const port = lockPort();
  const addr = lnurl(port);
  const w = await lockRound({ port, serveOpts: { lnurlFetch: addr.fetchLike } });
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    await closeRound(w);
    const settled = await untilSettled(w);
    const lockHeld = (o) => port.locks.has(`${toHex(o.txid)}:${o.outIdx}`);
    const claimed = port.settlements.flatMap((x) => x.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`));
    const seats = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    const stakePaid = port.settlements.flatMap((x) => x.payouts).filter((p) => !seats.includes(toHex(p.payoutPk)));
    console.log('  FACTS:', JSON.stringify({ state: settled.state, why: settled.why, claimed: claimed.length, stakePaid: stakePaid.length,
      issued: addr.issued.length, gatewayPayments: port.gatewayPayments.length, loserLockHeld: lockHeld(lost.outpoint), winnerLockHeld: lockHeld(won.outpoint),
      feeLocksHeld: [won, lost].filter((x) => lockHeld(x.feeOutpoint)).length }));
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    assert.equal(lockHeld(lost.outpoint), true, 'the loser\'s stake lock was claimed with nobody to send it to');
    assert.equal(lockHeld(won.outpoint), true);
    assert.equal(stakePaid.length, 0, 'a stake payout was built with nobody addressed');
    assert.equal(addr.issued.length, 0);
    assert.equal(port.gatewayPayments.length, 0);
    assert.equal([won, lost].filter((x) => lockHeld(x.feeOutpoint)).length, 0, 'the seats were not paid their fee');
  } finally { await w.close(); }
});

// THE FIRST ADDRESS STANDS (ruled 2026-09-23): the page posts the same signed bytes again to a node that did not answer,
// and that is 201 and changes nothing; another address for the same entry is 409, so no second one splits the nodes.
test('the first address stands at every signer node: the same bytes again are 201 and change nothing, another address is 409', async () => {
  const port = lockPort();
  const w = await lockRound({ port });
  try {
    const won = await lockAndPlay(w, WINNER);
    const post = async (d, address) => {
      const bytes = new TextEncoder().encode(address);
      const r = await fetch(`http://127.0.0.1:${d.port}/payout-address?entry=${toHex(won.eid)}`,
        { method: 'POST', body: Buffer.concat([Buffer.from(bytes), Buffer.from(ed25519.sign(bytes, won.session))]) });
      return { status: r.status, text: (await r.text()).trim() };
    };
    const got = [];
    for (const d of [w.a, w.b]) {
      const first = await post(d, 'winner@pay.example');
      const namedMs = d.round.payoutAddress(won.eid).namedMs;
      await wait(20);
      const same = await post(d, 'winner@pay.example');
      const other = await post(d, 'thief@pay.example');
      got.push({ first: first.status, same: same.status, other: other.status, why: other.text, held: d.round.payoutAddress(won.eid).address,
        unchanged: d.round.payoutAddress(won.eid).namedMs === namedMs });
    }
    console.log('  FACTS (first stands):', JSON.stringify(got));
    for (const g of got) {
      assert.deepEqual([g.first, g.same, g.other], [201, 201, 409]);
      assert.equal(g.held, 'winner@pay.example', 'a second address replaced the first');
      assert.equal(g.unchanged, true, 'the same bytes again changed the row');
      assert.match(g.why, /first one stands/);
    }
  } finally { await w.close(); }
});
