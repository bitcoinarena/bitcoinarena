// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2780 (live 2026-11-15, every seat): the feed kept its own first decoded copy of each open price round for the round's life. A v2
// round's `nodes` are written in by the seat (Round.seatDrawFree: the draw's first seats, then the certified seated set), and the store lets
// go of its copy then; the feed did not. After a reseat the beat signed readings for rounds the seat had left - refused at its own door, "a
// reading is signed by a key of the round's committee" - and read nothing for the rounds it was seated into. Every seat's own readings fell to
// 0 within hours, and the feed with them, until a restart. The beat now takes the contract the store holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;

// one seat's store as the server hands it to the feed: the open list, the kept decoded contracts, openSeq bumped by a write-in
function seat(me, nodes) {
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const enc = (n) => encodeRoundContract({ ...base, protocolVersion: 5, nodes: n, startTimeMs: BigInt(START) });
  let bytes = enc(nodes);
  const rid = roundIdOf(decodeRoundContract(bytes));
  const ids = [rid];
  let kept = null;
  const round = { identity: me, get pubkey() { return me.pubkey; }, openSeq: 1,
    get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
    openHeld: () => ids, hexOf: (id) => toHex(id),
    contractOf: () => (kept ||= decodeRoundContract(bytes)),
    writeIn(n) { bytes = enc(n); kept = null; this.openSeq++; } };
  return { round, rid };
}

test('#2780 after a write-in moves the seat out of a round the beat signs nothing for it, and after one moves it in the beat reads for it', async () => {
  const keys = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const me = keys[0];
  let t = START + 1 * 5000 + 300;
  const { round } = seat(me, keys.slice(0, 7).map((k) => k.pubkey));
  const feed = new PriceFeed(round, { priceRound: () => true, readPrice: async () => ({ cents: 8_297_193, atMs: t - 100 }), now: () => t,
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }), peersFor: () => [], log: () => {} });
  const signedOk = (out) => out.filter(([what, got]) => typeof what === 'number' && got && got.ok).length;
  const refusedAsStranger = (out) => out.filter(([, got]) => got && got.ok === false && /signed by a key of the round's committee/.test(got.why || '')).length;
  assert.ok(signedOk(await feed.beat()) >= 1, 'a seat of the round reads for it');
  // the seated set is written in without this seat
  round.writeIn(keys.slice(1, 8).map((k) => k.pubkey));
  t += 5000;
  const out = await feed.beat();
  assert.equal(refusedAsStranger(out), 0, 'the beat signed a reading for a round this seat left: refused at its own door');
  assert.equal(signedOk(out), 0);
  // and back in
  round.writeIn(keys.slice(0, 7).map((k) => k.pubkey));
  t += 5000;
  assert.ok(signedOk(await feed.beat()) >= 1, 'the beat reads nothing for a round this seat was seated into');
});
