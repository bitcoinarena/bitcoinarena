// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3549 (feedback #395): an Up/Down order that matched nobody (Buy Up 100 sat at 50c, round 535ca718, "no seat answered the book")
// came back whole - the wallet read "Refund - 100 of 100 sat back" - while Past orders said "Down won · -99 sats · final". The seats'
// settlement table held a row for it beside another unmatched order on the other side, so the pari-mutuel table read it "lost 99"; the book,
// which is what pays an order (#2902), was not read. An order's line is the book's: a book that held it unmatched is a refund (P&L 0), and a
// book not read yet says the order's pay is unverified - never won or lost off the pari-mutuel table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign as edSign } from 'node:crypto';
import { marketForRound, checkAttestation, marketLines } from '../src/market.js';
import { MARKET } from '../../arena-node/test/plugins/market/index.js';
import { encodeAttestation, attestationBodyId, pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ME = 'aa'.repeat(32), OTHER = 'bb'.repeat(32);

async function setup() {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const ROUND_ID = b32(0x35);
  const market = marketForRound({ gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), networkId: NETWORK_ID_REGTEST, stakeMsat: 100_000n });
  const rid = toHex(ROUND_ID);
  const [A0, , A2] = MARKET.attestors;
  const body = { roundId: ROUND_ID, outcome: 1, observedAtMs: 1n };   // Down
  const signed = { ...body, signatures: [A0, A2].map((k) => ({ key: k.pubkey, signature: new Uint8Array(edSign(null, Buffer.from(attestationBodyId(body)), k.key)) })) };
  const check = await checkAttestation({ attestationHex: toHex(encodeAttestation(signed)), market, roundIdHex: rid });
  assert.equal(check.verified, true);
  // the report's order (Up, 100 sat: 99 stake + 1 fee) and another order on Down that it never crossed - both rows in the table
  const entries = [{ entryId: ME, stakeMsat: 99000n, feeMsat: 1000n, donationMsat: 0n, pick: 0 }, { entryId: OTHER, stakeMsat: 99000n, feeMsat: 1000n, donationMsat: 0n, pick: 1 }];
  const table = JSON.parse(JSON.stringify(pariMutuelTable({ entries, outcome: 1 }), (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  const outcomes = new Map([[rid, { state: 'ATTESTED', outcome: 1, label: 'Down', final: true, table, check }]]);
  const pick = { roundIdHex: rid, entryIdHex: ME, market, pick: 0, stakeMsat: 100000n, entryCloseMs: 0, order: { index: 0, limitPrice: 50000 } };
  return { pick, outcomes };
}

test('#3549 an unmatched order with a row in the table and the book not read is not "lost"', async () => {
  const { pick, outcomes } = await setup();
  for (const stakeBack of [undefined, true]) {
    const [l] = marketLines({ picks: [{ ...pick, ...(stakeBack === undefined ? {} : { stakeBack }) }], outcomes });
    assert.notEqual(l.state, 'lost', `stakeBack ${stakeBack}: ${l.text}`);
    assert.notEqual(l.state, 'won');
    assert.equal(l.state, 'unverified');
    assert.match(l.text, /what this order is paid is the book's, and its book is not read yet/);
  }
});

test('#3549 an order the book held unmatched (two seats\' empty positions) is refunded whole, P&L 0', async () => {
  const { pick, outcomes } = await setup();
  const claim = { outMsat: '100000', gainMsat: '0', unfilled: true };   // what market-page.js keeps for two seats' empty positions
  const [l] = marketLines({ picks: [{ ...pick, unfilled: true, bookClaim: claim }], outcomes });
  assert.deepEqual([l.state, l.backMsat, l.final], ['refunded', '100000', true]);
  assert.match(l.text, /your order matched nobody: its 100 sats come back whole$/);
  const [transit] = marketLines({ picks: [{ ...pick, unfilled: true, bookClaim: claim, stakeBack: false }], outcomes });
  assert.deepEqual([transit.state, transit.final], ['refund in transit', false]);
  // a book claim that pays is still the book's (#2902)
  const [paid] = marketLines({ picks: [{ ...pick, bookClaim: { outMsat: '0', gainMsat: '-100000' } }], outcomes });
  assert.deepEqual([paid.state, paid.payoutMsat, paid.netMsat], ['settled', '0', '100000']);
});
