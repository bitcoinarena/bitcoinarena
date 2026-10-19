// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PLAYER'S NAME, NETWORK-WIDE (PIP, 2026-10-17: "Have custom names in the protocol"): a seat keeps the newest
// signed name per identity key and serves it on GET /funding; a name signed by another key, one breaking the lobby's rule, one dated
// ahead of the seat's clock or an older one is not kept; an empty name stands (back to the generated one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodePlayerName, decodePlayerName, playerNameId, PLAYER_NAME_SKEW_MS } from '../../arena-protocol/src/player-name.js';
import { readSignedFunding } from '../../arena-protocol/src/funding.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[0] = 2; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NET = new Uint8Array(32).fill(7), NOW = 1792240000000;
const nameHex = (n, name, atMs = NOW, signer = n) => { const r = { networkId: NET, player: pk(n), atMs: BigInt(atMs), name }; return toHex(Uint8Array.from([...encodePlayerName(r), ...schnorr.sign(playerNameId(r), sk(signer))])); };
const book = () => createFundingBook({ db: openStore(':memory:'), verify, tip: async () => 156850, isBonded: () => false, activeAt: async () => ({ ok: true, nodes: [] }), now: () => NOW });

test('the record: its bytes round-trip, the lobby\'s name rule holds, and only the identity key it names signs it', () => {
  const r = { networkId: NET, player: pk(1), atMs: 5n, name: 'satoshi fan' };
  assert.deepEqual(decodePlayerName(encodePlayerName(r)), r);
  assert.throws(() => encodePlayerName({ ...r, name: '  satoshi  fan ' }), /signed as it is kept/);
  assert.throws(() => encodePlayerName({ ...r, name: 'x'.repeat(25) }), /at most 24/);
  assert.throws(() => encodePlayerName({ ...r, name: '<script>' }), /letters and digits/);
  assert.equal(readSignedFunding('name', Buffer.from(nameHex(1, 'alice'), 'hex'), verify).ok, true);
  assert.match(readSignedFunding('name', Buffer.from(nameHex(1, 'alice', NOW, 2), 'hex'), verify).why, /signature does not verify/);
});

test('a seat keeps the newest name per player and serves it; older, forged and future-dated ones are not kept', async () => {
  const b = book();
  assert.deepEqual(await b.add('name', nameHex(1, 'alice', NOW - 5000)).then((r) => [r.ok, r.fresh]), [true, true]);
  assert.deepEqual(await b.add('name', nameHex(2, 'bob')).then((r) => [r.ok, r.fresh]), [true, true]);
  assert.deepEqual(await b.add('name', nameHex(1, 'alice two', NOW)).then((r) => [r.ok, r.fresh]), [true, true], 'a rename');
  const older = await b.add('name', nameHex(1, 'alice old', NOW - 60000));
  assert.deepEqual([older.ok, older.fresh], [true, false]);
  assert.equal((await b.add('name', nameHex(1, 'mallory', NOW + 1, 3))).status, 400, 'signed by another key');
  assert.equal((await b.add('name', nameHex(1, 'later', NOW + PLAYER_NAME_SKEW_MS + 1))).status, 422, 'dated ahead of the clock');
  const names = Object.fromEntries(b.names().map((x) => [x.player, x.name]));
  assert.deepEqual(names, { [toHex(pk(1))]: 'alice two', [toHex(pk(2))]: 'bob' });
  // back to the generated name: an empty name, newer, stands
  await b.add('name', nameHex(2, '', NOW + 10));
  assert.equal(b.names().find((x) => x.player === toHex(pk(2))).name, '');
  assert.equal(b.names().length, 2, 'one record per player');
  assert.equal(b.list().length, 0, 'a name is no proposal');
});
