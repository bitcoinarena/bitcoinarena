// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-10 skeptic 4 (kanban #1489): the honest path with no liar at all. Fourteen seats on one host (the live layout,
// tn4.bitcoin-arena.io/<seat>), each sat on a different committee and lists 100 settled rounds - well inside the 500 a seat may
// send. They are one site, so the union (1400 ids) is cut to the 500 newest, and the player's round, the oldest one seat 14 lists,
// is never derived. Before 71f2dcea8 each seat's own 100 were scanned and the round was found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { signedSeats } from './settled-signed.js';

// DECIDED 2026-11-14 (kanban #2108, #2123, "/settled signed by the census key"): each seat signs its /settled answer with its node key; the
// page counts only signed answers whose key the census it checked bonds, one allowance per key - not per site.
const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const contract = decodeRoundContract(fromHex(CONTRACT_HEX));
const id = toHex(roundId(contract));
const seed = new Uint8Array(32).fill(7);
const owedTo = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey));

test('wf1489-v1-refute-10-s4-3: fourteen honest seats on one host, 100 rounds each, still show the owed round', async () => {
  PL.forgetOwedRounds();
  const now = Date.now();
  const seats = Array.from({ length: 14 }, (_, i) => 'https://tn4.bitcoin-arena.io/seat-' + (i + 1));
  const listOf = (k) => {
    const l = Array.from({ length: 100 }, (_, i) => ({ id: (k * 1000 + i + 1).toString(16).padStart(64, '0'), madeMs: now - 1000 - k * 100 - i, payouts: [], refunds: [] }));
    if (k === 13) l[99] = { id, madeMs: now - 20 * 3600 * 1000, payouts: [owedTo], refunds: [] };
    return l;
  };
  const fetcher = async (url) => {
    const k = seats.findIndex((s) => url.startsWith(s + '/'));
    if (k < 0) return { ok: false };
    if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: listOf(k) }) };
    if (url.includes('/round?id=')) return { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
    return { ok: false };
  };
  const signed = signedSeats(fetcher, seats);
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: seats, fetcher: signed.fetcher, bonded: signed.bonded, sinceMs: 0 });
  console.log('  FACTS 14 seats one site', PL.owedSiteOf(seats[0]), '- found', found.length);
  assert.deepEqual(found.map((f) => f.roundIdHex), [id], 'the round seat 14 lists, owed to this phrase, was not found');
});
