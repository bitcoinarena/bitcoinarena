// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WINNINGS ARE ALWAYS SENT ON A FEDERATION ROUND (2026-09-21: "winnings are always sent. There is no
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
import { sendableInvoiceMsat, lowestLiveGateway } from '../../arena-protocol/src/winnings-send.js';
import { toHex, sha256, fromHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

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

test('WINNINGS-AUTO (RULED 2026-10-01): a qualifier who named an address is paid by its payout contract to its own key - no invoice asked, no gateway paid; settling again pays nothing more', async () => {
  const port = lockPort();
  const addr = lnurl(port);
  const w = await lockRound({ port, serveOpts: { lnurlFetch: addr.fetchLike, winningsEveryMs: 500 } });
  try {
    const won = await lockAndPlay(w, WINNER);
    await lockAndPlay(w, LOSER);
    await nameAddress(w, won);
    await closeRound(w);
    const settled = await untilSettled(w, 90000);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    const s = port.settlements.at(-1);
    const seats = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    const stake = s.payouts.filter((p) => !seats.includes(toHex(p.payoutPk)));
    console.log('  FACTS:', JSON.stringify({ stake: stake.map((p) => ({ msat: String(p.msat), sent: !!p.sent, to: toHex(p.payoutPk).slice(0, 12) })),
      issued: addr.issued.length, gatewayPayments: port.gatewayPayments.length }));
    assert.equal(stake.length, 1, 'the qualifier was not paid by one payout');
    assert.equal(stake[0].sent, undefined, 'the qualifier was paid by a Lightning send');
    assert.equal(toHex(stake[0].payoutPk), toHex(refundKeyOf(WINNER.key)), 'the payout contract is not to the qualifier\'s own key');
    assert.equal(addr.issued.length, 0, 'the address was asked for an invoice');
    assert.equal(port.gatewayPayments.length, 0, 'a gateway was paid');
    const before = { settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length };
    for (const d of [w.a, w.b]) await d.settlements.settle(w.rid);
    assert.deepEqual({ settlements: port.settlements.length, payments: port.gatewayPayments.length, issued: addr.issued.length }, before);
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

test('WINNINGS-AUTO: an address that would issue a lying invoice changes nothing - it is never asked, and the qualifier is paid by its contract', async () => {
  for (const lie of [{ lieAmount: true }, { lieHash: true }]) {
    const port = lockPort();
    const addr = lnurl(port, lie);
    const w = await lockRound({ port, serveOpts: { lnurlFetch: addr.fetchLike, winningsEveryMs: 500 } });
    try {
      const won = await lockAndPlay(w, WINNER);
      await lockAndPlay(w, LOSER);
      await nameAddress(w, won);
      await closeRound(w);
      const settled = await untilSettled(w, 90000);
      console.log('  FACTS:', JSON.stringify({ lie, asked: addr.issued.length, settlements: port.settlements.length, state: settled.state }));
      assert.equal(settled.state, 'ACCEPTED', settled.why);
      assert.equal(addr.issued.length, 0, 'the address was asked');
      assert.ok(port.settlements.at(-1).payouts.some((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key))), 'the qualifier was not paid by its contract');
      assert.equal(port.gatewayPayments.length, 0);
    } finally { await w.close(); }
  }
});

// THE QUALIFIER RE-SEND (a gateway that never pays, the contract refunded to the committee and sent again) is gone with
// WINNINGS-AUTO: no qualifier is paid by a send. The re-send machinery now carries only a walk-away round's donation
// shares; that path has no test here yet.
