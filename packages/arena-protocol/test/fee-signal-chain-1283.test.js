// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1283 (RULED #1277 B): fee signals and developer approvals as OP_RETURN payloads, counted by block height inside the period.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash } from '../src/hash.js';
import { encodeFeeSignal, decodeFeeSignal, encodeFeeApprovalOnChain, decodeFeeApprovalOnChain, feeSignalMessage, feeApprovalMessage, countFeeChain,
  FEE_SIGNAL_BYTES, FEE_APPROVAL_BYTES } from '../src/fee-signal-chain.js';

const key = (s) => { const secret = taggedHash('TEST/fee1283', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const ID = taggedHash('TEST/proposal1283', Uint8Array.of(1));
const bonds = Array.from({ length: 20 }, (_, i) => ({ ...key(`bond${i}`), outpoint: `${'ab'.repeat(32)}:${i}`, bondSats: 100000n }));
const census = bonds.map((b) => ({ pubkey: b.pub, outpoint: b.outpoint, bondSats: b.bondSats }));
const devs = [key('dev0'), key('dev1'), key('dev2')];
const signal = (b, height) => ({ kind: 'signal', height, payload: encodeFeeSignal({ proposalId: ID, signature: schnorr.sign(feeSignalMessage(ID), b.secret) }) });
const approval = (d, approve, height) => ({ kind: 'approval', height, payload: encodeFeeApprovalOnChain({ proposalId: ID, approve, signature: schnorr.sign(feeApprovalMessage(ID, approve), d.secret) }) });

test('#1283 signals counted one per bond inside the period; 15 % of the census passes; a developer\'s no stands over a yes', () => {
  assert.equal(encodeFeeSignal({ proposalId: ID, signature: new Uint8Array(64) }).length, FEE_SIGNAL_BYTES);
  assert.equal(FEE_SIGNAL_BYTES, 76); assert.equal(FEE_APPROVAL_BYTES, 77);
  assert.ok(decodeFeeSignal(signal(bonds[0], 1).payload));
  assert.equal(decodeFeeApprovalOnChain(signal(bonds[0], 1).payload), null, 'a signal is no approval');
  const items = [
    signal(bonds[0], 100), signal(bonds[1], 105), signal(bonds[1], 106),        // bond 1 twice: once
    signal(bonds[2], 99),                                                        // before the period: not counted
    signal(bonds[3], 110),                                                       // at the period's end (exclusive): not counted
    approval(devs[0], true, 101), approval(devs[1], true, 102), approval(devs[1], false, 103), approval(devs[2], true, 120),
  ];
  const two = countFeeChain({ proposalId: ID, items, fromHeight: 100, toHeight: 110, census, devKeys: devs.map((d) => d.pub), verify });
  const three = countFeeChain({ proposalId: ID, items: [...items, signal(bonds[4], 109)], fromHeight: 100, toHeight: 110, census, devKeys: devs.map((d) => d.pub), verify });
  const got = { signals2: [two.signals.bonds, two.signals.of, two.signals.passes], signals3: [three.signals.bonds, three.signals.passes],
    approvals: Object.fromEntries([...two.approvals].map(([k, v]) => [devs.findIndex((d) => Buffer.from(d.pub).toString('hex') === k), v])) };
  console.log('  MEASURED #1283:', JSON.stringify(got));
  assert.deepEqual(got.signals2, [2, 20, false]);        // 2 of 20 = 10 %
  assert.deepEqual(got.signals3, [3, true]);             // 3 of 20 = 15 %
  assert.deepEqual(got.approvals, { 0: true, 1: false }, 'dev1 said yes then no: no; dev2 approved after the period: not counted');
});
