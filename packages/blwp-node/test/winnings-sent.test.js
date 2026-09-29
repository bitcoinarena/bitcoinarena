// WINNINGS ARE ALWAYS SENT ON A FEDERATION ROUND (the owner 2026-09-21: "winnings are always sent. There is no
// Collect"; ruled for FEDERATION 2026-09-23 - refund key the committee's, gateway the lowest live key, invoice taken
// only if its amount and its LUD-06 description hash stand).
//
// The winner names a Lightning address once, signed by the entry's session key, and nothing of the player's runs
// after that. Measured here on two signer nodes and the fake lock port (whose gateways, settle and send stand in for
// the federation's), with a fake LNURL address that issues real-format invoices it knows the preimages of:
//   PASS  the settlement pays the qualifier by ONE outgoing contract to the checked invoice - the lowest-key gateway,
//         the committee's refund key - the gateway is asked once, and each signer node keeps one payment row, PAID
//         with a preimage whose sha256 is the invoice's hash; settling again pays nothing more.
//   FAIL  a round with no qualifier - both runs under min_score, the address named anyway - builds no payout output
//         and asks the address for no invoice; both stake locks are left to expire back.
//   REFUSE an invoice whose amount, or whose description hash, is not what the check requires: no settlement is built.
//   EXPIRY the lowest-key gateway is live when the plan is made and never pays: past its expiration the contract returns
//         to the committee's refund key and is re-sent, through the next live gateway, to a fresh invoice - paid once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockPort, TWO_GATEWAYS } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, standing, lnurl as lnurlFixture, nameAddress as nameAddressAt } from './lock-round-fixture.js';
import { WINNER, LOSER, wait } from './window-fixture.js';
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

test('a qualifier who named an address is paid by one outgoing contract to the checked invoice, through the lowest-key gateway, and each signer node keeps one payment row; settling again pays nothing more', async () => {
  const port = lockPort();
  const addr = lnurl(port);
  const w = await lockRound({ port, serveOpts: { lnurlFetch: addr.fetchLike, winningsEveryMs: 500 } });
  try {
    const won = await lockAndPlay(w, WINNER);
    await lockAndPlay(w, LOSER);
    await nameAddress(w, won);
    await closeRound(w);
    const t0 = Date.now();
    // 90 s, not the 30 of a plain settlement: every signer node must hold its run FINAL before it takes the plan, and a
    // peer that is a moment behind refuses it once and is asked again on the next finality pass.
    const settled = await untilSettled(w, 90000);
    console.log(`  settled after ${Date.now() - t0} ms`);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    const rows = await untilPaid(w, won.eid);
    const s = port.settlements.at(-1);
    const sent = s.payouts.filter((p) => p.sent);
    const gw = lowestLiveGateway(TWO_GATEWAYS);
    console.log('  FACTS:', JSON.stringify({ issued: addr.issued.map((x) => ({ msat: String(x.amountMsat), hash: x.paymentHash.slice(0, 12) })),
      sent: sent.map((p) => ({ msat: String(p.msat), gateway: p.sent.gatewayPk.slice(0, 12), hash: p.sent.paymentHash.slice(0, 12) })),
      gatewayPayments: port.gatewayPayments.length, rows: rows.map((r) => r.winnings && r.winnings.state) }));
    assert.equal(sent.length, 1, 'the qualifier was not paid by one outgoing contract');
    assert.equal(addr.issued.length, 1, 'the address was asked for more than one invoice');
    assert.equal(sent[0].sent.paymentHash, addr.issued[0].paymentHash, 'the contract is not for the invoice the address issued');
    assert.equal(sent[0].sent.gatewayPk, gw.modulePublicKey.toLowerCase(), 'the contract names another gateway than the lowest live key');
    assert.equal(toHex(sent[0].payoutPk), toHex(w.claimPk), 'the contract refunds to someone other than the committee');
    assert.equal(addr.issued[0].amountMsat, sendableInvoiceMsat(sent[0].msat, gw.sendFeeDefault), 'the invoice is not what the gateway\'s fee leaves');
    assert.equal(port.gatewayPayments.length, 1, 'the gateway was not asked exactly once');
    for (const r of rows) {
      assert.equal(r.winnings.state, 'PAID');
      assert.equal(toHex(sha256(fromHex(r.send.preimage))), addr.issued[0].paymentHash, 'a kept preimage is not the invoice\'s');
    }
    // AND AGAIN: a settle run once more - what a restart does - finds it paid and pays nothing.
    const before = { settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length };
    for (const d of [w.a, w.b]) await d.settlements.settle(w.rid);
    assert.deepEqual({ settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length }, before,
      'settling again made a new contract, asked the gateway again, or asked the address again');
  } finally { await w.close(); }
});

test('a round with no qualifier pays no winnings: no payout output, no invoice asked for, and both stake locks left to expire back', async () => {
  const port = lockPort();
  const addr = lnurl(port);
  // THE FLOOR NO RUN REACHES, the field's largest: scores are E x T x C in 1e-5 points and a delivering world here scores
  // up to 395 points (measured), so no smaller floor is sure to leave both runs under it.
  const w = await lockRound({ port, minScore: 0xffffffff, serveOpts: { lnurlFetch: addr.fetchLike, winningsEveryMs: 500 } });
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    await nameAddress(w, won);
    await closeRound(w);
    await untilSettled(w, 15000);
    const sent = port.settlements.flatMap((s) => s.payouts.filter((p) => p.sent));
    const stakeLocksLeft = [won.outpoint, lost.outpoint].filter((o) => port.locks.has(`${toHex(o.txid)}:${o.outIdx}`)).length;
    console.log('  FACTS:', JSON.stringify({ settlements: port.settlements.length, sent: sent.length, issued: addr.issued.length,
      gatewayPayments: port.gatewayPayments.length, stakeLocksLeft }));
    assert.equal(sent.length, 0, 'a round with no qualifier built a winnings contract');
    assert.equal(addr.issued.length, 0, 'a round with no qualifier asked the address for an invoice');
    assert.equal(port.gatewayPayments.length, 0);
    assert.equal(stakeLocksLeft, 2, 'a stake lock of a round with no qualifier was claimed');
    for (const d of [w.a, w.b]) assert.equal((await winningsAt(d, won.eid)).winnings, null);
  } finally { await w.close(); }
});

test('an invoice whose amount or description hash does not stand is refused: no settlement is built on it', async () => {
  for (const lie of [{ lieAmount: true }, { lieHash: true }]) {
    const port = lockPort();
    const addr = lnurl(port, lie);
    const w = await lockRound({ port, serveOpts: { lnurlFetch: addr.fetchLike, winningsEveryMs: 500 } });
    try {
      const won = await lockAndPlay(w, WINNER);
      await lockAndPlay(w, LOSER);
      await nameAddress(w, won);
      await closeRound(w);
      await untilSettled(w, 12000);
      const got = await standing(w.a, w);
      console.log('  FACTS:', JSON.stringify({ lie, asked: addr.issued.length, settlements: port.settlements.length, state: got.state }));
      assert.ok(addr.issued.length >= 1, 'the address was never asked, so nothing was checked');
      assert.equal(port.settlements.length, 0, 'a settlement was built on an invoice that does not stand');
      assert.equal(port.gatewayPayments.length, 0);
    } finally { await w.close(); }
  }
});

test('a gateway that does not pay before expiry: the contract returns to the committee and is re-sent once through the next live gateway, and is paid once', async () => {
  const port = lockPort();
  const addr = lnurl(port);
  const first = lowestLiveGateway(TWO_GATEWAYS);
  port.gatewayDown = first.url;
  const w = await lockRound({ port, serveOpts: { lnurlFetch: addr.fetchLike, winningsEveryMs: 300 } });
  try {
    const won = await lockAndPlay(w, WINNER);
    await lockAndPlay(w, LOSER);
    await nameAddress(w, won);
    await closeRound(w);
    const settled = await untilSettled(w, 90000);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    await wait(2000);
    const unpaid = await Promise.all([w.a, w.b].map((d) => winningsAt(d, won.eid)));
    assert.ok(unpaid.every((r) => !r.winnings), 'a winning was paid through a gateway that does not pay');
    assert.equal(port.gatewayPayments.length, 0);

    // PAST THE CONTRACT'S EXPIRATION: the federation's height moves on, and the sweep re-sends.
    port.height += 1500;
    const rows = await untilPaid(w, won.eid, 60000);
    const resend = port.settlements.find((x) => x.refunds && x.refunds.length);
    console.log('  FACTS:', JSON.stringify({ issued: addr.issued.length, payments: port.gatewayPayments.map((x) => x.gateway),
      resend: resend ? { refunds: resend.refunds.length, payouts: resend.payouts.map((p) => p.sent && p.sent.gatewayPk.slice(0, 12)) } : null,
      rows: rows.map((r) => r.winnings && r.winnings.state), attempt: rows.map((r) => r.send && r.send.attempt) }));
    assert.ok(resend, 'the expired contract was never refunded into a re-send');
    assert.equal(resend.refunds.length, 1);
    assert.equal(toHex(resend.payouts[0].payoutPk), toHex(w.claimPk), 'the re-send refunds to someone other than the committee');
    const next = TWO_GATEWAYS.find((g) => g.url !== first.url);
    assert.equal(resend.payouts[0].sent.gatewayPk, next.modulePublicKey.toLowerCase(), 'the re-send is not through the next live gateway');
    assert.equal(addr.issued.length, 2, 'the re-send did not ask the address for a fresh invoice, or asked more than once');
    assert.deepEqual(port.gatewayPayments.map((x) => x.gateway), [next.url], 'the winning was not paid exactly once, through the next gateway');
    for (const r of rows) {
      assert.equal(r.winnings.state, 'PAID');
      assert.equal(r.send.attempt, 1);
      assert.equal(toHex(sha256(fromHex(r.send.preimage))), addr.issued[1].paymentHash);
    }
    const before = { settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length };
    await wait(1500);
    for (const d of [w.a, w.b]) await d.settlements.settle(w.rid);
    assert.deepEqual({ settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length }, before,
      'a paid re-send was sent again');
  } finally { await w.close(); }
});
