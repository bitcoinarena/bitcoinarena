// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2902 (feedback #140): an order book round's Past orders result is the book's pay, not the pari-mutuel table's. The two
// positions are the live round 669a7991 (2026-11-16, seat 1 GET /book), both of which sold: the seat's /standing paid 107.221 and
// 106.920 sats against locks of 107.072 and 111.113, where the pari-mutuel table read "+110" and "-110"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign as edSign } from 'node:crypto';
import { marketForRound, checkAttestation, marketLines, bookClaimOf } from '../src/market.js';
import { MARKET } from '../../arena-node/test/plugins/market/index.js';
import { encodeAttestation, attestationBodyId, pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const BOOK = { ok: true, positions: [
  { entry: B, outcome: 1, shares: ['200000', '229632'], cost: '110002', buyFee: '1111', sellDebt: '92000', sellFee: '1080', cancelled: false },
  { entry: A, outcome: 0, shares: ['200003', '170371'], cost: '106002', buyFee: '1070', sellDebt: '92001', sellFee: '783', cancelled: false }] };

test('bookClaimOf: the order\'s pay is the book\'s, from two seats\' identical books', () => {
  assert.deepEqual(bookClaimOf({ books: [BOOK, BOOK], outcome: 0, entryIdHex: A, stakeMsat: '107072' }), { outMsat: '107221', gainMsat: '149' });
  assert.deepEqual(bookClaimOf({ books: [BOOK, BOOK], outcome: 0, entryIdHex: B, stakeMsat: '111113' }), { outMsat: '106920', gainMsat: '-4193' });
  // one seat's word is not enough, and two books that differ name nothing
  assert.equal(bookClaimOf({ books: [BOOK], outcome: 0, entryIdHex: A, stakeMsat: '107072' }), null);
  const other = { positions: BOOK.positions.map((p) => ({ ...p, sellDebt: '0' })) };
  assert.equal(bookClaimOf({ books: [BOOK, other], outcome: 0, entryIdHex: A, stakeMsat: '107072' }), null);
  assert.equal(bookClaimOf({ books: [BOOK, BOOK], outcome: null, entryIdHex: A, stakeMsat: '107072' }), null);
});

test('marketLines: a book order\'s line is what the book pays, not the pari-mutuel gain', async () => {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const ROUND_ID = b32(0x29);
  const market = marketForRound({ gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), networkId: NETWORK_ID_REGTEST, stakeMsat: 1_000_000n });
  const rid = toHex(ROUND_ID);
  const [A0, , A2] = MARKET.attestors;
  const body = { roundId: ROUND_ID, outcome: 0, observedAtMs: 1n };
  const signed = { ...body, signatures: [A0, A2].map((k) => ({ key: k.pubkey, signature: new Uint8Array(edSign(null, Buffer.from(attestationBodyId(body)), k.key)) })) };
  const check = await checkAttestation({ attestationHex: toHex(encodeAttestation(signed)), market, roundIdHex: rid });
  assert.equal(check.verified, true);
  const entries = [{ entryId: A, stakeMsat: 107072n, feeMsat: 1070n, donationMsat: 0n, pick: 0 }, { entryId: B, stakeMsat: 111113n, feeMsat: 1111n, donationMsat: 0n, pick: 1 }];
  const table = JSON.parse(JSON.stringify(pariMutuelTable({ entries, outcome: 0 }), (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  const outcomes = new Map([[rid, { state: 'ATTESTED', outcome: 0, label: 'Up', final: true, table, check }]]);
  const pick = (entry, side, stake) => ({ roundIdHex: rid, entryIdHex: entry, market, pick: side, stakeMsat: stake, entryCloseMs: 0, order: { limitPrice: 50000 } });
  // before (the page has not read the book): the pari-mutuel table's "won" - the measured wrong line
  const [before] = marketLines({ picks: [pick(A, 0, 107072n)], outcomes });
  assert.equal(before.state, 'won');
  const lines = marketLines({ picks: [
    { ...pick(A, 0, 107072n), bookClaim: bookClaimOf({ books: [BOOK, BOOK], outcome: 0, entryIdHex: A, stakeMsat: '107072' }) },
    { ...pick(B, 1, 111113n), bookClaim: bookClaimOf({ books: [BOOK, BOOK], outcome: 0, entryIdHex: B, stakeMsat: '111113' }) }], outcomes });
  for (const l of lines) console.log('  #2902 LINE:', l.state, l.text);
  assert.deepEqual(lines.map((l) => [l.state, l.payoutMsat, l.netMsat]), [['settled', '107221', '107072'], ['settled', '106920', '111113']]);
});
