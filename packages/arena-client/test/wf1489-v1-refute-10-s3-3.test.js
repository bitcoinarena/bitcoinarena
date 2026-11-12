// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1966, #2002 (#1489 v1-refute-10 s3): wildcard subdomains of one liar domain are one site (one seat's allowance), and the
// rounds a federation's seats agree on are scanned before any liar's made-up ids, however many liar domains the link names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const contract = decodeRoundContract(fromHex(CONTRACT_HEX));
const id = toHex(roundId(contract));
const seed = new Uint8Array(32).fill(7);
const owedTo = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey));
const fakeList = (k, now) => Array.from({ length: 500 }, (_, i) => ({ id: (k * 100000 + i + 1).toString(16).padStart(64, '0'), madeMs: now, payouts: [], refunds: [] }));

test('#1966: 31 wildcard subdomains of one liar domain cost the page one seat', async () => {
  PL.forgetOwedRounds();
  assert.equal(PL.owedSiteOf('https://a.b.liar.example./x'), PL.owedSiteOf('https://LIAR.example'));
  assert.equal(PL.owedSiteOf('http://[::ffff:192.0.2.1]/s'), PL.owedSiteOf('http://192.0.2.9/t'));
  const nodes = Array.from({ length: 31 }, (_, k) => `https://w${k}.liar.example/s${k}`);
  const fetcher = async (url) => {
    if (!url.includes('/settled?')) return { ok: false };
    return { ok: true, json: async () => ({ rounds: fakeList(Number(url.match(/\/s(\d+)\/settled/)[1]), Date.now()) }) };
  };
  let derived = 0;
  const curve = { ...pageCurve, pointX: (s) => { derived += 1; return pageCurve.pointX(s); } };
  await PL.findOwedRounds({ seed: new Uint8Array(32).fill(9), curve, nodes, fetcher, sinceMs: 0 });
  console.log(`  FACTS 31 subdomains: ${derived} key derivations`);
  assert.ok(derived <= 500 * 33, `31 subdomains of one domain made the page derive ${derived} keys`);
});

test('#2002: three federation seats\' oldest shared round is found beside 6 liar domains and 20 liar subdomains', async () => {
  PL.forgetOwedRounds();
  const now = Date.now();
  const honestList = Array.from({ length: 499 }, (_, i) => ({ id: (0xf00000 + i).toString(16).padStart(64, '0'), madeMs: now - 1000 - i, payouts: [], refunds: [] }));
  honestList.push({ id, madeMs: now - 10 * 3600 * 1000, payouts: [owedTo], refunds: [] });
  const honest = ['https://seat-a.example', 'https://seat-b.example', 'https://seat-c.example'];
  const liars = [...Array.from({ length: 6 }, (_, k) => `https://liar${k}.example/s${k}`), ...Array.from({ length: 20 }, (_, k) => `https://w${k}.liarz.example/s${10 + k}`)];
  const fetcher = async (url) => {
    if (honest.some((h) => url.startsWith(h))) {
      if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: honestList }) };
      if (url.includes('/round?id=')) return { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
      return { ok: false };
    }
    if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: fakeList(Number(url.match(/\/s(\d+)\/settled/)[1]), now) }) };
    return { ok: false };
  };
  // the liars first in the link: order must not matter
  const found = await PL.findOwedRounds({ seed, curve: pageCurve, nodes: [...liars, ...honest], fetcher, sinceMs: 0 });
  assert.deepEqual(found.map((f) => f.roundIdHex), [id]);
});
