// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-10 skeptic 3 (kanban #1489, #1832): the scan-wide OWED_SCAN_IDS_MAX (2000) taken "host by host in turn" lets
// a liar's hostnames crowd an honest seat's rounds out. An honest seat lists 500 settled rounds (what round.js settledSince answers
// at most); the player's round is the oldest of them. Before 71f2dcea8 the honest seat's whole 500 was scanned and the round found;
// now four spellings of one liar host (4 x 500 made-up ids) beside it leave the honest seat 400 of its 500, and the round is missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { signedSeats } from './settled-signed.js';   // kanban #2108: seats sign their /settled answers

const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const contract = decodeRoundContract(fromHex(CONTRACT_HEX));
const id = toHex(roundId(contract));
const seed = new Uint8Array(32).fill(7);
const owedTo = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey));

test('wf1489-v1-refute-10-s3-2: one liar host behind a few hostname spellings does not hide an honest seat\'s listed round', async () => {
  PL.forgetOwedRounds();
  const now = Date.now();
  const honestList = Array.from({ length: 499 }, (_, i) => ({ id: (0xf00000 + i).toString(16).padStart(64, '0'), madeMs: now - 1000 - i, payouts: [], refunds: [] }));
  honestList.push({ id, madeMs: now - 10 * 3600 * 1000, payouts: [owedTo], refunds: [] });
  const liars = ['https://liar.example/s0', 'https://liar.example./s1', 'http://192.0.2.1/s2', 'http://[::ffff:192.0.2.1]/s3'];
  const fetcher = async (url) => {
    if (url.startsWith('https://honest.example')) {
      if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: honestList }) };
      if (url.includes('/round?id=')) return { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
      return { ok: false };
    }
    if (url.includes('/settled?')) {
      const k = Number((url.match(/\/s(\d+)\/settled/) || [0, 0])[1]);
      return { ok: true, json: async () => ({ rounds: Array.from({ length: 500 }, (_, i) => ({ id: (k * 100000 + i + 1).toString(16).padStart(64, '0'), madeMs: now, payouts: [], refunds: [] })) }) };
    }
    return { ok: false };
  };
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: ['https://honest.example', ...liars], ...signedSeats(fetcher, ['https://honest.example']), sinceMs: 0 });
  console.log(`  FACTS honest seat lists 500 (the player's round oldest) beside ${liars.length} spellings of one liar host: ${found.length} found`);
  assert.deepEqual(found.map((f) => f.roundIdHex), [id], 'the honest seat\'s listed round owed to this phrase was not found');
});
