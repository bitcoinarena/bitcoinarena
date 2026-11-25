// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3610 (feedback #438): the faucet reads its census seats at 127.0.0.1, while the chain lists the same seats at their public tail-net name,
// which the public fetch refuses by name (#1809). The team's seats were then never witnesses, and an outside node that served ~300 rounds a week
// read "0 committees". A trusted seat's own advertised endpoint is now read at the trusted seat; a stranger's endpoint is still refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';

const SECRET = new Uint8Array(32).fill(0x3c), NODE = toHex(schnorr.getPublicKey(SECRET));
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const T = ['1a', '2a', '3a'].map((b) => b.repeat(32));
const LOCAL = ['http://127.0.0.1:31221', 'http://127.0.0.1:31231', 'http://127.0.0.1:31241'];
const PUB = ['wss://team.tail0000.ts.net/g1', 'wss://team.tail0000.ts.net/g2', 'wss://team.tail0000.ts.net/g3'];
const STRANGER = 'ee'.repeat(32);
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '50000' }, { node: STRANGER, endpoint: 'wss://evil.tail0000.ts.net', bondSats: '50000' },
  ...T.map((k, i) => ({ node: k, endpoint: PUB[i], bondSats: '50000' }))];
const rid = toHex(new Uint8Array(32).fill(0x51));
const fin = toHex(signFinalSig({ roundId: fromHex(rid), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, SECRET)));

// what the faucet's fetch does: its own seats plainly, a *.ts.net name refused (seatPublicFetch, #1809)
const asked = [];
const fetchJson = async (url) => {
  asked.push(url);
  if (/\.ts\.net/.test(new URL(url).hostname)) throw new Error('refused: internal by name');
  const i = LOCAL.findIndex((b) => url.startsWith(`${b}/`));
  if (url.endsWith('/roles')) { if (i < 0) throw new Error('404'); return { node: T[i], nodes: CENSUS }; }
  if (url.endsWith('/owner')) return i < 0 ? { node: NODE } : { node: T[i] };
  if (i < 0) return { held: [] };
  const from = Number(new URL(url).searchParams.get('from')), today = Math.floor(NOW / DAY) * DAY;
  return { node: T[i], held: from === today - DAY ? [{ roundId: rid, committee: [NODE, ...T], finals: [fin] }] : [] };
};

test('#3610 a trusted census seat listed at its refused public name is read at the seat itself; a stranger\'s refused name still is not', async () => {
  const r = await nodeBountyCheck({ node: NODE, seats: [...LOCAL, ...PUB], fetchJson, nowMs: NOW, censusSeats: LOCAL });
  const committees = r.checks.find((c) => c.key === 'committees');
  console.log('#3610 MEASURED:', JSON.stringify({ passes: r.passes, committees: committees.says, failed: r.checks.filter((c) => !c.ok).map((c) => c.key) }));
  assert.equal(committees.ok, true, committees.says);
  assert.equal(r.passes, true);
  assert.ok(asked.some((u) => u.startsWith('https://evil.tail0000.ts.net/')), 'the stranger\'s endpoint goes through the refusing fetch, not to a local seat');
  assert.ok(!asked.some((u) => u.startsWith('https://team.tail0000.ts.net/')), 'the team seats are read locally');
});
