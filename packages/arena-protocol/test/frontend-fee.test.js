// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WEBSITE THAT BROUGHT AN ENTRY (2026.0.9, roadmap item 7; RULED 2026-10-15, path (a): "Take it out of the
// nodes' 5% fee, 20% of that fee, so nodes earn less ... The player's stake is not increased by this fee").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEntryContract, decodeEntryContract, entryId, FRONTEND_MARKER } from '../src/contracts.js';
import { frontendShares, grossVolumeMsat, entryFeeMsat, FRONTEND_FEE_PERCENT, NODE_FEE_BPS } from '../src/fee.js';
import { FRONTEND_FEE_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/constants.js';
import { protocolVersionName } from '../src/protocol-version.js';
import { DELIVERED, ENTRY_VOID } from '../src/payout.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const site = (n) => { const k = new Uint8Array(33).fill(n); k[0] = 2; return k; };
const ENTRY = {
  roundId: b32(1), playerPubkey: b32(2), sessionPubkey: b32(3), stakeCommitment: b32(4), stakeMsat: 2000000n, feeMsat: 100000n, donationMsat: 100000n,
  joinTick: 0, worldSecret: b32(5), vssSharesRef: b32(6), stakePoint: new Uint8Array(33).fill(7), feePreimage: b32(8),
  stakeLockOutpoint: { txid: b32(9), outIdx: 0n }, feeLockOutpoint: { txid: b32(9), outIdx: 1n }, claimKeyAttestationRef: b32(10),
};

test('version 9 names it; an entry carries the website\'s key last, signed; every entry without it keeps its bytes', () => {
  assert.equal(FRONTEND_FEE_VERSION, 9);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(9));
  assert.equal(protocolVersionName(9), '9');
  const plain = encodeEntryContract(ENTRY);
  const withSite = encodeEntryContract({ ...ENTRY, frontendPk: site(0xaa) });
  assert.equal(withSite.length, plain.length + 34);
  assert.equal(toHex(withSite.subarray(0, plain.length)), toHex(plain), 'the entry before it is byte for byte the same');
  assert.equal(withSite[plain.length], FRONTEND_MARKER);
  assert.equal(toHex(decodeEntryContract(withSite).frontendPk), toHex(site(0xaa)));
  assert.equal(decodeEntryContract(plain).frontendPk, undefined);
  assert.notEqual(toHex(entryId({ ...ENTRY, frontendPk: site(0xaa) })), toHex(entryId({ ...ENTRY, frontendPk: site(0xbb) })), 'the website is in the entry\'s id');
  // after the operator and the federation, each alone or together
  for (const extra of [{ operatorId: b32(0x0c) }, { federationId: b32(0x0f) }, { operatorId: b32(0x0c), federationId: b32(0x0f) }, { pick: 1, federationId: b32(0x0f) }]) {
    const e = { ...ENTRY, ...extra, frontendPk: site(0xcc) };
    const back = decodeEntryContract(encodeEntryContract(e));
    assert.equal(toHex(back.frontendPk), toHex(site(0xcc)));
    assert.equal(toHex(encodeEntryContract(back)), toHex(encodeEntryContract(e)));
  }
  assert.throws(() => encodeEntryContract({ ...ENTRY, frontendPk: b32(1) }), /33-byte compressed payout key/);
  const bad = new Uint8Array(withSite); bad[plain.length + 1] = 4;
  assert.throws(() => decodeEntryContract(bad), /33-byte compressed payout key/);
});

test('the website is paid 20% of the nodes\' fee on the stakes it brought; the nodes the rest; the player nothing more', () => {
  assert.equal(FRONTEND_FEE_PERCENT, 20n);
  const entries = [
    { stakeMsat: 2000000n, outcome: DELIVERED, frontendPk: site(0xaa) },
    { stakeMsat: 2000000n, outcome: DELIVERED, frontendPk: site(0xaa) },
    { stakeMsat: 3000000n, outcome: DELIVERED, frontendPk: site(0xbb) },
    { stakeMsat: 1000000n, outcome: DELIVERED },
    { stakeMsat: 5000000n, outcome: ENTRY_VOID, frontendPk: site(0xbb) },
  ];
  // the nodes' fee table's own fee and gross (fee.js nodeFeeTable: 5% of the counted gross)
  const gross = grossVolumeMsat(entries);
  const table = { gross, fee: (gross * BigInt(NODE_FEE_BPS)) / 10000n };
  assert.deepEqual([table.gross, table.fee], [8000000n, 400000n], 'the fee is the network\'s 5% of the counted gross, as before');
  const s = frontendShares({ entries, fee: table.fee, gross: table.gross });
  // site aa brought 4,000,000 of 8,000,000: 20% of half the fee = 40,000; bb 3,000,000 (its void entry brings nothing): 30,000
  assert.deepEqual([...s.shares].map(([k, v]) => [k.slice(0, 4), v]), [['02aa', 40000n], ['02bb', 30000n]]);
  assert.equal(s.totalMsat, 70000n);
  assert.equal(table.fee - s.totalMsat, 330000n, 'the nodes keep 330,000 of their 400,000');
  // every entry referred: the nodes keep exactly 80%
  const all = entries.slice(0, 4).map((e) => ({ ...e, frontendPk: site(0xaa) }));
  assert.equal(frontendShares({ entries: all, fee: 400000n, gross: 8000000n }).totalMsat, 80000n);
  // the player's fee lock is the network's 5% of the stake whether or not a website brought it
  assert.equal(entryFeeMsat(2000000n), 100000n);
});

// THE SAME 20% ON AN ORDER BOOK (comment 2295): the book's fee lines, at the plan's numbers - two 10,000 sat orders, YES and
// NO at 0.50, both filled, Up/Down fees (node 0.5% + donation 0.5%), YES wins.
test('an order book pays the website 20% of the nodes\' part of the fees; the donation and the players are untouched', async () => {
  const { bookLedger, bookSettlement } = await import('../src/book-ledger.js');
  const { YES, NO } = await import('../src/order-book.js');
  const { bookLockSettlement } = await import('../src/lock-settlement.js');
  const { TEST_DONATION_SET_KEYS_REGTEST } = await import('../src/test-donation-set-keys-regtest.js');
  const STAKE = 10_000_000n;
  const feeMsat = entryFeeMsat(STAKE, 100);
  const id = (s) => s.padStart(64, '0');
  const L = bookLedger({ batches: [{ k: 1, cutoffMs: 1000n, orders: [{ id: id('a'), outcome: YES, price: 50000n, stakeMsat: STAKE, feeMsat, expiryMs: 0n },
    { id: id('b'), outcome: NO, price: 50000n, stakeMsat: STAKE, feeMsat, expiryMs: 0n }] }], feeBps: 100 });
  const table = bookSettlement({ positions: L.positions, outcome: YES });
  const nodeKey = (n) => { const k = new Uint8Array(32).fill(n); return k; };
  const contract = { nodes: [nodeKey(0x11), nodeKey(0x22)] };
  const player = { a: new Uint8Array(32).fill(0xa1), b: new Uint8Array(32).fill(0xb1) };
  const op = (n) => ({ txid: new Uint8Array(32).fill(n), outIdx: 0n });
  const settle = (withSite) => {
    const entries = ['a', 'b'].map((x) => ({ entryId: id(x), pubkey: player[x], ...(withSite ? { frontendPk: site(0xaa) } : {}) }));
    const locks = new Map(['a', 'b'].map((x, i) => [toHex(player[x]), { outpoint: op(1 + i), amountMsat: STAKE - feeMsat, refundPk: new Uint8Array([2, ...player[x]]) }]));
    const feeLocks = new Map(['a', 'b'].map((x, i) => [toHex(player[x]), { outpoint: op(5 + i), amountMsat: feeMsat, preimage: new Uint8Array(32).fill(9) }]));
    return bookLockSettlement({ roundId: b32(1), table, entries, locks, feeLocks, fees: { ppm: 0n, baseMsat: 0n }, contract, nodeBps: 50, donationBps: 50,
      donation: { recipients: TEST_DONATION_SET_KEYS_REGTEST.recipients } });
  };
  const lines = (s, kind) => s.payouts.filter((p) => p.kind === kind).map((p) => p.msat);
  const plain = settle(false), viaSite = settle(true);
  assert.ok(plain.ok, plain.why); assert.ok(viaSite.ok, viaSite.why);
  const sumOf = (xs) => xs.reduce((a, b) => a + b, 0n);
  console.log('  BOOK:', JSON.stringify({ plain: { nodes: lines(plain, 'signer node'), donation: sumOf(lines(plain, 'donation key')), players: plain.payouts.filter((p) => p.kind === 'qualifier').map((p) => p.msat) },
    viaSite: { nodes: lines(viaSite, 'signer node'), website: lines(viaSite, 'frontend'), donation: sumOf(lines(viaSite, 'donation key')) } }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(feeMsat, 100000n);
  assert.equal(table.feesDueMsat, 200000n);
  assert.deepEqual(lines(plain, 'signer node'), [50000n, 50000n]);
  assert.deepEqual(lines(viaSite, 'signer node'), [40000n, 40000n], 'the nodes earn 20% less');
  assert.deepEqual(lines(viaSite, 'frontend'), [20000n], 'the website: 20% of the nodes\' 100,000');
  assert.equal(sumOf(lines(plain, 'donation key')), 100000n);
  assert.equal(sumOf(lines(viaSite, 'donation key')), 100000n, 'the donation is untouched');
  const others = (s) => s.payouts.filter((p) => !['signer node', 'frontend', 'donation key'].includes(p.kind)).map((p) => [toHex(p.payoutPk), p.msat]);
  assert.deepEqual(others(viaSite), others(plain), 'every player line is the same');
  assert.equal(sumOf(others(plain).map((x) => x[1])), 19800000n, 'the winner is paid the whole pool');
  //: the book names what it paid each winner, by its player key - a season reads it (the winner's out, its own stake back
  // and its winnings), not 0
  assert.deepEqual(plain.stakeShares.map((x) => [toHex(x.pubkey), x.msat]), [[toHex(player.a), 19800000n]]);
});
