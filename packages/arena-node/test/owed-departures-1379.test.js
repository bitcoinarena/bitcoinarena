// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1379 (audit 2 #1204 INSTALLER-DOORS-14): a leaving guardian owes a departure notice for every federation that seats it, made once each
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { owedDepartures } from '../src/absence-producer.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const secret = new Uint8Array(32).fill(5), nodePubkey = schnorr.getPublicKey(secret);
const seat = (n) => ({ federation: String(n).repeat(64).slice(0, 64), peerKey: Uint8Array.from([0x02, ...new Uint8Array(32).fill(n)]) });

test('#1379 no records read yet: nothing made and nothing claimed; then both federations get a notice, each once', async () => {
  const kept = new Set(), posts = [];
  const run = (seats) => owedDepartures({ seats, held: (f, p) => kept.has(`${f}:${p}`), tip: async () => 120000, departureNotice: 144, nodePubkey,
    sign: (h) => schnorr.sign(h, secret), offer: (d) => { kept.add(`${toHex(d.federationId)}:${toHex(d.peerKey)}`); return { ok: true, kept: true }; },
    post: async (hex) => { posts.push(hex); return { postedTo: 6, of: 6 }; } });
  // a leave right after a restart: the records are not read yet
  assert.deepEqual(await run([]), []);
  // the next minute's pass: two records seat this node (its guardian and its guardian-next)
  const two = [seat(1), seat(2)];
  const made = await run(two);
  console.log(`#1379 two records: ${made.map((x) => `${x.federation.slice(0, 4)} ${x.notice ? `notice, leave after ${x.leaveAfterHeight}` : x.made ? 'made before' : x.why}`).join('; ')}`);
  assert.equal(made.length, 2);
  assert.ok(made.every((x) => x.notice && x.leaveAfterHeight === 120144 && x.postedTo === 6));
  assert.equal(posts.length, 2);
  // a later pass (or a second leave): both made, nothing sent again
  const again = await run(two);
  assert.deepEqual(again.map((x) => x.made), [true, true]);
  assert.equal(posts.length, 2);
});

test('#1379 a chain that does not answer: the notice stays owed and is made on a later pass', async () => {
  const kept = new Set();
  let up = false;
  const run = () => owedDepartures({ seats: [seat(3)], held: (f, p) => kept.has(`${f}:${p}`), tip: async () => { if (!up) throw new Error('bitcoind did not answer'); return 5000; },
    departureNotice: 144, nodePubkey, sign: (h) => schnorr.sign(h, secret), offer: (d) => { kept.add(`${toHex(d.federationId)}:${toHex(d.peerKey)}`); return { ok: true }; },
    post: async () => ({ postedTo: 1, of: 1 }) });
  const first = await run();
  assert.match(first[0].why, /did not answer/);
  up = true;
  const second = await run();
  assert.ok(second[0].notice);
});
