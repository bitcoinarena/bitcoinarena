// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEV CLIENT'S PERMANENT RECORD AND ITS READ RECEIPT (measure 4; 2026-10-05 08:15-08:17; the rate
// source ruled the same day: a public price API the dev client calls itself, the provider named in each record, no seat asks).
// Each donation the seats list is recorded for good - sender key, round id, amount, time, the USD and EUR rate at that time
// and the provider - BEFORE any seat is told it was read, and only a donation that is recorded and redeemed (or already
// spent) is ever named in a read receipt. A crash between the two can lose nothing the seats already deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as ecdsaVerify } from 'node:crypto';
import { newKey, redeemAll, donationFields, rateAt, RATE_PROVIDER, donationRecord, readRecord, recordDonations, signDonationsRead, settleRead } from '../src/donor.js';
import { donationsReadMessage, SECP256K1_SPKI_PREFIX } from '../../arena-protocol/src/donations-read.js';

const PLAYER = 'e1d969e9b0788cd4bdd39cf6b3f994e88efa52b001538d83881fddf0bbf67e3a';
const ROUND = 'aa'.repeat(32);
const AT = 1791200000000;                            // 2026-10-05T..Z
const dev = newKey();
const D = (i, over = {}) => ({ outpoint: `${String(i).repeat(64).slice(0, 64)}:${i}`, entryId: 'ee'.repeat(32), roundId: ROUND, federationId: 'fe'.repeat(32),
  amountMsat: String(1000 * (i + 1)), contractId: `c${i}`, verifiedMs: AT + i * 60000, playerKey: PLAYER, senderOnContract: true, seats: 2, ...over });
// a price API that answers [[ms, price], ...] around the asked time, per currency
const prices = { usd: [[AT - 120000, 62000], [AT - 30000, 62100], [AT + 90000, 62200]], eur: [[AT - 120000, 57000], [AT - 30000, 57100], [AT + 90000, 57200]] };
const priceApi = (fail = false) => async (url) => {
  if (fail) throw new Error('rate limit');
  const cur = /vs_currency=(\w+)/.exec(url)[1];
  return new Response(JSON.stringify({ prices: prices[cur] }));
};

test('redeem uses the contract the seats verified: the sender key as the image when it is on the contract, zeros when not', async () => {
  const seen = [];
  const client = { refund: async (txid, out, fields) => { seen.push(JSON.parse(fields).paymentImage.bytes); return JSON.stringify({ accepted: true, txid: 'ab' }); } };
  await redeemAll({ client, donations: [D(1), D(2, { senderOnContract: false })], recipientPkHex: dev.recipientPkHex, secretHex: dev.secretHex });
  assert.deepEqual(seen, [PLAYER, '00'.repeat(32)]);
  assert.equal(JSON.parse(donationFields(dev.recipientPkHex, 5, PLAYER)).paymentImage.bytes, PLAYER);
  assert.equal(JSON.parse(donationFields(dev.recipientPkHex, 5)).paymentImage.bytes, '00'.repeat(32));
});

test('the rate at the donation\'s time: USD and EUR from the nearest price, the provider named; a failed call answers why', async () => {
  const r = await rateAt({ atMs: AT, fetcher: priceApi() });
  assert.deepEqual(r, { ok: true, usd: 62100, eur: 57100, priceAtMs: { usd: AT - 30000, eur: AT - 30000 }, provider: RATE_PROVIDER });
  assert.match(RATE_PROVIDER, /coingecko/i);
  const no = await rateAt({ atMs: AT, fetcher: priceApi(true) });
  assert.equal(no.ok, false);
  assert.match(no.why, /rate limit/);
  const empty = await rateAt({ atMs: AT, fetcher: async () => new Response(JSON.stringify({ prices: [] })) });
  assert.equal(empty.ok, false);
});

test('a donation\'s record carries sender, round, amount, time, both rates and the provider, and survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'donor-record-'));
  const path = join(dir, 'donations.jsonl');
  const rec = donationRecord(D(1), { ok: true, usd: 62100, eur: 57100, priceAtMs: { usd: AT, eur: AT }, provider: RATE_PROVIDER }, { recordedAt: AT + 5 });
  assert.deepEqual(Object.keys(rec).sort(), ['amountMsat', 'contractId', 'entryId', 'eurPerBtc', 'federationId', 'outpoint', 'playerKey', 'rateProvider', 'ratesAtMs',
    'recordedAt', 'roundId', 'senderOnContract', 'usdPerBtc', 'verifiedMs'].sort());
  assert.deepEqual([rec.playerKey, rec.roundId, rec.amountMsat, rec.verifiedMs, rec.usdPerBtc, rec.eurPerBtc, rec.rateProvider], [PLAYER, ROUND, '2000', AT + 60000, 62100, 57100, RATE_PROVIDER]);
  recordDonations(path, [rec]);
  recordDonations(path, [donationRecord(D(2), { ok: true, usd: 1, eur: 2, priceAtMs: { usd: AT, eur: AT }, provider: RATE_PROVIDER }, { recordedAt: AT + 6 })]);
  const back = readRecord(path);                      // a new process reading the file
  assert.deepEqual(back.map((r) => r.outpoint), [D(1).outpoint, D(2).outpoint]);
  assert.deepEqual(back[0], rec);
  recordDonations(path, [rec]);
  assert.equal(readRecord(path).length, 2, 'a donation was recorded twice');
  assert.deepEqual(readRecord(join(dir, 'none.jsonl')), []);
});

test('the read receipt verifies under the recipient key with the seats\' own message, and under no other key', () => {
  const outpoints = [D(1).outpoint, D(2).outpoint];
  const s = signDonationsRead({ secretHex: dev.secretHex, key: dev.recipientPkHex, atMs: AT, outpoints });
  const check = (key) => ecdsaVerify('sha256', donationsReadMessage({ key: dev.recipientPkHex, atMs: AT, outpoints: [...outpoints].reverse() }),
    { key: createPublicKey({ key: Buffer.from(SECP256K1_SPKI_PREFIX + key, 'hex'), format: 'der', type: 'spki' }), dsaEncoding: 'der' }, Buffer.from(s, 'hex'));
  assert.equal(check(dev.recipientPkHex), true);
  assert.equal(check(newKey().recipientPkHex), false);
});

test('order: recorded first, then redeemed, then the receipt - only for what is recorded and redeemed or spent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'donor-order-'));
  const path = join(dir, 'donations.jsonl');
  const events = [];
  const sent = [];
  const fetcher = async (url, opts = {}) => {
    if (String(url).includes('coingecko')) return priceApi()(url);
    if (String(url).endsWith('/donations/read')) {
      const body = JSON.parse(opts.body);
      events.push(`receipt ${body.outpoints.length} (recorded ${readRecord(path).length})`);
      sent.push(body.outpoints);
      return new Response(JSON.stringify({ deleted: body.outpoints.length }));
    }
    throw new Error(`no such door ${url}`);
  };
  const client = { refund: async (txid, out) => { events.push(`redeem ${out}`); if (out === 3) throw new Error('the guardians did not answer'); return JSON.stringify({ accepted: true, txid: 'ab' }); } };
  const got = await settleRead({ path, donations: [D(1), D(2), D(3)], client, key: dev, seats: ['http://seat-a', 'http://seat-b'], fetcher, now: () => AT + 1000 });
  assert.deepEqual(events.slice(0, 3), ['redeem 1', 'redeem 2', 'redeem 3']);
  assert.deepEqual(readRecord(path).map((r) => r.outpoint), [D(1).outpoint, D(2).outpoint, D(3).outpoint], 'not every donation was recorded');
  assert.deepEqual(sent, [[D(1).outpoint, D(2).outpoint], [D(1).outpoint, D(2).outpoint]], 'a receipt named a donation not redeemed, or a seat was skipped');
  assert.ok(events.indexOf('receipt 2 (recorded 3)') > events.indexOf('redeem 3'), 'a receipt went out before every record was written');
  assert.deepEqual({ receipted: got.receipted, failed: got.failed.map((f) => f.outpoint) }, { receipted: 2, failed: [D(3).outpoint] });
  // NO RATE, NO RECEIPT: the seat keeps its copy until the dev's record is whole
  const dir2 = mkdtempSync(join(tmpdir(), 'donor-norate-'));
  const p2 = join(dir2, 'donations.jsonl');
  let receipts = 0;
  const noRate = async (url, opts) => { if (String(url).includes('coingecko')) throw new Error('down'); receipts++; return new Response('{"deleted":0}'); };
  const r2 = await settleRead({ path: p2, donations: [D(1)], client, key: dev, seats: ['http://seat-a'], fetcher: noRate, now: () => AT });
  assert.equal(receipts, 0, 'a receipt went out for a donation whose rate is not recorded');
  assert.equal(existsSync(p2) ? readRecord(p2).length : 0, 0);
  assert.match(r2.unrecorded[0].why, /down/);
  // A RECORD THAT CANNOT BE WRITTEN SENDS NO RECEIPT
  const r3 = await settleRead({ path: join(dir2, 'no-such-dir', 'x.jsonl'), donations: [D(1)], client, key: dev, seats: ['http://seat-a'], fetcher: priceApi(), now: () => AT })
    .catch((e) => ({ threw: e.message }));
  assert.ok(r3.threw || r3.receipted === 0, 'a receipt went out without a record');
  assert.equal(receipts, 0);
  // REDEEMED IN AN EARLIER PASS, STILL LISTED: recorded if it was not, named again, never redeemed twice
  const dir3 = mkdtempSync(join(tmpdir(), 'donor-again-'));
  const p3 = join(dir3, 'donations.jsonl');
  const sent3 = []; let redeems3 = 0;
  const f3 = async (url, opts = {}) => { if (String(url).includes('coingecko')) return priceApi()(url); sent3.push(JSON.parse(opts.body).outpoints); return new Response('{"deleted":1}'); };
  const c3 = { refund: async () => { redeems3++; return JSON.stringify({ accepted: true, txid: 'ab' }); } };
  const r4 = await settleRead({ path: p3, donations: [D(1), D(2)], client: c3, key: dev, seats: ['http://seat-a'], fetcher: f3, now: () => AT, done: new Set([D(1).outpoint]) });
  assert.equal(redeems3, 1, 'a donation redeemed in an earlier pass was redeemed again');
  assert.deepEqual(readRecord(p3).map((r) => r.outpoint), [D(1).outpoint, D(2).outpoint]);
  assert.deepEqual(sent3, [[D(2).outpoint, D(1).outpoint]]);
  assert.equal(r4.receipted, 2);
  void readFileSync;
});
