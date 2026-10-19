// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A VERSION-11 ENTRY PAYS THE RESERVES (§27A.9.2): a 100 sat entry's lock transaction pays the nodes' 4 % in
// its fee lock, the developers' 4 % as donation outputs and 2,000 msat to its federation's reserve key - and every signer node
// checks the reserve output with the federation like a donation output, refusing one msat short, a missing one, or another key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEntryGifts, donationContractFields } from '../src/stake-lock-signer-node.js';
import { donationOutputsExpected } from '../../arena-protocol/src/donation.js';
import { reservesEntryExpected, roundSplit } from '../../arena-protocol/src/reserves.js';
import { RESERVES_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { b32 } from './window-fixture.js';

const key = (prefix, fill) => Uint8Array.of(prefix, ...new Uint8Array(32).fill(fill));
const DEVS = [{ recipientPk: key(0x02, 0xa1), shareBps: 6667, label: 'dev a' }, { recipientPk: key(0x03, 0xb2), shareBps: 3333, label: 'dev b' }];
const TARGET = { network: DEVS, game: DEVS };
const RESERVE_KEY = key(0x02, 0xc3);
const at = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const idOf = (f) => [f.paymentImage.kind, toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk), toHex(f.refundPk), f.expiration].join('|');
const federation = (held) => ({ held: new Map(Object.entries(held)),
  async status(o) { const id = this.held.get(at(o)); return { blockCount: 156800, stored: id ? { contractId: id, blocksLeft: 0 } : null }; },
  async contractId(f) { return idOf(f); } });
const CONTRACT = { protocolVersion: RESERVES_VERSION, stakeMsat: 100000n };
const OUTS = [{ txid: b32(0x08), outIdx: 2n }, { txid: b32(0x08), outIdx: 3n }];
const RES = { txid: b32(0x08), outIdx: 4n };
const split = roundSplit(100000n);
const entry = (more = {}) => ({ roundId: b32(0x01), stakeMsat: 100000n, feeMsat: split.nodesMsat,
  donationMsat: split.protocolDevsMsat + split.gameDevsMsat + split.reservesMsat, donationOutpoints: OUTS, reserveOutpoint: RES, ...more });
const devOuts = donationOutputsExpected({ ...entry(), donationMsat: 4000n }, TARGET).outputs;
const heldAll = (reserveMsat = 2000n, reserveKey = RESERVE_KEY) => federation({
  ...Object.fromEntries(devOuts.map((o) => [at(o.outpoint), idOf(donationContractFields({ recipientPk: o.recipientPk, amountMsat: o.amountMsat }))])),
  [at(RES)]: idOf(donationContractFields({ recipientPk: reserveKey, amountMsat: reserveMsat })) });
const round = { donationOutputAt: () => null };
const check = (more = {}) => verifyEntryGifts({ round, port: heldAll(), entry: entry(), contract: CONTRACT, entryIdBytes: b32(0xee),
  recipients: TARGET, reserveKey: RESERVE_KEY, federationId: b32(0xfe), ...more });

test('a 100 sat version-11 entry: 4,000 msat fee, 4,000 to the developers, 2,000 to the reserve key - all held, rows kept', async () => {
  assert.deepEqual([split.nodesMsat, split.protocolDevsMsat + split.gameDevsMsat, split.reservesMsat], [4000n, 4000n, 2000n]);
  const r = await check();
  assert.equal(r.ok, true, r.why);
  const reserve = r.rows.filter((x) => x.reserve);
  assert.deepEqual(reserve.map((x) => [toHex(x.recipientPk), x.amountMsat, x.outpoint.outIdx]), [[toHex(RESERVE_KEY), 2000n, 4n]]);
  assert.equal(r.rows.filter((x) => !x.reserve).reduce((t, x) => t + x.amountMsat, 0n), 4000n);
});

test('refused by name: one msat short, another key, nothing held, no reserve outpoint, a lowered donation, a 5 % fee', async () => {
  const cases = [
    ['1,999 msat to the reserves', { port: heldAll(1999n) }, /reserves: the output at .* is not 2000 msat/],
    ['to another key', { port: heldAll(2000n, key(0x03, 0xd4)) }, /reserves: the output at .* is not 2000 msat to key/],
    ['nothing at the reserve outpoint', { port: (() => { const p = heldAll(); p.held.delete(at(RES)); return p; })() }, /reserves: the federation holds nothing/],
    ['no reserve key known', { reserveKey: null }, /no reserve key is known/],
  ];
  for (const [name, more, why] of cases) { const r = await check(more); assert.equal(r.ok, false, name); assert.match(r.why, why, `${name}: ${r.why}`); }
  assert.match(reservesEntryExpected({ entry: entry({ reserveOutpoint: undefined }), recipients: TARGET, reserveKey: RESERVE_KEY }).why, /names its reserve lock/);
  assert.match(reservesEntryExpected({ entry: entry({ donationMsat: 4000n }), recipients: TARGET, reserveKey: RESERVE_KEY }).why, /are 6000 msat, not 4000/);
  assert.match(reservesEntryExpected({ entry: entry({ feeMsat: 5000n }), recipients: TARGET, reserveKey: RESERVE_KEY }).why, /node fee is 4000 msat \(4 %\), not 5000/);
});

test('a round below version 11 checks its donation outputs as before, with no reserve', async () => {
  const old = await verifyEntryGifts({ round, port: heldAll(), entry: { ...entry({ reserveOutpoint: undefined }), donationMsat: 4000n }, contract: { protocolVersion: 10, stakeMsat: 100000n },
    entryIdBytes: b32(0xee), recipients: TARGET, federationId: b32(0xfe) });
  assert.equal(old.ok, true, old.why);
  assert.equal(old.rows.some((x) => x.reserve), false);
});
