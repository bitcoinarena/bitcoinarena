// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1199, THE #1196 RULING (spec §27A.7.4, §27A.7.6): a ballot is decided 3 blocks deep at least, a repeal's cooldown is 2,
// and a proposal whose activation leaves fewer than 3 blocks after its last voting block is invalid on its face - for proposals
// published at or after the network's BALLOT_DEPTH_HEIGHT. Older proposals keep the old rule (depth 1, repeal cooldown 0).
// Regtest keeps 1 / 6 / 1, repeal 0 / 6 / 0, depth 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { CLASS, SCHEDULES, REPEAL_SCHEDULES, BALLOT_DEPTH_HEIGHT, MIN_DECIDE_DEPTH, MIN_DECIDE_DEPTHS, LEGACY_REPEAL_COOLDOWN, LEGACY_DECIDE_DEPTH,
  HOST_REMOVAL_VOTING, proposalStands, proposalBodyId, configHashOf, underDepthRule } from '../src/ballot.js';
import { encodeSourceList } from '../src/market-check.js';

const H = (b) => new Uint8Array(32).fill(b);
const secret = new Uint8Array(32).fill(9); const proposer = schnorr.getPublicKey(secret);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const make = (config, activationHeight, cls = CLASS.MONEY) => {
  const p = { networkId: H(0x10), parent: H(2), configHash: configHashOf(config), config, class: cls, activationHeight, proposer, depositTxid: H(0x77) };
  return { ...p, signature: schnorr.sign(proposalBodyId(p), secret) };
};
const entry = (host) => ({ host, url: `https://${host}/x`, read: 'text', path: '', docs: `https://${host}/docs` });

test('#1199 the constants: regtest 1 / 6 / 1, repeal 0 / 6 / 0, depth 1; mainnet and testnet4 repeal cooldown 2, depth 3; the gate per network', () => {
  for (const k of [CLASS.DESIGN, CLASS.MONEY, CLASS.UPGRADE, CLASS.SOURCES]) assert.deepEqual(SCHEDULES.regtest[k], { review: 1, voting: 6, cooldown: 1 });
  assert.deepEqual({ ...REPEAL_SCHEDULES.regtest }, { review: 0, voting: 6, cooldown: 0 });
  assert.deepEqual({ ...REPEAL_SCHEDULES.mainnet }, { review: 0, voting: 720, cooldown: 2 });
  assert.deepEqual({ ...REPEAL_SCHEDULES.testnet4 }, { review: 0, voting: 144, cooldown: 2 }, 'testnet4 votes a day (kanban #785)');
  assert.deepEqual([MIN_DECIDE_DEPTH, MIN_DECIDE_DEPTHS.mainnet, MIN_DECIDE_DEPTHS.testnet4, MIN_DECIDE_DEPTHS.regtest], [3, 3, 3, 1]);
  assert.deepEqual([LEGACY_DECIDE_DEPTH, LEGACY_REPEAL_COOLDOWN], [1, 0]);
  assert.deepEqual([BALLOT_DEPTH_HEIGHT.regtest, BALLOT_DEPTH_HEIGHT.mainnet], [0, 0]);
  // TESTNET4 NOT SET YET: every height keeps the old rule, as the 1.9 seats beside it
  assert.equal(underDepthRule(0, BALLOT_DEPTH_HEIGHT.testnet4), false);
  assert.equal(underDepthRule(0xffffffff, BALLOT_DEPTH_HEIGHT.testnet4), false);
  assert.equal(underDepthRule(0, BALLOT_DEPTH_HEIGHT.mainnet), true);
});

test('#1199 a repeal: cooldown 2 at or after the gate, 0 before it', () => {
  const history = [{ config: Uint8Array.of(1) }, { config: Uint8Array.of(2) }];
  const facts = { publishedAt: 1000, depositSats: 100, lowestBondMinSats: 100000, verify, history };
  const back = (activation) => make(Uint8Array.of(1), activation);
  // AT THE GATE (published 1000, gate 1000): voting 1000-1719, activation from 1722
  const at = { ...facts, depthHeight: 1000 };
  assert.match(proposalStands(back(1720), at).why, /before the end of cooldown \(1722\)/);
  assert.match(proposalStands(back(1721), at).why, /before the end of cooldown \(1722\)/);
  assert.equal(proposalStands(back(1722), at).ok, true);
  // BELOW THE GATE (gate 1001): the old rule, activation from 1720
  const below = { ...facts, depthHeight: 1001 };
  const old = proposalStands(back(1720), below);
  assert.deepEqual([old.ok, old.repeal, old.votingUntil], [true, true, 1720], old.why);
  // testnet4 as set now: the old rule for every proposal
  assert.equal(proposalStands(back(1000 + 144), { ...facts, repealSchedule: REPEAL_SCHEDULES.testnet4, depthHeight: BALLOT_DEPTH_HEIGHT.testnet4 }).ok, true);
  assert.match(proposalStands(back(1000 + 144), { ...facts, repealSchedule: REPEAL_SCHEDULES.testnet4, depthHeight: 0 }).why, /before the end of cooldown \(1146\)/);
});

test('#1199 a host removal: cooldown 2 at or after the gate, 0 before it', () => {
  const history = [{ config: encodeSourceList([entry('a.example.org'), entry('b.example.org')]) }];
  const facts = { publishedAt: 1000, depositSats: 100, lowestBondMinSats: 100000, verify, history };
  const drop = (activation) => make(encodeSourceList([entry('a.example.org')]), activation, CLASS.SOURCES);
  const end = 1000 + Math.min(HOST_REMOVAL_VOTING, REPEAL_SCHEDULES.mainnet.voting);
  assert.match(proposalStands(drop(end), { ...facts, depthHeight: 0 }).why, new RegExp(`before the end of cooldown \\(${end + 2}\\)`));
  assert.equal(proposalStands(drop(end + 2), { ...facts, depthHeight: 0 }).ok, true);
  assert.equal(proposalStands(drop(end), { ...facts, depthHeight: 1001 }).ok, true, 'below the gate: the old cooldown 0');
});

test('#1199 an activation fewer than 3 blocks after the last voting block: refused at or after the gate, taken below it', () => {
  // a schedule with no cooldown, so only the depth check can refuse it: voting 1001-1006 (last 1006)
  const short = { ...SCHEDULES.mainnet, [CLASS.MONEY]: { review: 1, voting: 6, cooldown: 0 } };
  const facts = { publishedAt: 1000, depositSats: 100, lowestBondMinSats: 100000, verify, schedule: short };
  for (const a of [1007, 1008]) {
    assert.match(proposalStands(make(Uint8Array.of(5), a), { ...facts, depthHeight: 1000 }).why, /fewer than the 3 a ballot is decided at: invalid on its face/, `activation ${a}`);
    assert.equal(proposalStands(make(Uint8Array.of(5), a), { ...facts, depthHeight: 1001 }).ok, true, `activation ${a} below the gate`);
  }
  assert.equal(proposalStands(make(Uint8Array.of(5), 1009), { ...facts, depthHeight: 1000 }).ok, true, '3 blocks after 1006: stands');
  // REGTEST: depth 1, so its own 1 / 6 / 1 stands under the rule (gate 0)
  const reg = proposalStands(make(Uint8Array.of(5), 1008), { ...facts, schedule: SCHEDULES.regtest, depthHeight: BALLOT_DEPTH_HEIGHT.regtest });
  assert.deepEqual([reg.ok, reg.votingFrom, reg.votingUntil], [true, 1001, 1007], reg.why);
});
