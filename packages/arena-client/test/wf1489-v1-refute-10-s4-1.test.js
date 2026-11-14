// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-10 skeptic 4 (kanban #1489): the agreement ranking of 09f86927f assumes a federation's seats are distinct sites.
// The live federation is not: every seat is https://tn4.bitcoin-arena.io/guardian-N, ONE site by owedSiteOf, so each honest round
// is "listed by 1 site" - the same tier as a liar's made-up ids. Four liars on four cheap domains (4 x 500 ids, tier 1) beside the
// seven guardians cut the guardians' 500 to 400 in the round-robin, and the player's oldest round is missed (s3-2's attack, back).
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

test('wf1489-v1-refute-10-s4-1: seven guardians on one host (the live layout) beside four liar domains still show the owed round', async () => {
  PL.forgetOwedRounds();
  const now = Date.now();
  const honestList = Array.from({ length: 499 }, (_, i) => ({ id: (0xf00000 + i).toString(16).padStart(64, '0'), madeMs: now - 1000 - i, payouts: [], refunds: [] }));
  honestList.push({ id, madeMs: now - 10 * 3600 * 1000, payouts: [owedTo], refunds: [] });
  const guardians = Array.from({ length: 7 }, (_, i) => 'https://tn4.bitcoin-arena.io/guardian-' + (i + 1));
  const liars = ['https://liar-a.example/', 'https://liar-b.test/', 'https://liar-c.invalid/', 'https://liar-d.example.org/'];
  const fetcher = async (url) => {
    if (url.startsWith('https://tn4.bitcoin-arena.io')) {
      if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: honestList }) };
      if (url.includes('/round?id=')) return { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
      return { ok: false };
    }
    if (url.includes('/settled?')) {
      const k = liars.findIndex((l) => url.startsWith(l.replace(/\/$/, '')));
      return { ok: true, json: async () => ({ rounds: Array.from({ length: 500 }, (_, i) => ({ id: ((k + 1) * 100000 + i + 1).toString(16).padStart(64, '0'), madeMs: now, payouts: [], refunds: [] })) }) };
    }
    return { ok: false };
  };
  const signed = signedSeats(fetcher, guardians);   // the liars sign too, each with its own key: no census bonds it
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: [...guardians, ...liars], fetcher: signed.fetcher, bonded: signed.bonded, sinceMs: 0 });
  console.log('  FACTS sites', [...new Set([...guardians, ...liars].map(PL.owedSiteOf))].join(' '), '- found', found.length);
  assert.deepEqual(found.map((f) => f.roundIdHex), [id], 'the guardians\' listed round owed to this phrase was not found');
});

test('kanban #2108: an unsigned /settled answer, or one signed by a key the census does not bond, adds nothing', async () => {
  PL.forgetOwedRounds();
  const seat = 'https://tn4.bitcoin-arena.io/guardian-1';
  const list = { rounds: [{ id, madeMs: Date.now() - 1000, payouts: [owedTo], refunds: [] }] };
  const plain = async (url) => (url.includes('/settled?') ? { ok: true, json: async () => list }
    : url.includes('/round?id=') ? { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) } : { ok: false });
  assert.deepEqual(await PL.findOwedRounds({ seed, curve: pageCurve, nodes: [seat], fetcher: plain, bonded: signedSeats(plain, [seat]).bonded, sinceMs: 0 }), [], 'an unsigned answer counted');
  PL.forgetOwedRounds();
  const other = signedSeats(plain, ['https://another.example']);
  assert.deepEqual(await PL.findOwedRounds({ seed, curve: pageCurve, nodes: [seat], fetcher: other.fetcher, bonded: other.bonded, sinceMs: 0 }), [], 'a key outside the census counted');
  PL.forgetOwedRounds();
  const ok = signedSeats(plain, [seat]);
  assert.equal((await PL.findOwedRounds({ seed, curve: pageCurve, nodes: [seat], fetcher: ok.fetcher, bonded: ok.bonded, sinceMs: 0 })).length, 1, 'the bonded seat\'s signed answer');
});
