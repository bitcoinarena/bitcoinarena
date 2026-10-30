// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEST TOOL TAKES ONLY A ROUND OF A SEATED TABLE (kanban #803: tn4-rps-paid took rounds of table 24d4c900, whose first round never
// got a certificate, and waited each one out). tools/seated-table-pick.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pickSeatedTableRound } from '../tools/seated-table-pick.mjs';
import { contractFor } from './window-fixture.js';

const RPS_V2 = fromHex('a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea');
const base = { ...contractFor([]), gameId: RPS_V2, protocolVersion: 2, nodes: [], gameVerifySlots: 7, settlementSlots: 7, startTimeMs: 60500n };
const round = (series, roundIndex, extra = {}) => { const c = { ...base, seriesId: new Uint8Array(32).fill(series), roundIndex, ...extra }; return { c, id: toHex(roundIdOf(c)), bytes: encodeRoundContract(c) }; };

test('a round of a table whose first round has no certificate is passed; the next table that has both is taken', async () => {
  const unseated = round(0x24, 5), seated = round(0x6d, 7), other = round(0x6d, 8);
  const anchorOf = (r) => toHex(tableAnchorOf(r.c).anchorId);
  const all = [unseated, seated, other];
  const certs = new Set([`${anchorOf(seated)}:game`, `${anchorOf(seated)}:settlement`]);
  const asked = [];
  const got = await pickSeatedTableRound(all.map((r) => r.id), {
    contractOf: async (id) => all.find((r) => r.id === id).bytes,
    seated: async (a, role) => { asked.push(`${a}:${role}`); return certs.has(`${a}:${role}`); } });
  assert.equal(got.id, seated.id);
  assert.deepEqual(got.passed.map((p) => p.id), [unseated.id]);
  assert.match(got.passed[0].why, /is not seated/);
});

test('a table seated for one role only is not seated; a table\'s first round and a round seated on its own are taken as before', async () => {
  const half = round(0x31, 2), first = round(0x32, 0), solo = round(0x33, 4, { gameId: new Uint8Array(32).fill(0x11) });
  const all = [half, first, solo];
  const halfAnchor = toHex(tableAnchorOf(half.c).anchorId);
  const opts = { contractOf: async (id) => all.find((r) => r.id === id).bytes, seated: async (a, role) => a === halfAnchor && role === 'game' };
  assert.equal((await pickSeatedTableRound(all.map((r) => r.id), opts)).id, first.id, 'round 0: its seating is still to come');
  assert.equal((await pickSeatedTableRound([half.id, solo.id], opts)).id, solo.id, 'no table: seated per round');
  assert.equal((await pickSeatedTableRound([half.id], opts)).id, null);
});

test('each table is asked once, and accept() still filters by federation', async () => {
  const a = round(0x41, 1), b = round(0x41, 2), c = round(0x42, 3, { federationId: new Uint8Array(32).fill(0xbb) });
  const all = [a, b, c]; let asks = 0;
  const got = await pickSeatedTableRound(all.map((r) => r.id), {
    contractOf: async (id) => all.find((r) => r.id === id).bytes,
    seated: async () => { asks++; return false; },
    accept: (k) => toHex(k.federationId).startsWith('bb') });
  assert.equal(got.id, null, 'c is of federation bb but its table is not seated either');
  assert.equal(asks, 1, 'a and b never asked (another federation), c\'s table once');
});
